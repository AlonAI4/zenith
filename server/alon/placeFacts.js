import { clientKey, makeRateLimiter } from '../providers/common/rate-limit.js';
import { sameSiteGated } from '../providers/common/same-site.js';
import { fetchRegionalJson } from '../providers/regional/http.js';
import { enqueueNominatim } from '../providers/regional/place.js';

/**
 * Public map facts about the building at a spot, for the target box a
 * right-click opens: what it is, its name and address, its size, its floors
 * and height, and its outline. From OpenStreetMap, through Nominatim's
 * reverse lookup on its address layer, which answers with the building at
 * the spot and its outline: at most one request a second (the app's shared
 * Nominatim queue), answers remembered, and only the facts listed above
 * passed on, never who lives or works there.
 *
 * Parks are not looked up: Nominatim names the nearest bench instead, and
 * Overpass (which could) is not used by this app.
 */

export const NOMINATIM_REVERSE = 'https://nominatim.openstreetmap.org/reverse';
const HEADERS = Object.freeze({
  'User-Agent': 'Zenith/1.2 (+https://github.com/AlonAI4/zenith)',
  Referer: 'https://github.com/AlonAI4/zenith',
});
const CACHE_MAX = 200;
const MAX_POINTS = 500;
const SOURCE = 'Map data © OpenStreetMap contributors';

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
 * @param {{ requestJson?: Function, nominatimTurn?: Function }} [options]
 * @returns {(lat: number, lon: number) => Promise<object | null>}
 */
export function createPlaceFacts({
  requestJson = fetchRegionalJson,
  nominatimTurn = (work, signal) =>
    enqueueNominatim(work, { bounded: true, signal }),
} = {}) {
  const cache = new Map();
  const asking = new Map();
  const remember = (key, facts) => {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, facts);
    return facts;
  };
  const options = { headers: HEADERS, redirect: 'error', timeoutMs: 9000 };

  const lookUp = async (lat, lon, key, signal) => {
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
      await nominatimTurn(
        () => requestJson(`${NOMINATIM_REVERSE}?${params}`, options),
        signal,
      ),
      lat,
      lon,
    );
    return remember(key, building);
  };

  /**
   * Answers from the cache, or shares one lookup between everyone asking
   * for the same spot at once. The lookup is called off when all of them
   * have gone, so a page that moved on does not spend the services' requests.
   */
  return (lat, lon, { signal } = {}) => {
    const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
    if (cache.has(key)) return Promise.resolve(cache.get(key));
    let shared = asking.get(key);
    if (!shared) {
      const stop = new AbortController();
      shared = { stop, waiting: 0 };
      shared.answer = lookUp(lat, lon, key, stop.signal).finally(() =>
        asking.delete(key),
      );
      asking.set(key, shared);
    }
    shared.waiting += 1;
    const leave = () => {
      shared.waiting -= 1;
      if (shared.waiting === 0) shared.stop.abort();
    };
    if (signal?.aborted) leave();
    else signal?.addEventListener('abort', leave, { once: true });
    return shared.answer;
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
    // The page gave up (a newer right-click, or closed): stop asking for it.
    const gone = new AbortController();
    res.on?.('close', () => {
      if (!res.writableFinished) gone.abort();
    });
    try {
      const facts = await lookUp(lat, lon, { signal: gone.signal });
      send(res, 200, facts ? { found: true, ...facts } : { found: false });
    } catch (error) {
      const busy =
        error?.code === 'BUSY' || /^NOMINATIM_/.test(error?.code || '');
      send(res, busy ? 429 : 502, {
        error: busy
          ? 'Too many lookups: wait a moment'
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
