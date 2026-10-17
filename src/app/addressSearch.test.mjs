import assert from 'node:assert/strict';
import test from 'node:test';

import {
  chooseAddressHit,
  likeness,
  normalStreet,
  parseAddress,
  sameStreet,
} from './addressSearch.js';

const photon = (lon, lat, properties) => ({
  geometry: { coordinates: [lon, lat] },
  properties,
});

test('a house number then a street is an address; names and coordinates are not', () => {
  assert.deepEqual(parseAddress('10 Downing Street, London'), {
    number: '10',
    street: 'Downing Street',
    rest: 'London',
  });
  assert.deepEqual(parseAddress(' 221B Baker St '), {
    number: '221b',
    street: 'Baker St',
    rest: '',
  });
  assert.deepEqual(parseAddress('12-14 High Road, SE23 1AA'), {
    number: '12',
    street: 'High Road',
    rest: 'SE23 1AA',
  });
  assert.equal(parseAddress('Buckingham Palace'), null);
  assert.equal(parseAddress('51.5, -0.12'), null);
  assert.equal(parseAddress('51.50335 -0.12765'), null);
  assert.equal(parseAddress('1984'), null);
  assert.equal(parseAddress(''), null);
});

test('street names match through short forms and typing mistakes, and different streets do not', () => {
  assert.equal(normalStreet('Downing St.'), 'downing street');
  assert.equal(normalStreet('Honor Oak Rd'), 'honor oak road');
  assert.ok(sameStreet('Downing Stret', 'Downing Street'));
  assert.ok(sameStreet('Baker St', 'Baker Street'));
  assert.ok(sameStreet('Tewkesbury Avnue', 'Tewkesbury Avenue'));
  assert.ok(!sameStreet('Tewkesbury Avenue', 'Tewkesbury Road'));
  assert.ok(!sameStreet('Tewkesbury Avenue', 'Lambert Avenue'));
  assert.equal(likeness('abc', 'abc'), 1);
  assert.equal(likeness('', 'abc'), 0);
});

test('the house is chosen only when its number and its street both match', () => {
  const answers = [
    photon(-0.1276965, 51.5034878, {
      type: 'house',
      housenumber: '10',
      street: 'Downing Street',
      city: 'London',
      district: 'Westminster',
    }),
    photon(-0.1271283, 51.5032088, {
      type: 'street',
      name: 'Downing Street',
      city: 'London',
    }),
    photon(-0.1278499, 51.5034115, {
      type: 'house',
      housenumber: '11',
      street: 'Downing Street',
      city: 'London',
    }),
  ];
  const hit = chooseAddressHit(answers, parseAddress('10 Downing Stret'));
  assert.equal(hit.kind, 'house');
  assert.equal(hit.lat, 51.5034878);
  assert.match(hit.label, /^10 Downing Street/);
});

test('the right number in the wrong town is not the house', () => {
  // What Photon answered for a London street whose number is not mapped.
  const answers = [
    photon(-2.1235654, 51.8636774, {
      type: 'house',
      housenumber: '40',
      street: 'Lambert Avenue',
      city: 'Tewkesbury',
    }),
    photon(-2.1535148, 51.8510402, {
      type: 'house',
      housenumber: '40',
      street: 'Somerdale Avenue',
      city: 'Tewkesbury',
    }),
  ];
  assert.equal(
    chooseAddressHit(answers, parseAddress('40 Tewkesbury Avenue')),
    null,
  );
});

test('with the number not on the map, the street is chosen', () => {
  const answers = [
    photon(-0.06, 51.445, {
      type: 'street',
      name: 'Tewkesbury Avenue',
      city: 'London',
      district: 'Forest Hill',
    }),
    photon(-0.07, 51.446, {
      type: 'house',
      housenumber: '12',
      street: 'Tewkesbury Avenue',
      city: 'London',
    }),
  ];
  const hit = chooseAddressHit(answers, parseAddress('40 Tewkesbury Avenue'));
  assert.equal(hit.kind, 'street');
  assert.equal(hit.lat, 51.445);
  assert.equal(hit.label, 'Tewkesbury Avenue, London');
});

test('a town typed after the comma must match', () => {
  const answers = [
    photon(-0.1, 51.5, {
      type: 'house',
      housenumber: '10',
      street: 'High Street',
      city: 'Bromley',
    }),
  ];
  assert.equal(
    chooseAddressHit(answers, parseAddress('10 High Street, Croydon')),
    null,
  );
  assert.equal(
    chooseAddressHit(answers, parseAddress('10 High Street, Bromley')).kind,
    'house',
  );
  assert.equal(chooseAddressHit(null, parseAddress('10 High Street')), null);
});
