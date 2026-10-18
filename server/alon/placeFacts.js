import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';

import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';

import { readResponseBytesCapped } from '../providers/common/http.js';
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
 * The address layer often answers with an address point or the shop next
 * door instead (big stadiums, the Pentagon, ordinary blocks of flats). Then
 * two more free sources are asked: Photon names the stadiums and buildings
 * near the spot and one Nominatim lookup gives their outlines; and
 * OpenFreeMap's building tile has the unnamed buildings neither of them can
 * find. Where OpenStreetMap has no outline at all (many houses), Overture's
 * buildings, which add Microsoft's and Google's machine-traced footprints,
 * are read last. Only an outline that holds the spot is ever shown.
 *
 * Parks are not looked up: Nominatim names the nearest bench instead, and
 * Overpass (which could) is not used by this app.
 */

export const NOMINATIM_REVERSE = 'https://nominatim.openstreetmap.org/reverse';
export const NOMINATIM_LOOKUP = 'https://nominatim.openstreetmap.org/lookup';
export const PHOTON_REVERSE = 'https://photon.komoot.io/reverse';
export const OPENFREEMAP_TILES = 'https://tiles.openfreemap.org/planet';
export const OVERTURE_RELEASES = 'https://stac.overturemaps.org/catalog.json';
export const OVERTURE_TILES = 'https://tiles.overturemaps.org';
const HEADERS = Object.freeze({
  'User-Agent': 'Zenith/1.2 (+https://github.com/AlonAI4/zenith)',
  Referer: 'https://github.com/AlonAI4/zenith',
});
const CACHE_MAX = 200;
const MAX_POINTS = 500;
const SOURCE = 'Map data © OpenStreetMap contributors';
const TILE_ZOOM = 14;
const TILE_MAX_BYTES = 4 * 1024 * 1024;
const TILE_CACHE_MAX = 6;
const TILE_LIST_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// The start of a PMTiles file: its header and its first directory.
const PMTILES_HEAD_BYTES = 16384;
const UNZIPPED_MAX_BYTES = 32 * 1024 * 1024;
// Real directories unzip to about 30 KB; a hostile one could fill memory.
const DIRECTORY_MAX_BYTES = 1024 * 1024;
const LEAF_CACHE_MAX = 4;
// Photon's main tags that are never a building, so not worth a lookup.
const NOT_BUILDINGS = new Set([
  'highway',
  'boundary',
  'place',
  'landuse',
  'natural',
  'waterway',
  'railway',
  'route',
]);

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

const isStadium = (answer) =>
  answer?.category === 'leisure' && answer?.type === 'stadium';

/**
 * The box's facts from a Nominatim answer, or null when it is not a building
 * (or a stadium), or not the one at the spot: the address layer answers with
 * the nearest building even when the spot is in a park.
 */
export function factsFromNominatim(answer, lat, lon) {
  const extra = answer?.extratags || {};
  const ring = outerRing(answer?.geojson);
  const isBuilding =
    Boolean(extra.building) ||
    answer?.category === 'building' ||
    isStadium(answer);
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
 * The best of the places that hold a spot: one the spot is inside before one
 * it is only next to, then a stadium (the box names Anfield, not one stand).
 * Buildings on the map do not overlap, but a building's parts (a stadium's
 * tiers, a tower's floors) lie inside it: of outlines the spot is inside, the
 * biggest is the whole building. Of ones it is only next to, the smallest.
 */
function bestPlace(places, lat, lon) {
  const ranked = places.map(({ facts, stadium = false }) => ({
    facts,
    stadium,
    inside: insideOrNear(facts.outline, lat, lon, 0),
  }));
  ranked.sort(
    (a, b) =>
      b.inside - a.inside ||
      b.stadium - a.stadium ||
      (a.inside ? -1 : 1) * (a.facts.areaM2 - b.facts.areaM2),
  );
  return ranked[0]?.facts ?? null;
}

/**
 * The ways and relations Photon named near a spot whose box holds it, as
 * Nominatim lookup ids such as "W4830206". Photon names the nearest places,
 * not the one under the spot, and a point has no outline.
 */
export function photonIds(answers, lat, lon) {
  const pad = 0.0001; // about 10 m
  const ids = new Set();
  for (const answer of answers) {
    for (const { properties: p = {} } of answer?.features || []) {
      if (p.osm_type !== 'W' && p.osm_type !== 'R') continue;
      if (!Number.isSafeInteger(p.osm_id) || NOT_BUILDINGS.has(p.osm_key))
        continue;
      if (p.extent) {
        const [west, north, east, south] = p.extent;
        const holds =
          lon >= west - pad &&
          lon <= east + pad &&
          lat >= south - pad &&
          lat <= north + pad;
        // A park or a nature reserve, not a building: its outline could
        // fill the lookup's whole answer.
        const huge = east - west > 0.02 || north - south > 0.02;
        if (!holds || huge) continue;
      }
      ids.add(`${p.osm_type}${p.osm_id}`);
    }
  }
  return [...ids].slice(0, 50);
}

/** The box's facts from a Nominatim lookup: the best place holding the spot. */
export function factsFromLookup(answers, lat, lon) {
  const places = (Array.isArray(answers) ? answers : [])
    .map((answer) => ({
      facts: factsFromNominatim(answer, lat, lon),
      stadium: isStadium(answer),
    }))
    .filter(({ facts }) => facts);
  return bestPlace(places, lat, lon);
}

/** Where a spot is among the tiles at `z`, counted in tiles from the corner. */
function tilePoint(lat, lon, z) {
  const n = 2 ** z;
  const rad = (lat * Math.PI) / 180;
  return [
    ((lon + 180) / 360) * n,
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n,
  ];
}

/** The tile at `z` that holds a spot. */
export function tileFor(lat, lon, z = TILE_ZOOM) {
  const n = 2 ** z;
  const [across, down] = tilePoint(lat, lon, z).map(Math.floor);
  const fit = (value) => Math.max(0, Math.min(n - 1, value));
  return { z, x: fit(across), y: fit(down) };
}

/**
 * The box's facts from an OpenFreeMap building tile: the building outline
 * holding the spot. The tile knows no names, addresses or floors, and its
 * heights are often a stand-in, so those stay empty. A building across the
 * tile's edge is cut a little beyond it. `credit` gives a building's source
 * line from its tile tags.
 */
export function factsFromTile(
  bytes,
  { z, x, y },
  lat,
  lon,
  credit = () => `${SOURCE}, via OpenFreeMap © OpenMapTiles`,
) {
  const places = [];
  try {
    const layer = new VectorTile(new PbfReader(bytes)).layers.building;
    // The spot in the tile's own units. A building whose box is far from it
    // is skipped before its outline is worked out: a tile holds thousands.
    const extent = layer?.extent ?? 4096;
    const [across, down] = tilePoint(lat, lon, z);
    const [px, py] = [(across - x) * extent, (down - y) * extent];
    const pad = extent / 32; // tens of metres: well past the 4 m margin
    for (let i = 0; i < (layer?.length ?? 0); i++) {
      const feature = layer.feature(i);
      const [left, top, right, bottom] = feature.bbox();
      if (px < left - pad || px > right + pad) continue;
      if (py < top - pad || py > bottom + pad) continue;
      const { geometry } = feature.toGeoJSON(x, y, z);
      const polygons =
        geometry.type === 'Polygon'
          ? [geometry.coordinates]
          : geometry.type === 'MultiPolygon'
            ? geometry.coordinates
            : [];
      for (const [ring] of polygons) {
        if (!ring || ring.length < 4 || !insideOrNear(ring, lat, lon)) continue;
        places.push({
          facts: {
            kind: 'Building',
            name: '',
            address: '',
            place: '',
            areaM2: Math.round(ringAreaM2(ring)),
            floors: null,
            heightM: null,
            outline: thinRing(ring),
            source: credit(feature.properties),
          },
        });
      }
    }
  } catch {
    return null; // a damaged tile holds nothing
  }
  return bestPlace(places, lat, lon);
}

/**
 * An Overture building's source line: OpenStreetMap and Overture, and the
 * company whose traced footprint it is (its `sources` tag names them).
 */
export function overtureCredit(properties = {}) {
  let sources = [];
  try {
    sources = JSON.parse(properties.sources);
  } catch {
    // no sources tag: the plain line
  }
  const datasets = (Array.isArray(sources) ? sources : [])
    .map((source) => source?.dataset)
    .filter(
      (name) =>
        typeof name === 'string' &&
        name !== 'OpenStreetMap' &&
        /^[\w .,()&'-]{1,60}$/.test(name),
    );
  return [`${SOURCE}, Overture Maps Foundation`, ...new Set(datasets)].join(
    '; ',
  );
}

/**
 * PMTiles' number for a tile: all the tiles of lower zooms come first, then
 * this zoom's tiles in the order a Hilbert curve visits them.
 */
export function pmtilesTileId(z, x, y) {
  let id = (4 ** z - 1) / 3;
  const at = [x, y];
  for (let size = 2 ** (z - 1); size >= 1; size /= 2) {
    const right = at[0] & size ? 1 : 0;
    const down = at[1] & size ? 1 : 0;
    id += size * size * ((3 * right) ^ down);
    if (down === 0) {
      if (right === 1) {
        at[0] = size - 1 - at[0];
        at[1] = size - 1 - at[1];
      }
      at.reverse();
    }
  }
  return id;
}

/** The parts of a PMTiles v3 header this lookup reads. */
export function pmtilesHeader(bytes) {
  const magic = new TextDecoder().decode(bytes.subarray(0, 7));
  if (bytes.length < 127 || magic !== 'PMTiles' || bytes[7] !== 3)
    throw new Error('Not a PMTiles v3 file');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const number = (at) => Number(view.getBigUint64(at, true));
  const header = {
    rootOffset: number(8),
    rootLength: number(16),
    leafOffset: number(40),
    dataOffset: number(56),
    directoryZip: bytes[97],
    tileZip: bytes[98],
    maxZoom: bytes[101],
  };
  // Vector tiles, with no compression or gzip: what node can open alone.
  const known = (zip) => zip === 1 || zip === 2;
  if (
    bytes[99] !== 1 ||
    !known(header.directoryZip) ||
    !known(header.tileZip) ||
    header.rootOffset + header.rootLength > bytes.length
  )
    throw new Error('A PMTiles file this lookup cannot read');
  return header;
}

/** A PMTiles directory, unzipped: its entries in tile-number order. */
export function pmtilesDirectory(bytes) {
  let at = 0;
  const next = () => {
    let value = 0;
    for (let scale = 1; scale <= 2 ** 49; scale *= 128) {
      if (at >= bytes.length) break;
      const byte = bytes[at++];
      value += (byte & 0x7f) * scale;
      if (byte < 0x80) return value;
    }
    throw new Error('A damaged PMTiles directory');
  };
  const count = next();
  // Each entry takes at least four bytes.
  if (count * 4 > bytes.length) throw new Error('A damaged PMTiles directory');
  const entries = [];
  let id = 0;
  for (let i = 0; i < count; i++) entries.push({ id: (id += next()) });
  for (const entry of entries) entry.run = next();
  for (const entry of entries) entry.length = next();
  entries.forEach((entry, i) => {
    const value = next();
    // 0: right after the entry before it.
    entry.offset =
      value === 0 && i > 0
        ? entries[i - 1].offset + entries[i - 1].length
        : value - 1;
  });
  return entries;
}

/**
 * Where a directory says a tile is: `{ tile }` (its bytes), `{ leaf }` (a
 * further directory that may list it) or null (no buildings in that tile).
 */
export function pmtilesFind(entries, id) {
  let low = 0;
  let high = entries.length - 1;
  let hit = null;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (entries[middle].id <= id) {
      hit = entries[middle];
      low = middle + 1;
    } else high = middle - 1;
  }
  if (!hit) return null;
  if (hit.run === 0) return { leaf: hit };
  return id < hit.id + hit.run ? { tile: hit } : null;
}

const gunzipAsync = promisify(gunzip);
const unzip = (bytes, zip, max = UNZIPPED_MAX_BYTES) =>
  zip === 2 ? gunzipAsync(bytes, { maxOutputLength: max }) : bytes;

/**
 * A tile found building with the address the reverse lookup gave: its town
 * always, its street only when that address point is inside the outline.
 */
function withAddress(facts, reverse) {
  if (!facts || !reverse?.address) return facts;
  const { address, place } = addressLines(reverse.address);
  const at = [Number(reverse.lat), Number(reverse.lon)];
  const here =
    at.every(Number.isFinite) && insideOrNear(facts.outline, ...at, 0);
  return { ...facts, place, address: here ? address : '' };
}

/**
 * One capped binary download (a map tile), with no redirects. `range`
 * ([start, length]) asks for only that part of a file; `signal` calls it
 * off. Exported for its tests.
 */
export async function fetchBytes(
  url,
  { headers, range, signal, timeoutMs = 9000 } = {},
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const stop = signal
    ? AbortSignal.any([controller.signal, signal])
    : controller.signal;
  try {
    const response = await fetch(url, {
      signal: stop,
      headers: range
        ? { ...headers, Range: `bytes=${range[0]}-${range[0] + range[1] - 1}` }
        : headers,
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`Upstream returned ${response.status}`);
    // A server that ignores the range sends the whole file.
    if (range && response.status !== 206)
      throw new Error('The map file server ignored the range');
    return await readResponseBytesCapped(response, TILE_MAX_BYTES, stop);
  } finally {
    clearTimeout(timeout);
    controller.abort(); // a body left unread (an error) holds its connection
  }
}

/**
 * @param {{ requestJson?: Function, requestBytes?: Function, nominatimTurn?: Function }} [options]
 * @returns {(lat: number, lon: number) => Promise<object | null>}
 */
export function createPlaceFacts({
  requestJson = fetchRegionalJson,
  requestBytes = fetchBytes,
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
  const tiles = new Map();
  let tileList = null;

  /** OpenFreeMap's current tile address, which changes with each map build. */
  const tileAddress = async () => {
    if (tileList && Date.now() - tileList.at < TILE_LIST_MAX_AGE_MS)
      return tileList.url;
    const url = (await requestJson(OPENFREEMAP_TILES, options))?.tiles?.[0];
    if (typeof url !== 'string' || !url.startsWith(`${OPENFREEMAP_TILES}/`))
      throw new Error('OpenFreeMap gave no tile address');
    tileList = { url, at: Date.now() };
    return url;
  };

  const tileBytes = async ({ z, x, y }) => {
    const key = `${z}/${x}/${y}`;
    if (tiles.has(key)) return tiles.get(key);
    const url = (await tileAddress())
      .replace('{z}', z)
      .replace('{x}', x)
      .replace('{y}', y);
    const bytes = await requestBytes(url, options);
    if (tiles.size >= TILE_CACHE_MAX) tiles.delete(tiles.keys().next().value);
    tiles.set(key, bytes);
    return bytes;
  };

  let overture = null;
  const part = async (url, start, length, signal) => {
    if (!(start >= 0 && length > 0 && length <= TILE_MAX_BYTES))
      throw new Error('A map file part out of bounds');
    signal.throwIfAborted();
    return requestBytes(url, { ...options, range: [start, length], signal });
  };

  /**
   * Overture's newest buildings file, a PMTiles file of about 180 GB read in
   * small parts: its address changes with each release, and old ones go.
   * Its further directories are kept with it, so a new release starts empty.
   */
  const overtureFile = async (signal) => {
    if (overture && Date.now() - overture.at < TILE_LIST_MAX_AGE_MS)
      return overture;
    const release = (await requestJson(OVERTURE_RELEASES, options))?.latest;
    signal.throwIfAborted();
    if (
      typeof release !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}\.\d+$/.test(release)
    )
      throw new Error('Overture gave no release');
    const url = `${OVERTURE_TILES}/${release}/buildings.pmtiles`;
    if (overture?.url === url) {
      overture.at = Date.now();
      return overture;
    }
    const head = await part(url, 0, PMTILES_HEAD_BYTES, signal);
    const header = pmtilesHeader(head);
    const root = pmtilesDirectory(
      await unzip(
        head.subarray(header.rootOffset, header.rootOffset + header.rootLength),
        header.directoryZip,
        DIRECTORY_MAX_BYTES,
      ),
    );
    overture = { url, at: Date.now(), header, root, leaves: new Map() };
    return overture;
  };

  /** Overture's unzipped building tile holding a spot, or null for none. */
  const overtureTile = async (lat, lon, signal) => {
    const { url, header, root, leaves } = await overtureFile(signal);
    const tile = tileFor(lat, lon, Math.min(TILE_ZOOM, header.maxZoom));
    const key = `${url} ${tile.z}/${tile.x}/${tile.y}`;
    if (tiles.has(key)) return { tile, bytes: tiles.get(key) };
    const id = pmtilesTileId(tile.z, tile.x, tile.y);
    let entries = root;
    // The format allows directories three deep under the first.
    for (let depth = 0; depth < 4; depth++) {
      const found = pmtilesFind(entries, id);
      if (!found) return null;
      if (found.tile) {
        const { offset, length } = found.tile;
        const zipped = await part(
          url,
          header.dataOffset + offset,
          length,
          signal,
        );
        const bytes = await unzip(zipped, header.tileZip);
        if (tiles.size >= TILE_CACHE_MAX)
          tiles.delete(tiles.keys().next().value);
        tiles.set(key, bytes);
        return { tile, bytes };
      }
      const { offset, length } = found.leaf;
      entries = leaves.get(offset);
      if (!entries) {
        const zipped = await part(
          url,
          header.leafOffset + offset,
          length,
          signal,
        );
        entries = pmtilesDirectory(
          await unzip(zipped, header.directoryZip, DIRECTORY_MAX_BYTES),
        );
        if (leaves.size >= LEAF_CACHE_MAX)
          leaves.delete(leaves.keys().next().value);
        leaves.set(offset, entries);
      }
    }
    throw new Error('A PMTiles file nested too deep');
  };

  /**
   * When the address layer named no building at the spot. A source that
   * fails is skipped, so another can still find the building, and the
   * failure is passed back with what was found.
   */
  const fallBack = async (lat, lon, reverse, signal) => {
    let failed = null;
    const attempt = async (step) => {
      try {
        return await step();
      } catch (error) {
        signal.throwIfAborted();
        failed ??= error;
        return null;
      }
    };
    const at = { lat: lat.toFixed(6), lon: lon.toFixed(6) };
    const photon = (extra) =>
      attempt(() =>
        requestJson(
          `${PHOTON_REVERSE}?${new URLSearchParams({ ...at, ...extra })}`,
          options,
        ),
      );
    const named = await Promise.all([
      photon({ limit: '20' }),
      photon({ limit: '5', osm_tag: 'leisure:stadium' }),
    ]);
    signal.throwIfAborted();
    const ids = photonIds(named, lat, lon);
    if (ids.length > 0) {
      const params = new URLSearchParams({
        osm_ids: ids.join(','),
        format: 'jsonv2',
        polygon_geojson: '1',
        polygon_threshold: '0.00001',
        extratags: '1',
        addressdetails: '1',
        'accept-language': 'en',
      });
      const outlines = await attempt(() =>
        nominatimTurn(
          () => requestJson(`${NOMINATIM_LOOKUP}?${params}`, options),
          signal,
        ),
      );
      const found = factsFromLookup(outlines, lat, lon);
      if (found) return { found, failed };
    }
    signal.throwIfAborted();
    const tile = tileFor(lat, lon);
    const bytes = await attempt(() => tileBytes(tile));
    signal.throwIfAborted();
    const found =
      bytes && withAddress(factsFromTile(bytes, tile, lat, lon), reverse);
    if (found) return { found, failed };
    // A building OpenStreetMap has no outline for: Overture's traced ones.
    // Only a last try: when Overture fails, the box says NO MATCH (not a
    // lookup error), and the spot is asked again next time.
    let more = null;
    let unsure = false;
    try {
      more = await overtureTile(lat, lon, signal);
    } catch {
      signal.throwIfAborted();
      unsure = true;
    }
    const traced =
      more &&
      withAddress(
        factsFromTile(more.bytes, more.tile, lat, lon, overtureCredit),
        reverse,
      );
    return { found: traced || null, failed, unsure };
  };

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
    const reverse = await nominatimTurn(
      () => requestJson(`${NOMINATIM_REVERSE}?${params}`, options),
      signal,
    );
    const building = factsFromNominatim(reverse, lat, lon);
    if (building) return remember(key, building);
    const { found, failed, unsure } = await fallBack(lat, lon, reverse, signal);
    if (!failed && !unsure) return remember(key, found);
    if (!found && failed) throw failed;
    // Found while another source failed: maybe not the best answer (the
    // flats' tile outline instead of the named stadium), so not remembered.
    // Nor is a NO MATCH Overture could not check.
    return found;
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
    // A lookup everyone left is finishing its last step: start a new one.
    if (!shared || shared.stop.signal.aborted) {
      const fresh = { stop: new AbortController(), waiting: 0 };
      fresh.answer = lookUp(lat, lon, key, fresh.stop.signal).finally(() => {
        if (asking.get(key) === fresh) asking.delete(key);
      });
      asking.set(key, fresh);
      shared = fresh;
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
