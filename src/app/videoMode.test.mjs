import assert from 'node:assert/strict';
import test from 'node:test';

import { fakeDocument } from './fakeDom.mjs';
import {
  installVideoMode,
  keyEndsVideo,
  orbitStep,
  readChoice,
  TURN_SECONDS,
} from './videoMode.js';

test('the view turns at a steady rate: one full turn in the set time', () => {
  const perFrame = orbitStep(1000 / 60);
  const turn = perFrame * 60 * TURN_SECONDS.normal;
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

test('slow takes twice as long as normal and fast half as long', () => {
  const normal = orbitStep(16);
  assert.ok(Math.abs(orbitStep(16, { speed: 'slow' }) - normal / 2) < 1e-12);
  assert.ok(Math.abs(orbitStep(16, { speed: 'fast' }) - normal * 2) < 1e-12);
  assert.equal(orbitStep(16, { speed: 'warp' }), normal);
});

test('anticlockwise turns the other way at the same rate', () => {
  assert.equal(orbitStep(16, { clockwise: false }), -orbitStep(16));
  assert.equal(orbitStep(16, { speed: 'fast', clockwise: false }), -orbitStep(16, { speed: 'fast' }));
});

test('the saved choice is read back, and anything odd falls back to the usual one', () => {
  const usual = { speed: 'normal', clockwise: true };
  assert.deepEqual(readChoice(null), usual);
  assert.deepEqual(readChoice('not json'), usual);
  assert.deepEqual(readChoice('{"speed":"warp","clockwise":"yes"}'), usual);
  assert.deepEqual(readChoice('{"speed":"fast","clockwise":false}'), { speed: 'fast', clockwise: false });
  assert.deepEqual(readChoice('{"speed":"slow"}'), { speed: 'slow', clockwise: true });
  assert.deepEqual(readChoice('{"speed":"constructor"}'), usual);
});

test('opening video mode with its button puts the focus on the chosen speed', () => {
  const doc = fakeDocument();
  const bar = doc.createElement('div');
  bar.id = 'top-center-actions';
  doc.body.appendChild(bar);
  const storage = { getItem: () => null, setItem: () => {} };
  installVideoMode({ isDestroyed: () => false }, { doc, win: doc.defaultView, storage });
  doc.getElementById('video-mode-toggle').click();
  const focused = doc.activeElement;
  assert.ok(focused.dataset?.speed === 'normal' && focused.getAttribute('aria-pressed') === 'true', 'the chosen speed has the focus');
});
