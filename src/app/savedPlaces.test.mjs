import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addPlace,
  cleanName,
  describePlace,
  isPlace,
  MAX_NAME,
  MAX_PLACES,
  parsePlaces,
  removePlace,
} from './savedPlaces.js';

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
