import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

import { US_CITIES } from '../../alon-stations-build.mjs';
import { ZENITH_SWITCHES } from './zenithSwitches.js';

// What people read about Zenith must keep saying what the code does.
const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const DOCS = ['ZENITH-GUIDE.md', 'ALON-NOTICES.md', '.github/README.md', 'alon-site/index.html'];

test("every switch has a row in the guide's table of what this build adds", () => {
  const guide = read('ZENITH-GUIDE.md');
  const table = guide.slice(guide.indexOf('## What this build adds'), guide.indexOf('## API keys'));
  const rows = [...table.matchAll(/^\| ([^|]+?) \|/gm)].map((match) => match[1].trim().toLowerCase());
  for (const entry of ZENITH_SWITCHES) {
    assert.ok(
      rows.some((row) => row.startsWith(entry.name.toLowerCase())),
      `the guide has no row for ${entry.name}`,
    );
  }
});

test('the station counts in every document match the data', () => {
  const file = JSON.parse(read('public/alon/stations.json'));
  const countries = Object.keys(file.countries).filter((key) => key !== 'usa-cities');
  assert.equal(countries.length, 7, 'the documents say seven countries');
  assert.equal(Object.keys(US_CITIES).length, 11, 'the documents say eleven US city areas');
  for (const doc of DOCS) assert.match(read(doc), /\beleven\b/i, `${doc} does not say eleven`);
});

test('nothing people see calls them friends', () => {
  const app = readdirSync(new URL('.', import.meta.url))
    .filter((name) => name.endsWith('.js'))
    .map((name) => `src/app/${name}`);
  const ui = ['branding', 'buttonTooltips', 'customSelect', 'panelFullscreen', 'shortcutGuard'].map(
    (name) => `src/ui/${name}.js`,
  );
  for (const path of [...DOCS, ...app, ...ui, 'alon-browser-test.mjs']) {
    assert.doesNotMatch(read(path), /\bfriends\b/i, `${path} says "friends"`);
  }
});
