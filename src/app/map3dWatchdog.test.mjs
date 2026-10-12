import assert from 'node:assert/strict';
import test from 'node:test';

import { install3dMapWatchdog } from './map3dWatchdog.js';

function event() {
  const listeners = new Set();
  return {
    addEventListener(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    raise: () => listeners.forEach((fn) => fn()),
  };
}

function harness({ globeShown = false } = {}) {
  const tileset = { show: true, tileFailed: event(), tileLoad: event() };
  const switches = [];
  const notices = [];
  const stop = install3dMapWatchdog(
    {
      viewer: { scene: { globe: { show: globeShown } } },
      tileset,
      mapStackController: {
        isStackAvailable: () => true,
        setStack: (id, options) => switches.push([id, options]),
      },
    },
    { notify: (text) => notices.push(text) },
  );
  const fail = (times) => {
    for (let i = 0; i < times; i += 1) tileset.tileFailed.raise();
  };
  return { tileset, switches, notices, fail, stop };
}

test('an unbroken run of 3D tile failures switches to the satellite map once and says so', () => {
  const h = harness();
  h.fail(11);
  assert.equal(h.switches.length, 0);
  h.fail(1);
  assert.deepEqual(h.switches, [['esri-imagery', { silent: true }]]);
  assert.equal(h.notices.length, 1);
});

test('a tile that loads resets the count, so scattered failures never switch', () => {
  const h = harness();
  h.fail(11);
  h.tileset.tileLoad.raise();
  h.fail(11);
  assert.equal(h.switches.length, 0);
});

test('failures are ignored while another map is the one on screen', () => {
  const h = harness({ globeShown: true });
  h.fail(40);
  assert.equal(h.switches.length, 0);
});
