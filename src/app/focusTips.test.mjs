import assert from 'node:assert/strict';
import test from 'node:test';

import { fakeDocument } from './fakeDom.mjs';
import { installFocusTips } from './focusTips.js';

function toolbarInFakePage() {
  const doc = fakeDocument();
  const bar = doc.createElement('div');
  bar.id = 'top-center-actions';
  doc.body.appendChild(bar);
  const measure = doc.createElement('button');
  measure.title = 'Measure: click spots on the map to get the distance between them';
  bar.appendChild(measure);
  const elsewhere = doc.createElement('button');
  elsewhere.title = 'Not in the top bar';
  doc.body.appendChild(elsewhere);
  const remove = installFocusTips(doc);
  const tip = doc.getElementById('zenith-focus-tip');
  const focus = (element) => {
    element.focus();
    doc.dispatchEvent(new Event('focusin'));
  };
  return { doc, measure, elsewhere, tip, focus, remove };
}

test('a top-bar switch reached with the keyboard shows what it does', () => {
  const page = toolbarInFakePage();
  page.focus(page.measure);
  assert.equal(page.tip.hidden, false);
  assert.equal(page.tip.textContent, page.measure.title);
  assert.equal(page.tip.getAttribute('role'), 'tooltip');
  page.doc.dispatchEvent(new Event('focusout'));
  assert.equal(page.tip.hidden, true, 'it goes when the focus leaves');
  page.remove();
});

test('the tip goes on Escape, follows a changed title, and shows nothing outside the top bar', () => {
  const page = toolbarInFakePage();
  page.focus(page.measure);
  page.measure.title = 'Stop measuring and remove the points';
  page.doc.dispatchEvent(new Event('click'));
  assert.equal(page.tip.textContent, 'Stop measuring and remove the points');
  page.doc.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' }));
  assert.equal(page.tip.hidden, true);
  page.focus(page.elsewhere);
  assert.equal(page.tip.hidden, true);
  page.remove();
  assert.equal(page.doc.getElementById('zenith-focus-tip'), null, 'removing it takes the tip away');
});
