import assert from 'node:assert/strict';
import test from 'node:test';

import { keyEndsVideo, orbitStep, TURN_SECONDS } from './videoMode.js';

test('the view turns at a steady rate: one full turn in the set time', () => {
  const perFrame = orbitStep(1000 / 60);
  const turn = perFrame * 60 * TURN_SECONDS;
  assert.ok(Math.abs(turn - 2 * Math.PI) < 1e-9, String(turn));
  assert.ok(Math.abs(orbitStep(20) - 2 * orbitStep(10)) < 1e-12);
});

test('a stall never makes the view jump', () => {
  assert.equal(orbitStep(5000), orbitStep(100));
  assert.equal(orbitStep(0), 0);
  assert.equal(orbitStep(-16), 0);
  assert.equal(orbitStep(Number.NaN), 0);
});

test('any ordinary key ends video mode', () => {
  for (const key of ['a', 'v', ' ', 'Escape', 'Enter', 'ArrowLeft', '5']) {
    assert.equal(keyEndsVideo({ key }), true, key);
  }
  assert.equal(keyEndsVideo({ key: 'A', shiftKey: true }), true);
});

test('starting a screen recording does not end it', () => {
  // Cmd+Shift+5 arrives as Meta, then Shift, then 5 with Cmd held.
  assert.equal(keyEndsVideo({ key: 'Meta', metaKey: true }), false);
  assert.equal(keyEndsVideo({ key: 'Shift', metaKey: true, shiftKey: true }), false);
  assert.equal(keyEndsVideo({ key: '5', metaKey: true, shiftKey: true }), false);
  assert.equal(keyEndsVideo({ key: 'Control', ctrlKey: true }), false);
  assert.equal(keyEndsVideo({ key: 'Alt', altKey: true }), false);
});
