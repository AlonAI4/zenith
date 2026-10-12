import * as Cesium from 'cesium';

/**
 * Train, metro and tram stops, with one toolbar switch.
 *
 * The data is a bundled file built once from official OpenStreetMap country
 * extracts (see alon-stations-download.sh). Nothing is requested from any
 * map-data server while the app runs.
 */

const STORAGE_KEY = 'gev.trainStations';
const DATA_URL = '/alon/stations.json';
const CREDIT = 'Stations © OpenStreetMap contributors';
/** Markers drawn at once. Each one is clamped to the ground, which costs. */
export const MAX_MARKERS = 600;
const HOVER_PICK_MS = 120;
const KIND_STYLE = {
  train: { color: '#52d4ff', label: 'train station' },
  metro: { color: '#ff7ad9', label: 'metro station' },
  tram: { color: '#ffc04d', label: 'tram stop' },
};
// When more stops are in view than can be drawn, trains win, then metro.
const KIND_RANK = { train: 0, metro: 1, tram: 2 };

/**
 * The stops to draw for one view: those inside `box`, the most important
 * kinds first and then the ones nearest the middle, at most `cap`.
 * @param {Array<{lon:number, lat:number, kind:string}>} stations
 * @param {{west:number, south:number, east:number, north:number}} box Degrees.
 * @param {number} [cap]
 */
export function stationsInView(stations, box, cap = MAX_MARKERS) {
  const midLon = (box.west + box.east) / 2;
  const midLat = (box.south + box.north) / 2;
  // A view across the date line has west > east.
  const insideLon = (lon) =>
    box.west <= box.east
      ? lon >= box.west && lon <= box.east
      : lon >= box.west || lon <= box.east;
  return stations
    .filter((s) => s.lat >= box.south && s.lat <= box.north && insideLon(s.lon))
    .map((s) => ({
      s,
      rank: KIND_RANK[s.kind] ?? 3,
      far: (s.lon - midLon) ** 2 + (s.lat - midLat) ** 2,
    }))
    .sort((a, b) => a.rank - b.rank || a.far - b.far)
    .slice(0, cap)
    .map((entry) => entry.s);
}

/** Unpack the bundled file's compact rows. */
export function parseStations(file) {
  const kinds = Array.isArray(file?.kinds) ? file.kinds : [];
  return (Array.isArray(file?.stations) ? file.stations : [])
    .filter((row) => Number.isFinite(row?.[0]) && Number.isFinite(row?.[1]))
    .map(([lon, lat, kind, name]) => ({
      lon,
      lat,
      kind: kinds[kind] || 'train',
      name: String(name || 'Unnamed stop'),
    }));
}

function markerImage(color) {
  const size = 22;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, 7, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(4, 10, 16, 0.85)';
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, 2.5, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  return canvas;
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
 * @returns {() => void} Removes the markers, the switch and the listeners.
 */
export function installTrainStations({ viewer }, doc = document) {
  const { scene, camera } = viewer;
  let on = readSaved();
  let stations = null;
  let loading = null;
  let markers = null;
  let images = null;
  // On screen, not only in the attribution list.
  const credit = new Cesium.Credit(CREDIT, true);

  const tip = doc.createElement('div');
  tip.setAttribute('role', 'status');
  tip.style.cssText =
    'position:fixed;z-index:150;display:none;pointer-events:none;padding:5px 9px;' +
    'border-radius:8px;border:1px solid rgba(120,220,255,.55);background:rgba(4,10,16,.92);' +
    'color:#e8f8ff;font:600 12px/1.35 var(--font-mono,monospace);max-width:320px';
  doc.body.appendChild(tip);

  const button = doc.createElement('button');
  button.id = 'train-stations-toggle';
  button.type = 'button';
  button.textContent = '🚉';
  button.setAttribute('aria-label', 'Train stations');
  const paint = (note = '') => {
    button.setAttribute('aria-pressed', String(on));
    button.title =
      note ||
      (on
        ? 'Hide train, metro and tram stops'
        : 'Show train, metro and tram stops');
  };

  const clearMarkers = () => {
    markers?.removeAll();
    tip.style.display = 'none';
    scene.requestRender();
  };

  const redraw = () => {
    if (!on || !stations || viewer.isDestroyed()) return;
    const rect = camera.computeViewRectangle(scene.ellipsoid);
    markers.removeAll();
    if (rect) {
      const box = {
        west: Cesium.Math.toDegrees(rect.west),
        south: Cesium.Math.toDegrees(rect.south),
        east: Cesium.Math.toDegrees(rect.east),
        north: Cesium.Math.toDegrees(rect.north),
      };
      for (const station of stationsInView(stations, box)) {
        markers.add({
          id: station,
          position: Cesium.Cartesian3.fromDegrees(station.lon, station.lat),
          image: images[station.kind] || images.train,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          // Always on top: a marker hidden behind a building is no use.
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new Cesium.NearFarScalar(2_000, 1.1, 600_000, 0.45),
        });
      }
    }
    scene.requestRender();
  };

  const load = () => {
    loading ||= fetch(DATA_URL)
      .then((response) => {
        if (!response.ok)
          throw new Error(`stations file: HTTP ${response.status}`);
        return response.json();
      })
      .then((file) => {
        stations = parseStations(file);
      })
      .catch((error) => {
        loading = null;
        console.warn('[train-stations]', error?.message || error);
        paint('Station file missing: run alon-stations-download.sh');
      });
    return loading;
  };

  const apply = async () => {
    paint();
    if (!on) {
      clearMarkers();
      viewer.creditDisplay.removeStaticCredit(credit);
      return;
    }
    if (!markers) {
      images = Object.fromEntries(
        Object.entries(KIND_STYLE).map(([kind, style]) => [
          kind,
          markerImage(style.color),
        ]),
      );
      markers = scene.primitives.add(new Cesium.BillboardCollection({ scene }));
    }
    viewer.creditDisplay.addStaticCredit(credit);
    await load();
    redraw();
  };

  button.addEventListener('click', () => {
    on = !on;
    save(on);
    void apply();
  });
  doc.getElementById('top-center-actions')?.appendChild(button);

  const offMoveEnd = camera.moveEnd.addEventListener(redraw);

  // Hover or click a marker to read its name and kind.
  let lastPick = 0;
  const showAt = (position, force = false) => {
    if (!on || !markers?.length) return;
    const now = Date.now();
    if (!force && now - lastPick < HOVER_PICK_MS) return;
    lastPick = now;
    const picked = scene.pick(position);
    const station =
      picked?.collection === markers ||
      picked?.primitive?.collection === markers
        ? picked.id
        : null;
    if (!station) {
      tip.style.display = 'none';
      return;
    }
    const bounds = scene.canvas.getBoundingClientRect();
    tip.textContent = `${station.name} · ${KIND_STYLE[station.kind]?.label || 'station'}`;
    tip.style.left = `${bounds.left + position.x + 14}px`;
    tip.style.top = `${bounds.top + position.y + 14}px`;
    tip.style.display = 'block';
  };
  const handler = new Cesium.ScreenSpaceEventHandler(scene.canvas);
  handler.setInputAction(
    (movement) => showAt(movement.endPosition),
    Cesium.ScreenSpaceEventType.MOUSE_MOVE,
  );
  handler.setInputAction(
    (click) => showAt(click.position, true),
    Cesium.ScreenSpaceEventType.LEFT_CLICK,
  );

  void apply();

  return () => {
    offMoveEnd();
    handler.destroy();
    if (markers && !scene.isDestroyed()) scene.primitives.remove(markers);
    viewer.creditDisplay.removeStaticCredit(credit);
    tip.remove();
    button.remove();
  };
}
