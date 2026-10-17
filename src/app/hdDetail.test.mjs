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
  let timer = null;
  doc.defaultView.setTimeout = (fn, ms) => {
    timer = { fn, ms };
    return 1;
  };
  doc.defaultView.clearTimeout = () => {
    timer = null;
  };
  const frames = [];
  const vec = (x, y, z) => ({ x, y, z });
  const camera = { positionWC: vec(1, 2, 3), directionWC: vec(0, 0, -1), upWC: vec(0, 1, 0) };
  const viewer = {
    isDestroyed: () => false,
    useBrowserRecommendedResolution: true,
    resolutionScale: 1,
    camera,
    scene: {
      requestRender() {},
      preRender: { addEventListener: (fn) => (frames.push(fn), () => frames.splice(frames.indexOf(fn), 1)) },
    },
  };
  const frame = () => frames.forEach((fn) => fn());
  const before = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => '1', setItem() {} };
  const remove = installHdDetail({ viewer, tileset: null }, doc);
  try {
    frame();
    assert.equal(viewer.useBrowserRecommendedResolution, false, 'sharp when still');
    // A change of resolution redraws without moving: still sharp.
    frame();
    frame();
    assert.equal(viewer.useBrowserRecommendedResolution, false, 'redrawing in place is not moving');
    camera.positionWC = vec(5, 2, 3);
    frame();
    assert.equal(viewer.useBrowserRecommendedResolution, true, 'normal sharpness while moving');
    assert.equal(timer.ms, SHARP_AFTER_MS);
    timer.fn();
    assert.equal(viewer.useBrowserRecommendedResolution, false, 'sharp again once still');
    frame();
    assert.equal(viewer.useBrowserRecommendedResolution, false, 'and it stays sharp: no flipping');
  } finally {
    remove();
    globalThis.localStorage = before;
  }
  assert.equal(frames.length, 0, 'remove stops listening');
});
