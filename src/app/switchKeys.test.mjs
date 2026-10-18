import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SWITCH_KEYS,
  TAKEN_KEYS,
  switchForKey,
  withKey,
} from './switchKeys.js';
import { ZENITH_SWITCHES } from './zenithSwitches.js';

const press = (key, extra = {}) => ({
  key,
  target: { closest: () => null },
  ...extra,
});

test('every switch has one key of its own, and none is a key already in use', () => {
  const keys = Object.values(SWITCH_KEYS);
  assert.deepEqual(
    Object.keys(SWITCH_KEYS).sort(),
    ZENITH_SWITCHES.map((entry) => entry.id).sort(),
  );
  assert.equal(new Set(keys).size, keys.length, 'two switches share a key');
  for (const key of keys) assert.ok(!TAKEN_KEYS.includes(key), key);
});

test('a key finds its switch, in either case', () => {
  assert.equal(switchForKey(press('p')), 'address-lookup-toggle');
  assert.equal(
    switchForKey(press('P', { shiftKey: true })),
    'address-lookup-toggle',
  );
  assert.equal(
    switchForKey(press('?', { shiftKey: true })),
    'zenith-help-toggle',
  );
  assert.equal(switchForKey(press('j')), 'watch-zones-toggle');
  assert.equal(switchForKey(press('i')), null);
  assert.equal(switchForKey(press('1')), null);
});

test('keys do nothing while typing, with Cmd, Ctrl or Option held, held down, or in cockpit mode', () => {
  const typing = {
    closest: (selector) => (/input/.test(selector) ? {} : null),
  };
  assert.equal(switchForKey(press('p', { target: typing })), null);
  assert.equal(switchForKey(press('p', { metaKey: true })), null);
  assert.equal(switchForKey(press('p', { ctrlKey: true })), null);
  assert.equal(switchForKey(press('p', { altKey: true })), null);
  assert.equal(switchForKey(press('p', { repeat: true })), null);
  assert.equal(switchForKey(press('p'), { cockpit: true }), null);
  assert.equal(switchForKey(null), null);
});

test('keys something else took, dialogs, full screen, keys switched off and other layouts', () => {
  assert.equal(switchForKey(press('a', { defaultPrevented: true })), null);
  assert.equal(switchForKey(press('p'), { blocked: true }), null);
  assert.equal(switchForKey(press('p'), { off: true }), null);
  // AltGr: Ctrl and Alt together, on layouts where that types '?'.
  const altGr = press('?', {
    ctrlKey: true,
    altKey: true,
    getModifierState: (name) => name === 'AltGraph',
  });
  assert.equal(switchForKey(altGr), 'zenith-help-toggle');
  // A Hebrew layout: the letter is Hebrew, the key's place is P.
  assert.equal(
    switchForKey(press('פ', { code: 'KeyP' })),
    'address-lookup-toggle',
  );
});

test('a city landmark key is not a switch key', () => {
  for (const key of ['q', 'w', 'e', 'r', 't'])
    assert.equal(switchForKey(press(key)), null, key);
});

test('a tooltip names its key once', () => {
  assert.equal(withKey('Map pin', 'p'), 'Map pin (P)');
  assert.equal(withKey('Map pin (P)', 'p'), 'Map pin (P)');
  assert.equal(withKey('', '?'), ' (?)');
});
