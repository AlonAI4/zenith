import assert from 'node:assert/strict';
import test from 'node:test';

import { DIAL, fitsInline, GAP, MIN_DIAL_SCALE, panelTop, placeDial } from './toolbarFit.js';
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

test('at phone width the dial never sits on a side panel', () => {
  // Measured at 480 px: the bar on the right of the logo, Data Layers 70 px down.
  const bar = { left: 200, right: 470, top: 12, bottom: 48 };
  const panels = [{ left: 16, right: 464, top: 70 }];
  const spot = placeDial({ viewportWidth: 480, bar, titleRight: 52, limitRight: 480, panels });
  const bottom = spot.top + DIAL.height * spot.scale;
  const right = spot.left + DIAL.width * spot.scale;
  const overlaps = panels.some((panel) => spot.left < panel.right && right > panel.left && spot.top < panel.top + 200 && bottom > panel.top);
  assert.ok(!overlaps || spot.top >= 190, `the dial at ${JSON.stringify(spot)} covers a panel`);
});

test('a side panel far below or to the side leaves the dial where it was', () => {
  const bar = { ...centred(1440, 690), top: 30, bottom: 70 };
  const alone = placeDial({ viewportWidth: 1440, bar, titleRight: TITLE_RIGHT, limitRight: 1296 });
  const withPanels = placeDial({
    viewportWidth: 1440,
    bar,
    titleRight: TITLE_RIGHT,
    limitRight: 1296,
    panels: [{ left: 52, right: 228, top: 235 }, { left: 1212, right: 1388, top: 235 }],
  });
  assert.deepEqual(withPanels, alone);
});

test('the centred panels start below the dial when it hangs over the middle', () => {
  // A 900 px window: the dial sits right of the bar, over the middle column.
  assert.equal(panelTop({ viewportWidth: 900, dial: { left: 595, top: 16, scale: 1 } }), Math.ceil(16 + DIAL.height + 10));
  // On a wide window it is far to the right: the panels stay at 92 px.
  assert.equal(panelTop({ viewportWidth: 1440, dial: { left: 1085, top: 16, scale: 1 } }), 92);
});
