import assert from 'node:assert/strict';
import test from 'node:test';

import * as Cesium from 'cesium';

import {
  directionTo,
  HORIZON,
  nextSunTimes,
  nightLook,
  partOfDay,
  subsolarPoint,
  sunHeight,
  sunLine,
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

const utc = (ms) => new Date(ms).toISOString().slice(11, 16);
const minutes = (ms) => new Date(ms).getUTCHours() * 60 + new Date(ms).getUTCMinutes();

test('sunrise and sunset match the almanac for London', () => {
  // 13 October 2026: sunrise 07:21 and sunset 18:12 British Summer Time,
  // which is 06:21 and 17:12 UTC.
  const { rise, set } = nextSunTimes(51.5074, -0.1278, at('2026-10-13T00:00:00Z'));
  assert.ok(Math.abs(minutes(rise) - (6 * 60 + 21)) <= 4, `sunrise ${utc(rise)} UTC`);
  assert.ok(Math.abs(minutes(set) - (17 * 60 + 12)) <= 4, `sunset ${utc(set)} UTC`);
  // At those moments the sun is on the horizon the shading draws its line at.
  for (const moment of [rise, set]) {
    assert.ok(Math.abs(sunHeight(51.5074, -0.1278, subsolarPoint(moment)) - HORIZON) < 1e-4);
  }
});

test('on the equator at the equinox the day is a little over twelve hours', () => {
  const { rise, set } = nextSunTimes(0, 0, at('2026-03-20T00:00:00Z'));
  const dayMinutes = (set - rise) / 60_000;
  assert.ok(dayMinutes > 12 * 60 && dayMinutes < 12 * 60 + 12, String(dayMinutes));
});

test('the far north has days with no sunset and days with no sunrise', () => {
  const TROMSO = [69.65, 18.96];
  assert.deepEqual(nextSunTimes(...TROMSO, at('2026-06-21T00:00:00Z')), { rise: null, set: null });
  assert.deepEqual(nextSunTimes(...TROMSO, at('2026-12-21T00:00:00Z')), { rise: null, set: null });
  const clock = () => '00:00';
  assert.match(sunLine(...TROMSO, at('2026-06-21T12:00:00Z'), clock), /^Day · the sun does not set/);
  assert.match(sunLine(...TROMSO, at('2026-12-21T00:00:00Z'), clock), /^Night · the sun does not rise/);
});

test('the card line names the part of the day and lists what comes next first', () => {
  const clock = (ms) => utc(ms);
  const noon = sunLine(51.5074, -0.1278, at('2026-10-13T12:00:00Z'), clock);
  assert.match(noon, /^Day · sunset 17:1\d · sunrise 06:2\d$/, noon);
  const night = sunLine(51.5074, -0.1278, at('2026-10-13T23:00:00Z'), clock);
  assert.match(night, /^Night · sunrise 06:2\d · sunset 17:\d\d$/, night);
  const dusk = sunLine(51.5074, -0.1278, at('2026-10-13T17:25:00Z'), clock);
  assert.match(dusk, /^Twilight · sunrise/, dusk);
});
