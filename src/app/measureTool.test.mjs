import assert from 'node:assert/strict';
import test from 'node:test';

import * as Cesium from 'cesium';

import {
  areaLabel,
  CLOSE_WITHIN_PX,
  closesShape,
  distanceLabel,
  isMeasuring,
  metresBetween,
  pathMetres,
  pathSamples,
  profileLine,
  profileStats,
  readoutText,
  ringArea,
  shapeMiddle,
  whereAlong,
} from './measureTool.js';

const LONDON = { lon: -0.1276, lat: 51.5072 };
const PARIS = { lon: 2.3522, lat: 48.8566 };

test('distances follow the curved Earth', () => {
  // One degree of longitude along the equator.
  const degree = metresBetween({ lon: 0, lat: 0 }, { lon: 1, lat: 0 });
  assert.ok(Math.abs(degree - 111319.49) < 1, String(degree));
  const hop = metresBetween(LONDON, PARIS);
  assert.ok(hop > 343000 && hop < 345000, String(hop));
  assert.equal(metresBetween(LONDON, LONDON), 0);
  // Exactly opposite points have no single shortest path; it must not throw.
  const far = metresBetween({ lon: 0, lat: 0 }, { lon: 180, lat: 0 });
  assert.ok(far > 20000000 && far < 20040000, String(far));
});

test('a path is the sum of its legs, and the same in both directions', () => {
  const there = pathMetres([LONDON, PARIS, LONDON]);
  assert.ok(Math.abs(there - 2 * metresBetween(LONDON, PARIS)) < 1e-6);
  assert.equal(pathMetres([]), 0);
  assert.equal(pathMetres([LONDON]), 0);
});

test('distances are worded like the scale, rounded to what is worth reading', () => {
  assert.equal(distanceLabel(0.42), '42 cm');
  assert.equal(distanceLabel(87.3), '87 m');
  assert.equal(distanceLabel(999.7), '1 km');
  assert.equal(distanceLabel(1234.5), '1.23 km');
  assert.equal(distanceLabel(12345.6), '12.3 km');
  assert.equal(distanceLabel(343556), '344 km');
  assert.equal(distanceLabel(12345678), '12,346 km');
  assert.equal(distanceLabel(NaN), '');
});

test('the readout walks the user through the first two clicks', () => {
  assert.match(readoutText([]), /start measuring/);
  assert.match(readoutText([LONDON]), /next spot/);
  assert.match(readoutText([LONDON, PARIS]), /^34\d km · 2 points$/);
});

test('the tool is off until its switch is pressed', () => {
  assert.equal(isMeasuring(), false);
});

const square = (lon, lat, size) => [
  { lon, lat },
  { lon: lon + size, lat },
  { lon: lon + size, lat: lat + size },
  { lon, lat: lat + size },
];

test('area is worked out on the curved Earth', () => {
  // One degree by one degree at the equator is about 12,300 square km.
  const cell = ringArea(square(0, 0, 1)) / 1e6;
  assert.ok(Math.abs(cell - 12_309) / 12_309 < 0.006, String(cell));
  // The same cell further north is smaller, because meridians close in.
  assert.ok(ringArea(square(0, 60, 1)) < ringArea(square(0, 0, 1)) * 0.52);
  // The whole northern half of the Earth is half its surface.
  const cap = ringArea([
    { lon: 0, lat: 0 },
    { lon: 90, lat: 0 },
    { lon: 180, lat: 0 },
    { lon: -90, lat: 0 },
  ]);
  assert.ok(Math.abs(cap / 2.55032e14 - 1) < 0.001, String(cap));
});

test('area does not depend on direction, start point or the 180 degree line', () => {
  const ring = square(10, 20, 2);
  const area = ringArea(ring);
  assert.ok(Math.abs(ringArea([...ring].reverse()) - area) < 1e-3);
  assert.ok(Math.abs(ringArea([...ring.slice(2), ...ring.slice(0, 2)]) - area) < 1e-3);
  const across = [
    { lon: 179, lat: 20 },
    { lon: -179, lat: 20 },
    { lon: -179, lat: 22 },
    { lon: 179, lat: 22 },
  ];
  assert.ok(Math.abs(ringArea(across) - area) / area < 1e-9);
  assert.equal(ringArea([LONDON, PARIS]), 0);
});

test('areas are worded in square metres, then square kilometres', () => {
  assert.equal(areaLabel(8430.4), '8,430 m²');
  assert.equal(areaLabel(999_600), '1 km²');
  assert.equal(areaLabel(1_234_567), '1.23 km²');
  assert.equal(areaLabel(45_678_000), '45.7 km²');
  assert.equal(areaLabel(12_309e6), '12,309 km²');
  assert.equal(areaLabel(NaN), '');
});

test('a closed shape counts the leg back to the start and shows its area', () => {
  const ring = square(0, 0, 1);
  const open = pathMetres(ring);
  const shut = pathMetres(ring, true);
  assert.ok(Math.abs(shut - open - metresBetween(ring[3], ring[0])) < 1e-6);
  assert.equal(pathMetres([LONDON, PARIS], true), pathMetres([LONDON, PARIS]));
  assert.match(readoutText(ring, true), /^Area 12,3\d\d km² · outline 44\d km$/);
});

test('only a click on the first point, with three points or more, closes the shape', () => {
  const first = { x: 400, y: 300 };
  assert.equal(closesShape({ x: 405, y: 296 }, first, 3), true);
  assert.equal(closesShape({ x: 400 + CLOSE_WITHIN_PX + 1, y: 300 }, first, 3), false);
  assert.equal(closesShape({ x: 400, y: 300 }, first, 2), false);
  assert.equal(closesShape({ x: 400, y: 300 }, null, 5), false);
});

test('the middle of a shape is inside it', () => {
  // A 300 m square by Tower Bridge. The area label goes at its middle.
  const corners = [
    [-0.0780, 51.5040],
    [-0.0737, 51.5040],
    [-0.0737, 51.5067],
    [-0.0780, 51.5067],
  ].map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat, 50));
  const middle = shapeMiddle(corners);
  const lat = Cesium.Math.toDegrees(middle.latitude);
  const lon = Cesium.Math.toDegrees(middle.longitude);
  assert.ok(Math.abs(lat - 51.50535) < 0.0002, String(lat));
  assert.ok(Math.abs(lon + 0.07585) < 0.0002, String(lon));
});

test('heights are read at evenly spaced spots along the whole path', () => {
  const path = [LONDON, PARIS, { lon: 4.9, lat: 52.37 }];
  const samples = pathSamples(path, 11);
  const total = pathMetres(path);
  assert.equal(samples.length, 11);
  assert.equal(samples[0].along, 0);
  assert.ok(Math.abs(samples.at(-1).along - total) < 1e-6);
  assert.ok(Math.abs(samples[5].along - total / 2) < 1e-6);
  // It starts and ends on the path's own ends.
  assert.ok(Math.abs(samples[0].lon - LONDON.lon) < 1e-9 && Math.abs(samples[0].lat - LONDON.lat) < 1e-9);
  assert.ok(Math.abs(samples.at(-1).lon - 4.9) < 1e-6 && Math.abs(samples.at(-1).lat - 52.37) < 1e-6);
  // Every spot is the right distance along, measured again from the start.
  const corner = metresBetween(LONDON, PARIS);
  for (const sample of samples) {
    const back = sample.along <= corner ? metresBetween(LONDON, sample) : corner + metresBetween(PARIS, sample);
    assert.ok(Math.abs(back - sample.along) < 1, `${back} vs ${sample.along}`);
  }
  assert.deepEqual(pathSamples([LONDON], 10), []);
  assert.deepEqual(pathSamples([LONDON, LONDON], 10), []);
});

test('a closed shape is profiled all the way round', () => {
  const ring = square(0, 0, 1);
  const samples = pathSamples(ring, 9, true);
  assert.ok(Math.abs(samples.at(-1).along - pathMetres(ring, true)) < 1e-6);
  assert.ok(Math.abs(samples.at(-1).lon - ring[0].lon) < 1e-6 && Math.abs(samples.at(-1).lat - ring[0].lat) < 1e-6);
});

test('the highest and lowest points are found, skipping heights that are missing', () => {
  const stats = profileStats([40, undefined, 55, 12, NaN, 300, 80]);
  assert.deepEqual(stats, { lowIndex: 3, highIndex: 5, low: 12, high: 300, rise: 288 });
  assert.equal(profileStats([undefined, 5, NaN]), null);
  assert.equal(profileStats([10, 10.2, 10.1]), null);
  assert.equal(profileStats([]), null);
});

test('the chart line runs from the bottom at the lowest point to the top at the highest', () => {
  const heights = [0, 50, 100, undefined, 100, 0];
  const stats = profileStats(heights);
  const line = profileLine(heights, stats, 106, 56, 6);
  // Lowest sits on the bottom edge, highest on the top, and the gap lifts the pen.
  assert.equal(line, 'M6.0 50.0L24.8 28.0L43.6 6.0M81.2 6.0L100.0 50.0');
});

test('where a point is along the path is said in words', () => {
  assert.equal(whereAlong(0, 12_000), 'at the start');
  assert.equal(whereAlong(12_000, 12_000), 'at the end');
  assert.equal(whereAlong(11_400, 12_000), '11.4 km along');
  assert.equal(whereAlong(350, 12_000), '350 m along');
});
