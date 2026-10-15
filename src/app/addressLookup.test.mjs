import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ADDRESS_MAX_HEIGHT_M,
  chooseAddress,
  closeEnoughForAddress,
  describeAddress,
  distanceMetres,
  formatCoordinates,
  HOUSE_WITHIN_M,
  installAddressLookup,
  pickFamousPlace,
  requestGate,
  STREET_WITHIN_M,
} from './addressLookup.js';
import { fakeDocument } from './fakeDom.mjs';

test('addresses are looked up from close in, not from far out', () => {
  assert.equal(closeEnoughForAddress(900), true);
  assert.equal(closeEnoughForAddress(ADDRESS_MAX_HEIGHT_M), true);
  assert.equal(closeEnoughForAddress(ADDRESS_MAX_HEIGHT_M + 1), false);
  assert.equal(closeEnoughForAddress(14_000_000), false);
  assert.equal(closeEnoughForAddress(undefined), false);
  assert.equal(closeEnoughForAddress(NaN), false);
});

test('coordinates read latitude first with five decimals', () => {
  assert.equal(formatCoordinates(51.5034878, -0.1276965), '51.50349, -0.12770');
});

test('a house with a number reads as number and street, and counts as exact', () => {
  assert.deepEqual(
    describeAddress({
      name: '10 Downing Street',
      housenumber: '10',
      street: 'Downing Street',
      district: 'Covent Garden',
      city: 'London',
      postcode: 'SW1A 2AA',
    }),
    {
      title: '10 Downing Street',
      place: 'Covent Garden, London, SW1A 2AA',
      exact: true,
    },
  );
});

test('a named place keeps its name in front of its street', () => {
  assert.equal(
    describeAddress({
      name: "St Paul's Cathedral",
      street: "St Paul's Churchyard",
      city: 'London',
    }).title,
    "St Paul's Cathedral, St Paul's Churchyard",
  );
});

test('a bare street is not passed off as an exact house', () => {
  assert.deepEqual(
    describeAddress({ name: 'Brixton Road', city: 'London', postcode: 'SW9 8EH' }),
    { title: 'Brixton Road', place: 'London, SW9 8EH', exact: false },
  );
});

test('distance between two nearby points is in metres', () => {
  const metres = distanceMetres(51.5034, -0.1276, 51.5034, -0.1266);
  assert.ok(metres > 65 && metres < 75, String(metres));
});

test('the well-known place wins over a nearer obscure one, but not from far away', () => {
  const page = (title, views, dist) => ({
    title,
    pageviews: { a: views },
    coordinates: [{ dist }],
  });
  assert.deepEqual(
    pickFamousPlace([
      page('Royal Archives', 85, 8),
      page('Buckingham Palace', 8525, 20),
    ]),
    { title: 'Buckingham Palace', metres: 20 },
  );
  assert.equal(
    pickFamousPlace([
      page('Victoria Memorial, London', 735, 0),
      page('Buckingham Palace', 8525, 127),
    ]).title,
    'Victoria Memorial, London',
  );
  assert.equal(pickFamousPlace([]), null);
  assert.equal(pickFamousPlace([{ title: 'No position' }]), null);
});

// Made-up places around one spot. One degree of latitude is about 111 km,
// so 0.0001 degrees north is about 11 m.
const HERE = [51.5, -0.1];
const north = (metres) => HERE[0] + metres / 111_320;
const thing = (metres, properties) => ({
  geometry: { type: 'Point', coordinates: [HERE[1], north(metres)] },
  properties,
});
const postcodeOnly = (metres) => thing(metres, { type: 'other', name: 'AB1 2CD', postcode: 'AB1 2CD', city: 'Testford' });
const street = (metres) => thing(metres, { type: 'street', name: 'Example Avenue', postcode: 'AB1 3EF', district: 'West Test', city: 'Testford' });
const house = (metres, number, streetName = 'Example Avenue') =>
  thing(metres, { type: 'house', housenumber: number, street: streetName, postcode: 'AB1 3EF', city: 'Testford' });

test('two clicks on one street name the same street', () => {
  // The bug: nearest was a bare postcode for one house and the street for the next.
  const first = chooseAddress([postcodeOnly(51), street(55)], ...HERE);
  const second = chooseAddress([street(40), postcodeOnly(60)], ...HERE);
  assert.equal(first.title, 'Example Avenue');
  assert.equal(second.title, 'Example Avenue');
  assert.equal(first.exact, false);
  assert.equal(first.away, 55);
  // The street's own postcode and district are used, not the bare postcode's.
  assert.equal(first.place, 'West Test, Testford, AB1 3EF');
  assert.equal(second.place, first.place);
});

test('a numbered house close by is the house that was clicked', () => {
  const found = chooseAddress([street(9), house(12, '49'), house(26, '51')], ...HERE);
  assert.deepEqual(
    { title: found.title, exact: found.exact, away: found.away, guide: found.guide },
    { title: '49 Example Avenue', exact: true, away: 12, guide: null },
  );
  const named = chooseAddress([thing(8, { type: 'house', name: 'The Old Bakery', housenumber: '7', street: 'Mill Lane', city: 'Testford' })], ...HERE);
  assert.equal(named.title, 'The Old Bakery, 7 Mill Lane');
});

test('a numbered house further off is only a guide, not the answer', () => {
  const found = chooseAddress([street(14), house(HOUSE_WITHIN_M + 15, '49')], ...HERE);
  assert.equal(found.title, 'Example Avenue');
  assert.equal(found.exact, false);
  assert.deepEqual(found.guide, { number: '49', away: HOUSE_WITHIN_M + 15 });
  // A numbered house on another street is not a guide for this one.
  const other = chooseAddress([street(14), house(40, '3', 'Other Road')], ...HERE);
  assert.equal(other.title, 'Example Avenue');
  assert.equal(other.guide, null);
});

test('with no street nearby the nearest name is used, and nothing gives nothing', () => {
  const village = chooseAddress([thing(900, { type: 'locality', name: 'Little Testing', city: 'Testford' })], ...HERE);
  assert.equal(village.title, 'Little Testing');
  assert.equal(village.exact, false);
  const farStreet = chooseAddress([street(STREET_WITHIN_M + 50), postcodeOnly(20)], ...HERE);
  assert.equal(farStreet.title, 'AB1 2CD');
  assert.equal(chooseAddress([], ...HERE), null);
  assert.equal(chooseAddress(null, ...HERE), null);
  assert.equal(chooseAddress([{ properties: { name: 'No position' } }], ...HERE), null);
});

/** A clock the test moves by hand, so waits take no real time. */
function handClock() {
  let time = 10_000;
  const sleepers = [];
  return {
    now: () => time,
    sleep: (ms) => new Promise((resolve) => sleepers.push({ at: time + ms, resolve })),
    async advance(ms) {
      time += ms;
      for (const sleeper of sleepers.filter((one) => one.at <= time)) {
        sleepers.splice(sleepers.indexOf(sleeper), 1);
        sleeper.resolve();
      }
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

test('quick clicks send one address request a second, for the newest click only', async () => {
  const clock = handClock();
  const mayAsk = requestGate(1000, clock.now, clock.sleep);
  let latest = 0;
  const sent = [];
  const click = (n) => {
    latest = n;
    return mayAsk(() => latest === n).then((go) => {
      if (go) sent.push([n, clock.now()]);
    });
  };
  const clicks = [];
  for (let n = 1; n <= 5; n += 1) {
    clicks.push(click(n));
    await clock.advance(150);
  }
  await clock.advance(1000);
  await Promise.all(clicks);
  assert.deepEqual(sent.map(([n]) => n), [1, 5]);
  assert.ok(sent[1][1] - sent[0][1] >= 1000, JSON.stringify(sent));
});

test('the map pin card announces the address once, never its ticking clock', () => {
  const doc = fakeDocument();
  const viewer = {
    scene: { canvas: doc.createElement('canvas'), primitives: { add: (p) => p, remove() {} }, requestRender() {}, isDestroyed: () => false },
    camera: {},
  };
  // Cesium's click handler looks for the page's document.
  const before = globalThis.document;
  globalThis.document = doc;
  try {
    const remove = installAddressLookup({ viewer }, doc);
    const card = doc.getElementById('address-card');
    assert.notEqual(card.getAttribute('role'), 'status', 'a live card reads its clock out every second');
    assert.equal(card.getAttribute('role'), 'region');
    assert.ok(card.getAttribute('aria-label'));
    const live = card.querySelectorAll('[role=status]');
    assert.equal(live.length, 1, 'one live part: the address lines');
    const clock = doc.getElementById('address-card-sun').parentNode;
    assert.ok(!live[0].contains(clock), 'the clock is outside the live part');
    remove();
  } finally {
    if (before === undefined) delete globalThis.document;
    else globalThis.document = before;
  }
});
