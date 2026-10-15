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

function harness({
  globeShown = false,
  renewAnswers = [true],
  startOn = 'photoreal',
  stored = {},
  storage: storageOverride,
  renew: renewOverride,
  available = () => true,
  failSwitchTo = [],
} = {}) {
  const tileset = { show: true, tileFailed: event(), tileLoad: event() };
  const switches = [];
  const notices = [];
  const timers = [];
  let renews = 0;
  let clock = 1_000_000;
  let hidden = false;
  let generation = 0;
  let active = startOn;
  let origin = 'manual';
  let pressMapMenu = () => {};
  const subscribers = new Set();
  const storage = storageOverride ?? {
    getItem: (key) => stored[key] ?? null,
    setItem: (key, value) => (stored[key] = String(value)),
    removeItem: (key) => delete stored[key],
  };
  const controller = {
    isStackAvailable: available,
    getActiveId: () => active,
    getSwitchGeneration: () => generation,
    getSwitchOrigin: () => origin,
    subscribe(listener) {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    setStack: async (id, options) => {
      switches.push([id, options]);
      if (failSwitchTo.includes(id)) throw new Error('the map would not switch');
      active = id;
      generation += 1;
      origin = 'manual';
      subscribers.forEach((listener) => listener());
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
      renew: renewOverride ?? (async () => {
        const answer = renewAnswers[Math.min(renews, renewAnswers.length - 1)];
        renews += 1;
        return answer;
      }),
      schedule: (fn, ms) => timers.push({ fn, ms }),
      now: () => clock,
      isHidden: () => hidden,
      settleMs: 0,
      storage,
      onMapMenuPress: (mark) => {
        pressMapMenu = mark;
        return () => {};
      },
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
    stored,
    /** Press a map in the app's menu, which then switches to it. */
    pickByHand: (id) => {
      pressMapMenu();
      active = id;
      generation += 1;
      origin = 'manual';
      subscribers.forEach((listener) => listener());
    },
    /** The app puts back the map its saved address names: nobody pressed anything. */
    restoreFromAddress: (id) => {
      active = id;
      generation += 1;
      origin = 'manual';
      subscribers.forEach((listener) => listener());
    },
    /** The app itself changes the map, for example for a comparison. */
    switchByApp: (id) => {
      active = id;
      generation += 1;
      origin = 'automatic';
      subscribers.forEach((listener) => listener());
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
  assert.deepEqual(h.switches[1], ['photoreal', undefined]);
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
  assert.deepEqual(h.switches[1], ['photoreal', undefined]);
});

test('satellite picked from the menu is remembered as a choice; picking 3D forgets it', () => {
  const h = harness();
  h.pickByHand('esri-imagery');
  assert.equal(h.stored['gev.satelliteByChoice'], '1');
  h.pickByHand('photoreal');
  assert.equal(h.stored['gev.satelliteByChoice'], undefined);
  // A map change the app makes for itself is not a choice.
  h.switchByApp('esri-imagery');
  assert.equal(h.stored['gev.satelliteByChoice'], undefined);
});

test('the fallback itself is never remembered as a choice', async () => {
  const h = harness({ renewAnswers: [false, true] });
  h.fail(12);
  await settle();
  assert.equal(h.switches[0][0], 'esri-imagery');
  assert.equal(h.stored['gev.satelliteByChoice'], undefined);
});

test('starting on satellite that was never chosen is a saved fallback: 3D is brought back', async () => {
  const h = harness({ startOn: 'esri-imagery' });
  assert.equal(await h.tick(), 1_500);
  assert.deepEqual(h.switches, [['photoreal', undefined]]);
  assert.deepEqual(h.notices, ['3D map is back.']);
});

test('starting on satellite that was chosen by hand is left alone', async () => {
  const h = harness({
    startOn: 'esri-imagery',
    stored: { 'gev.satelliteByChoice': '1' },
  });
  await settle();
  assert.equal(h.timers.length, 0);
  assert.deepEqual(h.switches, []);
});

test('satellite restored from the saved address, never chosen, is a saved fallback: 3D comes back', async () => {
  const h = harness();
  h.restoreFromAddress('esri-imagery');
  assert.equal(h.stored['gev.satelliteByChoice'], undefined);
  assert.equal(await h.tick(), 1_500);
  assert.deepEqual(h.switches, [['photoreal', undefined]]);
  assert.deepEqual(h.notices, ['3D map is back.']);
});

test('satellite restored from the saved address after being chosen by hand stays', async () => {
  const h = harness({ stored: { 'gev.satelliteByChoice': '1' } });
  h.restoreFromAddress('esri-imagery');
  await settle();
  assert.equal(h.timers.length, 0);
  assert.deepEqual(h.switches, []);
});

test('a press on the map menu only counts for the change that follows it', async () => {
  const h = harness();
  h.pickByHand('photoreal');
  h.pass(10_000);
  h.restoreFromAddress('esri-imagery');
  assert.equal(h.stored['gev.satelliteByChoice'], undefined);
  assert.equal(h.timers.length, 1);
});

const refusing = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('SecurityError');
  },
  removeItem: () => {
    throw new Error('SecurityError');
  },
};

test('when storage refuses, a start on satellite is left alone: the choice cannot be read', async () => {
  const h = harness({ startOn: 'esri-imagery', storage: refusing });
  await settle();
  assert.equal(h.timers.length, 0, 'no rescue is planned');
  assert.deepEqual(h.switches, []);
});

test('stopping during a rescue never switches to 3D and leaves no timer behind', async () => {
  let answer;
  const h = harness({ startOn: 'esri-imagery', renew: () => new Promise((resolve) => (answer = resolve)) });
  await settle();
  h.timers.shift().fn(); // the rescue starts asking for a session
  await settle();
  h.stop();
  answer(true);
  await settle();
  assert.deepEqual(h.switches, []);
  assert.equal(h.timers.length, 0, 'nothing is left to run after stop');
});

test('a session request that throws counts as no session', async () => {
  const h = harness({
    renew: async () => {
      throw new Error('network');
    },
  });
  h.fail(12);
  await settle();
  assert.deepEqual(h.switches, [['esri-imagery', { silent: true }]]);
});

test('with no satellite map to fall back to there is no notice, and watching goes on', async () => {
  const h = harness({ renewAnswers: [false], available: (id) => id !== 'esri-imagery' });
  h.fail(12);
  await settle();
  assert.deepEqual(h.notices, []);
  assert.deepEqual(h.switches, []);
  h.fail(12);
  await settle();
  assert.equal(h.renews(), 2, 'a later run of failures is handled again');
});

test('when switching back to 3D fails there is no "back" notice, and it waits longer', async () => {
  const h = harness({ renewAnswers: [false, true], failSwitchTo: ['photoreal'] });
  h.fail(12);
  await settle();
  assert.equal(await h.tick(), 5_000);
  assert.equal(h.notices.length, 1, 'only the fallback notice');
  assert.equal(h.timers[0]?.ms, 10_000);
});

test('a press on the map menu with storage refusing does not throw', () => {
  const h = harness({ storage: refusing, startOn: 'photoreal' });
  assert.doesNotThrow(() => h.pickByHand('esri-imagery'));
});
