import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPlaceFacts,
  describeKind,
  factsFromNominatim,
  factsFromOverpass,
  insideOrNear,
  pacer,
  placeFactsHandler,
  ringAreaM2,
  stitchOuter,
  tagNumber,
  thinRing,
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

test('the smallest named park around the spot wins, and relations are joined into one ring', () => {
  const big = SQUARE.map(([x, y]) => [x * 1.0001, y * 1.0001]);
  const answer = {
    elements: [
      {
        type: 'way',
        tags: { leisure: 'park', name: 'Big Park' },
        geometry: big.map(([lon, lat]) => ({ lon, lat })),
      },
      {
        type: 'way',
        tags: { leisure: 'garden' },
        geometry: SQUARE.map(([lon, lat]) => ({ lon, lat })),
      },
    ],
  };
  const facts = factsFromOverpass(answer);
  assert.equal(facts.name, 'Big Park');
  assert.equal(facts.kind, 'Park');

  const [a, b, c, d] = SQUARE;
  const ring = stitchOuter([
    { role: 'outer', geometry: [a, b].map(([lon, lat]) => ({ lon, lat })) },
    { role: 'outer', geometry: [d, c].map(([lon, lat]) => ({ lon, lat })) },
    { role: 'inner', geometry: [a, c].map(([lon, lat]) => ({ lon, lat })) },
    { role: 'outer', geometry: [b, c].map(([lon, lat]) => ({ lon, lat })) },
    { role: 'outer', geometry: [d, a].map(([lon, lat]) => ({ lon, lat })) },
  ]);
  assert.equal(ring.length, 5);
  assert.deepEqual(ring[0], ring[4]);
  assert.equal(factsFromOverpass({ elements: [] }), null);
});

test('requests to one service go out at most once a second, and a crowd is refused', async () => {
  let clock = 0;
  const sent = [];
  const turn = pacer(1100, {
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    maxWaiting: 3,
  });
  const work = () => sent.push(clock);
  const all = [turn(work), turn(work), turn(work)];
  await assert.rejects(turn(work), { code: 'BUSY' });
  await Promise.all(all);
  assert.deepEqual(sent, [0, 1100, 2200]);
});

test('answers are remembered: the same spot is asked once', async () => {
  const asked = [];
  const look = createPlaceFacts({
    requestJson: async (url) => {
      asked.push(url);
      return nominatimHouse;
    },
    nominatimTurn: (work) => work(),
    overpassTurn: (work) => work(),
  });
  const first = await look(...inside);
  const again = await look(...inside);
  assert.equal(asked.length, 1);
  assert.equal(first, again);
  assert.match(asked[0], /layer=address/);
  assert.match(asked[0], /polygon_geojson=1/);
});

test('with no building at the spot, the park around it is asked of Overpass, with a backup server', async () => {
  const asked = [];
  const look = createPlaceFacts({
    requestJson: async (url) => {
      asked.push(url);
      if (url.includes('nominatim'))
        return {
          category: 'amenity',
          type: 'bench',
          geojson: { type: 'Point', coordinates: [LON, LAT] },
        };
      if (url.includes('overpass-api.de'))
        throw new Error('Upstream returned 502');
      return {
        elements: [
          {
            type: 'way',
            tags: { leisure: 'park', name: 'Example Park' },
            geometry: SQUARE.map(([lon, lat]) => ({ lon, lat })),
          },
        ],
      };
    },
    nominatimTurn: (work) => work(),
    overpassTurn: (work) => work(),
  });
  const facts = await look(...inside);
  assert.equal(facts.name, 'Example Park');
  assert.equal(asked.length, 3);
  assert.ok(
    !asked[1].includes('+'),
    'spaces in the query are %20, which Overpass reads as spaces',
  );
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

  const parksDown = fakeResponse();
  await placeFactsHandler(
    async () => {
      throw Object.assign(new Error('x'), { code: 'PARKS_DOWN' });
    },
    () => true,
  )(fakeRequest('/?lat=51.5&lon=-0.1'), parksDown);
  assert.equal(parksDown.status, 502);
  assert.match(JSON.parse(parksDown.body).error, /park service/);

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
    overpassTurn: (work) => work(),
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

test('a turn whose asker has gone is skipped', async () => {
  const turn = pacer(1100, { now: () => 0, sleep: async () => {} });
  const gone = new AbortController();
  gone.abort();
  let ran = false;
  await assert.rejects(
    turn(() => (ran = true), gone.signal),
    { name: 'AbortError' },
  );
  assert.equal(ran, false);
});
