import assert from 'node:assert/strict';
import test from 'node:test';

import {
  agoLabel,
  FEED_URL,
  installEarthquakes,
  parseQuakes,
  quakeCard,
  quakeColor,
  quakeSize,
} from './earthquakes.js';
import { fakeDocument } from './fakeDom.mjs';

const feature = (mag, extra = {}, coordinates = [142.4, 38.3, 29.1]) => ({
  type: 'Feature',
  id: `us${mag}`,
  properties: {
    mag,
    place: '70 km E of Sendai, Japan',
    time: Date.parse('2026-10-13T10:00:00Z'),
    type: 'earthquake',
    url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us7000test',
    ...extra,
  },
  geometry: { type: 'Point', coordinates },
});

test('the feed is the official one, over https', () => {
  assert.match(FEED_URL, /^https:\/\/earthquake\.usgs\.gov\/earthquakes\/feed\//);
});

test('earthquakes are read weakest first, so strong ones are drawn on top', () => {
  const quakes = parseQuakes({ features: [feature(6.1), feature(2.7), feature(4.4)] });
  assert.deepEqual(quakes.map((quake) => quake.mag), [2.7, 4.4, 6.1]);
  assert.deepEqual(
    { lon: quakes[0].lon, lat: quakes[0].lat, depthKm: quakes[0].depthKm },
    { lon: 142.4, lat: 38.3, depthKm: 29.1 },
  );
});

test('anything that is not a complete earthquake is left out', () => {
  const quakes = parseQuakes({
    features: [
      feature(3, { type: 'quarry blast' }),
      feature(3, { type: 'explosion' }),
      feature(null),
      feature(3, {}, [200, 10, 5]),
      feature(3, {}, [10, 95, 5]),
      feature(3, { time: 'yesterday' }),
      { nonsense: true },
      null,
      feature(3.3),
    ],
  });
  assert.equal(quakes.length, 1);
  assert.equal(quakes[0].mag, 3.3);
  assert.deepEqual(parseQuakes(null), []);
  assert.deepEqual(parseQuakes({ features: 'none' }), []);
});

test('text and links from outside are kept short and on the official site', () => {
  const [quake] = parseQuakes({
    features: [feature(3, { place: 'x'.repeat(500), url: 'https://evil.example/steal' })],
  });
  assert.equal(quake.place.length, 120);
  assert.equal(quake.url, null);
  assert.equal(parseQuakes({ features: [feature(3)] })[0].url, 'https://earthquake.usgs.gov/earthquakes/eventpage/us7000test');
  assert.equal(parseQuakes({ features: [feature(3, { place: null })] })[0].place, 'Place not given');
});

test('a stronger earthquake is a bigger circle, within limits', () => {
  assert.equal(quakeSize(2.5), 6);
  assert.ok(quakeSize(4) < quakeSize(5) && quakeSize(5) < quakeSize(6.5));
  assert.equal(quakeSize(9.5), 46);
  assert.equal(quakeSize(-1), 6);
  assert.equal(quakeColor(3), '#ffd84d');
  assert.equal(quakeColor(4.8), '#ff9d3d');
  assert.equal(quakeColor(6.8), '#ff4d4d');
});

test('how long ago is said in words', () => {
  assert.equal(agoLabel(30_000), 'just now');
  assert.equal(agoLabel(17 * 60_000), '17 min ago');
  assert.equal(agoLabel(200 * 60_000), '3 h 20 min ago');
  assert.equal(agoLabel(182 * 60_000), '3 h ago');
  assert.equal(agoLabel(23 * 3_600_000 + 40 * 60_000), '23 h ago');
  assert.equal(agoLabel(-5000), 'just now');
});

test('the card gives the strength, the place, the time and the depth', () => {
  const [quake] = parseQuakes({ features: [feature(5.44)] });
  const card = quakeCard(quake, Date.parse('2026-10-13T13:20:00Z'));
  assert.equal(card.title, 'Magnitude 5.4');
  assert.deepEqual(card.details, ['70 km E of Sendai, Japan', '10:00 UTC · 3 h 20 min ago', '29 km deep']);
  const noDepth = quakeCard({ ...quake, depthKm: null }, Date.parse('2026-10-13T10:01:00Z'));
  assert.deepEqual(noDepth.details, ['70 km E of Sendai, Japan', '10:00 UTC · just now']);
});

test('when the feed does not answer, it says so on screen and tries again soon', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const doc = fakeDocument();
  const bar = doc.createElement('div');
  bar.id = 'top-center-actions';
  doc.body.appendChild(bar);
  let asked = 0;
  const fetchFeed = async () => {
    asked += 1;
    if (asked === 1) throw new Error('timeout');
    return { features: [{ id: 'q1', properties: { mag: 4.2, place: 'Somewhere', time: 0 }, geometry: { coordinates: [10, 20, 5] } }] };
  };
  const never = { addEventListener: () => () => {} };
  const viewer = {
    scene: { canvas: doc.createElement('canvas'), primitives: { add: (p) => p, remove() {} }, requestRender() {}, preRender: never },
    camera: {},
    creditDisplay: { addStaticCredit() {}, removeStaticCredit() {} },
  };
  const before = globalThis.document;
  globalThis.document = doc;
  let remove;
  try {
    remove = installEarthquakes({ viewer }, doc, { fetchFeed });
    doc.getElementById('earthquakes-toggle').click();
    await new Promise((resolve) => setImmediate(resolve));
    const notice = doc.getElementById('feed-notice');
    assert.ok(notice && /earthquake feed did not answer/i.test(notice.textContent), 'the failure is on screen, not only in a hover title');
    t.mock.timers.tick(30_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(asked, 2, 'it tries again after 30 seconds, not five minutes');
    assert.equal(doc.getElementById('feed-notice'), null, 'the message goes once the feed answers');
  } finally {
    remove?.();
    if (before === undefined) delete globalThis.document;
    else globalThis.document = before;
  }
});

const edgeFeature = (over = {}) => ({
  id: 'us7000abc',
  properties: { type: 'earthquake', mag: 4.2, time: 1_760_000_000_000, place: 'Somewhere', ...over.properties },
  geometry: { coordinates: over.coordinates ?? [10, 20, 12] },
  ...('id' in over ? { id: over.id } : {}),
});

test('a quake with no id gets one made from its time and place, and long ids are cut', () => {
  const [made] = parseQuakes({ features: [{ ...edgeFeature(), id: undefined }] });
  assert.equal(made.id, '1760000000000:10:20');
  const [long] = parseQuakes({ features: [edgeFeature({ id: 'x'.repeat(100) })] });
  assert.equal(long.id.length, 60);
});

test('a quake with no depth has no depth line on its card', () => {
  const [quake] = parseQuakes({ features: [edgeFeature({ coordinates: [10, 20] })] });
  assert.equal(quake.depthKm, null);
  assert.ok(!quakeCard(quake, quake.time).details.some((line) => /deep/.test(line)));
});

test('only the 600 strongest are kept, weakest first', () => {
  const features = Array.from({ length: 700 }, (_, i) => edgeFeature({ id: `q${i}`, properties: { mag: 2.5 + i / 100 } }));
  const kept = parseQuakes({ features });
  assert.equal(kept.length, 600);
  assert.equal(kept[0].mag, 3.5);
  assert.equal(kept.at(-1).mag, 9.49);
});

test('depths read sensibly, including quakes at or above sea level', () => {
  const card = (depthKm) => quakeCard({ mag: 3, place: 'P', time: 0, depthKm }, 0).details.at(-1);
  assert.equal(card(29.1), '29 km deep');
  assert.equal(card(0.3), 'less than 1 km deep');
  assert.equal(card(-0.8), 'less than 1 km deep');
});
