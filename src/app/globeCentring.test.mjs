import assert from 'node:assert/strict';
import test from 'node:test';

import {
  elevationForOffNadir,
  fitHeight,
  maxOffNadir,
  offNadirFor,
  tiltToRestore,
} from './globeCentring.js';

const EARTH = 6_371_000;
const deg = (radians) => (radians * 180) / Math.PI;
const rad = (degrees) => (degrees * Math.PI) / 180;

test('the whole Earth fits from about two Earth radii up, for a 40 degree view', () => {
  const height = fitHeight(EARTH, rad(40));
  // From there the Earth is exactly as wide as the view.
  assert.ok(Math.abs(deg(Math.asin(EARTH / (EARTH + height))) - 20) < 1e-9);
  assert.ok(height > 12_000_000 && height < 12_500_000, String(height));
  // A wider view fits the Earth from closer in.
  assert.ok(fitHeight(EARTH, rad(60)) < height);
});

test('near the ground any tilt is allowed', () => {
  const fit = fitHeight(EARTH, rad(40));
  for (const height of [0, 300, 20_000, 100_000])
    assert.equal(maxOffNadir(height, fit), Math.PI / 2);
});

test('the allowed tilt shrinks steadily on the way out and is zero once the Earth fits', () => {
  const fit = fitHeight(EARTH, rad(40));
  const heights = [100_001, 300_000, 1e6, 3e6, 6e6, 1e7, fit];
  const limits = heights.map((height) => deg(maxOffNadir(height, fit)));
  for (let i = 1; i < limits.length; i += 1)
    assert.ok(limits[i] < limits[i - 1], limits.join(', '));
  assert.ok(limits[0] > 89.9);
  assert.equal(maxOffNadir(fit, fit), 0);
  assert.equal(maxOffNadir(fit * 1000, fit), 0);
  // A view tilted 60 degrees, the usual street view, is left alone until
  // about 600 km up.
  assert.ok(deg(maxOffNadir(500_000, fit)) > 60);
  assert.ok(deg(maxOffNadir(800_000, fit)) < 60);
});

test('from 600 km up the middle of the screen stays on the Earth', () => {
  const fit = fitHeight(EARTH, rad(40));
  // Looking further from straight down than the Earth's edge means looking
  // at space. Lower than this, looking at the horizon is still allowed.
  for (let height = 600_000; height < fit; height *= 1.3) {
    const edge = Math.asin(EARTH / (EARTH + height));
    assert.ok(maxOffNadir(height, fit) < edge, String(height));
  }
});

test('straight overhead looks straight down, and the horizon view the least', () => {
  assert.ok(offNadirFor(Math.PI / 2, 5e6, EARTH) < 1e-9);
  assert.ok(
    offNadirFor(rad(30), 5e6, EARTH) > offNadirFor(rad(60), 5e6, EARTH),
  );
  // Close to the ground the two angles add up to a quarter turn.
  assert.ok(Math.abs(deg(offNadirFor(rad(30), 1000, EARTH)) - 60) < 0.01);
});

test('the camera is raised just enough to come within the limit', () => {
  for (const [limitDeg, range] of [
    [30, 2e6],
    [10, 8e6],
    [45, 5e5],
  ]) {
    const elevation = elevationForOffNadir(rad(limitDeg), range, EARTH);
    assert.ok(
      Math.abs(deg(offNadirFor(elevation, range, EARTH)) - limitDeg) < 1e-6,
    );
  }
  // No limit to meet: stay where you are. A limit of zero: go overhead.
  assert.equal(elevationForOffNadir(Math.PI / 2, 2e6, EARTH), 0);
  assert.ok(
    Math.abs(deg(elevationForOffNadir(0, 2e6, EARTH)) - 90) < 1e-6,
  );
});

test('zooming in gives back the tilt that was taken away, never more than the height allows', () => {
  const deg = (d) => (d * Math.PI) / 180;
  // Nothing remembered: nothing to give back.
  assert.equal(tiltToRestore(null, deg(90), deg(0)), null);
  // Still far out: only as much as that height allows.
  assert.equal(tiltToRestore(deg(55), deg(20), deg(5)), deg(20));
  // Close in again: all of it, and no more.
  assert.equal(tiltToRestore(deg(55), deg(90), deg(30)), deg(55));
  // Already there.
  assert.equal(tiltToRestore(deg(55), deg(90), deg(55)), null);
  // A view that was straight down has nothing to restore.
  assert.equal(tiltToRestore(0, deg(90), 0), null);
});
