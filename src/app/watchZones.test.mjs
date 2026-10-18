import assert from 'node:assert/strict';
import test from 'node:test';

import { fakeDocument } from './fakeDom.mjs';
import { SWITCH_KEYS, TAKEN_KEYS } from './switchKeys.js';
import {
  addZone,
  cleanZoneName,
  createAlerter,
  distanceM,
  insideZone,
  installWatchZones,
  isPickingZone,
  isZone,
  longestStep,
  MAX_ZONE_NAME,
  MAX_ZONES,
  nextZoneName,
  parseZones,
  passedThrough,
  removeZone,
  REPEAT_MS,
  sizeLabel,
  switchZone,
  zulu,
} from './watchZones.js';

const EARTH_M = 6_371_000;
/** A spot this many metres north of another. */
const north = (lat, metres) => lat + (metres / EARTH_M) * (180 / Math.PI);
const zone = (extra = {}) => ({
  id: 'home',
  name: 'HOME',
  lat: 51.5,
  lon: -0.12,
  radiusM: 2000,
  watch: ['planes'],
  on: true,
  ...extra,
});

test('sizes and names read well', () => {
  assert.equal(sizeLabel(500), '500 m');
  assert.equal(sizeLabel(2000), '2 km');
  assert.equal(sizeLabel(50_000), '50 km');
  assert.equal(cleanZoneName('  Heathrow   north  '), 'Heathrow north');
  assert.equal(Array.from(cleanZoneName('x'.repeat(60))).length, MAX_ZONE_NAME);
  assert.equal(nextZoneName([zone({ name: 'Zone 1' })]), 'Zone 2');
  assert.equal(zulu(Date.UTC(2026, 9, 18, 14, 2, 30)), '14:02Z');
});

test('inside a zone up to its ring, outside just past it', () => {
  const z = zone();
  assert.ok(insideZone(z, north(z.lat, 1999), z.lon));
  assert.ok(insideZone(z, north(z.lat, 2000) - 1e-9, z.lon));
  assert.ok(!insideZone(z, north(z.lat, 2001), z.lon));
  assert.ok(insideZone(z, z.lat, z.lon));
  assert.ok(
    Math.abs(distanceM(z.lat, z.lon, north(z.lat, 2000), z.lon) - 2000) < 0.01,
  );
});

test('something fast that crossed a zone between two checks counts as having entered it', () => {
  const small = zone({ radiusM: 500, watch: ['satellites'] });
  // A satellite 15 km south, then 15 km north, two seconds later.
  const from = { lat: north(small.lat, -15_000), lon: small.lon };
  const to = { lat: north(small.lat, 15_000), lon: small.lon };
  assert.ok(
    !insideZone(small, from.lat, from.lon) &&
      !insideZone(small, to.lat, to.lon),
  );
  assert.ok(passedThrough(small, from, to));
  // The same path 600 m to the east misses it.
  const east =
    (600 / (EARTH_M * Math.cos((small.lat * Math.PI) / 180))) * (180 / Math.PI);
  assert.ok(
    !passedThrough(
      small,
      { ...from, lon: small.lon + east },
      { ...to, lon: small.lon + east },
    ),
  );
  // A jump of thousands of kilometres is bad data, not a journey through the zone.
  assert.ok(
    !passedThrough(
      small,
      { lat: -40, lon: small.lon },
      { lat: 60, lon: small.lon },
    ),
  );
  // With no earlier spot, only where it is now counts.
  assert.ok(
    passedThrough(small, undefined, { lat: small.lat, lon: small.lon }),
  );
  assert.ok(!passedThrough(small, undefined, to));
});

test('an arrival is one alert, and the same thing back within 10 minutes is not another', () => {
  const alerter = createAlerter();
  const t0 = 1_000_000;
  // The first check is the starting point: BAW1 was already there.
  assert.deepEqual(alerter.sweep('home', 'planes', new Set(['baw1']), t0), []);
  // BAW2 arrives: one alert, however long it stays.
  assert.deepEqual(
    alerter.sweep('home', 'planes', new Set(['baw1', 'baw2']), t0 + 2000),
    ['baw2'],
  );
  assert.deepEqual(
    alerter.sweep('home', 'planes', new Set(['baw1', 'baw2']), t0 + 4000),
    [],
  );
  // BAW2 leaves and is back five minutes later: no new alert.
  assert.deepEqual(
    alerter.sweep('home', 'planes', new Set(['baw1']), t0 + 6000),
    [],
  );
  assert.deepEqual(
    alerter.sweep('home', 'planes', new Set(['baw1', 'baw2']), t0 + 5 * 60_000),
    [],
  );
  // Out again, and back after the 10 minutes: a new alert.
  alerter.sweep('home', 'planes', new Set(), t0 + 6 * 60_000);
  assert.deepEqual(
    alerter.sweep('home', 'planes', new Set(['baw2']), t0 + 2000 + REPEAT_MS),
    ['baw2'],
  );
  // BAW1 was there from the start, left, and came back: that is an arrival.
  assert.deepEqual(
    alerter.sweep(
      'home',
      'planes',
      new Set(['baw1', 'baw2']),
      t0 + 2000 + REPEAT_MS + 2000,
    ),
    ['baw1'],
  );
});

test('something missing from the data has not left: back in view, it is not a new arrival', () => {
  const alerter = createAlerter();
  const t0 = 1_000_000;
  // A ship already in the port when watching starts, and one that arrives.
  alerter.sweep('port', 'ships', new Set(['old']), t0, new Set(['old', 'far']));
  assert.deepEqual(
    alerter.sweep(
      'port',
      'ships',
      new Set(['old', 'new']),
      t0 + 2000,
      new Set(['old', 'new', 'far']),
    ),
    ['new'],
  );
  // The camera pans away: neither is in the data any more.
  alerter.sweep('port', 'ships', new Set(), t0 + 4000, new Set(['far']));
  // Back five minutes later, both still in the port: no alerts.
  assert.deepEqual(
    alerter.sweep(
      'port',
      'ships',
      new Set(['old', 'new']),
      t0 + 5 * 60_000,
      new Set(['old', 'new']),
    ),
    [],
  );
  // Missing for more than 10 minutes, it is forgotten: back inside is an arrival.
  alerter.sweep('port', 'ships', new Set(), t0 + 6 * 60_000, new Set(['far']));
  assert.deepEqual(
    alerter.sweep(
      'port',
      'ships',
      new Set(['old']),
      t0 + 17 * 60_000,
      new Set(['old']),
    ),
    ['old'],
  );
});

test('a page checked less often still catches a satellite crossing a zone', () => {
  assert.equal(longestStep('satellites', 2000), 100_000);
  // A minute between checks in a background tab: about 8 km a second.
  assert.equal(longestStep('satellites', 60_000), 600_000);
  assert.equal(longestStep('satellites', 10 * 60_000), 1_000_000);
  assert.equal(longestStep('ships', 60_000), 100_000);
  const small = zone({ radiusM: 500 });
  const from = { lat: north(small.lat, -240_000), lon: small.lon };
  const to = { lat: north(small.lat, 240_000), lon: small.lon };
  assert.ok(
    !passedThrough(small, from, to),
    'a 480 km step is a jump at the usual pace',
  );
  assert.ok(passedThrough(small, from, to, longestStep('satellites', 60_000)));
});

test('zones and kinds are remembered apart, and a reset starts a zone afresh', () => {
  const alerter = createAlerter();
  alerter.sweep('home', 'planes', new Set(), 0);
  alerter.sweep('port', 'planes', new Set(), 0);
  assert.deepEqual(alerter.sweep('home', 'planes', new Set(['x']), 2000), [
    'x',
  ]);
  assert.deepEqual(alerter.sweep('port', 'planes', new Set(['x']), 2000), [
    'x',
  ]);
  // A layer switched back on: what is inside is the new starting point, not a flood of alerts.
  alerter.reset('home', 'planes');
  assert.deepEqual(
    alerter.sweep('home', 'planes', new Set(['x', 'y']), 4000),
    [],
  );
});

test('at most 10 zones, and the saved list reads back as it was', () => {
  let list = [];
  for (let i = 0; i < 12; i += 1)
    list = addZone(list, zone({ id: `z${i}`, name: `Zone ${i + 1}` }));
  assert.equal(list.length, MAX_ZONES);
  assert.deepEqual(parseZones(JSON.stringify(list)), list);
  // Damaged or doubled entries are left out; too many are cut to 10.
  const damaged = [
    zone(),
    zone(),
    zone({ id: 'b', radiusM: 3000 }),
    zone({ id: 'c', watch: ['bikes'] }),
    zone({ id: 'd', lat: 99 }),
    null,
  ];
  assert.deepEqual(parseZones(JSON.stringify(damaged)), [zone()]);
  assert.deepEqual(parseZones('not json'), []);
  assert.equal(
    parseZones(
      JSON.stringify([...list, ...list.map((z) => ({ ...z, id: `${z.id}b` }))]),
    ).length,
    MAX_ZONES,
  );
  assert.ok(!isZone(zone({ watch: [] })), 'a zone must watch something');
  assert.deepEqual(removeZone(list, 'z0').length, 9);
  assert.equal(switchZone(list, 'z1', false)[1].on, false);
});

test('the Watch zones key is free and its own', () => {
  assert.equal(SWITCH_KEYS['watch-zones-toggle'], 'j');
  assert.ok(!TAKEN_KEYS.includes('j'));
  assert.equal(
    Object.values(SWITCH_KEYS).filter((key) => key === 'j').length,
    1,
  );
});

/** The panel in a fake page, with a made-up flights layer and storage. */
function inFakePage(saved) {
  const doc = fakeDocument();
  const win = doc.defaultView;
  win.setInterval = (fn, ms) => setInterval(fn, ms);
  win.clearInterval = (handle) => clearInterval(handle);
  const bar = doc.createElement('div');
  bar.id = 'top-center-actions';
  doc.body.appendChild(bar);
  const store = new Map(
    saved ? [['gev.watchZones', JSON.stringify(saved)]] : [],
  );
  const storage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
  };
  const planes = [];
  const dataManager = {
    layers: new Map([
      ['flights', { module: { getAnalystRecords: () => planes } }],
    ]),
    isEnabled: (id) => id === 'flights',
  };
  const viewer = {
    scene: {
      canvas: doc.createElement('canvas'),
      globe: { show: true, getHeight: () => 0 },
      requestRender() {},
    },
    camera: {},
    dataSources: { add: async () => {}, remove() {} },
    isDestroyed: () => false,
  };
  const before = globalThis.document;
  globalThis.document = doc; // Cesium's click handler looks for the page's document
  let remove;
  try {
    remove = installWatchZones(
      { viewer },
      { dataManager, storage, checkMs: 20 },
      doc,
    );
  } finally {
    if (before === undefined) delete globalThis.document;
    else globalThis.document = before;
  }
  return { doc, store, planes, remove };
}

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

test('saved zones are listed, a delete is saved, and an arriving plane gives one alert', async () => {
  const home = zone();
  const page = inFakePage([
    home,
    zone({ id: 'port', name: 'PORT', lat: 50.9, on: false }),
  ]);
  try {
    page.doc
      .getElementById('watch-zones-toggle')
      .dispatchEvent(new Event('click'));
    const rows = page.doc
      .getElementById('watch-zones-list')
      .querySelectorAll('li');
    assert.equal(rows.length, 2);
    assert.match(rows[0].textContent, /HOME.*2 km · planes/);
    assert.ok(!isPickingZone());
    // A plane 5 km away, then inside.
    page.planes.push({
      id: 'BAW33',
      icao24: '400abc',
      lat: north(home.lat, 5000),
      lon: home.lon,
    });
    await wait(80);
    page.planes[0] = { ...page.planes[0], lat: north(home.lat, 900) };
    await wait(120);
    const alerts = page.doc
      .getElementById('watch-zones-alerts')
      .querySelectorAll('button');
    assert.equal(alerts.length, 1, 'one alert');
    assert.match(alerts[0].textContent, /^\d\d:\d\dZ · BAW33 entered HOME$/);
    assert.match(
      page.doc.getElementById('zenith-zone-alert')?.textContent ?? '',
      /^ALERT · BAW33 entered HOME · \d\d:\d\dZ$/,
    );
    // Deleting PORT is saved.
    rows[1].querySelector('.wz-delete').dispatchEvent(new Event('click'));
    assert.deepEqual(
      parseZones(page.store.get('gev.watchZones')).map((z) => z.id),
      ['home'],
    );
  } finally {
    page.remove();
  }
});
