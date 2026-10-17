import { clientKey, makeRateLimiter } from '../providers/common/rate-limit.js';
import { sameSiteGated } from '../providers/common/same-site.js';
import { fetchRegionalJson } from '../providers/regional/http.js';
import { enqueueNominatim } from '../providers/regional/place.js';

/**
 * Public map facts about the building or park at a spot, for the target box
 * a right-click opens: what it is, its name and address, its size, its
 * floors and height, and its outline. All from OpenStreetMap.
 *
 * Buildings come from Nominatim's reverse lookup on its address layer, which
 * answers with the building at the spot and its outline. Nominatim has no
 * good answer for parks (it names the nearest bench or post box), so when no
 * building is found the park around the spot is asked of Overpass. Each
 * service gets at most one request a second, answers are remembered, and only
 * the facts listed above are passed on: never who lives or works there.
 */

export const NOMINATIM_REVERSE = 'https://nominatim.openstreetmap.org/reverse';
/** The main Overpass server, then a second public one for when it is down. */
export const OVERPASS = Object.freeze([
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
]);
const HEADERS = Object.freeze({
  'User-Agent': 'Zenith/1.2 (+https://github.com/AlonAI4/zenith)',
  Referer: 'https://github.com/AlonAI4/zenith',
});
const GAP_MS = 1100;
const MAX_WAITING = 4;
const CACHE_MAX = 200;
const MAX_POINTS = 500;
const SOURCE = 'Map data © OpenStreetMap contributors';
const PARKS =
  '^(park|garden|playground|pitch|nature_reserve|common|recreation_ground|dog_park|golf_course)$';

/** Plain names for the kinds of place a box can show. */
const KINDS = Object.freeze({
  house: 'House',
  detached: 'Detached house',
  semidetached_house: 'Semi-detached house',
  terrace: 'Terraced house',
  bungalow: 'Bungalow',
  residential: 'Homes',
  apartments: 'Block of flats',
  school: 'School',
  university: 'University building',
  college: 'College',
  kindergarten: 'Nursery',
  church: 'Church',
  mosque: 'Mosque',
  synagogue: 'Synagogue',
  temple: 'Temple',
  cathedral: 'Cathedral',
  retail: 'Shop',
  shop: 'Shop',
  supermarket: 'Supermarket',
  commercial: 'Offices',
  office: 'Offices',
  government: 'Government building',
  industrial: 'Industrial building',
  warehouse: 'Warehouse',
  hospital: 'Hospital',
  hotel: 'Hotel',
  train_station: 'Station',
  garage: 'Garage',
  garages: 'Garages',
  shed: 'Shed',
  palace: 'Palace',
  castle: 'Castle',
  museum: 'Museum',
  stadium: 'Stadium',
  park: 'Park',
  garden: 'Garden',
  playground: 'Playground',
  pitch: 'Sports pitch',
  nature_reserve: 'Nature reserve',
  common: 'Common',
  recreation_ground: 'Recreation ground',
  dog_park: 'Dog park',
  golf_course: 'Golf course',
});

const words = (value) => {
  const text = String(value || '')
    .replace(/[_;]+/g, ' ')
    .trim();
  return text ? text[0].toUpperCase() + text.slice(1) : '';
};

/**
 * What a place is, in plain words. The building tag says the most when it is
 * more than "yes"; then the kind of place it is; then just "Building".
 */
export function describeKind({ building, category, type } = {}) {
  if (building && building !== 'yes') return KINDS[building] || words(building);
  if (KINDS[type]) return KINDS[type];
  if (building)
    return category === 'building' ? 'Building' : words(type) || 'Building';
  return words(type) || words(category) || 'Place';
}

/** A number from an OpenStreetMap tag such as "12", "12 m" or "3;4". */
export function tagNumber(value) {
  const found = /^\s*(\d+(?:\.\d+)?)/.exec(String(value ?? ''));
  return found ? Number(found[1]) : null;
}

/**
 * The area inside a ring of [lon, lat] points, in square metres, on a round
 * Earth (close enough for a building or a park).
 */
export function ringAreaM2(ring) {
  const R = 6378137;
  const rad = Math.PI / 180;
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [lon1, lat1] = ring[i];
    const [lon2, lat2] = ring[i + 1];
    sum +=
      (lon2 - lon1) * rad * (2 + Math.sin(lat1 * rad) + Math.sin(lat2 * rad));
  }
  return Math.abs((sum * R * R) / 2);
}

/** At most `max` points, spread evenly, with the ring still closed. */
export function thinRing(ring, max = MAX_POINTS) {
  if (ring.length <= max) return ring;
  const step = (ring.length - 1) / (max - 1);
  const kept = [];
  for (let i = 0; i < max - 1; i++) kept.push(ring[Math.round(i * step)]);
  kept.push(kept[0]);
  return kept;
}

const isPoint = (point) =>
  Array.isArray(point) &&
  Number.isFinite(point[0]) &&
  Number.isFinite(point[1]) &&
  Math.abs(point[0]) <= 180 &&
  Math.abs(point[1]) <= 90;

/** The outer ring of a GeoJSON polygon, or the biggest one of a multipolygon. */
export function outerRing(geometry) {
  const rings =
    geometry?.type === 'Polygon'
      ? [geometry.coordinates?.[0]]
      : geometry?.type === 'MultiPolygon'
        ? (geometry.coordinates || []).map((polygon) => polygon?.[0])
        : [];
  const good = rings.filter(
    (ring) => Array.isArray(ring) && ring.length >= 4 && ring.every(isPoint),
  );
  if (good.length === 0) return null;
  return good.reduce((a, b) => (ringAreaM2(b) > ringAreaM2(a) ? b : a));
}

/**
 * Join an Overpass relation's outer ways into one closed ring (the biggest,
 * if there are several). Ways can run either way round, so each next piece is
 * the one that starts or ends where the ring so far ends.
 */
export function stitchOuter(members = []) {
  const pieces = members
    .filter(
      (member) => member?.role === 'outer' && Array.isArray(member.geometry),
    )
    .map((member) => member.geometry.map(({ lon, lat }) => [lon, lat]))
    .filter((piece) => piece.length >= 2 && piece.every(isPoint));
  const same = (a, b) => a[0] === b[0] && a[1] === b[1];
  const rings = [];
  while (pieces.length) {
    let ring = pieces.shift();
    let grew = true;
    while (!same(ring[0], ring[ring.length - 1]) && grew) {
      grew = false;
      const end = ring[ring.length - 1];
      const next = pieces.findIndex(
        (piece) => same(piece[0], end) || same(piece[piece.length - 1], end),
      );
      if (next >= 0) {
        const [piece] = pieces.splice(next, 1);
        const forward = same(piece[0], end) ? piece : [...piece].reverse();
        ring = ring.concat(forward.slice(1));
        grew = true;
      }
    }
    if (ring.length >= 4 && same(ring[0], ring[ring.length - 1]))
      rings.push(ring);
  }
  if (rings.length === 0) return null;
  return rings.reduce((a, b) => (ringAreaM2(b) > ringAreaM2(a) ? b : a));
}

/**
 * Whether a spot is inside a ring of [lon, lat] points, or within `marginM`
 * metres of its edge (a click on a wall or a roof edge still counts).
 */
export function insideOrNear(ring, lat, lon, marginM = 4) {
  const mPerLat = 111_320;
  const mPerLon = 111_320 * Math.cos((lat * Math.PI) / 180);
  const xy = ring.map(([x, y]) => [(x - lon) * mPerLon, (y - lat) * mPerLat]);
  let inside = false;
  let nearest = Infinity;
  for (let i = 0, j = xy.length - 1; i < xy.length; j = i++) {
    const [xi, yi] = xy[i];
    const [xj, yj] = xy[j];
    if (yi > 0 !== yj > 0 && 0 < ((xj - xi) * (0 - yi)) / (yj - yi) + xi)
      inside = !inside;
    const dx = xj - xi;
    const dy = yj - yi;
    const t = Math.max(
      0,
      Math.min(1, -(xi * dx + yi * dy) / (dx * dx + dy * dy || 1)),
    );
    nearest = Math.min(nearest, Math.hypot(xi + t * dx, yi + t * dy));
  }
  return inside || nearest <= marginM;
}

function addressLines(address = {}) {
  const street = [address.house_number, address.road].filter(Boolean).join(' ');
  const town =
    address.city || address.town || address.village || address.county;
  const place = [address.suburb, town, address.postcode]
    .filter(Boolean)
    .filter((part, i, all) => all.indexOf(part) === i)
    .join(', ');
  return { address: street, place };
}

/**
 * The box's facts from a Nominatim reverse answer, or null when it is not a
 * building, or not the building at the spot: the address layer answers with
 * the nearest building even when the spot is in a park.
 */
export function factsFromNominatim(answer, lat, lon) {
  const extra = answer?.extratags || {};
  const ring = outerRing(answer?.geojson);
  const isBuilding = Boolean(extra.building) || answer?.category === 'building';
  if (!ring || !isBuilding || !insideOrNear(ring, lat, lon)) return null;
  const { address, place } = addressLines(answer.address);
  const name = String(answer.name || '').trim();
  return {
    kind: describeKind({
      building: extra.building,
      category: answer.category,
      type: answer.type,
    }),
    name: name && name !== address ? name : '',
    address,
    place,
    areaM2: Math.round(ringAreaM2(ring)),
    floors: tagNumber(extra['building:levels']),
    heightM: tagNumber(extra.height),
    outline: thinRing(ring),
    source: `${SOURCE}, via Nominatim`,
  };
}

/**
 * The box's facts for the smallest park around the spot in an Overpass
 * answer, preferring a named one (a park's name says more than an unnamed
 * flower bed inside it).
 */
export function factsFromOverpass(answer) {
  const found = (answer?.elements || [])
    .map((element) => {
      const ring =
        element.type === 'way' && Array.isArray(element.geometry)
          ? element.geometry.map(({ lon, lat }) => [lon, lat])
          : element.type === 'relation'
            ? stitchOuter(element.members)
            : null;
      if (!ring || ring.length < 4 || !ring.every(isPoint)) return null;
      return { tags: element.tags || {}, ring, area: ringAreaM2(ring) };
    })
    .filter(Boolean)
    .sort((a, b) => a.area - b.area);
  const best = found.find((park) => park.tags.name) || found[0];
  if (!best) return null;
  const { tags } = best;
  return {
    kind: describeKind({ type: tags.leisure }),
    name: String(tags.name || '').trim(),
    address: '',
    place: '',
    areaM2: Math.round(best.area),
    floors: null,
    heightM: null,
    outline: thinRing(best.ring),
    source: `${SOURCE}, via Overpass`,
  };
}

/**
 * Keeps one service's requests at least `gapMs` apart, with at most
 * `maxWaiting` waiting: past that a request is refused at once.
 */
export function pacer(
  gapMs = GAP_MS,
  {
    now = () => Date.now(),
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    maxWaiting = MAX_WAITING,
  } = {},
) {
  let queue = Promise.resolve();
  let last = -Infinity;
  let waiting = 0;
  return (work) => {
    if (waiting >= maxWaiting) {
      return Promise.reject(
        Object.assign(new Error('Too many lookups waiting'), { code: 'BUSY' }),
      );
    }
    waiting += 1;
    const turn = queue.then(async () => {
      try {
        const wait = last + gapMs - now();
        if (wait > 0) await sleep(wait);
        last = now();
        return await work();
      } finally {
        waiting -= 1;
      }
    });
    queue = turn.catch(() => null);
    return turn;
  };
}

/**
 * @param {{ requestJson?: Function, nominatimTurn?: Function, overpassTurn?: Function }} [options]
 * @returns {(lat: number, lon: number) => Promise<object | null>}
 */
export function createPlaceFacts({
  requestJson = fetchRegionalJson,
  nominatimTurn = (work) => enqueueNominatim(work, { bounded: true }),
  overpassTurn = pacer(),
} = {}) {
  const cache = new Map();
  const remember = (key, facts) => {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, facts);
    return facts;
  };
  const options = { headers: HEADERS, redirect: 'error', timeoutMs: 9000 };

  return async (lat, lon) => {
    const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
    if (cache.has(key)) return cache.get(key);
    const params = new URLSearchParams({
      format: 'jsonv2',
      lat: lat.toFixed(6),
      lon: lon.toFixed(6),
      zoom: '18',
      layer: 'address',
      polygon_geojson: '1',
      extratags: '1',
      addressdetails: '1',
      'accept-language': 'en',
    });
    const building = factsFromNominatim(
      await nominatimTurn(() =>
        requestJson(`${NOMINATIM_REVERSE}?${params}`, options),
      ),
      lat,
      lon,
    );
    if (building) return remember(key, building);
    const at = `${lat.toFixed(6)},${lon.toFixed(6)}`;
    const query =
      `[out:json][timeout:8];is_in(${at})->.a;` +
      `(way(pivot.a)[leisure~"${PARKS}"];rel(pivot.a)[leisure~"${PARKS}"];);out tags geom 8;`;
    const ask = async () => {
      let failed;
      for (const server of OVERPASS) {
        try {
          // encodeURIComponent, not URLSearchParams: Overpass reads a + as a plus, not a space.
          return await requestJson(
            `${server}?data=${encodeURIComponent(query)}`,
            {
              ...options,
              // One Overpass server fails on the newer compressions Node offers.
              headers: { ...HEADERS, 'Accept-Encoding': 'gzip' },
              timeoutMs: 6000,
            },
          );
        } catch (error) {
          failed = error;
        }
      }
      throw Object.assign(
        new Error(failed?.message || 'Overpass did not answer'),
        {
          code: 'PARKS_DOWN',
        },
      );
    };
    const park = factsFromOverpass(await overpassTurn(ask));
    return remember(key, park);
  };
}

const send = (res, status, body) => {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
};

/** The request handler for /api/alon/place. Exported for its tests. */
export function placeFactsHandler(
  lookUp,
  limiter = makeRateLimiter({ windowMs: 60_000, max: 40, globalMax: 80 }),
) {
  return sameSiteGated(async (req, res) => {
    if (req.method !== 'GET') {
      send(res, 405, { error: 'Method Not Allowed' });
      return;
    }
    const url = new URL(req.url || '/', 'http://localhost');
    const lat = Number(url.searchParams.get('lat'));
    const lon = Number(url.searchParams.get('lon'));
    const given =
      url.searchParams.get('lat') !== null &&
      url.searchParams.get('lon') !== null;
    if (
      !given ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180
    ) {
      send(res, 400, { error: 'A latitude and longitude are needed' });
      return;
    }
    if (!limiter(clientKey(req))) {
      send(res, 429, { error: 'Too many lookups: wait a moment' });
      return;
    }
    try {
      const facts = await lookUp(lat, lon);
      send(res, 200, facts ? { found: true, ...facts } : { found: false });
    } catch (error) {
      const busy =
        error?.code === 'BUSY' || /^NOMINATIM_/.test(error?.code || '');
      send(res, busy ? 429 : 502, {
        error: busy
          ? 'Too many lookups: wait a moment'
          : error?.code === 'PARKS_DOWN'
            ? 'No building here, and the park service (Overpass) is not answering. Try again later'
            : 'The map facts service did not answer',
      });
    }
  });
}

/** Vite plugin: the target box's facts route. */
export function alonPlaceFacts(options = {}) {
  const handler = placeFactsHandler(createPlaceFacts(options));
  // Returns nothing: Vite runs a function returned from these hooks later.
  const install = (server) => {
    server.middlewares.use('/api/alon/place', handler);
  };
  return {
    name: 'alon-place-facts',
    configureServer: install,
    configurePreviewServer: install,
  };
}
