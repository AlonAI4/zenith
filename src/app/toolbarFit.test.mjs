import assert from 'node:assert/strict';
import test from 'node:test';

import { DIAL, fitsInline, GAP, MIN_DIAL_SCALE, placeDial } from './toolbarFit.js';
import { ZENITH_SWITCHES } from './zenithSwitches.js';

// Numbers measured in the running app: the title text ends near 238 px, the
// style label is 108 px wide and sits 36 px from the right edge.
const TITLE_RIGHT = 238;
const centred = (viewportWidth, barWidth) => ({
  left: viewportWidth / 2 - barWidth / 2,
  right: viewportWidth / 2 + barWidth / 2,
  top: 32,
  bottom: 68,
});

test('the full row fits a wide window and not a narrow one', () => {
  const tenButtons = 432;
  assert.equal(
    fitsInline({ bar: centred(1440, tenButtons), titleRight: TITLE_RIGHT, limitRight: 1296 }),
    true,
  );
  // 900 px: the bar starts at 234, inside the title.
  assert.equal(
    fitsInline({ bar: centred(900, tenButtons), titleRight: TITLE_RIGHT, limitRight: 756 }),
    false,
  );
  // Clear of the title, but the dial would reach the style label.
  assert.equal(
    fitsInline({ bar: centred(1000, tenButtons), titleRight: TITLE_RIGHT, limitRight: 856 }),
    false,
  );
});

test('the dial sits right of the bar at full size when there is room', () => {
  const bar = centred(1024, 256);
  const spot = placeDial({ viewportWidth: 1024, bar, titleRight: TITLE_RIGHT, limitRight: 880 });
  assert.deepEqual(spot, { left: bar.right + GAP, top: 18, scale: 1 });
  assert.ok(spot.left + DIAL.width <= 880 - GAP);
});

test('the dial shrinks to fit a tight gap, but never below its smallest size', () => {
  const bar = centred(760, 256);
  const spot = placeDial({ viewportWidth: 760, bar, titleRight: TITLE_RIGHT, limitRight: 616 });
  assert.equal(spot.left, bar.right + GAP);
  assert.ok(spot.scale < 1 && spot.scale >= MIN_DIAL_SCALE, String(spot.scale));
  assert.ok(spot.left + DIAL.width * spot.scale <= 616 - GAP + 1e-9);
});

test('with the bar at the right edge the dial goes left of it', () => {
  // The app's own narrow layout: bar right-aligned, no style label.
  const bar = { left: 428, right: 684, top: 12, bottom: 48 };
  const spot = placeDial({ viewportWidth: 700, bar, titleRight: 200, limitRight: 700 });
  assert.equal(spot.scale, 1);
  assert.equal(spot.left, 428 - GAP - DIAL.width);
  assert.ok(spot.left >= 200 + GAP);
  assert.equal(spot.top, 4);
});

test('with no room on the row the dial drops below it, inside the window', () => {
  const bar = { left: 103, right: 359, top: 12, bottom: 48 };
  const spot = placeDial({ viewportWidth: 375, bar, titleRight: 52, limitRight: 375 });
  assert.ok(spot.top > bar.bottom);
  assert.ok(spot.left > 0 && spot.left + DIAL.width * spot.scale <= 375 - GAP + 1e-9);
});

test('every switch in the list has an id, a name and an explanation', () => {
  const ids = new Set();
  for (const entry of ZENITH_SWITCHES) {
    assert.match(entry.id, /^[a-z0-9-]+$/);
    assert.ok(entry.name.length > 2 && entry.what.length > 10, entry.id);
    assert.ok(!ids.has(entry.id), `listed twice: ${entry.id}`);
    ids.add(entry.id);
  }
});
