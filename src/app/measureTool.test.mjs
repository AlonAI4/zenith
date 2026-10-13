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
  readoutText,
  ringArea,
  shapeMiddle,
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
