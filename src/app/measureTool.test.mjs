import assert from 'node:assert/strict';
import test from 'node:test';

import {
  distanceLabel,
  isMeasuring,
  metresBetween,
  pathMetres,
  readoutText,
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
