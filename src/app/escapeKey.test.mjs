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

test('every Zenith panel, card and close button closes on Escape too', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const folder = new URL('.', import.meta.url);
  const opensSomething = /setAttribute\('role', 'dialog'\)|setAttribute\(\s*'aria-label',\s*'Close |variant: 'card'/;
  const missing = readdirSync(folder)
    .filter((name) => name.endsWith('.js') && name !== 'escapeKey.js')
    .filter((name) => {
      const source = readFileSync(new URL(name, folder), 'utf8');
      return opensSomething.test(source) && !/import \{[^}]*\bcloseOnEscape\b[^}]*\} from '\.\/escapeKey\.js'/.test(source);
    });
  assert.deepEqual(missing, []);
});

test('Escape gives focus back to the button that opened the panel', () => {
  const win = fakeWindow();
  win.document = { activeElement: 'a control inside the panel' };
  let focused = 0;
  const opener = { focus: () => (focused += 1) };
  const panel = { contains: (node) => node === 'a control inside the panel' };
  let open = true;
  closeOnEscape(win, () => open, () => (open = false), { panel, opener });
  win.press('Escape');
  assert.equal(open, false);
  assert.equal(focused, 1, 'focus inside the panel would be lost when it hides');
  // Focus that was somewhere else stays where it is.
  open = true;
  win.document.activeElement = 'the map';
  win.press('Escape');
  assert.equal(focused, 1);
});
