import assert from 'node:assert/strict';
import test from 'node:test';

import {
  describeAddress,
  distanceMetres,
  formatCoordinates,
  inLondon,
  pickFamousPlace,
} from './addressLookup.js';

test('London is in, and Paris, Manchester and the sea are out', () => {
  assert.equal(inLondon(51.5034, -0.1276), true);
  assert.equal(inLondon(51.4623, -0.1152), true);
  assert.equal(inLondon(48.8566, 2.3522), false);
  assert.equal(inLondon(53.4808, -2.2426), false);
  assert.equal(inLondon(51.5, 1.2), false);
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
