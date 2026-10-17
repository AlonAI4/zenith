import assert from 'node:assert/strict';
import test from 'node:test';

import { initBranding } from './branding.js';

test('the credit under the title says the original, and stays readable over the map', () => {
  const made = () => ({ style: {}, textContent: '', className: '', replaceChildren() {} });
  const subtitle = made();
  const nodes = {
    '#title-bar .subtitle': subtitle,
    '#title-bar h1 > span:not(.title-logo)': made(),
    '#loading-screen h2': made(),
  };
  initBranding({ title: '', querySelector: (selector) => nodes[selector] ?? null, createElement: made });
  assert.equal(subtitle.textContent, "BUILT ON GOD'S EYE VIEW");
  assert.ok(subtitle.style.textShadow, 'a dark shadow keeps it readable over a bright satellite picture');
  assert.ok(subtitle.style.color, 'a brighter colour than the faint default');
});

test('the map credits sit in two lines: Cesium ion on top, Google Maps under it', () => {
  const made = () => ({ style: {}, textContent: '', className: '', replaceChildren() {} });
  const added = [];
  const nodes = {
    '#title-bar .subtitle': made(),
    '#title-bar h1 > span:not(.title-logo)': made(),
    '#loading-screen h2': made(),
  };
  initBranding({
    title: '',
    head: { appendChild: (node) => added.push(node) },
    querySelector: (selector) => nodes[selector] ?? null,
    createElement: made,
  });
  const style = added.find((node) => node.id === 'zenith-credit-lines');
  assert.ok(style, 'the credit style is added');
  assert.match(style.textContent, /#cesium-credits \.cesium-credit-logoContainer \{ display: block !important;/);
});
