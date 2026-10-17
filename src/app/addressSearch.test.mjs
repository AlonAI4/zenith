import assert from 'node:assert/strict';
import test from 'node:test';

import {
  googleHouse,
  townMatches,
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

test('compass words must agree: North Street is not South Street, nor E 42nd St West 42nd Street', () => {
  assert.ok(!sameStreet('North Street', 'South Street'));
  assert.ok(!sameStreet('East Street', 'West Street'));
  assert.ok(!sameStreet('E 42nd St', 'West 42nd Street'));
  assert.ok(sameStreet('E 42nd St', 'East 42nd Street'));
});

test('the best-named street wins: Kings Street is not chosen for King Street', () => {
  const answers = [
    photon(-0.2, 51.6, {
      type: 'house',
      housenumber: '5',
      street: 'Kings Street',
      city: 'London',
    }),
    photon(-0.1, 51.5, { type: 'street', name: 'King Street', city: 'London' }),
  ];
  const hit = chooseAddressHit(answers, parseAddress('5 King Street'));
  assert.equal(hit.kind, 'street');
  assert.equal(hit.lat, 51.5);
});

test('a typed town matches whole words only', () => {
  assert.ok(townMatches('London', ['London Borough of Richmond upon Thames']));
  assert.ok(townMatches('SW1A 2AA', ['City of Westminster', 'SW1A 2AA']));
  assert.ok(!townMatches('Ham', ['Birmingham']));
  assert.ok(!townMatches('Bath', ['Bathgate']));
  assert.ok(townMatches('', ['Anywhere']));
});

test('a postcode and a town is not a street address', () => {
  assert.equal(parseAddress('10115 Berlin'), null);
  assert.equal(parseAddress('75001 Paris'), null);
  assert.ok(parseAddress('10 Berlin Road'));
});

test('spoken addresses have no comma: the town starts after the street word', () => {
  assert.deepEqual(parseAddress('10 downing street london'), {
    number: '10',
    street: 'downing street',
    rest: 'london',
  });
  assert.deepEqual(parseAddress('221B Baker St London'), {
    number: '221b',
    street: 'Baker St',
    rest: 'London',
  });
  // A street word at the end, or in the middle of a name, is left alone.
  assert.equal(parseAddress('5 Park Road').rest, '');
  assert.equal(parseAddress('5 Avenue Road').street, 'Avenue Road');
  assert.deepEqual(parseAddress('120 Earls Court Road'), {
    number: '120',
    street: 'Earls Court Road',
    rest: '',
  });
  assert.deepEqual(parseAddress('4 Old Court Place London'), {
    number: '4',
    street: 'Old Court Place',
    rest: 'London',
  });
});

test("Google's answer counts as the house only when Google knows the building", () => {
  const answer = (location_type, types) => ({
    status: 'OK',
    results: [
      {
        formatted_address: '10 Downing St, London SW1A 2AA, UK',
        geometry: { location: { lat: 51.5034, lng: -0.1276 }, location_type },
        types,
      },
    ],
  });
  assert.deepEqual(googleHouse(answer('ROOFTOP', ['street_address'])), {
    kind: 'house',
    lat: 51.5034,
    lon: -0.1276,
    label: '10 Downing St, London SW1A 2AA, UK',
  });
  assert.equal(
    googleHouse(answer('RANGE_INTERPOLATED', ['street_address'])).kind,
    'house',
  );
  assert.equal(googleHouse(answer('GEOMETRIC_CENTER', ['route'])), null);
  assert.equal(googleHouse({ status: 'ZERO_RESULTS', results: [] }), null);
  assert.equal(googleHouse(null), null);
});
