import assert from 'node:assert/strict';
import test from 'node:test';

import { fakeDocument } from './fakeDom.mjs';
import {
  HELP_SWITCH_ID,
  installHelpCard,
  MAP_CLICKS,
  MOVING,
  opensAtStart,
  pinLine,
} from './helpCard.js';
import { ZENITH_SWITCHES } from './zenithSwitches.js';

test('the card opens the first time and stays closed once it has been closed', () => {
  assert.equal(opensAtStart(null), true);
  assert.equal(opensAtStart(''), true);
  assert.equal(opensAtStart('closed'), false);
});

test('the pin line says whether a click on empty map does anything', () => {
  assert.match(pinLine(true), /pin ON/);
  assert.match(pinLine(true), /local time, coordinates and address/);
  assert.match(pinLine(false), /pin OFF/);
  assert.match(pinLine(false), /does nothing/);
  assert.notEqual(pinLine(true), pinLine(false));
});

test('the card has something to say about clicking and about moving', () => {
  assert.ok(MAP_CLICKS.length >= 3 && MOVING.length >= 3);
  assert.ok(MAP_CLICKS.some((line) => /Right-click a building for its target box/.test(line)));
  for (const line of [...MAP_CLICKS, ...MOVING]) assert.ok(line.length > 15, line);
});

test('the help switch is in the list of added switches', () => {
  assert.ok(ZENITH_SWITCHES.some((entry) => entry.id === HELP_SWITCH_ID));
});

/** The help card in a fake page, with one other switch in the bar. */
function cardInFakePage(stored) {
  const doc = fakeDocument();
  const win = doc.defaultView;
  let switchesChanged = () => {};
  win.MutationObserver = class {
    constructor(callback) {
      switchesChanged = callback;
    }
    observe() {}
    disconnect() {}
  };
  const bar = doc.createElement('div');
  bar.id = 'top-center-actions';
  doc.body.appendChild(bar);
  const quakes = doc.createElement('button');
  quakes.id = 'earthquakes-toggle';
  quakes.setAttribute('aria-pressed', 'false');
  bar.appendChild(quakes);
  const storage = { getItem: () => stored, setItem: () => {} };
  installHelpCard(doc, { storage, win });
  return { doc, card: doc.getElementById('zenith-help'), quakes, switchesChanged: () => switchesChanged() };
}

test('opening the card with its button puts the focus in the card, not when it opens by itself', () => {
  const page = cardInFakePage('closed');
  page.doc.getElementById(HELP_SWITCH_ID).click();
  assert.ok(page.doc.activeElement === page.card.querySelector('.zh-close'), 'the close button has the focus');
  const first = cardInFakePage(null);
  assert.equal(first.card.hidden, false);
  assert.ok(first.doc.activeElement === first.doc.body, 'a card that opens at start must not take the focus');
});

test('the open card keeps the focused control when the switches write their state', () => {
  const page = cardInFakePage('closed');
  page.doc.getElementById(HELP_SWITCH_ID).click();
  const close = page.card.querySelector('.zh-close');
  close.focus();
  page.switchesChanged(); // a switch wrote the same state again
  assert.ok(page.card.contains(page.doc.activeElement), 'nothing changed, so nothing is rebuilt');
  page.quakes.setAttribute('aria-pressed', 'true');
  page.switchesChanged();
  assert.ok(page.card.contains(page.doc.activeElement), 'a real change redraws the rows only');
  const quakeRow = page.card.querySelectorAll('.zh-icon').find((icon) => icon.dataset.on === 'true');
  assert.ok(quakeRow, 'the earthquakes row now shows the switch on');
});
