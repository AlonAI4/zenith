import assert from 'node:assert/strict';
import test from 'node:test';

import { formatDistance, metresPerPixel, niceScale } from './scaleBar.js';

test('one pixel covers more ground the further away the camera is', () => {
  const fovy = Math.PI / 3;
  const near = metresPerPixel(1000, fovy, 900);
  // 60 degrees seen from 1 km spans 1,154.7 m across 900 pixels.
  assert.ok(Math.abs(near - 1154.7005 / 900) < 1e-4, String(near));
  assert.ok(Math.abs(metresPerPixel(2000, fovy, 900) - near * 2) < 1e-9);
  assert.ok(Number.isNaN(metresPerPixel(0, fovy, 900)));
  assert.ok(Number.isNaN(metresPerPixel(1000, fovy, 0)));
  assert.ok(Number.isNaN(metresPerPixel(1000, undefined, 900)));
});

test('the ruler is a round number and never longer than the space allowed', () => {
  // 1.5 m per pixel and 120 pixels: up to 180 m fits, so the ruler is 100 m.
  assert.deepEqual(niceScale(1.5, 120), {
    metres: 100,
    pixels: 100 / 1.5,
    label: '100 m',
  });
  assert.equal(niceScale(2, 120).label, '200 m');
  assert.equal(niceScale(5, 120).label, '500 m');
  assert.equal(niceScale(10, 120).label, '1 km');
  assert.equal(niceScale(20_000, 120).label, '2,000 km');
  assert.equal(niceScale(0.005, 120).label, '50 cm');
  for (const perPixel of [0.003, 0.7, 1.5, 9, 42, 880, 31_000]) {
    const scale = niceScale(perPixel, 120);
    assert.ok(scale.pixels <= 120, `${perPixel}: ${scale.pixels}`);
    // A round ruler is always at least a fifth of the space, so never a stub.
    assert.ok(scale.pixels > 120 / 5 - 1e-9, `${perPixel}: ${scale.pixels}`);
    assert.match(String(scale.metres), /^(1|2|5)0*$|^0\.0*(1|2|5)$/);
  }
});

test('no ruler when the scale is unknown', () => {
  assert.equal(niceScale(NaN), null);
  assert.equal(niceScale(0), null);
  assert.equal(niceScale(Infinity), null);
});

test('distances read the way people write them', () => {
  assert.equal(formatDistance(200), '200 m');
  assert.equal(formatDistance(1000), '1 km');
  assert.equal(formatDistance(5000), '5 km');
  assert.equal(formatDistance(2_000_000), '2,000 km');
  assert.equal(formatDistance(0.5), '50 cm');
});
