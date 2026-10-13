import * as Cesium from 'cesium';
import { isMeasuring } from './measureTool.js';
import {
  isTimeZonePick,
  loadTimeZones,
  zoneAt,
  zoneClock,
} from './timeZones.js';

/**
 * Click the map to read what is there: the local time, ticking, and the
 * coordinates anywhere in the world, and in London the address too. One
 * toolbar switch, off until it is pressed.
 *
 * The address comes from Photon, the free OpenStreetMap search service the
 * app's place search already uses. It answers with the nearest mapped
 * address, which is not always the exact house, so the card says how far away
 * that address is. A well-known place nearby is named from Wikipedia. Each
 * click asks each service once, at most one click a second.
 */

const STORAGE_KEY = 'gev.addressLookup';
const PHOTON_REVERSE = 'https://photon.komoot.io/reverse';
const WIKIPEDIA = 'https://en.wikipedia.org/w/api.php';
const FAMOUS_RADIUS_M = 150;
const TIMEOUT_MS = 6000;
const MIN_GAP_MS = 1000;
const CACHE_MAX = 64;
const ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>';

/** Greater London, a little generous at the edges. */
export const LONDON = Object.freeze({
  south: 51.28,
  west: -0.52,
  north: 51.7,
  east: 0.34,
});

export function inLondon(lat, lon) {
  return (
    lat >= LONDON.south &&
    lat <= LONDON.north &&
    lon >= LONDON.west &&
    lon <= LONDON.east
  );
}

/** "51.50349, -0.12770": latitude first, about one metre of precision. */
export function formatCoordinates(lat, lon) {
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

export function distanceMetres(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) *
      Math.cos(lat2 * rad) *
      Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(a));
}

/**
 * Turn one Photon result into the lines the card shows.
 * @param {object} properties Photon feature properties.
 * @returns {{ title: string, place: string, exact: boolean }} `exact` is
 * false when no house number is mapped there.
 */
export function describeAddress(properties = {}) {
  const text = (value) => String(value || '').trim();
  const number = text(properties.housenumber);
  const street = text(properties.street);
  const name = text(properties.name);
  const line = number && street ? `${number} ${street}` : street || name;
  const title =
    name && name !== line && name !== street ? `${name}, ${line}` : line;
  const place = [properties.district, properties.city, properties.postcode]
    .map(text)
    .filter(Boolean)
    .join(', ');
  return { title, place, exact: Boolean(number) };
}

/**
 * The best-known Wikipedia place near a click. Many readers and close by
 * beats obscure and closest, so a palace wins over a statue in its garden.
 * @param {Array<{title?: string, pageviews?: object, coordinates?: Array<{dist?: number}>}>} pages
 * @returns {{ title: string, metres: number } | null}
 */
export function pickFamousPlace(pages = []) {
  let best = null;
  for (const page of pages) {
    const metres = page?.coordinates?.[0]?.dist;
    if (!page?.title || !Number.isFinite(metres)) continue;
    const views = Object.values(page.pageviews || {}).reduce(
      (sum, count) => sum + (count || 0),
      0,
    );
    const score = (views + 1) / (metres + 20) ** 2;
    if (!best || score > best.score)
      best = { title: page.title, metres: Math.round(metres), score };
  }
  return best && { title: best.title, metres: best.metres };
}

function pinImage() {
  const canvas = document.createElement('canvas');
  canvas.width = 26;
  canvas.height = 34;
  const ctx = canvas.getContext('2d');
  ctx.beginPath();
  ctx.moveTo(13, 33);
  ctx.bezierCurveTo(4, 22, 2, 18, 2, 13);
  ctx.arc(13, 13, 11, Math.PI, 0);
  ctx.bezierCurveTo(24, 18, 22, 22, 13, 33);
  ctx.fillStyle = '#ff6474';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#1a0508';
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(13, 13, 4, 0, Math.PI * 2);
  ctx.fillStyle = '#fff';
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
 * @returns {() => void} Removes the pin, the card, the switch and the listener.
 */
export function installAddressLookup({ viewer }, doc = document) {
  const { scene, camera } = viewer;
  let on = readSaved();
  let pins = null;
  let request = 0;
  let lastAskedAt = 0;
  const cache = new Map();

  const card = doc.createElement('div');
  card.id = 'address-card';
  card.setAttribute('role', 'status');
  card.style.cssText =
    'position:fixed;top:132px;left:50%;transform:translateX(-50%);z-index:160;display:none;' +
    'min-width:260px;max-width:min(460px,90vw);padding:10px 34px 10px 14px;border-radius:10px;' +
    'border:1px solid rgba(120,220,255,.55);background:rgba(4,10,16,.94);color:#e8f8ff;' +
    'font:500 12px/1.5 var(--font-mono,monospace)';
  const close = doc.createElement('button');
  close.type = 'button';
  close.textContent = '×';
  close.title = 'Close the address card';
  close.setAttribute('aria-label', 'Close the address card');
  close.style.cssText =
    'position:absolute;top:4px;right:6px;border:0;background:none;color:inherit;' +
    'font:600 18px/1 var(--font-mono,monospace);cursor:pointer';
  const lines = doc.createElement('div');
  const clock = doc.createElement('div');
  clock.style.cssText =
    'display:none;margin-top:6px;padding-top:6px;border-top:1px solid rgba(120,220,255,.25)';
  const clockTime = doc.createElement('div');
  clockTime.style.cssText =
    'font-weight:700;font-size:15px;letter-spacing:.04em;color:#ffc44d';
  const clockZone = doc.createElement('div');
  clockZone.style.cssText = 'opacity:.7;font-size:11px';
  clock.append(clockTime, clockZone);
  card.append(close, lines, clock);
  doc.body.appendChild(card);

  let clockTimer = null;
  const stopClock = () => {
    clearInterval(clockTimer);
    clockTimer = null;
    clock.style.display = 'none';
  };
  // The time is a bonus: if the zone file does not load, the rest still shows.
  const startClock = async (lat, lon, mine) => {
    stopClock();
    let zone;
    try {
      zone = zoneAt(await loadTimeZones(), lat, lon);
    } catch (error) {
      console.warn('[address-lookup] time zones', error?.message || error);
      return;
    }
    if (mine !== request) return;
    const tick = () => {
      const { time, day, offset, summer, city } = zoneClock(zone);
      const text = `Local time ${time}`;
      if (clockTime.textContent === text) return;
      clockTime.textContent = text;
      clockZone.textContent = [
        day,
        summer ? `${offset} (summer time)` : offset,
        city && `same clock as ${city}`,
      ]
        .filter(Boolean)
        .join(' · ');
    };
    tick();
    clock.style.display = 'block';
    // Checked four times a second so the seconds never visibly skip.
    clockTimer = setInterval(tick, 250);
  };

  const show = (rows) => {
    lines.replaceChildren(
      ...rows.filter(Boolean).map(([text, style]) => {
        const row = doc.createElement('div');
        row.textContent = text;
        if (style) row.style.cssText = style;
        return row;
      }),
    );
    card.style.display = 'block';
  };
  const STRONG = 'font-weight:700;font-size:13px;color:#fff';
  const FAINT = 'opacity:.7;font-size:11px';

  const hide = () => {
    request += 1;
    stopClock();
    card.style.display = 'none';
    pins?.removeAll();
    scene.requestRender();
  };
  close.addEventListener('click', hide);

  const askAddress = async (lat, lon) => {
    const response = await fetch(
      `${PHOTON_REVERSE}?lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}&limit=1&lang=en`,
      { signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json())?.features?.[0] || null;
  };

  // A famous place is a bonus: if Wikipedia does not answer, the address
  // still shows.
  const askFamous = async (lat, lon) => {
    try {
      const point = `${lat.toFixed(6)}%7C${lon.toFixed(6)}`;
      const response = await fetch(
        `${WIKIPEDIA}?action=query&generator=geosearch&ggscoord=${point}` +
          `&ggsradius=${FAMOUS_RADIUS_M}&ggslimit=10&prop=coordinates%7Cpageviews` +
          `&codistancefrompoint=${point}&pvipdays=7&format=json&formatversion=2&origin=*`,
        { signal: AbortSignal.timeout(TIMEOUT_MS) },
      );
      if (!response.ok) return null;
      return pickFamousPlace((await response.json())?.query?.pages);
    } catch {
      return null;
    }
  };

  const ask = async (lat, lon) => {
    const key = formatCoordinates(lat, lon);
    if (cache.has(key)) return cache.get(key);
    const wait = lastAskedAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastAskedAt = Date.now();
    const [feature, famous] = await Promise.all([
      askAddress(lat, lon),
      askFamous(lat, lon),
    ]);
    const found = { feature, famous };
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, found);
    return found;
  };

  const onClick = async (click) => {
    // While the measure tool is on, a click on the map is a measuring point.
    if (!on || isMeasuring()) return;
    // A click on a plane, camera or station belongs to that thing.
    const picked = scene.pick(click.position);
    const onMap =
      !picked ||
      picked.primitive instanceof Cesium.Cesium3DTileset ||
      picked instanceof Cesium.Cesium3DTileFeature ||
      isTimeZonePick(picked);
    if (!onMap) return;
    const spot =
      (scene.pickPositionSupported && scene.pickPosition(click.position)) ||
      camera.pickEllipsoid(click.position, scene.ellipsoid);
    if (!Cesium.defined(spot)) return;
    const where = Cesium.Cartographic.fromCartesian(spot);
    const lat = Cesium.Math.toDegrees(where.latitude);
    const lon = Cesium.Math.toDegrees(where.longitude);
    const coordinates = [`Coordinates: ${formatCoordinates(lat, lon)}`];
    const mine = ++request;

    pins ||= scene.primitives.add(new Cesium.BillboardCollection({ scene }));
    pins.removeAll();
    pins.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat),
      image: pinImage(),
      verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    });
    scene.requestRender();
    startClock(lat, lon, mine);

    if (!inLondon(lat, lon)) {
      show([['Addresses work in London only for now', STRONG], coordinates]);
      return;
    }
    show([['Looking up the address…', STRONG], coordinates]);
    try {
      const { feature, famous } = await ask(lat, lon);
      if (mine !== request) return;
      const famousRows = famous
        ? [
            [famous.title, STRONG],
            [
              `Well-known place (Wikipedia), ${famous.metres} m from your click`,
              FAINT,
            ],
          ]
        : [];
      if (!feature) {
        show([
          ...famousRows,
          ['No address is mapped near here', famous ? '' : STRONG],
          coordinates,
        ]);
        return;
      }
      const { title, place, exact } = describeAddress(feature.properties);
      const [foundLon, foundLat] = feature.geometry?.coordinates || [];
      const away = Number.isFinite(foundLat)
        ? Math.round(distanceMetres(lat, lon, foundLat, foundLon))
        : null;
      show([
        ...famousRows,
        [title || 'Unnamed place', famous ? '' : STRONG],
        place && [place],
        coordinates,
        [
          `${exact ? 'Nearest mapped address' : 'No house number is mapped here: nearest street or place'}` +
            `${away === null ? '' : `, ${away} m from your click`}`,
          FAINT,
        ],
        [
          'Addresses © OpenStreetMap contributors, via Photon. Place names from Wikipedia',
          FAINT,
        ],
      ]);
    } catch (error) {
      if (mine !== request) return;
      show([
        ['The address service did not answer. Try again in a moment', STRONG],
        coordinates,
      ]);
      console.warn('[address-lookup]', error?.message || error);
    }
  };

  const handler = new Cesium.ScreenSpaceEventHandler(scene.canvas);
  handler.setInputAction(onClick, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  const button = doc.createElement('button');
  button.id = 'address-lookup-toggle';
  button.type = 'button';
  button.innerHTML = ICON;
  button.setAttribute('aria-label', 'Address lookup');
  const paint = () => {
    button.setAttribute('aria-pressed', String(on));
    button.title = on
      ? 'Stop showing addresses when the map is clicked'
      : 'Click the map to see the local time and coordinates there (and the address, in London)';
  };
  button.addEventListener('click', () => {
    on = !on;
    save(on);
    paint();
    if (!on) hide();
  });
  paint();
  doc.getElementById('top-center-actions')?.appendChild(button);

  return () => {
    handler.destroy();
    if (pins && !scene.isDestroyed()) scene.primitives.remove(pins);
    card.remove();
    button.remove();
  };
}
