import assert from 'node:assert/strict';
import test from 'node:test';

import { fakeDocument } from '../app/fakeDom.mjs';
import { initPanelFullscreen } from './panelFullscreen.js';

test('the full-screen buttons show a drawn icon, never a text symbol', () => {
  const doc = fakeDocument();
  doc.fullscreenEnabled = true;
  const camera = doc.createElement('div');
  camera.id = 'cctv-frame-wrap';
  const street = doc.createElement('div');
  street.id = 'sl-viewer-wrap';
  const tools = doc.createElement('div');
  tools.className = 'sl-viewer-tools';
  street.appendChild(tools);
  doc.body.append(camera, street);
  const before = globalThis.document;
  globalThis.document = doc; // the buttons are made with the page's document
  try {
    initPanelFullscreen(doc);
  } finally {
    if (before === undefined) delete globalThis.document;
    else globalThis.document = before;
  }
  const buttons = [camera.querySelector('button'), tools.querySelector('button')];
  for (const button of buttons) {
    assert.ok(button, 'each viewer has its button');
    assert.ok(button.innerHTML.includes('<svg'), 'the icon is drawn');
    assert.ok(!`${button.innerHTML}${button.textContent}`.includes('⛶'), 'no text symbol');
    assert.equal(button.getAttribute('aria-label'), 'Full screen');
  }
  assert.match(buttons[1].textContent, /FULL SCREEN/, 'Street Level keeps its word');
});

/** The page and the module set up together, with the page's document in place. */
function fullscreenPage({ hosts = true } = {}) {
  const doc = fakeDocument();
  doc.fullscreenEnabled = true;
  doc.fullscreenElement = null;
  doc.exits = 0;
  doc.exitFullscreen = async () => {
    doc.exits += 1;
  };
  let changed = () => {};
  const realObserver = globalThis.MutationObserver;
  const realDocument = globalThis.document;
  globalThis.MutationObserver = class {
    constructor(callback) {
      changed = callback;
    }
    observe() {}
    disconnect() {}
  };
  globalThis.document = doc;
  const addCamera = () => {
    const camera = doc.createElement('div');
    camera.id = 'cctv-frame-wrap';
    doc.body.appendChild(camera);
    return camera;
  };
  const camera = hosts ? addCamera() : null;
  initPanelFullscreen(doc);
  const restore = () => {
    globalThis.MutationObserver = realObserver;
    if (realDocument === undefined) delete globalThis.document;
    else globalThis.document = realDocument;
  };
  const press = (key) => {
    let stopped = false;
    const event = Object.assign(new Event('keydown'), { key });
    event.stopPropagation = () => (stopped = true);
    doc.dispatchEvent(event);
    return stopped;
  };
  return { doc, camera, addCamera, changed: () => changed(), press, restore };
}

test('Escape in full screen leaves it and goes no further; otherwise it is passed on', () => {
  const page = fullscreenPage();
  try {
    page.doc.fullscreenElement = page.camera;
    assert.equal(page.press('Escape'), true, 'the panel behind the picture must not close too');
    assert.equal(page.doc.exits, 1);
    page.doc.fullscreenElement = null;
    assert.equal(page.press('Escape'), false, 'with nothing full screen the app hears Escape as usual');
    assert.equal(page.doc.exits, 1);
  } finally {
    page.restore();
  }
});

test('a refused full-screen request changes nothing and throws nothing', async () => {
  const page = fullscreenPage();
  try {
    page.camera.requestFullscreen = () => Promise.reject(new Error('not allowed'));
    assert.doesNotThrow(() => page.camera.querySelector('button').click());
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    page.restore();
  }
});

test('a camera picture that appears later gets exactly one button', () => {
  const page = fullscreenPage({ hosts: false });
  try {
    const camera = page.addCamera();
    page.changed();
    page.changed();
    assert.equal(camera.querySelectorAll('button').length, 1);
  } finally {
    page.restore();
  }
});
