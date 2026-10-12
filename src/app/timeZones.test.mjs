import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { buildZones, simplifyLine, snapRing } from '../../alon-timezones-build.mjs';
import {
  decodeZones,
  offsetLabel,
  offsetMinutes,
  seaZone,
  zoneAt,
  zoneCity,
  zoneClock,
} from './timeZones.js';

const square = (west, south, east, north) => [
  [west, south],
  [east, south],
  [east, north],
  [west, north],
  [west, south],
];

/** Two zones side by side, the eastern one with an island of the western in it. */
const SOURCE = {
  features: [
    {
      properties: { tzid: 'Europe/London' },
      geometry: {
        type: 'MultiPolygon',
        coordinates: [[square(-10, 40, 0, 50)], [square(4, 44, 6, 46)]],
      },
    },
    {
      properties: { tzid: 'Europe/Paris' },
      geometry: {
        type: 'Polygon',
        coordinates: [square(0, 40, 10, 50), square(4, 44, 6, 46)],
      },
    },
  ],
};

test('a point is found in its zone, with islands and holes respected', () => {
  const zones = decodeZones(buildZones(SOURCE));
  assert.equal(zoneAt(zones, 45, -5), 'Europe/London');
  assert.equal(zoneAt(zones, 45, 2), 'Europe/Paris');
  assert.equal(zoneAt(zones, 45, 5), 'Europe/London');
  assert.equal(zoneAt(zones, 41, 9), 'Europe/Paris');
});

test('two zones store the border they share only once', () => {
  const built = buildZones(SOURCE);
  const uses = built.polygons.flatMap(([, rings]) => rings.flat()).length;
  // London's outline and Paris's outline each use the line between them, and
  // the island is London's shape and Paris's hole: six uses of four borders.
  assert.equal(uses, 6);
  assert.equal(built.arcs.length, 4);
});

test('a point outside every shape gets the sea zone for its longitude', () => {
  const zones = decodeZones(buildZones(SOURCE));
  assert.equal(zoneAt(zones, 0, 76), 'Etc/GMT-5');
  assert.equal(seaZone(-140), 'Etc/GMT+9');
  assert.equal(seaZone(3), 'Etc/GMT');
  // The Etc names count backwards: Etc/GMT-5 is five hours AHEAD of UTC.
  assert.equal(offsetMinutes('Etc/GMT-5'), 300);
});

test('simplifying keeps the ends and the corners, and drops the wobble', () => {
  const line = snapRing([
    [0, 0],
    [1, 0.004],
    [2, -0.004],
    [3, 0],
    [3, 3],
  ]);
  assert.equal(simplifyLine([...line, line[0]]).length, 4);
});

test('the bundled file puts well-known cities in the right zone', () => {
  const zones = decodeZones(
    JSON.parse(
      readFileSync(
        new URL('../../public/alon/timezones.json', import.meta.url),
        'utf8',
      ),
    ),
  );
  const at = (lat, lon) => zoneAt(zones, lat, lon);
  assert.equal(at(51.5074, -0.1278), 'Europe/London');
  assert.equal(at(35.6762, 139.6503), 'Asia/Tokyo');
  assert.equal(at(40.7128, -74.006), 'America/New_York');
  assert.equal(at(27.7172, 85.324), 'Asia/Kathmandu');
  // Arizona does not change its clocks; Colorado next door does.
  assert.equal(at(33.4484, -112.074), 'America/Phoenix');
  assert.equal(at(39.7392, -104.9903), 'America/Denver');
  // Zones that keep the same time are stored as one.
  assert.equal(at(40.4168, -3.7038), 'Europe/Paris');
  assert.equal(at(38.7223, -9.1393), 'Europe/London');
  // Two towns 20 km apart on either side of the Spain-Portugal border.
  assert.equal(at(38.8794, -6.9707), 'Europe/Paris');
  assert.equal(at(38.8815, -7.1628), 'Europe/London');
  // Either side of the 180 degree line.
  assert.notEqual(at(-17.7, 178), at(-14.3, -170.7));
});

test('daylight saving: London is an hour ahead in July and not in January', () => {
  const january = new Date(Date.UTC(2026, 0, 15, 12, 0, 5));
  const july = new Date(Date.UTC(2026, 6, 15, 12, 0, 5));
  assert.equal(offsetMinutes('Europe/London', january), 0);
  assert.equal(offsetMinutes('Europe/London', july), 60);
  assert.deepEqual(zoneClock('Europe/London', january), {
    time: '12:00:05',
    day: 'Thu 15 Jan',
    offset: 'UTC',
    summer: false,
    city: 'London',
  });
  assert.deepEqual(zoneClock('Europe/London', july), {
    time: '13:00:05',
    day: 'Wed 15 Jul',
    offset: 'UTC+1',
    summer: true,
    city: 'London',
  });
  // South of the equator summer is in January.
  assert.equal(zoneClock('Australia/Sydney', january).summer, true);
  assert.equal(zoneClock('Australia/Sydney', july).summer, false);
  // Japan never changes its clocks.
  assert.equal(zoneClock('Asia/Tokyo', july).summer, false);
  assert.equal(zoneClock('Asia/Tokyo', july).time, '21:00:05');
});

test('offsets and city names read the way people write them', () => {
  assert.equal(offsetLabel(0), 'UTC');
  assert.equal(offsetLabel(60), 'UTC+1');
  assert.equal(offsetLabel(-210), 'UTC-3:30');
  assert.equal(offsetLabel(345), 'UTC+5:45');
  assert.equal(zoneCity('America/Sao_Paulo'), 'Sao Paulo');
  assert.equal(zoneCity('America/Argentina/Buenos_Aires'), 'Buenos Aires');
  assert.equal(zoneCity('Etc/GMT+12'), '');
});
