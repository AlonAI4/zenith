import assert from 'node:assert/strict';
import test from 'node:test';

import * as Cesium from 'cesium';

import {
  FILL_ALPHA,
  MAX_CORNERS,
  PULSE_MS,
  PULSE_RUN_MS,
  SWEEP_MS,
  WALL_SLACK_M,
  buildingSpan,
  cornerIndexes,
  createSpotlight,
  groundHeight,
  groundPoints,
  grownRing,
  openRing,
  peakPoints,
  pulseAlpha,
  roofPoints,
  sweepHeight,
} from './spotlight.js';

// A 40 m by 20 m block in Austin, closed the way OpenStreetMap closes it.
const LAT = 30.2747;
const LON = -97.7404;
const M_LAT = 1 / 110_574;
const M_LON = 1 / (111_320 * Math.cos((LAT * Math.PI) / 180));
const block = [
  [LON, LAT],
  [LON + 40 * M_LON, LAT],
  [LON + 40 * M_LON, LAT + 20 * M_LAT],
  [LON, LAT + 20 * M_LAT],
  [LON, LAT],
];
const metresBetween = ([a, b], [c, d]) =>
  Math.hypot((c - a) / M_LON, (d - b) / M_LAT);

test('a closed outline loses its repeated last point', () => {
  assert.equal(openRing(block).length, 4);
  assert.equal(openRing(block.slice(0, 4)).length, 4);
});

test('the light and the rings reach past the walls, whichever way the outline runs', () => {
  for (const ring of [block, [...block].reverse()]) {
    const grown = grownRing(ring, WALL_SLACK_M);
    const corner = grown.find((p) => p[0] < LON && p[1] < LAT);
    assert.ok(corner, 'the south-west corner moved out to the south-west');
    // Both sides moved out the same: the corner moves the square root of two times as far.
    assert.ok(
      Math.abs(metresBetween(block[0], corner) - WALL_SLACK_M * Math.SQRT2) <
        0.02,
    );
  }
  const shrunk = grownRing(block, -1.5);
  assert.ok(shrunk.every(([lon, lat]) => lon > LON && lat > LAT));
});

test('corners are the sharp turns, at most eight of them', () => {
  assert.deepEqual(cornerIndexes(block), [0, 1, 2, 3]);
  // A round dome: every turn is gentle, so no corner lines.
  const dome = Array.from({ length: 64 }, (_, i) => [
    LON + 30 * M_LON * Math.cos((i / 64) * 2 * Math.PI),
    LAT + 30 * M_LAT * Math.sin((i / 64) * 2 * Math.PI),
  ]);
  assert.deepEqual(cornerIndexes(dome), []);
  // A star with twenty points: only the eight sharpest are kept.
  const star = Array.from({ length: 20 }, (_, i) => {
    const r = i % 2 ? 10 : 30 + i;
    const a = (i / 20) * 2 * Math.PI;
    return [LON + r * M_LON * Math.cos(a), LAT + r * M_LAT * Math.sin(a)];
  });
  assert.equal(cornerIndexes(star).length, MAX_CORNERS);
});

test('the roof is measured inside the outline and the ground just outside it', () => {
  const roofs = roofPoints(block);
  assert.ok(roofs.length >= 20);
  assert.ok(
    roofs.every(
      ([lon, lat]) =>
        lon > LON &&
        lon < LON + 40 * M_LON &&
        lat > LAT &&
        lat < LAT + 20 * M_LAT,
    ),
  );
  const ground = groundPoints(block);
  assert.ok(ground.length > 0 && ground.length <= 24);
  assert.ok(
    ground.every(
      ([lon, lat]) =>
        lon < LON ||
        lon > LON + 40 * M_LON ||
        lat < LAT ||
        lat > LAT + 20 * M_LAT,
    ),
  );
});

test('the closer look is a small square round the highest spot, inside the outline', () => {
  const middle = [LON + 20 * M_LON, LAT + 10 * M_LAT];
  const near = peakPoints(block, middle, 3);
  assert.equal(near.length, 49);
  assert.ok(
    near.some((p) => metresBetween(p, middle) < 0.01),
    'the spot itself',
  );
  assert.ok(
    near.every((p) => metresBetween(p, middle) <= 3 * Math.SQRT2 + 0.01),
  );
  // At a corner, the points that fall outside the building are left out.
  const corner = peakPoints(block, [LON + 1 * M_LON, LAT + 1 * M_LAT], 12);
  assert.ok(corner.length > 0 && corner.length < 49);
  assert.ok(corner.every(([lon, lat]) => lon > LON && lat > LAT));
});

test('the ground is low among the heights around, ignoring trees and gaps', () => {
  assert.equal(
    groundHeight([150, 150.5, 151, 162, undefined, 149.8, 158]),
    150,
  );
  assert.equal(groundHeight([150, undefined]), undefined);
});

test('the lit span reaches the measured dome, with OpenStreetMap as the least', () => {
  // The Texas Capitol: 35 m on OpenStreetMap, the dome measured far higher.
  assert.deepEqual(
    buildingSpan({
      ground: 160,
      roofs: [195, 250, undefined],
      tallM: 35,
      spotHeight: 196,
    }),
    { base: 160, roof: 250 },
  );
  // Nothing measured yet: the clicked spot and the mapped height.
  assert.deepEqual(buildingSpan({ tallM: 35, spotHeight: 196 }), {
    base: 161,
    roof: 196,
  });
  // A low measurement never cuts the mapped height.
  assert.deepEqual(
    buildingSpan({ ground: 100, roofs: [104], tallM: 20, spotHeight: 110 }),
    {
      base: 100,
      roof: 120,
    },
  );
});

test('the fill pulses gently every two seconds', () => {
  assert.equal(pulseAlpha(0), FILL_ALPHA);
  assert.ok(Math.abs(pulseAlpha(PULSE_MS) - FILL_ALPHA) < 1e-9);
  assert.ok(pulseAlpha(PULSE_MS / 2) > FILL_ALPHA + 0.09);
  assert.ok(pulseAlpha(PULSE_MS / 2) <= 0.45 + 1e-9);
});

test('the band sweeps from the base to the top in 0.8 seconds, then stops', () => {
  assert.equal(sweepHeight(0, 100, 200), 100);
  assert.equal(sweepHeight(SWEEP_MS, 100, 200), 200);
  const middle = sweepHeight(SWEEP_MS / 2, 100, 200);
  assert.ok(
    middle > 150 && middle < 200,
    'it slows down as it reaches the top',
  );
  assert.equal(sweepHeight(SWEEP_MS + 1, 100, 200), null);
  assert.equal(sweepHeight(-1, 100, 200), null);
});

/** A scene with just what the light uses; height samples wait to be answered. */
function fakeMap({ reduced = false } = {}) {
  const calls = [];
  const timers = new Map();
  let nextTimer = 1;
  const scene = {
    primitives: {
      list: [],
      add(p) {
        this.list.push(p);
        return p;
      },
      remove(p) {
        this.list = this.list.filter((one) => one !== p);
      },
    },
    globe: { show: false },
    invertClassification: false,
    invertClassificationColor: new Cesium.Color(0.1, 0.2, 0.3, 0.4),
    invertClassificationSupported: true,
    sampleHeightSupported: true,
    sampleHeightMostDetailed(places) {
      let answer;
      const promise = new Promise((done) => {
        answer = done;
      });
      calls.push({ places, answer });
      return promise;
    },
    requestRender() {},
    isDestroyed: () => false,
  };
  const win = {
    matchMedia: () => ({ matches: reduced }),
    setInterval(fn) {
      timers.set(nextTimer, fn);
      return nextTimer++;
    },
    clearInterval: (id) => timers.delete(id),
    setTimeout: () => 0,
    clearTimeout() {},
    // One-shot, like the browser's.
    requestAnimationFrame: (fn) => {
      const id = nextTimer++;
      timers.set(id, (now) => {
        timers.delete(id);
        fn(now);
      });
      return id;
    },
    cancelAnimationFrame: (id) => timers.delete(id),
  };
  const tileset = { show: true, isDestroyed: () => false };
  const lines = new Cesium.CustomDataSource('spotlight-test');
  const light = createSpotlight({ viewer: { scene }, tileset }, lines, win);
  const toSatellite = (on) => {
    scene.globe.show = on;
    tileset.show = !on;
  };
  return { scene, win, timers, calls, lines, light, toSatellite };
}

const settle = () => new Promise((done) => setImmediate(done));
/**
 * Answer every waiting height sample: the roof at `roof`, the ground at 150.
 * The first sample is the roof grid, then the ground round it; the closer
 * looks after it are all roof.
 */
async function answerAll(calls, roof) {
  let roofs = roofPoints(block).length;
  while (calls.length) {
    const { places, answer } = calls.shift();
    answer(places.map((_, i) => ({ height: i < roofs ? roof : 150 })));
    roofs = Infinity;
    await settle();
  }
}

test('the 3D light dims the rest of the map, and closing puts it back as it was', () => {
  const { scene, lines, light, timers } = fakeMap();
  const before = Cesium.Color.clone(scene.invertClassificationColor);
  light.show(block, { spotHeight: 160, tallM: 20 });
  assert.equal(scene.primitives.list.length, 1);
  assert.ok(scene.primitives.list[0] instanceof Cesium.ClassificationPrimitive);
  assert.equal(scene.invertClassification, true);
  assert.ok(lines.entities.values.length >= 2, 'a top ring and a base ring');
  light.hide();
  assert.equal(scene.primitives.list.length, 0);
  assert.equal(scene.invertClassification, false);
  assert.ok(Cesium.Color.equals(scene.invertClassificationColor, before));
  assert.equal(lines.entities.values.length, 0);
  assert.equal(timers.size, 0, 'no sweep or pulse left running');
  assert.equal(light.span(), null);
});

test('a measurement from before a map switch is thrown away and taken again', async () => {
  const { calls, light, toSatellite } = fakeMap();
  light.show(block, { spotHeight: 160, tallM: 20 });
  assert.equal(calls.length, 1);
  // Switched to the satellite map while the 3D map was being measured.
  toSatellite(true);
  light.onFrame();
  await answerAll(calls, 999);
  assert.equal(light.span().roof, 160, 'the old answer was not used');
  // Back on the 3D map: measured again, and this answer counts.
  toSatellite(false);
  light.onFrame();
  assert.equal(calls.length, 1);
  await answerAll(calls, 210);
  assert.deepEqual(light.span(), { base: 150, roof: 210 });
  light.hide();
});

test('with reduced motion nothing sweeps or pulses', () => {
  const { light, timers } = fakeMap({ reduced: true });
  light.show(block, { spotHeight: 160, tallM: 20 });
  assert.equal(timers.size, 0);
  light.hide();
});

test('the light pulses five times, then holds still', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const { light, timers } = fakeMap();
  light.show(block, { spotHeight: 160, tallM: 20 });
  assert.ok(timers.size >= 1, 'the pulse started');
  t.mock.timers.tick(PULSE_RUN_MS + 1);
  for (const fn of [...timers.values()]) fn(Date.now());
  assert.equal(timers.size, 0, 'nothing keeps the map drawing');
  light.hide();
});
