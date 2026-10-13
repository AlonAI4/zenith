import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HELP_SWITCH_ID,
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
  assert.match(pinLine(true), /local time and coordinates/);
  assert.match(pinLine(false), /pin OFF/);
  assert.match(pinLine(false), /does nothing/);
  assert.notEqual(pinLine(true), pinLine(false));
});

test('the card has something to say about clicking and about moving', () => {
  assert.ok(MAP_CLICKS.length >= 3 && MOVING.length >= 3);
  assert.ok(MAP_CLICKS.some((line) => /Right-click does nothing/.test(line)));
  for (const line of [...MAP_CLICKS, ...MOVING]) assert.ok(line.length > 15, line);
});

test('the help switch is in the list of added switches', () => {
  assert.ok(ZENITH_SWITCHES.some((entry) => entry.id === HELP_SWITCH_ID));
});
