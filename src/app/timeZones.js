import * as Cesium from 'cesium';
import {
  clearOverlaySource,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../overlays/worldOverlay.js';

/**
 * The world's time zones: borders drawn on the map with each zone's offset
 * from UTC, and the zone for any point.
 *
 * The shapes come from one bundled file (built by alon-timezones-build.mjs).
 * The times never come from a fixed offset: each zone has a name such as
 * Europe/London, and the browser's own date tools work out the time from the
 * name, so clock changes for summer are right without any table here.
 */

const STORAGE_KEY = 'gev.timeZones';
const DATA_URL = '/alon/timezones.json';
const LAYER_NAME = 'alon-time-zones';
const CREDIT = 'Time zones © OpenStreetMap contributors';
const LINE_COLOR = '#ffc44d';
/** Closer than this a zone fills the screen and its label only gets in the way. */
const LABEL_NEAR_M = 300_000;
/** The smaller zones' labels wait until the camera is this close. */
const SMALL_LABEL_FAR_M = 9_000_000;
/** Offsets only change when clocks do, so this is plenty. */
const RELABEL_MS = 10 * 60_000;
const ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/><path d="M5 5.5c1.6 2 1.6 11 0 13M19 5.5c-1.6 2-1.6 11 0 13" stroke-width="1.2"/></svg>';

/**
 * Unpack the bundled file.
 * @param {object} data
 * @returns {{ zones: string[], lines: number[][], polygons: Array<{zone: string, box: number[], rings: number[][]}>, labels: Array<{zone: string, lon: number, lat: number, big: boolean}> }}
 * Lines and rings are flat lists: lon, lat, lon, lat...
 */
export function decodeZones(data) {
  const lines = data.arcs.map((steps) => {
    const line = new Array(steps.length);
    let x = 0;
    let y = 0;
    for (let i = 0; i < steps.length; i += 2) {
      x += steps[i];
      y += steps[i + 1];
      line[i] = x / data.grid;
      line[i + 1] = y / data.grid;
    }
    return line;
  });
  const ringOf = (refs) => {
    const ring = [];
    for (const ref of refs) {
      const line = lines[ref < 0 ? ~ref : ref];
      // A border ends where the next begins, so its last point is skipped.
      if (ref < 0)
        for (let i = line.length - 2; i > 0; i -= 2)
          ring.push(line[i], line[i + 1]);
      else
        for (let i = 0; i < line.length - 2; i += 2)
          ring.push(line[i], line[i + 1]);
    }
    return ring;
  };
  const polygons = data.polygons.map(([zone, refs]) => {
    const rings = refs.map(ringOf);
    const box = [Infinity, Infinity, -Infinity, -Infinity];
    for (let i = 0; i < rings[0].length; i += 2) {
      box[0] = Math.min(box[0], rings[0][i]);
      box[1] = Math.min(box[1], rings[0][i + 1]);
      box[2] = Math.max(box[2], rings[0][i]);
      box[3] = Math.max(box[3], rings[0][i + 1]);
    }
    return { zone: data.zones[zone], box, rings };
  });
  const labels = data.labels.map(([zone, lon, lat, tier]) => ({
    zone: data.zones[zone],
    lon,
    lat,
    big: tier === 0,
  }));
  return { zones: data.zones, lines, polygons, labels };
}

function insideRing(ring, lon, lat) {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const yi = ring[i + 1];
    const yj = ring[j + 1];
    if (
      yi > lat !== yj > lat &&
      lon < ((ring[j] - ring[i]) * (lat - yi)) / (yj - yi) + ring[i]
    )
      inside = !inside;
  }
  return inside;
}

/**
 * The zone a ship would keep at this longitude: whole hours, no clock
 * changes. The Etc names count the other way round, so 5 hours ahead of UTC
 * is Etc/GMT-5.
 */
export function seaZone(lon) {
  const hours = Math.round(lon / 15);
  if (!hours) return 'Etc/GMT';
  return `Etc/GMT${hours > 0 ? '-' : '+'}${Math.abs(hours)}`;
}

/**
 * @param {{polygons: Array<{zone: string, box: number[], rings: number[][]}>}} decoded
 * @returns {string} The zone's name, such as Europe/London.
 */
export function zoneAt(decoded, lat, lon) {
  const x = lon >= 180 ? lon - 360 : lon;
  for (const { zone, box, rings } of decoded.polygons) {
    if (x < box[0] || x > box[2] || lat < box[1] || lat > box[3]) continue;
    if (!insideRing(rings[0], x, lat)) continue;
    if (rings.slice(1).some((hole) => insideRing(hole, x, lat))) continue;
    return zone;
  }
  // A sliver the simplified shapes leave out.
  return seaZone(x);
}

const formatters = new Map();
/** The moment's date and time as numbers, read off a clock in that zone. */
function wallClock(zone, date) {
  if (!formatters.has(zone))
    formatters.set(
      zone,
      new Intl.DateTimeFormat('en-GB', {
        timeZone: zone,
        hourCycle: 'h23',
        weekday: 'short',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }),
    );
  return Object.fromEntries(
    formatters
      .get(zone)
      .formatToParts(date)
      .map(({ type, value }) => [type, value]),
  );
}

const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');

/** Minutes the zone is ahead of UTC at that moment: 60 for London in July. */
export function offsetMinutes(zone, date = new Date()) {
  const p = wallClock(zone, date);
  const wall = Date.UTC(
    p.year,
    MONTHS.indexOf(p.month.slice(0, 3)),
    p.day,
    p.hour,
    p.minute,
    p.second,
  );
  return Math.round((wall - date.getTime()) / 60_000);
}

/** "UTC", "UTC+1", "UTC-3:30". */
export function offsetLabel(minutes) {
  if (!minutes) return 'UTC';
  const size = Math.abs(minutes);
  const rest = size % 60;
  return `UTC${minutes > 0 ? '+' : '-'}${Math.floor(size / 60)}${rest ? `:${String(rest).padStart(2, '0')}` : ''}`;
}

/**
 * The city a zone is named after: Paris for Europe/Paris. Zones that keep
 * the same time are stored as one, so Madrid's zone is Europe/Paris too, and
 * the honest thing to show is "same clock as Paris". Sea zones have no city.
 */
export function zoneCity(zone) {
  if (zone.startsWith('Etc/')) return '';
  return zone.slice(zone.lastIndexOf('/') + 1).replaceAll('_', ' ');
}

/**
 * What a clock in that zone reads.
 * @returns {{ time: string, day: string, offset: string, summer: boolean, city: string }}
 * `summer` is true while the zone's clocks are forward for daylight saving.
 */
export function zoneClock(zone, date = new Date()) {
  const p = wallClock(zone, date);
  const minutes = offsetMinutes(zone, date);
  const year = date.getUTCFullYear();
  const usual = Math.min(
    offsetMinutes(zone, new Date(Date.UTC(year, 0, 1))),
    offsetMinutes(zone, new Date(Date.UTC(year, 6, 1))),
  );
  return {
    time: `${p.hour}:${p.minute}:${p.second}`,
    day: `${p.weekday} ${p.day} ${p.month}`,
    offset: offsetLabel(minutes),
    summer: minutes > usual,
    city: zoneCity(zone),
  };
}

let loading = null;
/** The decoded file, fetched once and shared by the map layer and the click card. */
export function loadTimeZones() {
  loading ||= fetch(DATA_URL)
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    })
    .then(decodeZones)
    .catch((error) => {
      loading = null;
      throw error;
    });
  return loading;
}

/** Whether a click landed on one of this layer's lines. */
export function isTimeZonePick(picked) {
  return picked?.id?.entityCollection?.owner?.name === LAYER_NAME;
}

function readSaved() {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function save(on) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, on ? '1' : '0');
  } catch {
    // Private windows may refuse storage; the switch still works this visit.
  }
}

/**
 * @param {{ viewer: Cesium.Viewer }} scene
 * @param {Document} [doc]
 * @returns {() => void} Removes the layer and the switch.
 */
export function installTimeZones({ viewer }, doc = document) {
  let on = readSaved();
  let layer = null;
  let labelled = [];
  let building = null;
  let timer = null;
  // On screen, not only in the attribution list.
  const credit = new Cesium.Credit(CREDIT, true);

  // The app's own overlay draws all text on the map, so the labels go
  // through it: it hides the ones behind the Earth and keeps them apart.
  const relabel = () => {
    const now = new Date();
    setOverlayEntries(
      LAYER_NAME,
      labelled.map(({ entry, zone }) => ({
        ...entry,
        title: offsetLabel(offsetMinutes(zone, now)),
      })),
      { cohortLimit: labelled.length, collisionCapacity: labelled.length },
    );
  };

  const build = async () => {
    const decoded = await loadTimeZones();
    const { lines, labels } = decoded;
    const source = new Cesium.CustomDataSource(LAYER_NAME);
    const color = Cesium.Color.fromCssColorString(LINE_COLOR);
    const material = color.withAlpha(0.8);
    const draw = (points) => {
      if (points.length < 4) return;
      source.entities.add({
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArray(points),
          // Borders run along lines of latitude and longitude, which a
          // shortest-path line would cut the corners of.
          arcType: Cesium.ArcType.RHUMB,
          clampToGround: true,
          width: 1.5,
          material,
        },
      });
    };
    // The file is a flat map, so its edges show up as borders that are not
    // real: the two poles, and the 180 degree line twice. That line is drawn
    // once, and only where the zone really changes across it.
    const isMapEdge = (lonA, latA, lonB, latB) => {
      if (Math.abs(latA) === 90 && latA === latB) return true;
      if (Math.abs(lonA) !== 180 || lonA !== lonB) return false;
      const lat = (latA + latB) / 2;
      return (
        lonA === -180 ||
        zoneAt(decoded, lat, 179.95) === zoneAt(decoded, lat, -179.95)
      );
    };
    // Kept just off the exact pole and the exact 180 line, where the
    // drawing maths has no single answer.
    const drawable = (lon, lat) => [
      Cesium.Math.clamp(lon, -179.999, 179.999),
      Cesium.Math.clamp(lat, -89.5, 89.5),
    ];
    for (const line of lines) {
      let run = [];
      for (let i = 0; i + 3 < line.length; i += 2) {
        if (isMapEdge(line[i], line[i + 1], line[i + 2], line[i + 3])) {
          draw(run);
          run = [];
          continue;
        }
        if (!run.length) run.push(...drawable(line[i], line[i + 1]));
        run.push(...drawable(line[i + 2], line[i + 3]));
      }
      draw(run);
    }
    labelled = labels.map(({ zone, lon, lat, big }, index) => ({
      zone,
      entry: {
        id: `zone:${index}`,
        position: Cesium.Cartesian3.fromDegrees(lon, lat),
        variant: 'label',
        accent: LINE_COLOR,
        priority: big ? 2 : 1,
        minDistance: LABEL_NEAR_M,
        maxDistance: big ? Number.POSITIVE_INFINITY : SMALL_LABEL_FAR_M,
      },
    }));
    await viewer.dataSources.add(source);
    return source;
  };

  const button = doc.createElement('button');
  button.id = 'time-zones-toggle';
  button.type = 'button';
  button.innerHTML = ICON;
  button.setAttribute('aria-label', 'Time zones');
  const paint = (note = '') => {
    button.setAttribute('aria-pressed', String(on));
    button.title =
      note || (on ? 'Hide the time zones' : 'Show the world’s time zones');
  };

  const apply = async () => {
    clearInterval(timer);
    timer = null;
    if (!on) {
      // Taken off the map, not just hidden: hidden ground lines over the 3D
      // buildings still cost the map about a quarter of its speed.
      if (layer && viewer.dataSources.contains(layer)) {
        viewer.dataSources.remove(layer, false);
      }
      setOverlaySourceVisible(LAYER_NAME, false);
      viewer.creditDisplay.removeStaticCredit(credit);
      viewer.scene.requestRender();
      return;
    }
    try {
      layer ||= await (building ||= build());
    } catch (error) {
      building = null;
      on = false;
      paint('The time zone file did not load. Click to try again');
      console.warn('[time-zones]', error?.message || error);
      return;
    }
    if (viewer.isDestroyed()) return;
    if (!on) {
      if (viewer.dataSources.contains(layer))
        viewer.dataSources.remove(layer, false);
      return;
    }
    if (!viewer.dataSources.contains(layer))
      await viewer.dataSources.add(layer);
    layer.show = true;
    viewer.creditDisplay.addStaticCredit(credit);
    relabel();
    setOverlaySourceVisible(LAYER_NAME, true);
    timer = setInterval(relabel, RELABEL_MS);
  };

  button.addEventListener('click', () => {
    on = !on;
    save(on);
    paint();
    apply();
  });
  paint();
  doc.getElementById('top-center-actions')?.appendChild(button);
  if (on) apply();

  return () => {
    clearInterval(timer);
    button.remove();
    clearOverlaySource(LAYER_NAME);
    if (viewer.isDestroyed()) return;
    viewer.creditDisplay.removeStaticCredit(credit);
    if (layer) viewer.dataSources.remove(layer, true);
  };
}
