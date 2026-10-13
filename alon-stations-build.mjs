// Turns the rail stops osmium pulled out of each country file into one small
// file the app can load: public/alon/stations.json.
// Usage: node alon-stations-build.mjs <dir with *.geojsonseq>
import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const KINDS = ['train', 'metro', 'tram'];

/** Which kind of stop an OpenStreetMap node is, from its tags. */
export function stationKind(tags) {
  if (tags.railway === 'tram_stop') return 'tram';
  if (tags.station === 'subway' || tags.subway === 'yes') return 'metro';
  if (tags.station === 'light_rail' || tags.light_rail === 'yes') return 'tram';
  return 'train';
}

/** One compact row, or null for a stop that is closed or has no position. */
export function stationRow(feature) {
  const tags = feature?.properties || {};
  const [lon, lat] = feature?.geometry?.coordinates || [];
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  if (tags.disused === 'yes' || tags.abandoned === 'yes') return null;
  const local = String(tags.name || '').trim();
  const english = String(tags['name:en'] || '').trim();
  const name =
    local && english && english !== local
      ? `${local} (${english})`
      : local || english || 'Unnamed stop';
  return [
    Math.round(lon * 1e5) / 1e5,
    Math.round(lat * 1e5) / 1e5,
    KINDS.indexOf(stationKind(tags)),
    name,
  ];
}

/**
 * The largest city areas of the USA, each as a box on the map: south, west,
 * north, east. The eleven biggest by people living there.
 */
export const US_CITIES = Object.freeze({
  'New York': [40.4, -74.6, 41.2, -73.2],
  'Los Angeles': [33.6, -118.8, 34.4, -117.5],
  Chicago: [41.55, -88.4, 42.2, -87.45],
  'Dallas and Fort Worth': [32.55, -97.5, 33.1, -96.5],
  Houston: [29.5, -95.8, 30.1, -95.0],
  'Washington DC': [38.7, -77.5, 39.15, -76.8],
  Philadelphia: [39.85, -75.45, 40.15, -74.9],
  Miami: [25.6, -80.5, 26.4, -80.05],
  Atlanta: [33.55, -84.65, 34.05, -84.1],
  Boston: [42.2, -71.35, 42.55, -70.9],
  'San Francisco Bay': [37.2, -122.6, 38.05, -121.7],
});

/** The US city area a point is in, or null. */
export function usCity(lon, lat) {
  for (const [name, [south, west, north, east]] of Object.entries(US_CITIES)) {
    if (lat >= south && lat <= north && lon >= west && lon <= east) return name;
  }
  return null;
}

// node alon-stations-build.mjs --us-cities <state files...>
// prints the stops that are in one of the city areas, each once.
if (process.argv[1]?.endsWith('alon-stations-build.mjs') && process.argv[2] === '--us-cities') {
  const seen = new Set();
  for (const file of process.argv.slice(3)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const text = line.replace(/^\x1e/, '').trim();
      if (!text) continue;
      const [lon, lat] = JSON.parse(text)?.geometry?.coordinates || [];
      if (!Number.isFinite(lon) || !Number.isFinite(lat) || !usCity(lon, lat)) continue;
      // State files overlap a little at their edges.
      const key = `${lon.toFixed(6)},${lat.toFixed(6)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      console.log(text);
    }
  }
  process.exit(0);
}

if (process.argv[1]?.endsWith('alon-stations-build.mjs')) {
  const dir = process.argv[2];
  const countries = {};
  const stations = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.geojsonseq')).sort()) {
    const country = file.replace('.geojsonseq', '');
    let count = 0;
    for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
      const text = line.replace(/^\x1e/, '').trim();
      if (!text) continue;
      const row = stationRow(JSON.parse(text));
      if (!row) continue;
      stations.push(row);
      count += 1;
    }
    countries[country] = count;
  }
  mkdirSync('public/alon', { recursive: true });
  writeFileSync(
    'public/alon/stations.json',
    JSON.stringify({
      credit: '© OpenStreetMap contributors',
      via: 'Geofabrik country extracts',
      built: new Date().toISOString().slice(0, 10),
      countries,
      kinds: KINDS,
      stations,
    }),
  );
  console.log('stations per country:', countries, 'total:', stations.length);
}
