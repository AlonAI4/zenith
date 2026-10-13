import assert from 'node:assert/strict';
import test from 'node:test';

import { installPanelGuard, mayOpen, pressKind } from './panelGuard.js';

test('a press that stays put and is short is a click; anything else is a drag', () => {
  assert.equal(pressKind({ travelPx: 0, durationMs: 80 }), 'click');
  assert.equal(pressKind({ travelPx: 3, durationMs: 120 }), 'click');
  // Panning the map, even a short way.
  assert.equal(pressKind({ travelPx: 60, durationMs: 200 }), 'drag');
  assert.equal(pressKind({ travelPx: 9, durationMs: 90 }), 'drag');
  // Holding still for a long time is not a click either.
  assert.equal(pressKind({ travelPx: 1, durationMs: 900 }), 'drag');
  // Wiggling and coming back to the start still travelled.
  assert.equal(pressKind({ travelPx: 14, durationMs: 150 }), 'drag');
});

test('choosing a preset never opens Display; Display may open any other time', () => {
  const base = { cameraChanging: false, msSinceMapClick: Infinity };
  assert.equal(
    mayOpen({ ...base, panelId: 'pp-toggles', choosingPreset: true }),
    false,
  );
  assert.equal(
    mayOpen({ ...base, panelId: 'pp-toggles', choosingPreset: false }),
    true,
  );
});

test('a new active camera opens CCTV only just after a click on the map', () => {
  const base = { panelId: 'cctv-panel', choosingPreset: false };
  assert.equal(
    mayOpen({ ...base, cameraChanging: true, msSinceMapClick: 200 }),
    true,
  );
  assert.equal(
    mayOpen({ ...base, cameraChanging: true, msSinceMapClick: 20_000 }),
    false,
  );
  // Clicking empty map and then switching the cameras layer on a second
  // later is not a click on a camera.
  assert.equal(
    mayOpen({ ...base, cameraChanging: true, msSinceMapClick: 1_200 }),
    false,
  );
  assert.equal(
    mayOpen({ ...base, cameraChanging: true, msSinceMapClick: Infinity }),
    false,
  );
  // Its own button, or anything else asking, is not a camera change.
  assert.equal(
    mayOpen({ ...base, cameraChanging: false, msSinceMapClick: Infinity }),
    true,
  );
});

test('other panels are never held shut', () => {
  assert.equal(
    mayOpen({
      panelId: 'data-panel',
      choosingPreset: true,
      cameraChanging: true,
      msSinceMapClick: Infinity,
    }),
    true,
  );
});

/** A stand-in for the app's panel manager, shaped like the real one. */
function fakeApp() {
  const calls = [];
  class CctvControls {
    constructor(actions) {
      this.actions = actions;
    }
    _renderCctvState() {
      this.actions.setPanelCollapsed('cctv-panel', false, { explicit: false });
    }
  }
  class VisualSettings {
    constructor(operations) {
      this.operations = operations;
    }
    _revealStyleParameters() {
      this.operations.setPanelCollapsed('pp-toggles', false, {
        explicit: true,
      });
    }
    setStyle() {
      this._revealStyleParameters();
    }
  }
  class StyleManager {
    constructor() {
      const forward = {
        setPanelCollapsed: (...args) => this.setPanelCollapsed(...args),
      };
      this._cctvControls = new CctvControls(forward);
      this._visualSettings = new VisualSettings(forward);
    }
    setPanelCollapsed(panelId, collapsed, options) {
      calls.push([panelId, collapsed, options]);
    }
    setStyle(...args) {
      return this._visualSettings.setStyle(...args);
    }
  }
  return { app: new StyleManager(), calls, CctvControls };
}

function fakePage() {
  const listeners = {};
  return {
    addEventListener: (type, fn) => (listeners[type] = fn),
    removeEventListener: (type) => delete listeners[type],
    press(target, { moveBy = 0 } = {}) {
      listeners.pointerdown({ target, clientX: 100, clientY: 100 });
      if (moveBy)
        listeners.pointermove({ target, clientX: 100 + moveBy, clientY: 100 });
      listeners.pointerup({ target });
    },
  };
}
const onMap = { closest: (selector) => (selector.includes('cesium') ? {} : null) };
const onAButton = { closest: () => null };

function guarded({ stored = { 'gev.panelGuard.cleaned': '1' } } = {}) {
  const { app, calls, CctvControls } = fakeApp();
  const page = fakePage();
  const timers = [];
  let clock = 50_000;
  const stop = installPanelGuard(app, {
    doc: page,
    now: () => clock,
    storage: {
      getItem: (key) => stored[key] ?? null,
      setItem: (key, value) => (stored[key] = value),
    },
    schedule: (fn, ms) => timers.push({ fn, ms }),
  });
  return {
    app,
    calls,
    page,
    timers,
    stored,
    stop,
    CctvControls,
    pass: (ms) => (clock += ms),
  };
}

test('in the app: a preset no longer opens Display, but its own button still does', () => {
  const h = guarded();
  h.app.setStyle('nvg');
  assert.deepEqual(h.calls, []);
  h.app.setPanelCollapsed('pp-toggles', false, { explicit: true });
  assert.deepEqual(h.calls, [['pp-toggles', false, { explicit: true }]]);
});

test('in the app: turning cameras on leaves CCTV shut; clicking a camera opens it; dragging does not', () => {
  const h = guarded();
  h.app._cctvControls._renderCctvState();
  assert.deepEqual(h.calls, []);

  h.page.press(onMap, { moveBy: 60 });
  h.app._cctvControls._renderCctvState();
  assert.deepEqual(h.calls, [], 'a drag across the map is not a click on a camera');

  h.page.press(onAButton);
  h.app._cctvControls._renderCctvState();
  assert.deepEqual(h.calls, [], 'a click on a button is not a click on the map');

  h.page.press(onMap);
  h.pass(150);
  h.app._cctvControls._renderCctvState();
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0].slice(0, 2), ['cctv-panel', false]);

  // Long after that click, a camera change on its own does nothing again.
  h.pass(10_000);
  h.app._cctvControls._renderCctvState();
  assert.equal(h.calls.length, 1);
});

test('in the app: a CCTV panel built later is covered too', () => {
  const h = guarded();
  const rebuilt = new h.CctvControls({
    setPanelCollapsed: (...args) => h.app.setPanelCollapsed(...args),
  });
  rebuilt._renderCctvState();
  assert.deepEqual(h.calls, []);
});

test('in the app: closing is never blocked, and saved state is still put back at start', () => {
  const h = guarded();
  h.app.setPanelCollapsed('pp-toggles', true, { explicit: true });
  h.app.setPanelCollapsed('cctv-panel', false, { restore: true, persist: false });
  assert.equal(h.calls.length, 2);
});

test('once, both panels are closed to clear what the app had saved as open', () => {
  const h = guarded({ stored: {} });
  assert.equal(h.timers.length, 1);
  h.timers[0].fn();
  assert.deepEqual(h.calls, [
    ['pp-toggles', true, { explicit: true }],
    ['cctv-panel', true, { explicit: true }],
  ]);
  assert.equal(h.stored['gev.panelGuard.cleaned'], '1');
  // The next start does not do it again.
  assert.equal(guarded({ stored: h.stored }).timers.length, 0);
});

test('taking the guard away puts the app back exactly as it was', () => {
  const h = guarded();
  h.stop();
  h.app.setStyle('nvg');
  h.app._cctvControls._renderCctvState();
  assert.equal(h.calls.length, 2);
  assert.equal(Object.hasOwn(h.app, 'setPanelCollapsed'), false);
});
