import assert from 'node:assert/strict';
import test from 'node:test';

import { hdResolutionScale } from './hdDetail.js';

test('a normal or retina screen draws at its full resolution', () => {
  assert.equal(hdResolutionScale(1), 1);
  assert.equal(hdResolutionScale(2), 1);
});

test('a denser screen is capped at two device pixels', () => {
  assert.equal(hdResolutionScale(3), 2 / 3);
});

test('a missing or broken ratio falls back to one', () => {
  assert.equal(hdResolutionScale(undefined), 1);
  assert.equal(hdResolutionScale(0), 1);
});

test('HD draws at normal sharpness while the view moves, and sharp again once it stops', async () => {
  const { installHdDetail, SHARP_AFTER_MS } = await import('./hdDetail.js');
  const { fakeDocument } = await import('./fakeDom.mjs');
  const doc = fakeDocument();
  const bar = doc.createElement('div');
  bar.id = 'top-center-actions';
  doc.body.appendChild(bar);
  doc.defaultView.devicePixelRatio = 2;
  const timers = [];
  doc.defaultView.setTimeout = (fn, ms) => timers.push({ fn, ms }) && timers.length;
  doc.defaultView.clearTimeout = () => {};
  const listeners = { start: [], end: [] };
  const event = (list) => ({ addEventListener: (fn) => (list.push(fn), () => list.splice(list.indexOf(fn), 1)) });
  const viewer = {
    isDestroyed: () => false,
    useBrowserRecommendedResolution: true,
    resolutionScale: 1,
    scene: { requestRender() {} },
    camera: { moveStart: event(listeners.start), moveEnd: event(listeners.end) },
  };
  const before = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => '1', setItem() {} };
  const remove = installHdDetail({ viewer, tileset: null }, doc);
  try {
    assert.equal(viewer.useBrowserRecommendedResolution, false, 'sharp when still');
    listeners.start.forEach((fn) => fn());
    assert.equal(viewer.useBrowserRecommendedResolution, true, 'normal sharpness while moving');
    listeners.end.forEach((fn) => fn());
    assert.equal(viewer.useBrowserRecommendedResolution, true, 'not straight away');
    const timer = timers.at(-1);
    assert.equal(timer.ms, SHARP_AFTER_MS);
    timer.fn();
    assert.equal(viewer.useBrowserRecommendedResolution, false, 'sharp again once still');
  } finally {
    remove();
    globalThis.localStorage = before;
  }
  assert.equal(listeners.start.length + listeners.end.length, 0, 'remove stops listening');
});
