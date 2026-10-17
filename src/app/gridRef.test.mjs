import assert from 'node:assert/strict';
import test from 'node:test';

import { gridReference, osgbToGrid, wgs84ToGrid } from './gridRef.js';

const RAD = Math.PI / 180;

test("the projection matches Ordnance Survey's worked example to the millimetre", () => {
  // OSGB36 52°39′27.2531″N 1°43′4.5177″E is E 651409.903, N 313177.270.
  const lat = (52 + 39 / 60 + 27.2531 / 3600) * RAD;
  const lon = (1 + 43 / 60 + 4.5177 / 3600) * RAD;
  const { easting, northing } = osgbToGrid(lat, lon);
  assert.ok(Math.abs(easting - 651409.903) < 0.01, String(easting));
  assert.ok(Math.abs(northing - 313177.27) < 0.01, String(northing));
});

test('GPS positions land within ten metres of the grid the postcode list gives', () => {
  // Postcode centres from postcodes.io: GPS latitude and longitude, and their eastings and northings.
  for (const [name, lat, lon, e, n] of [
    ['SW1A 2AA, London', 51.503541, -0.12767, 530047, 179951],
    ['EH1 1YZ, Edinburgh', 55.950328, -3.193018, 325597, 673676],
    ['PL1 1EA, Plymouth', 50.372508, -4.137794, 248078, 54699],
  ]) {
    const { easting, northing } = wgs84ToGrid(lat, lon);
    const off = Math.hypot(easting - e, northing - n);
    assert.ok(off < 10, `${name} is ${off.toFixed(1)} m off`);
  }
});

test('grid references have the right letters and five-figure numbers', () => {
  assert.match(gridReference(51.503541, -0.12767), /^TQ 300\d\d 799\d\d$/);
  assert.match(gridReference(55.950328, -3.193018), /^NT 255\d\d 736\d\d$/);
  assert.match(gridReference(50.372508, -4.137794), /^SX 480\d\d 546\d\d$/);
});

test('places outside Great Britain have no grid reference', () => {
  assert.equal(gridReference(48.8584, 2.2945), null);
  assert.equal(gridReference(53.3498, -6.2603), null, 'Dublin');
  assert.equal(gridReference(54.5973, -5.9301), null, 'Belfast');
  assert.equal(gridReference(50.9513, 1.8587), null, 'Calais');
  assert.match(gridReference(55.3, -5.8), /^NR /, 'Kintyre stays in');
  assert.equal(gridReference(40.7128, -74.006), null);
  assert.equal(gridReference(Number.NaN, 0), null);
});
