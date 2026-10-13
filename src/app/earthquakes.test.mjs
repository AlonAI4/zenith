import assert from 'node:assert/strict';
import test from 'node:test';

import {
  agoLabel,
  FEED_URL,
  parseQuakes,
  quakeCard,
  quakeColor,
  quakeSize,
} from './earthquakes.js';

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
