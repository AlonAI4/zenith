import assert from 'node:assert/strict';
import test from 'node:test';

import { cutCardTitle } from './worldOverlay.js';

test('cutCardTitle ends a cut name with an ellipsis and keeps it to the limit', () => {
  const cut = cutCardTitle('A5 Kilburn High Rd/Willesden Ln', 15);
  assert.equal(cut, 'A5 KILBURN HIG…');
  assert.equal(cut.length, 15);
});

test('cutCardTitle leaves a name that fits alone, in capitals', () => {
  assert.equal(cutCardTitle('Kilburn High Rd', 15), 'KILBURN HIGH RD');
  assert.equal(cutCardTitle('Main & Fifth', 0), 'MAIN & FIFTH');
  assert.equal(cutCardTitle(null, 15), '');
});
