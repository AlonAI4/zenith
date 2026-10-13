import assert from 'node:assert/strict';
import test from 'node:test';

import { closeOnEscape } from './escapeKey.js';

function fakeWindow() {
  const listeners = [];
  return {
    listeners,
    addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture }),
    removeEventListener: (type, fn, capture) => {
      const at = listeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === capture);
      if (at >= 0) listeners.splice(at, 1);
    },
    press(key) {
      const event = { key, stopped: false, stopImmediatePropagation: () => (event.stopped = true) };
      for (const listener of [...listeners]) listener.fn(event);
      return event;
    },
  };
}

test('Escape closes an open panel and goes no further', () => {
  const win = fakeWindow();
  let open = true;
  closeOnEscape(win, () => open, () => (open = false));
  assert.equal(win.listeners[0].capture, true, 'it must hear the key before the rest of the page');
  const first = win.press('Escape');
  assert.equal(open, false);
  assert.equal(first.stopped, true);
});

test('with nothing to close, Escape and every other key are passed on untouched', () => {
  const win = fakeWindow();
  let open = false;
  let closes = 0;
  closeOnEscape(win, () => open, () => (closes += 1));
  assert.equal(win.press('Escape').stopped, false);
  open = true;
  assert.equal(win.press('a').stopped, false);
  assert.equal(win.press('Enter').stopped, false);
  assert.equal(closes, 0);
  assert.equal(open, true);
});

test('it stops listening when asked', () => {
  const win = fakeWindow();
  const stop = closeOnEscape(win, () => true, () => {});
  stop();
  assert.equal(win.listeners.length, 0);
});
