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
