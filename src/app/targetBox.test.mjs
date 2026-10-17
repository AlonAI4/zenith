import assert from 'node:assert/strict';
import test from 'node:test';

import { formatArea, insideRing, screenBox, targetRows } from './targetBox.js';

test('areas read well at every size', () => {
  assert.equal(formatArea(267), '267 m²');
  assert.equal(formatArea(18236), '1.8 ha');
  assert.equal(formatArea(1_420_000), '1.4 km²');
  assert.equal(formatArea(0), '');
  assert.equal(formatArea(undefined), '');
});

test('the box for a building: kind in the header, then name, address, size, floors and height', () => {
  const { header, rows } = targetRows(
    {
      found: true,
      kind: 'Palace',
      name: 'Buckingham Palace',
      address: 'Buckingham Gate',
      place: 'Victoria, City of Westminster, SW1A 1AA',
      areaM2: 18236,
      floors: 3,
      heightM: 23.4,
      source: 'Map data © OpenStreetMap contributors, via Nominatim',
    },
    51.5014,
    -0.14189,
  );
  assert.equal(header, 'TARGET // PALACE');
  assert.deepEqual(
    rows.map((row) => row.text),
    [
      'Buckingham Palace',
      'Buckingham Gate',
      'Victoria, City of Westminster, SW1A 1AA',
      'Area 1.8 ha',
      '3 floors · 23 m tall',
      '51.50140, -0.14189',
      'Map data © OpenStreetMap contributors, via Nominatim',
    ],
  );
  assert.equal(rows[0].kind, 'title');
});

test('a house with no name leads with its address, and missing facts are left out', () => {
  const { header, rows } = targetRows(
    {
      found: true,
      kind: 'House',
      name: '',
      address: '62 Honor Oak Road',
      place: 'Forest Hill',
      areaM2: 267,
      floors: 1,
      heightM: null,
    },
    51.443,
    -0.057,
  );
  assert.equal(header, 'TARGET // HOUSE');
  assert.equal(rows[0].text, '62 Honor Oak Road');
  assert.ok(rows.some((row) => row.text === '1 floor'));
  assert.ok(!rows.some((row) => /tall|undefined|null/.test(row.text)));
});

test('nothing mapped at the spot says so', () => {
  const { header, rows } = targetRows({ found: false }, 51.5, -0.1);
  assert.equal(header, 'TARGET // NO MATCH');
  assert.match(rows[0].text, /No building or park/);
});

test('a second right-click inside the shown place is recognised', () => {
  const ring = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
    [0, 0],
  ];
  assert.ok(insideRing(ring, 0.5, 0.5));
  assert.ok(!insideRing(ring, 1.5, 0.5));
});

test('the corners wrap the points on screen, and skip points behind the camera', () => {
  assert.deepEqual(
    screenBox([{ x: 10, y: 20 }, undefined, { x: 50, y: 5 }], 2),
    { left: 8, top: 3, right: 52, bottom: 22 },
  );
  assert.equal(screenBox([undefined]), null);
});
