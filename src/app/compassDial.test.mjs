import assert from 'node:assert/strict';
import test from 'node:test';

import {
  angleStep,
  fractionForTilt,
  headingLabel,
  pointerAngle,
  tiltForFraction,
} from './compassDial.js';

test('the pointer angle is measured clockwise from straight up', () => {
  assert.equal(pointerAngle(100, 100, 100, 50), 0);
  assert.equal(pointerAngle(100, 100, 150, 100), 90);
  assert.equal(pointerAngle(100, 100, 100, 150), 180);
  assert.equal(pointerAngle(100, 100, 50, 100), 270);
});

test('a step takes the short way round, across the top of the dial too', () => {
  assert.equal(angleStep(10, 30), 20);
  assert.equal(angleStep(30, 10), -20);
  assert.equal(angleStep(350, 10), 20);
  assert.equal(angleStep(10, 350), -20);
});

test('a quarter turn dragged in small moves adds up to 90 degrees', () => {
  let turned = 0;
  let last = pointerAngle(0, 0, 0, -40);
  for (let degrees = 5; degrees <= 90; degrees += 5) {
    const radians = (degrees * Math.PI) / 180;
    const angle = pointerAngle(
      0,
      0,
      40 * Math.sin(radians),
      -40 * Math.cos(radians),
    );
    turned += angleStep(last, angle);
    last = angle;
  }
  assert.ok(Math.abs(turned - 90) < 1e-9, String(turned));
});

test('the heading reads as three digits and never as 360', () => {
  assert.equal(headingLabel(15), '015°');
  assert.equal(headingLabel(0), '000°');
  assert.equal(headingLabel(359.6), '000°');
  assert.equal(headingLabel(-90), '270°');
  assert.equal(headingLabel(271.4), '271°');
});

test('the tilt arc runs from straight down to nearly level and stops there', () => {
  assert.equal(tiltForFraction(0), -89);
  assert.equal(tiltForFraction(1), -12);
  assert.equal(tiltForFraction(-3), -89);
  assert.equal(tiltForFraction(7), -12);
  assert.equal(tiltForFraction(0.5), -50.5);
  assert.equal(fractionForTilt(-50.5), 0.5);
  assert.equal(fractionForTilt(-90), 0);
  assert.equal(fractionForTilt(0), 1);
});
