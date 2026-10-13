import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSettingsFile, readSettingsFile, SETTINGS } from './settingsFile.js';

const place = { name: 'Tower Bridge', lon: -0.0754, lat: 51.5055, height: 900, heading: 20, pitch: -35 };
const store = (entries) => (key) => (Object.hasOwn(entries, key) ? entries[key] : null);

test('only the listed settings go into the file, and never a key', () => {
  const file = buildSettingsFile(
    store({
      'gev.dayNight': '1',
      'gev.timeZones': '0',
      'gev.savedPlaces': JSON.stringify([place]),
      'gev.videoMode': '{"speed":"fast","clockwise":false}',
      // Things that are in a browser's storage but must not travel.
      'gev.satelliteByChoice': '1',
      CESIUM_ION_TOKEN: 'eyJ-secret-token-value-1234567890',
      'gev.secretKey': 'sk-live-0123456789abcdef',
      'other-site-setting': 'x',
    }),
    new Date('2026-10-13T12:00:00Z'),
  );
  assert.deepEqual(Object.keys(file.settings).sort(), ['gev.dayNight', 'gev.savedPlaces', 'gev.timeZones', 'gev.videoMode']);
  assert.ok(!JSON.stringify(file).includes('secret'));
  assert.ok(!JSON.stringify(file).includes('sk-live'));
  assert.deepEqual({ app: file.app, kind: file.kind, version: file.version, saved: file.saved }, { app: 'Zenith', kind: 'settings', version: 1, saved: '2026-10-13T12:00:00.000Z' });
  for (const key of Object.keys(SETTINGS)) assert.ok(!/key|token|secret|password/i.test(key), key);
});

test('a saved file loads back to the same settings', () => {
  const entries = {
    'gev.dayNight': '1',
    'gev.hdDetail': '0',
    'gev.helpCard': 'closed',
    'gev.savedPlaces': JSON.stringify([place]),
    'gev.videoMode': '{"speed":"slow","clockwise":true}',
  };
  const result = readSettingsFile(JSON.stringify(buildSettingsFile(store(entries))));
  assert.equal(result.ok, true);
  assert.deepEqual(result.settings, entries);
  assert.equal(result.ignored, 0);
});

test('a damaged or foreign file is refused with a plain message', () => {
  const refused = (text) => {
    const result = readSettingsFile(text);
    assert.equal(result.ok, false, text?.slice?.(0, 40));
    assert.ok(result.why.length > 10);
    return result.why;
  };
  assert.match(refused(''), /empty/);
  assert.match(refused('not json at all'), /not a Zenith settings file/);
  assert.match(refused('{"some":"other app"}'), /not a Zenith settings file/);
  assert.match(refused('[1,2,3]'), /not a Zenith settings file/);
  assert.match(refused('null'), /not a Zenith settings file/);
  assert.match(refused(JSON.stringify({ app: 'Zenith', kind: 'settings', version: 1, settings: [] })), /not a Zenith settings file/);
  assert.match(refused(JSON.stringify({ app: 'Zenith', kind: 'settings', version: 2, settings: { 'gev.dayNight': '1' } })), /newer Zenith/);
  assert.match(refused(JSON.stringify({ app: 'Zenith', kind: 'settings', version: 1, settings: { nothing: 'useful' } })), /no Zenith settings/);
  assert.match(refused('x'.repeat(1_000_001)), /too big/);
  assert.match(refused(undefined), /empty/);
});

test('a file that is accepted has every value checked and tidied', () => {
  const result = readSettingsFile(
    JSON.stringify({
      app: 'Zenith',
      kind: 'settings',
      version: 1,
      settings: {
        'gev.dayNight': '1',
        'gev.timeZones': 'yes please',
        'gev.hdDetail': 1,
        'gev.helpCard': 'open',
        'gev.videoMode': '{"speed":"warp","clockwise":"sideways"}',
        'gev.savedPlaces': JSON.stringify([place, { name: 'Broken', lat: 999 }, { name: '<script>', lon: 0, lat: 0, height: 1, heading: 0, pitch: 0, look: { style: 'x y' } }]),
        'gev.satelliteByChoice': '1',
        CESIUM_ION_TOKEN: 'eyJ-not-wanted',
        __proto__: 'gev.dayNight',
        constructor: '1',
      },
    }),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.settings).sort(), ['gev.dayNight', 'gev.savedPlaces', 'gev.videoMode']);
  assert.equal(result.settings['gev.dayNight'], '1');
  assert.equal(result.settings['gev.videoMode'], '{"speed":"normal","clockwise":true}');
  assert.deepEqual(JSON.parse(result.settings['gev.savedPlaces']).map((entry) => entry.name), ['Tower Bridge']);
  assert.ok(result.ignored >= 5);
});
