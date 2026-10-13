import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';

import {
  afterFailures,
  applySession,
  install3dMapWatchdog,
  retryDelayMs,
  sessionIn,
} from './map3dWatchdog.js';

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

/** Lets promise chains inside the watchdog run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

function harness({ globeShown = false, renewAnswers = [true] } = {}) {
  const tileset = { show: true, tileFailed: event(), tileLoad: event() };
  const switches = [];
  const notices = [];
  const timers = [];
  let renews = 0;
  let clock = 1_000_000;
  let hidden = false;
  let generation = 0;
  let active = 'photoreal';
  const controller = {
    isStackAvailable: () => true,
    getActiveId: () => active,
    getSwitchGeneration: () => generation,
    setStack: async (id, options) => {
      switches.push([id, options]);
      active = id;
      generation += 1;
    },
  };
  const stop = install3dMapWatchdog(
    {
      viewer: { scene: { globe: { show: globeShown } } },
      tileset,
      mapStackController: controller,
    },
    {
      notify: (text) => notices.push(text),
      renew: async () => {
        const answer = renewAnswers[Math.min(renews, renewAnswers.length - 1)];
        renews += 1;
        return answer;
      },
      schedule: (fn, ms) => timers.push({ fn, ms }),
      now: () => clock,
      isHidden: () => hidden,
      settleMs: 0,
    },
  );
  return {
    tileset,
    switches,
    notices,
    timers,
    controller,
    stop,
    renews: () => renews,
    pass: (ms) => (clock += ms),
    hide: (value) => (hidden = value),
    pickByHand: (id) => {
      active = id;
      generation += 1;
    },
    fail: (times) => {
      for (let i = 0; i < times; i += 1) tileset.tileFailed.raise();
    },
    /** Run the next waiting timer and let what it starts finish. */
    async tick() {
      const next = timers.shift();
      next?.fn();
      await settle();
      return next?.ms;
    },
  };
}

test('a fresh session is tried first; failing again straight after means fall back', () => {
  assert.equal(afterFailures(Infinity), 'renew');
  assert.equal(afterFailures(4 * 3_600_000), 'renew');
  assert.equal(afterFailures(5_000), 'fallback');
});

test('3D is tried again after 5 seconds, then less and less often, never rarer than 5 minutes', () => {
  assert.deepEqual(
    [0, 1, 2, 3, 6, 20].map(retryDelayMs),
    [5_000, 10_000, 20_000, 40_000, 300_000, 300_000],
  );
});

test('the session is read out of the map’s starting file', () => {
  const root = {
    root: { children: [{ content: { uri: '/v1/3dtiles/a.json?session=AbC-12_x' } }] },
  };
  assert.equal(sessionIn(root), 'AbC-12_x');
  assert.equal(sessionIn({ root: { content: { uri: '/a.json?key=1&session=Z9&x=2' } } }), 'Z9');
  assert.equal(sessionIn({ root: {} }), null);
  assert.equal(sessionIn(null), null);
});

test('a new session reaches every tile, and failed tiles may be asked for again', () => {
  const { FAILED, UNLOADED, READY } = Cesium.Cesium3DTileContentState;
  const tile = (session, state, children = []) => ({
    _contentState: state,
    _contentResource: {
      queryParameters: session ? { session, key: 'k' } : { key: 'k' },
      setQueryParameters(values) {
        Object.assign(this.queryParameters, values);
      },
    },
    children,
  });
  const leaf = tile('old', FAILED);
  const ready = tile('old', READY);
  const root = tile(null, READY, [tile('old', READY, [leaf, ready])]);
  assert.equal(applySession({ root }, 'new'), 3);
  assert.equal(leaf._contentResource.queryParameters.session, 'new');
  assert.equal(leaf._contentResource.queryParameters.key, 'k');
  assert.equal(leaf._contentState, UNLOADED);
  assert.equal(ready._contentState, READY);
  // The starting file itself never carried a session and still does not.
  assert.equal(root._contentResource.queryParameters.session, undefined);
});

test('a session that ran out is renewed quietly: no satellite map, no notice', async () => {
  const h = harness();
  h.fail(11);
  assert.equal(h.renews(), 0);
  h.fail(1);
  await settle();
  assert.equal(h.renews(), 1);
  await h.tick(); // the short wait for requests already on their way
  assert.deepEqual(h.switches, []);
  assert.deepEqual(h.notices, []);
  // Failures while the new session was being fetched did not count.
  h.fail(11);
  await settle();
  assert.deepEqual(h.switches, []);
});

test('with no way to get a session it falls back, keeps trying, and brings 3D back by itself', async () => {
  const h = harness({ renewAnswers: [false, false, true] });
  h.fail(12);
  await settle();
  assert.deepEqual(h.switches, [['esri-imagery', { silent: true }]]);
  assert.match(h.notices[0], /satellite map/);
  assert.match(h.notices[0], /trying to get 3D back/);
  assert.doesNotMatch(h.notices[0], /reload/i);

  assert.equal(await h.tick(), 5_000); // first try: still no session
  assert.equal(h.switches.length, 1);
  assert.equal(await h.tick(), 10_000); // second try works
  assert.deepEqual(h.switches[1], ['photoreal', { silent: true }]);
  assert.equal(h.notices[1], '3D map is back.');
  assert.equal(h.timers.length, 0);
});

test('if tiles fail again right after a new session, the session was not the problem', async () => {
  const h = harness();
  h.fail(12);
  await settle();
  await h.tick();
  h.pass(20_000);
  h.fail(12);
  await settle();
  assert.deepEqual(h.switches, [['esri-imagery', { silent: true }]]);
});

test('a tile that loads resets the count, so scattered failures do nothing', async () => {
  const h = harness();
  h.fail(11);
  h.tileset.tileLoad.raise();
  h.fail(11);
  await settle();
  assert.equal(h.renews(), 0);
  assert.equal(h.switches.length, 0);
});

test('failures are ignored while another map is the one on screen', async () => {
  const h = harness({ globeShown: true });
  h.fail(40);
  await settle();
  assert.equal(h.renews(), 0);
  assert.equal(h.switches.length, 0);
});

test('choosing a map by hand during the rescue ends it', async () => {
  const h = harness({ renewAnswers: [false, true] });
  h.fail(12);
  await settle();
  h.pickByHand('esri-imagery');
  await h.tick();
  assert.equal(h.switches.length, 1);
  assert.equal(h.timers.length, 0);
});

test('nothing is tried while the page is not on screen', async () => {
  const h = harness({ renewAnswers: [false, true] });
  h.fail(12);
  await settle();
  h.hide(true);
  await h.tick();
  assert.equal(h.renews(), 1);
  assert.equal(h.timers.length, 1);
  h.hide(false);
  await h.tick();
  assert.deepEqual(h.switches[1], ['photoreal', { silent: true }]);
});
