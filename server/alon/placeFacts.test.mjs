import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

import { PbfWriter } from 'pbf';

import {
  NOMINATIM_LOOKUP,
  NOMINATIM_REVERSE,
  OPENFREEMAP_TILES,
  OVERTURE_RELEASES,
  OVERTURE_TILES,
  PHOTON_REVERSE,
  createPlaceFacts,
  describeKind,
  factsFromLookup,
  factsFromNominatim,
  factsFromTile,
  insideOrNear,
  overtureCredit,
  photonIds,
  placeFactsHandler,
  pmtilesDirectory,
  pmtilesFind,
  pmtilesHeader,
  pmtilesTileId,
  ringAreaM2,
  tagNumber,
  thinRing,
  tileFor,
} from './placeFacts.js';

// A 20 m by 10 m building in London, about.
const LAT = 51.5;
const LON = -0.1;
const dLat = 10 / 111_320;
const dLon = 20 / (111_320 * Math.cos((LAT * Math.PI) / 180));
const SQUARE = [
  [LON, LAT],
  [LON + dLon, LAT],
  [LON + dLon, LAT + dLat],
  [LON, LAT + dLat],
  [LON, LAT],
];
const inside = [LAT + dLat / 2, LON + dLon / 2];
// Overture's release list, as much of it as the lookup reads.
const RELEASE = { latest: '2026-09-23.1' };

const nominatimHouse = {
  category: 'building',
  type: 'house',
  name: '',
  extratags: {
    building: 'semidetached_house',
    'building:levels': '2',
    height: '8.5 m',
  },
  address: {
    house_number: '10',
    road: 'Example Road',
    suburb: 'Forest Hill',
    city: 'London',
    postcode: 'SE23 1AA',
  },
  geojson: { type: 'Polygon', coordinates: [SQUARE] },
};

function fakeRequest(path, headers = {}) {
  return {
    method: 'GET',
    url: path,
    headers: {
      host: 'localhost:4173',
      'sec-fetch-site': 'same-origin',
      ...headers,
    },
    socket: {},
  };
}
function fakeResponse() {
  const res = { status: 0, headers: {}, body: null };
  res.writeHead = (status, headers) => Object.assign(res, { status, headers });
  res.setHeader = (name, value) => (res.headers[name] = value);
  res.end = (body) => (res.body = body);
  return res;
}

test('a place is described in plain words', () => {
  assert.equal(describeKind({ building: 'apartments' }), 'Block of flats');
  assert.equal(
    describeKind({ building: 'yes', category: 'building', type: 'yes' }),
    'Building',
  );
  assert.equal(
    describeKind({ building: 'yes', category: 'office', type: 'government' }),
    'Government building',
  );
  assert.equal(describeKind({ type: 'park' }), 'Park');
  assert.equal(describeKind({ building: 'boat_house' }), 'Boat house');
  assert.equal(describeKind({}), 'Place');
});

test('numbers are read from map tags, and the area is close to the real one', () => {
  assert.equal(tagNumber('12'), 12);
  assert.equal(tagNumber('8.5 m'), 8.5);
  assert.equal(tagNumber('3;4'), 3);
  assert.equal(tagNumber('tall'), null);
  assert.equal(tagNumber(undefined), null);
  const area = ringAreaM2(SQUARE);
  assert.ok(Math.abs(area - 200) < 4, `${area} m² instead of about 200`);
});

test('a long outline is thinned and stays closed', () => {
  const ring = Array.from({ length: 1001 }, (_, i) => [
    Math.cos(i / 159),
    Math.sin(i / 159),
  ]);
  ring[1000] = ring[0];
  const thin = thinRing(ring, 100);
  assert.equal(thin.length, 100);
  assert.deepEqual(thin[0], thin[99]);
  assert.equal(thinRing(SQUARE, 100), SQUARE);
});

test('a building counts only when the spot is inside it or on its edge', () => {
  assert.ok(insideOrNear(SQUARE, ...inside));
  assert.ok(
    insideOrNear(SQUARE, LAT - 2 / 111_320, LON + dLon / 2),
    'two metres outside a wall still counts',
  );
  assert.ok(
    !insideOrNear(SQUARE, LAT - 30 / 111_320, LON),
    'thirty metres away is not this building',
  );
});

test('the box gets only the public facts of the building at the spot', () => {
  const facts = factsFromNominatim(
    {
      ...nominatimHouse,
      extratags: {
        ...nominatimHouse.extratags,
        phone: '0123',
        operator: 'Somebody',
      },
    },
    ...inside,
  );
  assert.deepEqual(
    Object.keys(facts).sort(),
    [
      'address',
      'areaM2',
      'floors',
      'heightM',
      'kind',
      'name',
      'outline',
      'place',
      'source',
    ].sort(),
  );
  assert.equal(facts.kind, 'Semi-detached house');
  assert.equal(facts.address, '10 Example Road');
  assert.equal(facts.place, 'Forest Hill, London, SE23 1AA');
  assert.equal(facts.floors, 2);
  assert.equal(facts.heightM, 8.5);
  assert.match(facts.source, /OpenStreetMap/);
  // The nearest building to a spot in a park is not the place clicked.
  assert.equal(factsFromNominatim(nominatimHouse, LAT + 0.001, LON), null);
  // A street or a point is not a building.
  assert.equal(
    factsFromNominatim(
      { category: 'highway', geojson: { type: 'LineString', coordinates: [] } },
      ...inside,
    ),
    null,
  );
});

test('answers are remembered: the same spot is asked once', async () => {
  const asked = [];
  const look = createPlaceFacts({
    requestJson: async (url) => {
      asked.push(url);
      return nominatimHouse;
    },
    nominatimTurn: (work) => work(),
  });
  const first = await look(...inside);
  const again = await look(...inside);
  assert.equal(asked.length, 1);
  assert.equal(first, again);
  assert.match(asked[0], /layer=address/);
  assert.match(asked[0], /polygon_geojson=1/);
});

test('with no building at the spot nothing is found, after Photon, the building tile and Overture are asked', async () => {
  const asked = [];
  const overture = pmtilesFile([{ tile: tileFor(...inside), bytes: buildingTile([], tileFor(...inside)) }]);
  const look = createPlaceFacts({
    requestJson: async (url) => {
      asked.push(new URL(url).host);
      if (url === OPENFREEMAP_TILES)
        return { tiles: [`${OPENFREEMAP_TILES}/v1/{z}/{x}/{y}.pbf`] };
      if (url === OVERTURE_RELEASES) return RELEASE;
      return {
        category: 'amenity',
        type: 'bench',
        geojson: { type: 'Point', coordinates: [LON, LAT] },
      };
    },
    requestBytes: async (url, options) => {
      asked.push(new URL(url).host);
      if (url.startsWith(OVERTURE_TILES)) return served(overture, options);
      return buildingTile([], tileFor(...inside));
    },
    nominatimTurn: (work) => work(),
  });
  assert.equal(await look(...inside), null);
  // No way or relation was named, so no Nominatim lookup. Overture: its
  // release, then its file's header, a further directory and the tile.
  assert.deepEqual(asked, [
    'nominatim.openstreetmap.org',
    'photon.komoot.io',
    'photon.komoot.io',
    'tiles.openfreemap.org',
    'tiles.openfreemap.org',
    'stac.overturemaps.org',
    'tiles.overturemaps.org',
    'tiles.overturemaps.org',
    'tiles.overturemaps.org',
  ]);
});

test('the route answers this page only, checks the spot, and refuses other websites', async () => {
  const handler = placeFactsHandler(
    async () => ({ kind: 'House', outline: SQUARE }),
    () => true,
  );
  const ok = fakeResponse();
  await handler(fakeRequest('/?lat=51.5&lon=-0.1'), ok);
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.body).found, true);
  assert.equal(ok.headers['Cache-Control'], 'no-store');

  const elsewhere = fakeResponse();
  await handler(
    fakeRequest('/?lat=51.5&lon=-0.1', {
      origin: 'https://evil.example',
      'sec-fetch-site': 'cross-site',
    }),
    elsewhere,
  );
  assert.equal(elsewhere.statusCode ?? elsewhere.status, 403);

  for (const bad of ['/', '/?lat=91&lon=0', '/?lat=abc&lon=0', '/?lat=1']) {
    const res = fakeResponse();
    await handler(fakeRequest(bad), res);
    assert.equal(res.status, 400, bad);
  }
  const post = fakeResponse();
  await handler(
    { ...fakeRequest('/?lat=51.5&lon=-0.1'), method: 'POST' },
    post,
  );
  assert.equal(post.status, 405);

  const nothing = fakeResponse();
  await placeFactsHandler(
    async () => null,
    () => true,
  )(fakeRequest('/?lat=51.5&lon=-0.1'), nothing);
  assert.deepEqual(JSON.parse(nothing.body), { found: false });

  const busy = fakeResponse();
  await placeFactsHandler(
    async () => {
      throw Object.assign(new Error('x'), { code: 'BUSY' });
    },
    () => true,
  )(fakeRequest('/?lat=51.5&lon=-0.1'), busy);
  assert.equal(busy.status, 429);

  const limited = fakeResponse();
  await placeFactsHandler(
    async () => null,
    () => false,
  )(fakeRequest('/?lat=51.5&lon=-0.1'), limited);
  assert.equal(limited.status, 429);
});

test('two asks for the same spot share one lookup, and a lookup nobody waits for is called off', async () => {
  let asked = 0;
  let release;
  const look = createPlaceFacts({
    requestJson: async () => {
      asked += 1;
      await new Promise((resolve) => (release = resolve));
      return nominatimHouse;
    },
    nominatimTurn: (work, signal) => {
      signal?.throwIfAborted();
      return work();
    },
  });
  const [a, b] = [look(...inside), look(...inside)];
  await new Promise((resolve) => setImmediate(resolve));
  release();
  assert.equal(await a, await b);
  assert.equal(asked, 1);

  // Everyone left before its turn: the request is never sent.
  let sent = 0;
  const gate = createPlaceFacts({
    requestJson: async () => {
      sent += 1;
      return nominatimHouse;
    },
    nominatimTurn: async (work, signal) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      signal?.throwIfAborted();
      return work();
    },
  });
  const leaving = new AbortController();
  const answer = gate(LAT + 0.01, LON, { signal: leaving.signal });
  leaving.abort();
  await assert.rejects(answer);
  assert.equal(sent, 0);
});

// The test spots from Alon's screenshots: what the free sources really
// answered there (recorded 18 Oct 2026, trimmed to what the lookup reads).
const FIXTURES = JSON.parse(
  readFileSync(new URL('./placeFacts.fixtures.json', import.meta.url), 'utf8'),
);

const zigzag = (value) => (value << 1) ^ (value >> 31);

/**
 * A small OpenFreeMap-style tile with only a building layer, made again from
 * the outlines kept in the fixtures: the real tiles are over half a megabyte.
 */
function buildingTile(buildings, { z, x, y }) {
  const n = 2 ** z;
  const local = ([lon, lat]) => {
    const rad = (lat * Math.PI) / 180;
    const across = ((lon + 180) / 360) * n;
    const down =
      ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n;
    return [Math.round((across - x) * 4096), Math.round((down - y) * 4096)];
  };
  const pbf = new PbfWriter();
  pbf.writeMessage(3, (_, layer) => {
    layer.writeVarintField(15, 2);
    layer.writeStringField(1, 'building');
    // Tags (Overture's sources): every name and value once, in two lists.
    const keys = [];
    const values = [];
    const index = (list, item) => {
      if (!list.includes(item)) list.push(item);
      return list.indexOf(item);
    };
    for (const { rings, properties = {} } of buildings)
      layer.writeMessage(2, (_, feature) => {
        feature.writePackedVarint(2, Object.entries(properties).flatMap(([key, value]) => [index(keys, key), index(values, String(value))]));
        const geometry = [];
        let [cx, cy] = [0, 0];
        for (const ring of rings) {
          const points = ring.slice(0, -1).map(local);
          points.forEach(([px, py], i) => {
            if (i === 0) geometry.push(9); // move to, once
            if (i === 1) geometry.push(((points.length - 1) << 3) | 2); // lines
            geometry.push(zigzag(px - cx), zigzag(py - cy));
            [cx, cy] = [px, py];
          });
          geometry.push(15); // close the ring
        }
        feature.writeVarintField(3, 3); // a polygon
        feature.writePackedVarint(4, geometry);
      });
    for (const key of keys) layer.writeStringField(3, key);
    for (const value of values) layer.writeMessage(4, (_, v) => v.writeStringField(1, value));
    layer.writeVarintField(5, 4096);
  });
  return pbf.finish();
}

/** Numbers as PMTiles writes them: 7 bits a byte, the lowest first. */
function varints(numbers) {
  const out = [];
  for (let value of numbers) {
    while (value >= 128) {
      out.push((value % 128) | 128);
      value = Math.floor(value / 128);
    }
    out.push(value);
  }
  return out;
}

/** A PMTiles directory, before gzip, from its entries ({ id, run, offset, length }). */
function directoryBytes(entries) {
  return Uint8Array.from([
    ...varints([entries.length]),
    ...varints(entries.map((e, i) => e.id - (entries[i - 1]?.id ?? 0))),
    ...varints(entries.map((e) => e.run)),
    ...varints(entries.map((e) => e.length)),
    // 0 means "right after the one before", as the real files write it.
    ...varints(entries.map((e, i) => (i > 0 && e.offset === entries[i - 1].offset + entries[i - 1].length ? 0 : e.offset + 1))),
  ]);
}

/**
 * A small PMTiles file in Overture's form (gzip, vector tiles, zooms 0 to 14)
 * holding the given tiles, listed in a further directory as in the real
 * 180 GB file, whose first directory points to its further ones.
 */
function pmtilesFile(tiles) {
  const sorted = tiles
    .map(({ tile: { z, x, y }, bytes }) => ({ id: pmtilesTileId(z, x, y), zipped: gzipSync(bytes) }))
    .sort((a, b) => a.id - b.id);
  let at = 0;
  const entries = sorted.map(({ id, zipped }) => {
    const entry = { id, run: 1, offset: at, length: zipped.length };
    at += zipped.length;
    return entry;
  });
  const leaf = gzipSync(directoryBytes(entries));
  const root = gzipSync(directoryBytes([{ id: entries[0].id, run: 0, offset: 0, length: leaf.length }]));
  const header = new Uint8Array(127);
  const view = new DataView(header.buffer);
  header.set(new TextEncoder().encode('PMTiles'));
  header[7] = 3;
  const put = (where, value) => view.setBigUint64(where, BigInt(value), true);
  put(8, 127);
  put(16, root.length);
  put(40, 127 + root.length);
  put(48, leaf.length);
  put(56, 127 + root.length + leaf.length);
  put(64, at);
  Object.assign(header, { 97: 2, 98: 2, 99: 1, 100: 0, 101: 14 });
  return Buffer.concat([header, root, leaf, ...sorted.map(({ zipped }) => zipped)]);
}

/** The part of a file a range read asks for, as a server sends it. */
function served(file, { range } = {}) {
  assert.ok(range, 'Overture was read without a range');
  return new Uint8Array(file.subarray(range[0], range[0] + range[1]));
}

// Overture's buildings around the recorded spots, as one small file.
const OVERTURE_FILE = pmtilesFile(
  Object.entries(FIXTURES.overtureTiles).map(([key, buildings]) => {
    const [z, x, y] = key.split('/').map(Number);
    return { tile: { z, x, y }, bytes: buildingTile(buildings, { z, x, y }) };
  }),
);

/** A lookup that answers only from the recorded answers, and lists its asks. */
function recorded() {
  const asked = [];
  let spot = null;
  const facts = createPlaceFacts({
    requestJson: async (url) => {
      const kind = url.startsWith(NOMINATIM_REVERSE)
        ? 'reverse'
        : url.startsWith(NOMINATIM_LOOKUP)
          ? 'lookup'
          : url.startsWith(PHOTON_REVERSE)
            ? url.includes('osm_tag=')
              ? 'photonStadium'
              : 'photonAny'
            : url === OPENFREEMAP_TILES
              ? 'tileList'
              : url === OVERTURE_RELEASES
                ? 'overtureRelease'
                : url;
      asked.push(kind);
      const answer = { tileList: FIXTURES.tileList, overtureRelease: FIXTURES.overtureRelease }[kind] ?? spot[kind];
      if (!answer) throw new Error(`nothing recorded for ${kind}`);
      return structuredClone(answer);
    },
    requestBytes: async (url, options) => {
      if (url.startsWith(OVERTURE_TILES)) {
        asked.push('overture');
        assert.equal(url, `${OVERTURE_TILES}/${FIXTURES.overtureRelease.latest}/buildings.pmtiles`);
        return served(OVERTURE_FILE, options);
      }
      asked.push('tile');
      const [z, x, y] = /(\d+)\/(\d+)\/(\d+)\.pbf$/
        .exec(url)
        .slice(1)
        .map(Number);
      assert.equal(`${z}/${x}/${y}`, spot.tile);
      return buildingTile(FIXTURES.tiles[spot.tile], { z, x, y });
    },
    nominatimTurn: (work) => work(),
  });
  const look = (name) => {
    spot = FIXTURES.spots[name];
    return facts(...spot.spot);
  };
  return { asked, look };
}

/** The found facts as recorded, and an outline that holds the spot. */
function assertFound(facts, name) {
  const { spot, expected } = FIXTURES.spots[name];
  assert.ok(facts, `${name}: nothing found`);
  for (const [key, value] of Object.entries(expected))
    assert.equal(facts[key], value, `${name}: ${key}`);
  assert.ok(insideOrNear(facts.outline, ...spot), `${name}: spot not inside`);
}

test('Anfield is found from both clicks, as the whole stadium, through Photon and one lookup', async () => {
  for (const name of ['anfield-stand', 'anfield-front']) {
    const { asked, look } = recorded();
    const facts = await look(name);
    assertFound(facts, name);
    assert.equal(facts.name, 'Anfield');
    assert.deepEqual(asked, ['reverse', 'photonAny', 'photonStadium', 'lookup']);
  }
});

test('the Pentagon is found through Photon and one lookup', async () => {
  const { asked, look } = recorded();
  const facts = await look('pentagon');
  assertFound(facts, 'pentagon');
  assert.equal(facts.name, 'The Pentagon');
  assert.equal(asked.at(-1), 'lookup');
});

test('the two Montjuic clicks find two different blocks of flats in the building tile, fetched once', async () => {
  const { asked, look } = recorded();
  const a = await look('montjuic-a');
  const b = await look('montjuic-b');
  assertFound(a, 'montjuic-a');
  assertFound(b, 'montjuic-b');
  assert.notDeepEqual(a.outline, b.outline);
  assert.ok(!insideOrNear(a.outline, ...FIXTURES.spots['montjuic-b'].spot, 0));
  // The street comes from the reverse lookup's address point, only when it is
  // inside the outline; Photon named no building there, so no lookup.
  assert.equal(a.address, '9 Carrer del Nerbion');
  assert.equal(b.address, '');
  assert.deepEqual(asked, [
    ...['reverse', 'photonAny', 'photonStadium', 'tileList', 'tile'],
    ...['reverse', 'photonAny', 'photonStadium'],
  ]);
});

test('Spotify Camp Nou stays NO MATCH: the click is outside the stadium as mapped', async () => {
  const { asked, look } = recorded();
  assert.equal(await look('camp-nou'), null);
  const stadium = FIXTURES.spots['camp-nou'].photonStadium.features[0];
  assert.equal(stadium.properties.name, 'Spotify Camp Nou');
  assert.deepEqual(asked, [
    ...['reverse', 'photonAny', 'photonStadium', 'tileList', 'tile'],
    ...['overtureRelease', 'overture', 'overture', 'overture'],
  ]);
});

test('a house OpenStreetMap has no outline for (Soweto) is found in Overture, with its makers named', async () => {
  const { asked, look } = recorded();
  const facts = await look('soweto');
  assertFound(facts, 'soweto');
  assert.match(facts.source, /OpenStreetMap contributors, Overture Maps Foundation; Microsoft ML Buildings$/);
  // The reverse lookup's address point is the street, not in the house.
  assert.equal(facts.address, '');
  assert.deepEqual(asked, [
    ...['reverse', 'photonAny', 'photonStadium', 'tileList', 'tile'],
    // Overture's release, its file's start, a further directory, the tile.
    ...['overtureRelease', 'overture', 'overture', 'overture'],
  ]);
});

test('the Texas Capitol is unchanged: the address lookup alone finds it, same outline', async () => {
  const { asked, look } = recorded();
  const facts = await look('capitol');
  assertFound(facts, 'capitol');
  const { reverse, spot } = FIXTURES.spots.capitol;
  assert.deepEqual(facts, factsFromNominatim(reverse, ...spot));
  assert.deepEqual(asked, ['reverse']);
});

test('only the ways and relations Photon names around the spot are looked up', () => {
  const at = (osm_type, osm_id, extra = {}) => ({
    properties: { osm_type, osm_id, osm_key: 'building', ...extra },
  });
  const around = { extent: [LON - 0.001, LAT + 0.001, LON + 0.001, LAT - 0.001] };
  const away = { extent: [LON + 0.01, LAT + 0.011, LON + 0.012, LAT + 0.01] };
  const ids = photonIds(
    [
      {
        features: [
          at('W', 1, around),
          at('N', 2, around),
          at('W', 3, away),
          at('R', 4),
          at('W', 5, { ...around, osm_key: 'highway' }),
          // A nature reserve round the spot, kilometres wide.
          at('R', 7, { extent: [LON - 0.03, LAT + 0.03, LON + 0.03, LAT - 0.03] }),
          at('W', 1, around),
        ],
      },
      null,
      { features: [at('W', 'six', around)] },
    ],
    LAT,
    LON,
  );
  assert.deepEqual(ids, ['W1', 'R4']);
  const many = { features: Array.from({ length: 80 }, (_, i) => at('W', i)) };
  assert.equal(photonIds([many], LAT, LON).length, 50);
});

test('a stadium holding the spot beats its stand, and a building the spot is inside beats one it is near', () => {
  const ring = (dE, dN, wM, hM) => {
    const [x, y] = [LON + (dE * dLon) / 20, LAT + (dN * dLat) / 10];
    const [w, h] = [(wM * dLon) / 20, (hM * dLat) / 10];
    return [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]];
  };
  const answer = (category, type, outline, extratags = {}) => ({
    category,
    type,
    name: type,
    extratags,
    geojson: { type: 'Polygon', coordinates: [outline] },
  });
  const ground = answer('leisure', 'stadium', ring(-200, -150, 400, 300));
  const stand = answer('building', 'stand', ring(-20, -20, 60, 40));
  const park = answer('leisure', 'park', ring(-10, -10, 30, 30));
  assert.equal(factsFromLookup([stand, park, ground], LAT, LON).name, 'stadium');
  assert.equal(factsFromLookup([stand, park], LAT, LON).name, 'stand');
  // Two metres outside a stadium's edge, inside a shed: the shed.
  const edge = answer('leisure', 'stadium', ring(2, -50, 100, 100));
  const shed = answer('building', 'shed', ring(-5, -5, 10, 10));
  assert.equal(factsFromLookup([edge, shed], LAT, LON).name, 'shed');
  assert.equal(factsFromLookup([edge], LAT, LON).name, 'stadium');
  // Next to two buildings and inside neither: the smaller.
  const small = answer('building', 'small', ring(1, -5, 10, 10));
  const long = answer('building', 'long', ring(-31, -50, 30, 100));
  assert.equal(factsFromLookup([long, small], LAT, LON).name, 'small');
  assert.equal(factsFromLookup(null, LAT, LON), null);
  assert.equal(factsFromLookup([park], LAT, LON), null);
});

test('the tile holding a spot, and the whole building in it, not one of its parts', () => {
  assert.deepEqual(tileFor(...FIXTURES.spots['montjuic-a'].spot), {
    z: 14,
    x: 8289,
    y: 6120,
  });
  assert.deepEqual(tileFor(90, 180), { z: 14, x: 16383, y: 0 });
  assert.deepEqual(tileFor(-90, -180), { z: 14, x: 0, y: 16383 });
  const tile = tileFor(...inside);
  const big = [
    [LON - dLon, LAT - dLat],
    [LON + 2 * dLon, LAT - dLat],
    [LON + 2 * dLon, LAT + 2 * dLat],
    [LON - dLon, LAT + 2 * dLat],
    [LON - dLon, LAT - dLat],
  ];
  const bytes = buildingTile([{ rings: [big] }, { rings: [SQUARE] }], tile);
  const facts = factsFromTile(bytes, tile, ...inside);
  assert.ok(Math.abs(facts.areaM2 - 1800) < 40, `${facts.areaM2} m²`);
  assert.equal(facts.kind, 'Building');
  assert.match(facts.source, /OpenStreetMap.*OpenFreeMap/);
  assert.equal(factsFromTile(bytes, tile, LAT + 0.01, LON), null);
  assert.equal(factsFromTile(new Uint8Array([255, 1, 2]), tile, ...inside), null);
  assert.equal(factsFromTile(new PbfWriter().finish(), tile, ...inside), null);
});

test('a failing source is skipped; when nothing is found the failure is passed on and not remembered', async () => {
  const square = { rings: [SQUARE] };
  let photonDown = true;
  let tileList = { tiles: [`${OPENFREEMAP_TILES}/v1/{z}/{x}/{y}.pbf`] };
  let tiles = 0;
  const look = createPlaceFacts({
    requestJson: async (url) => {
      if (url.startsWith(NOMINATIM_REVERSE)) return { category: 'place' };
      if (url.startsWith(PHOTON_REVERSE) && photonDown)
        throw new Error('Photon is down');
      if (url === OPENFREEMAP_TILES) return tileList;
      return { features: [] };
    },
    requestBytes: async () => {
      tiles += 1;
      return buildingTile([square], tileFor(...inside));
    },
    nominatimTurn: (work) => work(),
  });
  const found = await look(...inside);
  assert.ok(insideOrNear(found.outline, ...inside, 0));

  // A tile address on another website is refused: nothing found, error.
  const elsewhere = createPlaceFacts({
    requestJson: async (url) => {
      if (url === OPENFREEMAP_TILES)
        return { tiles: ['https://tiles.openfreemap.org.evil.example/{z}/{x}/{y}.pbf'] };
      if (url.startsWith(PHOTON_REVERSE)) throw new Error('Photon is down');
      return { category: 'place' };
    },
    requestBytes: async () => {
      fetched += 1;
      return buildingTile([square], tileFor(...inside));
    },
    nominatimTurn: (work) => work(),
  });
  let fetched = 0;
  await assert.rejects(elsewhere(...inside), /Photon is down/);
  assert.equal(fetched, 0, 'a tile was fetched from another website');

  // Nothing remembered after a failure: the next ask tries again.
  let listDown = true;
  let fetches = 0;
  const empty = pmtilesFile([{ tile: tileFor(...inside), bytes: buildingTile([], tileFor(...inside)) }]);
  const flaky = createPlaceFacts({
    requestJson: async (url) => {
      if (url.startsWith(NOMINATIM_REVERSE)) return { category: 'place' };
      if (url === OPENFREEMAP_TILES) {
        if (listDown) throw new Error('OpenFreeMap is down');
        return { tiles: [`${OPENFREEMAP_TILES}/v1/{z}/{x}/{y}.pbf`] };
      }
      if (url === OVERTURE_RELEASES) return RELEASE;
      return { features: [] };
    },
    requestBytes: async (url, options) => {
      if (url.startsWith(OVERTURE_TILES)) return served(empty, options);
      fetches += 1;
      return buildingTile([], tileFor(...inside));
    },
    nominatimTurn: (work) => work(),
  });
  await assert.rejects(flaky(...inside), /OpenFreeMap is down/);
  listDown = false;
  assert.equal(await flaky(...inside), null);
  assert.equal(await flaky(...inside), null, 'remembered this time');
  assert.equal(fetches, 1);
});

test('inside the Camp Nou bowl, the whole stadium, not one of its tiers', () => {
  const tile = { z: 14, x: 8288, y: 6119 };
  const bytes = buildingTile(FIXTURES.tiles['14/8288/6119'], tile);
  const facts = factsFromTile(bytes, tile, 41.38086, 2.12281);
  assert.ok(Math.abs(facts.areaM2 - 29_639) < 300, `${facts.areaM2} m²`);
});

test('an answer found while another source failed is shown, not remembered', async () => {
  const named = {
    ...nominatimHouse,
    name: 'The Grand Stand',
    category: 'leisure',
    type: 'stadium',
    extratags: {},
  };
  let lookups = 0;
  const look = createPlaceFacts({
    requestJson: async (url) => {
      if (url.startsWith(NOMINATIM_REVERSE)) return { category: 'place' };
      if (url.startsWith(PHOTON_REVERSE))
        return { features: [{ properties: { osm_type: 'W', osm_id: 1 } }] };
      if (url.startsWith(NOMINATIM_LOOKUP)) {
        lookups += 1;
        if (lookups === 1)
          throw Object.assign(new Error('full'), { code: 'NOMINATIM_QUEUE_FULL' });
        return [named];
      }
      return { tiles: [`${OPENFREEMAP_TILES}/v1/{z}/{x}/{y}.pbf`] };
    },
    requestBytes: async () => buildingTile([{ rings: [SQUARE] }], tileFor(...inside)),
    nominatimTurn: (work) => work(),
  });
  const first = await look(...inside);
  assert.equal(first.name, '', 'the tile outline while the lookup was busy');
  const again = await look(...inside);
  assert.equal(again.name, 'The Grand Stand');
  assert.equal(lookups, 2);
});

test('a lookup everyone left stops before its next source, and a new ask starts afresh', async () => {
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const asked = [];
  const look = createPlaceFacts({
    requestJson: async (url) => {
      asked.push(new URL(url).host);
      if (url.startsWith(NOMINATIM_REVERSE)) return { category: 'place' };
      if (url.startsWith(PHOTON_REVERSE)) {
        await held;
        return { features: [] };
      }
      return { tiles: [`${OPENFREEMAP_TILES}/v1/{z}/{x}/{y}.pbf`] };
    },
    requestBytes: async () => {
      asked.push('tile');
      return buildingTile([{ rings: [SQUARE] }], tileFor(...inside));
    },
    nominatimTurn: (work, signal) => {
      signal?.throwIfAborted();
      return work();
    },
  });
  const leaving = new AbortController();
  const first = look(...inside, { signal: leaving.signal });
  await new Promise((resolve) => setImmediate(resolve));
  leaving.abort(); // the page moved on while Photon was answering
  const second = look(...inside);
  release();
  await assert.rejects(first, { name: 'AbortError' });
  assert.ok(insideOrNear((await second).outline, ...inside, 0));
  // Two reverse lookups, and one tile list and tile: the first lookup
  // stopped before them.
  assert.equal(asked.filter((host) => host.startsWith('nominatim')).length, 2);
  assert.equal(asked.filter((host) => host === 'tile').length, 1);
});

test('PMTiles: tile numbers, directories and further directories are read as the format says', () => {
  // The format's own examples: zoom 0, the four tiles of zoom 1, and one deep tile.
  const ids = [[0, 0, 0], [1, 0, 0], [1, 0, 1], [1, 1, 1], [1, 1, 0], [2, 0, 0], [12, 3423, 1763]];
  assert.deepEqual(ids.map((zxy) => pmtilesTileId(...zxy)), [0, 1, 2, 3, 4, 5, 19_078_479]);
  const entries = [
    { id: 5, run: 1, offset: 0, length: 300 },
    { id: 6, run: 3, offset: 300, length: 200 }, // right after the one before
    { id: 200, run: 0, offset: 70_000, length: 1000 }, // a further directory
    { id: 300_000_000, run: 1, offset: 2 ** 40, length: 5 }, // big numbers
  ];
  assert.deepEqual(pmtilesDirectory(directoryBytes(entries)), entries);
  assert.equal(pmtilesFind(entries, 4), null);
  assert.equal(pmtilesFind(entries, 8).tile, entries[1]);
  assert.equal(pmtilesFind(entries, 9), null, 'past the run of the same tile');
  assert.equal(pmtilesFind(entries, 250).leaf, entries[2]);
  assert.equal(pmtilesFind([], 1), null);
  assert.throws(() => pmtilesDirectory(Uint8Array.from([3, 1, 0x80])), /damaged/);
  assert.throws(() => pmtilesDirectory(Uint8Array.from([200, 1])), /damaged/);

  const file = pmtilesFile([{ tile: { z: 14, x: 1, y: 2 }, bytes: new Uint8Array(3) }]);
  const header = pmtilesHeader(file);
  assert.equal(header.maxZoom, 14);
  assert.equal(header.rootOffset, 127);
  const brotli = Uint8Array.from(file);
  brotli[98] = 3;
  assert.throws(() => pmtilesHeader(brotli), /cannot read/);
  assert.throws(() => pmtilesHeader(new TextEncoder().encode('{"tiles":[]}')), /Not a PMTiles/);
});

test('Overture is read only from its own address, in parts, and its file is opened once a day', async () => {
  const tile = tileFor(...inside);
  const file = pmtilesFile([{ tile, bytes: buildingTile([{ rings: [SQUARE], properties: { sources: '[{"dataset":"Google Open Buildings"}]' } }], tile) }]);
  const reads = [];
  let release = { latest: '../../evil.example/x' };
  let releases = 0;
  const look = createPlaceFacts({
    requestJson: async (url) => {
      if (url === OVERTURE_RELEASES) {
        releases += 1;
        return release;
      }
      if (url === OPENFREEMAP_TILES) return { tiles: [`${OPENFREEMAP_TILES}/v1/{z}/{x}/{y}.pbf`] };
      return url.startsWith(NOMINATIM_REVERSE) ? { category: 'place' } : { features: [] };
    },
    requestBytes: async (url, options) => {
      if (!url.startsWith(OPENFREEMAP_TILES)) reads.push(url);
      return url.startsWith(OPENFREEMAP_TILES) ? buildingTile([], tile) : served(file, options);
    },
    nominatimTurn: (work) => work(),
  });
  // A release name that is not a date would make another address: refused.
  await assert.rejects(look(...inside), /no release/);
  assert.deepEqual(reads, []);

  release = RELEASE;
  const found = await look(...inside);
  assert.match(found.source, /Overture Maps Foundation; Google Open Buildings$/);
  assert.ok(reads.every((url) => url === `${OVERTURE_TILES}/2026-09-23.1/buildings.pmtiles`));
  assert.equal(reads.length, 3);
  // A second spot in the same tile: the file and the tile are not read again.
  const next = await look(inside[0] + dLat / 4, inside[1]);
  assert.ok(next);
  assert.equal(reads.length, 3);
  assert.equal(releases, 2, 'the release list was asked again');
});

test("Overture's source line names OpenStreetMap once, and each tracing company once", () => {
  const sources = (...datasets) => ({ sources: JSON.stringify(datasets.map((dataset) => ({ dataset }))) });
  const plain = 'Map data © OpenStreetMap contributors, Overture Maps Foundation';
  assert.equal(overtureCredit(sources('OpenStreetMap')), plain);
  assert.equal(overtureCredit(sources('Microsoft ML Buildings', 'Microsoft ML Buildings', 'OpenStreetMap')), `${plain}; Microsoft ML Buildings`);
  assert.equal(overtureCredit(sources('Esri Community Maps', 'Google Open Buildings')), `${plain}; Esri Community Maps; Google Open Buildings`);
  assert.equal(overtureCredit({ sources: 'not json' }), plain);
  assert.equal(overtureCredit({}), plain);
  assert.equal(overtureCredit(sources('<img src=x>', 'x'.repeat(90))), plain);
});
