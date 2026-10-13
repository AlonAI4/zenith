import assert from 'node:assert/strict';
import test from 'node:test';

import * as Cesium from 'cesium';

import {
  directionTo,
  nightLook,
  partOfDay,
  subsolarPoint,
  sunHeight,
} from './dayNight.js';

const at = (iso) => Date.parse(iso);

/** The same answer from Cesium's own sun maths, as an independent check. */
function cesiumSubsolar(ms) {
  const time = Cesium.JulianDate.fromDate(new Date(ms));
  const inertial =
    Cesium.Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(time);
  const toFixed = Cesium.Transforms.computeTemeToPseudoFixedMatrix(time);
  const fixed = Cesium.Matrix3.multiplyByVector(toFixed, inertial, new Cesium.Cartesian3());
  const unit = Cesium.Cartesian3.normalize(fixed, fixed);
  return {
    lat: Cesium.Math.toDegrees(Math.asin(unit.z)),
    lon: Cesium.Math.toDegrees(Math.atan2(unit.y, unit.x)),
  };
}

test("the sun's place matches Cesium's own sun maths through the year", () => {
  for (const iso of [
    '2026-01-05T03:00:00Z',
    '2026-03-20T14:46:00Z',
    '2026-06-21T12:00:00Z',
    '2026-10-13T12:03:00Z',
    '2026-12-21T23:30:00Z',
    '2031-08-08T08:08:00Z',
  ]) {
    const mine = subsolarPoint(at(iso));
    const theirs = cesiumSubsolar(at(iso));
    const lonGap = Math.abs(((mine.lon - theirs.lon + 540) % 360) - 180);
    assert.ok(Math.abs(mine.lat - theirs.lat) < 0.3, `${iso} lat ${mine.lat} vs ${theirs.lat}`);
    assert.ok(lonGap < 0.5, `${iso} lon ${mine.lon} vs ${theirs.lon}`);
  }
});

test('the sun is over the tropics at the solstices and the equator at the equinox', () => {
  assert.ok(Math.abs(subsolarPoint(at('2026-06-21T12:00:00Z')).lat - 23.44) < 0.1);
  assert.ok(Math.abs(subsolarPoint(at('2026-12-21T12:00:00Z')).lat + 23.44) < 0.1);
  assert.ok(Math.abs(subsolarPoint(at('2026-03-20T14:46:00Z')).lat) < 0.1);
  // At 12:00 UTC it is overhead near the Greenwich meridian (within the
  // quarter hour the sun runs fast or slow through the year).
  assert.ok(Math.abs(subsolarPoint(at('2026-06-21T12:00:00Z')).lon) < 4.5);
});

test('day and night agree with the clock on the wall', () => {
  const LONDON = [51.5, -0.13];
  const SYDNEY = [-33.87, 151.21];
  const noonUtc = subsolarPoint(at('2026-10-13T12:00:00Z'));
  assert.equal(partOfDay(...LONDON, noonUtc), 'day'); // 13:00 in London
  assert.equal(partOfDay(...SYDNEY, noonUtc), 'night'); // 23:00 in Sydney
  const midnightUtc = subsolarPoint(at('2026-10-13T00:00:00Z'));
  assert.equal(partOfDay(...LONDON, midnightUtc), 'night'); // 01:00 in London
  assert.equal(partOfDay(...SYDNEY, midnightUtc), 'day'); // 11:00 in Sydney
  // Straight under the sun it is as high as it gets.
  assert.ok(Math.abs(sunHeight(noonUtc.lat, noonUtc.lon, noonUtc) - 1) < 1e-12);
});

test('the night look is strong from far out and mild close to the ground', () => {
  const far = nightLook(10_000_000);
  const near = nightLook(1000);
  assert.ok(far.floor < 0.08 && far.glow > 2);
  // Close in, the lights are off: one pixel of the picture is about 11 km.
  assert.ok(near.floor > 0.3 && near.glow === 0);
  let last = nightLook(1);
  for (const height of [1e3, 1e5, 3e5, 1e6, 2e6, 1e7, 1e9]) {
    const look = nightLook(height);
    assert.ok(look.floor <= last.floor + 1e-12 && look.glow >= last.glow - 1e-12);
    last = look;
  }
});

test('directions are unit vectors', () => {
  const [x, y, z] = directionTo({ lat: 37, lon: -122 });
  assert.ok(Math.abs(Math.hypot(x, y, z) - 1) < 1e-12);
});
