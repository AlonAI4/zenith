import assert from 'node:assert/strict';
import test from 'node:test';

import { fakeDocument } from './fakeDom.mjs';
import {
  addPlace,
  cleanName,
  describePlace,
  flySeconds,
  installSavedPlaces,
  isLook,
  isPlace,
  lookChanges,
  MAX_NAME,
  MAX_PLACES,
  parsePlaces,
  removePlace,
  routeOf,
} from './savedPlaces.js';

/** The saved-places panel in a fake page, with the camera over London. */
function panelInFakePage(storage, { reduceMotion = false } = {}) {
  const doc = fakeDocument();
  doc.defaultView.matchMedia = (query) => ({ matches: reduceMotion && query.includes('prefers-reduced-motion: reduce') });
  const bar = doc.createElement('div');
  bar.id = 'top-center-actions';
  doc.body.appendChild(bar);
  const camera = {
    positionCartographic: { longitude: -0.0022, latitude: 0.8988, height: 900 },
    heading: 0.35,
    pitch: -0.6,
    flights: [],
    flyTo(options) {
      this.flights.push(options);
    },
    cancelFlight() {},
    lookAtTransform() {},
  };
  installSavedPlaces({ viewer: { camera } }, doc, { storage, win: doc.defaultView });
  const panel = doc.getElementById('saved-places');
  const form = panel.querySelector('form');
  return {
    toggle: doc.getElementById('saved-places-toggle'),
    close: panel.querySelector('.sp-close'),
    save(name) {
      form.querySelector('input').value = name;
      form.dispatchEvent(new Event('submit', { cancelable: true }));
    },
    names: () => panel.querySelectorAll('.sp-name').map((node) => node.textContent),
    note: () => panel.querySelector('.sp-note').textContent,
    panel,
    doc,
    camera,
  };
}

const place = (name, extra = {}) => ({
  name,
  lon: -0.0754,
  lat: 51.5055,
  height: 900,
  heading: 20,
  pitch: -35,
  ...extra,
});

test('names are trimmed, single-spaced and capped', () => {
  assert.equal(cleanName('  Tower   Bridge \n'), 'Tower Bridge');
  assert.equal(cleanName(''), '');
  assert.equal(cleanName(null), '');
  assert.equal(cleanName('x'.repeat(200)).length, MAX_NAME);
});

test('only a complete, sensible record counts as a place', () => {
  assert.equal(isPlace(place('Home view')), true);
  assert.equal(isPlace(place('')), false);
  assert.equal(isPlace(place('  padded ')), false);
  assert.equal(isPlace(place('A', { lat: 91 })), false);
  assert.equal(isPlace(place('A', { lon: Number.NaN })), false);
  assert.equal(isPlace(place('A', { height: '900' })), false);
  assert.equal(isPlace(place('A', { pitch: -120 })), false);
  assert.equal(isPlace(null), false);
  // Zoom has no limit, so a view from billions of km out is still a place.
  assert.equal(isPlace(place('Far out', { height: 6.8e13 })), true);
});

test('damaged storage gives an empty list, never an error', () => {
  assert.deepEqual(parsePlaces(null), []);
  assert.deepEqual(parsePlaces('not json'), []);
  assert.deepEqual(parsePlaces('{"name":"x"}'), []);
  const text = JSON.stringify([place('Good'), { name: 'Bad' }, place('Also good')]);
  assert.deepEqual(parsePlaces(text).map((entry) => entry.name), ['Good', 'Also good']);
});

test('a new place goes on top, the same name is replaced, and the list is capped', () => {
  let list = [];
  list = addPlace(list, place('One'));
  list = addPlace(list, place('Two'));
  assert.deepEqual(list.map((entry) => entry.name), ['Two', 'One']);
  list = addPlace(list, place('one', { height: 5000 }));
  assert.deepEqual(list.map((entry) => entry.name), ['one', 'Two']);
  assert.equal(list[0].height, 5000);
  assert.equal(addPlace(list, place('')), list);
  for (let i = 0; i < MAX_PLACES + 10; i++) list = addPlace(list, place(`Place ${i}`));
  assert.equal(list.length, MAX_PLACES);
  assert.equal(list[0].name, `Place ${MAX_PLACES + 9}`);
});

test('deleting removes exactly that place', () => {
  const list = [place('One'), place('Two'), place('Three')];
  assert.deepEqual(removePlace(list, 'Two').map((entry) => entry.name), ['One', 'Three']);
  assert.equal(removePlace(list, 'Nope').length, 3);
});

test('the line under a name says where it is and how high', () => {
  assert.equal(describePlace(place('A')), '51.51°N 0.08°W · 900 m up');
  assert.equal(describePlace(place('B', { lat: -33.87, lon: 151.21, height: 4200 })), '33.87°S 151.21°E · 4.2 km up');
  assert.equal(describePlace(place('C', { height: 14_000_000 })), '51.51°N 0.08°W · 14,000 km up');
});

const look = (extra = {}) => ({ style: 'noir', map: 'photoreal', layers: ['flights'], ...extra });

test('a place saved before looks were remembered still counts', () => {
  assert.equal(isPlace(place('Old one')), true);
  assert.equal(isPlace(place('New one', { look: look() })), true);
  assert.deepEqual(parsePlaces(JSON.stringify([place('Old one')])).length, 1);
});

test('a damaged or odd look is refused', () => {
  assert.equal(isLook(undefined), true);
  assert.equal(isLook(look({ style: null, map: null, layers: [] })), true);
  assert.equal(isLook(null), false);
  assert.equal(isLook(look({ style: 'no spaces allowed' })), false);
  assert.equal(isLook(look({ layers: 'flights' })), false);
  assert.equal(isLook(look({ layers: ['<script>'] })), false);
  assert.equal(isLook(look({ layers: Array.from({ length: 200 }, (_, i) => `l${i}`) })), false);
  assert.equal(isPlace(place('Bad look', { look: look({ map: 7 }) })), false);
});

test('putting a look back changes only what differs', () => {
  const now = { style: 'normal', map: 'photoreal', layers: ['cctv', 'flights'] };
  assert.deepEqual(lookChanges(now, look()), { style: 'noir', map: null, toggle: ['cctv'] });
  assert.deepEqual(lookChanges(now, { style: 'normal', map: 'esri-imagery', layers: ['flights', 'vessels'] }), {
    style: null,
    map: 'esri-imagery',
    toggle: ['cctv', 'vessels'],
  });
  // No look saved: leave everything as it is.
  assert.deepEqual(lookChanges(now, undefined), { style: null, map: null, toggle: [] });
  // A look with no style or map recorded leaves those alone too.
  assert.deepEqual(lookChanges(now, { style: null, map: null, layers: ['cctv', 'flights'] }), { style: null, map: null, toggle: [] });
});

test('a fly-through is unhurried for a short hop and not much longer round the world', () => {
  assert.equal(flySeconds(0), 6);
  assert.equal(flySeconds(20_000), 6);
  assert.ok(Math.abs(flySeconds(500_000) - 9) < 1e-9);
  assert.ok(flySeconds(5_000_000) > flySeconds(500_000));
  assert.ok(flySeconds(20_000_000) <= 16);
  assert.equal(flySeconds(1e12), 16);
  assert.equal(flySeconds(-5), 6);
});

test('a fly-through visits the ticked places in the order they are listed', () => {
  const list = [place('Three'), place('Two'), place('One')];
  assert.deepEqual(routeOf(list, ['One', 'Three']).map((entry) => entry.name), ['Three', 'One']);
  assert.deepEqual(routeOf(list, new Set(['Two', 'Gone'])).map((entry) => entry.name), ['Two']);
  assert.deepEqual(routeOf(list, []), []);
});

test('a place saved while the browser refuses storage survives closing and reopening', () => {
  const refusing = {
    getItem: () => null,
    setItem: () => {
      throw new Error('QuotaExceededError');
    },
  };
  const page = panelInFakePage(refusing);
  page.toggle.click();
  page.save('Home');
  assert.deepEqual(page.names(), ['Home']);
  assert.match(page.note(), /would not save the list/);
  page.close.click();
  page.toggle.click();
  // Reading storage again would bring back its empty list and lose Home.
  assert.deepEqual(page.names(), ['Home']);
});

test('reopening the panel picks up places stored by something else', () => {
  const saved = new Map();
  const storage = { getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
  const page = panelInFakePage(storage);
  page.toggle.click();
  page.save('Home');
  page.close.click();
  // A settings file loaded while the panel was closed.
  saved.set('gev.savedPlaces', JSON.stringify([{ ...JSON.parse(saved.get('gev.savedPlaces'))[0], name: 'Work' }]));
  page.toggle.click();
  assert.deepEqual(page.names(), ['Work']);
});

test('deleting a place with the keyboard moves the focus to the next one, then to the name box', () => {
  const saved = new Map();
  const page = panelInFakePage({ getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) });
  page.toggle.click();
  page.save('Alpha');
  page.save('Bravo');
  const deleteButton = (name) => page.panel.querySelectorAll('.sp-delete').find((node) => node.getAttribute('aria-label') === `Delete ${name}`);
  const first = deleteButton(page.names()[0]);
  first.focus();
  first.click();
  assert.equal(page.names().length, 1);
  assert.ok(page.doc.activeElement.classList.contains('sp-go'), 'focus is on the next place');
  const last = deleteButton(page.names()[0]);
  last.focus();
  last.click();
  assert.ok(page.doc.activeElement === page.panel.querySelector('input'), 'with none left, focus is in the name box');
});

test('with "reduce motion" on, going to a saved place jumps there instead of flying', () => {
  const memory = () => {
    const saved = new Map();
    return { getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
  };
  for (const reduceMotion of [false, true]) {
    const page = panelInFakePage(memory(), { reduceMotion });
    page.toggle.click();
    page.save('Home');
    page.panel.querySelector('.sp-go').click();
    const { duration } = page.camera.flights.at(-1);
    if (reduceMotion) assert.equal(duration, 0);
    else assert.ok(duration > 0);
  }
});

test('heights and coordinates at the rounding edges read cleanly', () => {
  const at = (over) => describePlace(place('X', over));
  assert.match(at({ height: 999.6 }), / · 1\.0 km up$/);
  assert.match(at({ height: 9960 }), / · 10 km up$/);
  assert.match(at({ height: 9940 }), / · 9\.9 km up$/);
  assert.match(at({ lon: -0.001, lat: -0.002 }), /^0\.00° 0\.00° · /, 'a value that rounds to zero has no N, S, E or W');
});

test('a name cut at the length limit never splits a character in two', () => {
  const cut = cleanName(`${'a'.repeat(MAX_NAME - 1)}😀b`);
  assert.ok(cut.isWellFormed(), 'no broken half of an emoji');
  assert.ok([...cut].length <= MAX_NAME);
  assert.ok(cut.endsWith('😀'));
});
