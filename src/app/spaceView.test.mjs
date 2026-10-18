import assert from 'node:assert/strict';
import test from 'node:test';

import { SWITCH_KEYS, TAKEN_KEYS } from './switchKeys.js';
import {
  APOLLO_SITES,
  ARRIVE,
  createTrip,
  dragMove,
  EARTH_RADIUS_M,
  flightPoint,
  meansEarth,
  meansMoon,
  MOON_RADIUS_M,
  moonCameraLocal,
  moonPoint,
  screenSpot,
  spaceViewCamera,
  terrainReason,
  turnTilt,
  zoomAt,
  zoomHeight,
} from './spaceView.js';

const length = (v) => Math.hypot(v.x, v.y, v.z);
const RAD = Math.PI / 180;
/** The Moon 384,400 km away at a declination and a longitude, Earth-centred. */
const moonAt = (decDeg, lonDeg, km = 384_400) => ({
  x: km * 1000 * Math.cos(decDeg * RAD) * Math.cos(lonDeg * RAD),
  y: km * 1000 * Math.cos(decDeg * RAD) * Math.sin(lonDeg * RAD),
  z: km * 1000 * Math.sin(decDeg * RAD),
});

test("space view has the Earth, its satellites' ring and the Moon in the window, apart", () => {
  for (const moon of [
    moonAt(0, 0),
    moonAt(28.6, 120),
    moonAt(-28.6, -75),
    moonAt(18, 200, 405_000),
  ]) {
    const view = spaceViewCamera(moon);
    for (const aspect of [1440 / 900, 900 / 800]) {
      const earth = screenSpot(view, { x: 0, y: 0, z: 0 }, { aspect });
      const theMoon = screenSpot(view, moon, { aspect });
      assert.ok(
        earth && Math.abs(earth.x) < 0.8 && Math.abs(earth.y) < 0.8,
        `Earth at ${JSON.stringify(earth)}`,
      );
      assert.ok(
        theMoon && Math.abs(theMoon.x) < 0.9 && Math.abs(theMoon.y) < 0.9,
        `Moon at ${JSON.stringify(theMoon)}`,
      );
      // Off to one side: well clear of the Earth, not hidden behind it.
      assert.ok(
        Math.hypot(earth.x - theMoon.x, earth.y - theMoon.y) > 0.4,
        'the Moon is beside the Earth',
      );
      // The geostationary ring (42,164 km from the Earth's centre) fits round the Earth.
      const toEarth = length(view.position);
      const ring = Math.asin(42_164_000 / toEarth) / RAD;
      assert.ok(
        ring < 25,
        `the satellite ring is ${ring.toFixed(1)} degrees across`,
      );
    }
    // Looking from outside, at a sensible distance.
    assert.ok(
      length(view.position) > 100_000_000 &&
        length(view.position) < 200_000_000,
    );
    assert.ok(
      Math.abs(
        view.direction.x * view.up.x +
          view.direction.y * view.up.y +
          view.direction.z * view.up.z,
      ) < 1e-9,
      'up is square to the view',
    );
  }
});

test('arriving at the Moon: straight down on the side facing the Earth, the whole Moon in the window', () => {
  const view = moonCameraLocal(ARRIVE);
  assert.ok(
    Math.abs(length(view.position) - (MOON_RADIUS_M + ARRIVE.height)) < 1,
  );
  // Straight down: the view points at the Moon's centre.
  const toCentre = {
    x: -view.position.x,
    y: -view.position.y,
    z: -view.position.z,
  };
  const cos =
    (view.direction.x * toCentre.x +
      view.direction.y * toCentre.y +
      view.direction.z * toCentre.z) /
    length(toCentre);
  assert.ok(cos > 0.999999);
  // The Moon's disc (its edge seen from here) fits inside a wide window's height.
  const half = Math.asin(MOON_RADIUS_M / length(view.position)) / RAD;
  const tallHalf = Math.atan(Math.tan(30 * RAD) / 1.6) / RAD;
  assert.ok(
    half < tallHalf,
    `the Moon is ${(half * 2).toFixed(1)} degrees across, the window ${(tallHalf * 2).toFixed(1)}`,
  );
  // Heading 0 straight down: north is the top of the window.
  assert.ok(view.up.z > 0.999);
});

test('a tilted view looks ahead along its heading', () => {
  const view = moonCameraLocal({
    lat: 0,
    lon: 0,
    height: 1000,
    heading: 90,
    pitch: 0,
  });
  // At latitude 0, longitude 0, east is +y in the Moon's frame.
  assert.ok(view.direction.y > 0.999);
  assert.ok(view.up.x > 0.999);
});

test('scrolling zooms by a share of the height, down to the ground, with no other limit', () => {
  assert.ok(zoomHeight(1_000_000, -100) < 1_000_000);
  assert.ok(zoomHeight(1_000_000, 100) > 1_000_000);
  let height = 4_500_000;
  for (let i = 0; i < 200; i += 1) height = zoomHeight(height, -400);
  assert.equal(height, 2);
  height = 4_500_000;
  for (let i = 0; i < 60; i += 1) height = zoomHeight(height, 400);
  assert.ok(height > 1e12, 'zooming out never stops');
});

test('zooming with the pointer off the middle moves towards that spot; in the middle it does not move', () => {
  const size = { tall: 900, fovyRad: 40 * RAD };
  const start = { lat: 0, lon: 0, height: 100_000, heading: 0, pitch: -90 };
  const middle = zoomAt(start, -100, 0, 0, size);
  assert.equal(middle.lat, 0);
  assert.equal(middle.lon, 0);
  const right = zoomAt(start, -100, 300, 0, size);
  assert.ok(right.lon > 0, 'towards the east, under the pointer on the right');
  assert.ok(right.height < start.height);
});

test('dragging moves the ground with the pointer, and right-drag turns and tilts', () => {
  const size = { tall: 900, fovyRad: 40 * RAD };
  const start = { lat: 10, lon: 20, height: 100_000, heading: 0, pitch: -90 };
  // Dragging the ground right moves the view west; dragging it down moves the view north.
  assert.ok(dragMove(start, 100, 0, size).lon < 20);
  assert.ok(dragMove(start, 0, 100, size).lat > 10);
  // Facing east, dragging down moves the view east.
  assert.ok(dragMove({ ...start, heading: 90 }, 0, 100, size).lon > 20);
  // Never over a pole, and longitude wraps.
  assert.ok(dragMove(start, 0, 1e7, size).lat <= 89.9);
  const wrapped = dragMove({ ...start, lon: 179.9 }, -2000, 0, size).lon;
  assert.ok(wrapped < 0 && wrapped > -180);
  const turned = turnTilt(start, 100, -100);
  assert.equal(turned.heading, 30);
  assert.equal(turned.pitch, -60);
  assert.equal(turnTilt(start, 0, 1000).pitch, -90);
  assert.equal(turnTilt(start, 0, -1000).pitch, -5);
});

test('the flight between the Earth and the Moon goes round the Earth, never through it', () => {
  const london = { x: 3_978_000, y: -5_000, z: 4_968_000 };
  // The Moon on the far side of the Earth from London.
  const moon = moonAt(-20, 180);
  // Never closer to the Earth's centre than London itself (which is on the ground).
  const floor = length(london) - 1;
  for (let i = 0; i <= 100; i += 1) {
    const at = flightPoint(moon, london, i / 100);
    assert.ok(length(at) >= floor, `inside the Earth at step ${i}`);
  }
  assert.ok(floor > EARTH_RADIUS_M * 0.99);
  const end = flightPoint(moon, london, 1);
  assert.ok(
    Math.hypot(end.x - london.x, end.y - london.y, end.z - london.z) < 1,
  );
});

test('going back puts the view and both switches back as they were', () => {
  const state = {
    satellites: false,
    celestial: false,
    view: { position: 'over London' },
  };
  const app = {
    readView: () => state.view,
    getSatellites: () => state.satellites,
    setSatellites: (on) => (state.satellites = on),
    getCelestial: () => state.celestial,
    setCelestial: (on) => (state.celestial = on),
  };
  const trip = createTrip(app);
  trip.space();
  assert.equal(trip.where, 'space');
  assert.ok(
    state.satellites && !state.celestial,
    'the ring waits until the Earth is in view',
  );
  trip.arrived();
  assert.ok(state.satellites && state.celestial, 'space view switches both on');
  state.view = { position: 'out in space' };
  trip.moon();
  assert.equal(trip.where, 'moon');
  assert.deepEqual(trip.earth(), { position: 'over London' });
  assert.equal(trip.where, 'earth');
  assert.ok(!state.satellites && !state.celestial, 'both switches back off');
  assert.equal(trip.earth(), null, 'already home');

  // Satellites already on: they stay on afterwards.
  state.satellites = true;
  trip.space();
  trip.arrived();
  trip.earth();
  assert.ok(state.satellites && !state.celestial);

  // Straight to the Moon from a search: the switches are not touched.
  state.satellites = false;
  trip.moon();
  assert.ok(!state.satellites && !state.celestial);
  trip.earth();
  assert.ok(!state.satellites && !state.celestial);
});

test('the six Apollo landing sites, from NASA NSSDC, all on the side facing the Earth', () => {
  assert.deepEqual(
    APOLLO_SITES.map((site) => site.mission),
    [
      'Apollo 11',
      'Apollo 12',
      'Apollo 14',
      'Apollo 15',
      'Apollo 16',
      'Apollo 17',
    ],
  );
  const where = Object.fromEntries(
    APOLLO_SITES.map((site) => [site.mission, [site.lat, site.lon]]),
  );
  assert.deepEqual(where['Apollo 11'], [0.67416, 23.47314]);
  assert.deepEqual(where['Apollo 12'], [-3.0128, -23.4219]);
  assert.deepEqual(where['Apollo 14'], [-3.64589, -17.47194]);
  assert.deepEqual(where['Apollo 15'], [26.13239, 3.6333]);
  assert.deepEqual(where['Apollo 16'], [-8.9734, 15.5011]);
  assert.deepEqual(where['Apollo 17'], [20.1911, 30.7723]);
  for (const site of APOLLO_SITES) {
    assert.ok(Math.abs(site.lon) < 90 && Math.abs(site.lat) < 90, site.mission);
    assert.match(site.landed, /^\d{1,2} [A-Z][a-z]+ 19(69|71|72)$/);
    // On the Moon's surface.
    assert.ok(
      Math.abs(length(moonPoint(site.lat, site.lon)) - MOON_RADIUS_M) < 1e-3,
    );
  }
});

test('searches for the Moon and the Earth', () => {
  for (const text of ['Moon', 'moon', 'the Moon', ' the moon '])
    assert.ok(meansMoon(text), text);
  for (const text of ['Moonstone', 'Moon Street', 'honeymoon', ''])
    assert.ok(!meansMoon(text), text);
  assert.ok(meansEarth('Earth') && meansEarth('the earth'));
  assert.ok(!meansEarth('Earthquakes'));
});

test('why Cesium Moon Terrain was not used is said plainly', () => {
  assert.match(terrainReason(null, false), /no Cesium ion token/);
  assert.match(
    terrainReason({ statusCode: 404 }, true),
    /not in this Cesium ion account/,
  );
  assert.match(terrainReason({ statusCode: 401 }, true), /cannot open it/);
  assert.match(
    terrainReason(new Error('offline'), true),
    /could not be reached/,
  );
});

test('the Space view key is free and its own', () => {
  assert.equal(SWITCH_KEYS['space-view-toggle'], 'y');
  assert.ok(!TAKEN_KEYS.includes('y'));
  const keys = Object.values(SWITCH_KEYS);
  assert.equal(new Set(keys).size, keys.length);
});
