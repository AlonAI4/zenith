import assert from 'node:assert/strict';
import test from 'node:test';

import { LAYER_IDS, nextRow } from './toolbarLayout.js';
import { ZENITH_SWITCHES } from './zenithSwitches.js';

test('the LAYERS menu holds the six map overlays, in order', () => {
  assert.deepEqual(LAYER_IDS, [
    'map-labels-toggle',
    'train-stations-toggle',
    'earthquakes-toggle',
    'time-zones-toggle',
    'day-night-toggle',
    'hd-detail-toggle',
  ]);
});

test('the LAYERS button is a switch of its own, so the narrow window can fold it into the tray', () => {
  const entry = ZENITH_SWITCHES.find(
    (item) => item.id === 'zenith-layers-toggle',
  );
  assert.ok(entry && entry.panel && !entry.group);
  const inBar = ZENITH_SWITCHES.filter((item) => !item.group).map(
    (item) => item.id,
  );
  assert.equal(inBar.length, ZENITH_SWITCHES.length - LAYER_IDS.length);
});

test('arrow keys move between the rows and wrap round; other keys do nothing', () => {
  assert.equal(nextRow(0, 6, 'ArrowDown'), 1);
  assert.equal(nextRow(5, 6, 'ArrowDown'), 0);
  assert.equal(nextRow(0, 6, 'ArrowUp'), 5);
  assert.equal(nextRow(3, 6, 'Home'), 0);
  assert.equal(nextRow(3, 6, 'End'), 5);
  assert.equal(nextRow(2, 6, 'Enter'), null);
  assert.equal(nextRow(0, 0, 'ArrowDown'), null);
});
