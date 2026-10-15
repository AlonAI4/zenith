import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

import { ZENITH_SWITCHES } from './zenithSwitches.js';

const folder = new URL('.', import.meta.url);
const sources = readdirSync(folder)
  .filter((name) => name.endsWith('.js'))
  .map((name) => readFileSync(new URL(name, folder), 'utf8'));

/** The aria-label set on the element that gets this id, in whichever file makes it. */
function spokenName(id) {
  for (const source of sources) {
    const constant = new RegExp(`const (\\w+) = '${id}';`).exec(source)?.[1];
    const made = new RegExp(`(\\w+)\\.id = (?:'${id}'|${constant ?? '(?!)'});`).exec(source);
    if (!made) continue;
    const label = new RegExp(`${made[1]}\\.setAttribute\\('aria-label', '([^']+)'\\)`).exec(source.slice(made.index));
    return label?.[1] ?? null;
  }
  return null;
}

test('every switch is read out by the name people see on it', () => {
  for (const entry of ZENITH_SWITCHES) {
    const spoken = spokenName(entry.id);
    assert.ok(spoken, `${entry.id} has a spoken name`);
    assert.ok(spoken.toLowerCase().includes(entry.name.toLowerCase()), `${entry.id}: "${spoken}" does not say "${entry.name}"`);
  }
});

test('the narrow-window tray is a plain show-and-hide panel, not a menu', () => {
  const fit = readFileSync(new URL('toolbarFit.js', folder), 'utf8');
  assert.doesNotMatch(fit, /aria-haspopup/, 'a popup is announced as a menu, which needs arrow keys');
  assert.match(fit, /more\.setAttribute\('aria-controls', 'zenith-tray'\)/);
});

test('on a narrow window the tray closes for switches that need a click on the map next', () => {
  const closes = ZENITH_SWITCHES.filter((entry) => entry.panel || entry.closesTray).map((entry) => entry.id);
  for (const id of ['address-lookup-toggle', 'measure-toggle']) assert.ok(closes.includes(id), `${id} closes the tray`);
  // Layer switches keep it open, so several can be switched in a row.
  for (const id of ['train-stations-toggle', 'earthquakes-toggle']) assert.ok(!closes.includes(id), `${id} keeps the tray open`);
  const fit = readFileSync(new URL('toolbarFit.js', folder), 'utf8');
  assert.match(fit, /entry\.panel \|\| entry\.closesTray/, 'the tray reads both marks');
});
