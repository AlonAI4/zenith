import assert from 'node:assert/strict';
import test from 'node:test';

import { stationKind, stationRow } from '../../alon-stations-build.mjs';
import { fakeDocument } from './fakeDom.mjs';
import { installTrainStations, parseStations, stationsInView } from './trainStations.js';

test('a stop is classed as train, metro or tram from its map tags', () => {
  assert.equal(stationKind({ railway: 'station' }), 'train');
  assert.equal(stationKind({ railway: 'halt' }), 'train');
  assert.equal(stationKind({ railway: 'station', station: 'subway' }), 'metro');
  assert.equal(stationKind({ railway: 'tram_stop' }), 'tram');
  assert.equal(stationKind({ railway: 'station', light_rail: 'yes' }), 'tram');
});

test('a row keeps the local name with the English one, and closed stops are dropped', () => {
  const point = (properties) => ({
    properties,
    geometry: { coordinates: [34.7817234, 32.0852999] },
  });
  assert.deepEqual(
    stationRow(point({ railway: 'station', name: 'תל אביב', 'name:en': 'Tel Aviv' })),
    [34.78172, 32.0853, 0, 'תל אביב (Tel Aviv)'],
  );
  assert.equal(stationRow(point({ railway: 'station', disused: 'yes' })), null);
  assert.equal(stationRow({ properties: {}, geometry: {} }), null);
});

test('the bundled file unpacks into named stops', () => {
  assert.deepEqual(
    parseStations({
      kinds: ['train', 'metro', 'tram'],
      stations: [
        [-0.1246, 51.5007, 1, 'Westminster'],
        ['bad', 1, 0, 'x'],
      ],
    }),
    [{ lon: -0.1246, lat: 51.5007, kind: 'metro', name: 'Westminster' }],
  );
});

test('only stops inside the view are drawn, trains first, and never more than the cap', () => {
  const box = { west: -1, south: 50, east: 1, north: 52 };
  const stations = [
    { lon: 0.9, lat: 51, kind: 'tram', name: 'far tram' },
    { lon: 0.1, lat: 51, kind: 'tram', name: 'near tram' },
    { lon: 0.8, lat: 51, kind: 'train', name: 'far train' },
    { lon: 5, lat: 51, kind: 'train', name: 'outside' },
  ];
  assert.deepEqual(
    stationsInView(stations, box, 2).map((s) => s.name),
    ['far train', 'near tram'],
  );
  assert.equal(stationsInView(stations, box, 10).length, 3);
});

test('a view across the date line still finds its stops', () => {
  const box = { west: 170, south: -10, east: -170, north: 10 };
  const names = stationsInView(
    [
      { lon: 175, lat: 0, kind: 'train', name: 'west side' },
      { lon: -175, lat: 0, kind: 'train', name: 'east side' },
      { lon: 0, lat: 0, kind: 'train', name: 'other side of the world' },
    ],
    box,
  ).map((s) => s.name);
  assert.deepEqual(names.sort(), ['east side', 'west side']);
});

test('when the station list cannot be loaded, the switch goes back off and says so', async () => {
  const doc = fakeDocument();
  const bar = doc.createElement('div');
  bar.id = 'top-center-actions';
  doc.body.appendChild(bar);
  const never = { addEventListener: () => () => {} };
  const viewer = {
    scene: { canvas: doc.createElement('canvas'), primitives: { add: (p) => p, remove() {} }, requestRender() {}, isDestroyed: () => false },
    camera: { moveEnd: never, changed: never, computeViewRectangle: () => null },
    creditDisplay: { addStaticCredit() {}, removeStaticCredit() {} },
  };
  const realFetch = globalThis.fetch;
  const realDocument = globalThis.document;
  globalThis.fetch = async () => {
    throw new Error('offline');
  };
  globalThis.document = doc;
  let remove;
  try {
    remove = installTrainStations({ viewer }, doc);
    const toggle = doc.getElementById('train-stations-toggle');
    toggle.click();
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(toggle.getAttribute('aria-pressed'), 'false', 'the switch is off again');
    const notice = doc.getElementById('feed-notice');
    assert.ok(notice && /station/i.test(notice.textContent), 'the reason is on screen');
    assert.doesNotMatch(notice.textContent, /\.sh\b/, 'no programmer words');
  } finally {
    remove?.();
    globalThis.fetch = realFetch;
    if (realDocument === undefined) delete globalThis.document;
    else globalThis.document = realDocument;
  }
});
