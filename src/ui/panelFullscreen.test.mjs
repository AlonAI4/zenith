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
