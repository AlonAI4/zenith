import assert from 'node:assert/strict';
import test from 'node:test';

import { STYLE, installSelectGuard } from './selectGuard.js';

test('the page cannot be selected, but typed fields and the info panels can', () => {
  assert.match(
    STYLE,
    /body \{\s*-webkit-user-select: none;\s*user-select: none;/,
  );
  for (const kept of [
    'input',
    'textarea',
    '#target-box-panel .tb-rows',
    '#address-card',
  ])
    assert.ok(STYLE.includes(kept), kept);
  assert.match(STYLE, /user-select: text;/);
});

test('the rule is added once and taken away again', () => {
  const added = [];
  const doc = {
    createElement: () => ({
      remove() {
        added.splice(added.indexOf(this), 1);
      },
    }),
    head: { appendChild: (node) => added.push(node) },
  };
  const stop = installSelectGuard(doc);
  assert.equal(added.length, 1);
  assert.equal(added[0].id, 'zenith-select-guard');
  assert.equal(added[0].textContent, STYLE);
  stop();
  assert.equal(added.length, 0);
});
