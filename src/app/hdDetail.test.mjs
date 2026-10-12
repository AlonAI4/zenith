import assert from 'node:assert/strict';
import test from 'node:test';

import { hdResolutionScale } from './hdDetail.js';

test('a normal or retina screen draws at its full resolution', () => {
  assert.equal(hdResolutionScale(1), 1);
  assert.equal(hdResolutionScale(2), 1);
});

test('a denser screen is capped at two device pixels', () => {
  assert.equal(hdResolutionScale(3), 2 / 3);
});

test('a missing or broken ratio falls back to one', () => {
  assert.equal(hdResolutionScale(undefined), 1);
  assert.equal(hdResolutionScale(0), 1);
});
