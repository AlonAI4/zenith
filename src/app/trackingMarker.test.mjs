import assert from 'node:assert/strict';
import test from 'node:test';

import { flyRange, markerShows, shortName } from './trackingMarker.js';

test('no marker when nothing is tracked, however far out the view is', () => {
  assert.equal(markerShows({ tracking: false, range: 9e9, home: 5000 }), false);
});

test('no marker at the normal following distance, or a little further', () => {
  assert.equal(markerShows({ tracking: true, range: 5000, home: 5000 }), false);
  assert.equal(markerShows({ tracking: true, range: 40_000, home: 5000 }), false);
});

test('the marker shows from far out, including 5,000 km up', () => {
  assert.equal(markerShows({ tracking: true, range: 60_000, home: 5000 }), true);
  assert.equal(
    markerShows({ tracking: true, range: 5_000_000, home: 5000 }),
    true,
  );
});

test('something normally followed from far away needs to be further still', () => {
  // A satellite followed from 2,000 km is still easy to see at 5,000 km.
  const home = 2_000_000;
  assert.equal(markerShows({ tracking: true, range: 5_000_000, home }), false);
  assert.equal(markerShows({ tracking: true, range: 9_000_000, home }), true);
});

test('a missing follow distance or a broken range does not break the rule', () => {
  assert.equal(markerShows({ tracking: true, range: 60_000, home: NaN }), true);
  assert.equal(markerShows({ tracking: true, range: NaN, home: 5000 }), false);
});

test('the name is the first part of the tracked label', () => {
  assert.equal(shortName('BAW123 · 31000 ft · 450 kts'), 'BAW123');
  assert.equal(shortName('ISS (ZARYA)'), 'ISS (ZARYA)');
  assert.equal(shortName(''), 'Tracked');
  assert.equal(shortName(undefined), 'Tracked');
});

test('flying back starts where the camera is and ends at the follow distance', () => {
  assert.equal(flyRange(5_000_000, 5000, 0), 5_000_000);
  assert.ok(Math.abs(flyRange(5_000_000, 5000, 1) - 5000) < 1e-6);
  // Half-way in time is half-way in zoom steps, not in kilometres.
  const half = flyRange(5_000_000, 5000, 0.5);
  assert.ok(Math.abs(half - Math.sqrt(5_000_000 * 5000)) < 1e-6, String(half));
  assert.equal(flyRange(5_000_000, 5000, 7), flyRange(5_000_000, 5000, 1));
});
