import assert from 'node:assert/strict';
import test from 'node:test';

import { keyRotation, wheelRotation } from './rotateGestures.js';

test('only an Option wheel rotates, and a pinch (ctrl) never does', () => {
  assert.equal(wheelRotation({ deltaX: 40, deltaY: 0 }), 0);
  assert.equal(wheelRotation({ altKey: true, ctrlKey: true, deltaX: 40 }), 0);
  assert.ok(wheelRotation({ altKey: true, deltaX: 40, deltaY: 3 }) > 0);
  assert.ok(wheelRotation({ altKey: true, deltaX: -40, deltaY: 3 }) < 0);
});

test('a mouse wheel, which has no sideways delta, still rotates', () => {
  assert.ok(wheelRotation({ altKey: true, deltaX: 0, deltaY: 100 }) > 0);
});

test('E turns right, Q turns left, and shortcuts with modifiers are left alone', () => {
  assert.ok(keyRotation({ key: 'e' }) > 0);
  assert.ok(keyRotation({ key: 'Q' }) < 0);
  assert.equal(keyRotation({ key: 'e', metaKey: true }), 0);
  assert.equal(keyRotation({ key: 'w' }), 0);
});
