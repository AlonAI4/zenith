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

test('pictures get mipmaps and anisotropic filtering; pixel art and pictures without mipmaps keep their filter', async () => {
  const Cesium = await import('cesium');
  const { sharperSampler } = await import('./hdDetail.js');
  const { LINEAR, NEAREST, LINEAR_MIPMAP_LINEAR } = Cesium.TextureMinificationFilter;
  const plain = new Cesium.Sampler({ minificationFilter: LINEAR, wrapS: Cesium.TextureWrap.REPEAT });
  const sharp = sharperSampler(plain, {}, 16);
  assert.equal(sharp.minificationFilter, LINEAR_MIPMAP_LINEAR);
  assert.equal(sharp.maximumAnisotropy, 16);
  assert.equal(sharp.wrapS, Cesium.TextureWrap.REPEAT);
  assert.equal(sharp.magnificationFilter, plain.magnificationFilter);
  const pixelArt = sharperSampler(new Cesium.Sampler({ minificationFilter: NEAREST }), {}, 16);
  assert.equal(pixelArt.minificationFilter, NEAREST);
  const compressed = sharperSampler(plain, { compressedTextureNoMipmap: true }, 16);
  assert.equal(compressed.minificationFilter, LINEAR, 'no mipmaps to filter with');
  assert.equal(compressed.maximumAnisotropy, 16);
  assert.equal(sharperSampler(plain, {}, 0).maximumAnisotropy, 1, 'a GPU without anisotropic filtering');
});

test("Cesium makes tile pictures sharp while patched, and its own way again after", async () => {
  const Cesium = await import('cesium');
  const { patchTileSamplers } = await import('./hdDetail.js');
  const util = Cesium.GltfLoaderUtil;
  const own = util.createSampler;
  // A glTF picture with no sampler of its own, like Google's tiles.
  const options = { gltf: { textures: [{ source: 0 }], samplers: [] }, textureInfo: { index: 0 } };
  const undo = patchTileSamplers(util, 8);
  try {
    const sampler = util.createSampler(options);
    assert.equal(sampler.minificationFilter, Cesium.TextureMinificationFilter.LINEAR_MIPMAP_LINEAR);
    assert.equal(sampler.maximumAnisotropy, 8);
  } finally {
    undo();
  }
  assert.ok(util.createSampler === own, "Cesium's own function is back");
  assert.equal(util.createSampler(options).minificationFilter, Cesium.TextureMinificationFilter.LINEAR);
});

test('HD: extra pixels only while still with nothing moving, sharp tile pictures, all undone when switched off', async () => {
  const Cesium = await import('cesium');
  const { installHdDetail, STILL_SUPERSAMPLE } = await import('./hdDetail.js');
  const { fakeDocument } = await import('./fakeDom.mjs');
  const doc = fakeDocument();
  const bar = doc.createElement('div');
  bar.id = 'top-center-actions';
  doc.body.appendChild(bar);
  doc.defaultView.devicePixelRatio = 2;
  let timer = null;
  doc.defaultView.setTimeout = (fn, ms) => ((timer = { fn, ms }), 1);
  doc.defaultView.clearTimeout = () => {
    timer = null;
  };
  // One loaded tile with one picture, the way Cesium keeps it.
  const plain = new Cesium.Sampler({ minificationFilter: Cesium.TextureMinificationFilter.LINEAR });
  let mipmapsMade = 0;
  const texture = {
    _sampler: plain,
    _hasMipmap: false,
    get sampler() {
      return this._sampler;
    },
    set sampler(value) {
      this._sampler = value;
    },
    generateMipmap() {
      mipmapsMade += 1;
      this._hasMipmap = true;
    },
  };
  const material = { metallicRoughness: { baseColorTexture: { texture } } };
  const tile = { content: { _model: { _sceneGraph: { _components: { nodes: [{ primitives: [{ material }] }] } } } }, children: [] };
  const tileset = { root: tile, maximumScreenSpaceError: 16, isDestroyed: () => false };
  const frames = [];
  const vec = (x, y, z) => ({ x, y, z });
  const camera = { positionWC: vec(1, 2, 3), directionWC: vec(0, 0, -1), upWC: vec(0, 1, 0) };
  const viewer = {
    isDestroyed: () => false,
    useBrowserRecommendedResolution: true,
    resolutionScale: 1,
    camera,
    scene: {
      requestRenderMode: true,
      requestRender() {},
      preRender: { addEventListener: (fn) => (frames.push(fn), () => frames.splice(frames.indexOf(fn), 1)) },
    },
  };
  const frame = () => frames.forEach((fn) => fn());
  const own = Cesium.GltfLoaderUtil.createSampler;
  const before = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => '1', setItem() {} };
  const remove = installHdDetail({ viewer, tileset }, doc);
  try {
    frame();
    assert.equal(viewer.resolutionScale, STILL_SUPERSAMPLE, 'still, nothing moving: extra pixels');
    assert.ok(Cesium.GltfLoaderUtil.createSampler !== own, 'new tiles get sharp pictures');
    assert.equal(mipmapsMade, 1, 'the loaded picture got its mipmaps');
    assert.equal(texture.sampler.minificationFilter, Cesium.TextureMinificationFilter.LINEAR_MIPMAP_LINEAR);
    assert.equal(doc.body.dataset.hdTextures, 'sharp');
    // Live planes switched on: the map redraws every frame, so no extra pixels.
    viewer.scene.requestRenderMode = false;
    frame();
    assert.equal(viewer.resolutionScale, 1, 'something moving: the screen pixels only');
    viewer.scene.requestRenderMode = true;
    frame();
    assert.equal(viewer.resolutionScale, STILL_SUPERSAMPLE);
    camera.positionWC = vec(5, 2, 3);
    frame();
    assert.equal(viewer.resolutionScale, 1, 'moving: normal sharpness');
    assert.equal(viewer.useBrowserRecommendedResolution, true);
    timer.fn();
    assert.equal(viewer.resolutionScale, STILL_SUPERSAMPLE, 'still again');
    doc.getElementById('hd-detail-toggle').click();
    assert.ok(Cesium.GltfLoaderUtil.createSampler === own, "HD off: Cesium's own pictures");
    assert.ok(texture.sampler === plain, 'HD off: the loaded picture is back as it was');
    assert.equal(doc.body.dataset.hdTextures, 'plain');
    assert.equal(viewer.resolutionScale, 1);
    assert.equal(tileset.maximumScreenSpaceError, 16);
    doc.getElementById('hd-detail-toggle').click();
    assert.equal(texture.sampler.minificationFilter, Cesium.TextureMinificationFilter.LINEAR_MIPMAP_LINEAR, 'HD on again');
    assert.equal(mipmapsMade, 1, 'mipmaps are made once');
  } finally {
    remove();
    globalThis.localStorage = before;
  }
  assert.ok(Cesium.GltfLoaderUtil.createSampler === own, 'remove puts Cesium back');
  assert.ok(texture.sampler === plain);
  assert.equal(frames.length, 0, 'remove stops listening');
});
