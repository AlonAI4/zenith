import assert from 'node:assert/strict';
import test from 'node:test';

import { initShortcutGuard, isModifiedShortcut } from './shortcutGuard.js';

test('a plain key press is always let through', () => {
  for (const key of ['c', 'v', 'f', 'h', 'o', 'd', '1', '3', '7', 'q', 'e'])
    assert.equal(isModifiedShortcut({ key }), false, key);
});

test('copy, paste, find and Cmd+number are not shortcuts for the app', () => {
  assert.equal(isModifiedShortcut({ key: 'c', metaKey: true }), true);
  assert.equal(isModifiedShortcut({ key: 'c', ctrlKey: true }), true);
  assert.equal(isModifiedShortcut({ key: 'v', metaKey: true }), true);
  assert.equal(isModifiedShortcut({ key: 'f', metaKey: true }), true);
  assert.equal(isModifiedShortcut({ key: '3', metaKey: true }), true);
  assert.equal(isModifiedShortcut({ key: 'd', altKey: true }), true);
  // Caps Lock or Shift held as well makes the letter a capital.
  assert.equal(isModifiedShortcut({ key: 'C', metaKey: true }), true);
});

test('Shift on its own still reaches the app, as before', () => {
  assert.equal(isModifiedShortcut({ key: 'C', shiftKey: true }), false);
});

test('keys the app has no shortcut for are left alone even with Cmd held', () => {
  for (const key of ['a', 'z', 'k', 'q', 'e', 'Escape', 'ArrowDown', '8', '0'])
    assert.equal(isModifiedShortcut({ key, metaKey: true }), false, key);
  assert.equal(isModifiedShortcut({ metaKey: true }), false);
});

test('in the page: only a modified shortcut key is kept from the app', () => {
  const listeners = [];
  const view = {
    addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture }),
    removeEventListener: (type, fn) =>
      listeners.splice(
        listeners.findIndex((l) => l.fn === fn),
        1,
      ),
  };
  const stop = initShortcutGuard({ defaultView: view });
  assert.equal(listeners.length, 1);
  // First in line: on the window, in the capture phase.
  assert.deepEqual([listeners[0].type, listeners[0].capture], ['keydown', true]);

  const press = (event) => {
    let stopped = false;
    listeners[0].fn({ ...event, stopPropagation: () => (stopped = true) });
    return stopped;
  };
  assert.equal(press({ key: 'c', metaKey: true }), true);
  assert.equal(press({ key: 'c' }), false);
  assert.equal(press({ key: 'a', metaKey: true }), false);

  stop();
  assert.equal(listeners.length, 0);
});

test('every one-key shortcut in the original app is guarded, even after its updates', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('applicationShortcuts.js', import.meta.url), 'utf8');
  const styles = /const STYLE_KEYS = Object\.freeze\(\{([\s\S]*?)\}\)/.exec(source)?.[1] ?? '';
  const keys = new Set([
    ...[...styles.matchAll(/['"]?(\w)['"]?\s*:/g)].map((match) => match[1]),
    ...[...source.matchAll(/\bkey === '(\w)'/g)].map((match) => match[1]),
  ]);
  assert.ok(keys.size >= 13, `only ${keys.size} shortcut keys were found: the test has lost track of the file`);
  for (const key of keys) {
    assert.ok(isModifiedShortcut({ key, metaKey: true }), `the original app's shortcut "${key}" is not in the guard's list (src/ui/shortcutGuard.js)`);
  }
});
