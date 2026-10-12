import * as Cesium from 'cesium';

/**
 * Click the map to read the address there, with its coordinates. London only
 * for now. One toolbar switch, off until it is pressed.
 *
 * The address comes from Photon, the free OpenStreetMap search service the
 * app's place search already uses: one request per click, at most one a
 * second. It answers with the nearest mapped address, which is not always the
 * exact house, so the card says how far away that address is.
 */

const STORAGE_KEY = 'gev.addressLookup';
const PHOTON_REVERSE = 'https://photon.komoot.io/reverse';
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
  card.append(close, lines);
  doc.body.appendChild(card);

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
    card.style.display = 'none';
    pins?.removeAll();
    scene.requestRender();
  };
  close.addEventListener('click', hide);

  const ask = async (lat, lon) => {
    const key = formatCoordinates(lat, lon);
    if (cache.has(key)) return cache.get(key);
    const wait = lastAskedAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastAskedAt = Date.now();
    const response = await fetch(
      `${PHOTON_REVERSE}?lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}&limit=1&lang=en`,
      { signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const feature = (await response.json())?.features?.[0] || null;
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, feature);
    return feature;
  };

  const onClick = async (click) => {
    if (!on) return;
    // A click on a plane, camera or station belongs to that thing.
    const picked = scene.pick(click.position);
    const onMap =
      !picked ||
      picked.primitive instanceof Cesium.Cesium3DTileset ||
      picked instanceof Cesium.Cesium3DTileFeature;
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

    if (!inLondon(lat, lon)) {
      show([['Addresses work in London only for now', STRONG], coordinates]);
      return;
    }
    show([['Looking up the address…', STRONG], coordinates]);
    try {
      const feature = await ask(lat, lon);
      if (mine !== request) return;
      if (!feature) {
        show([['No address is mapped near here', STRONG], coordinates]);
        return;
      }
      const { title, place, exact } = describeAddress(feature.properties);
      const [foundLon, foundLat] = feature.geometry?.coordinates || [];
      const away = Number.isFinite(foundLat)
        ? Math.round(distanceMetres(lat, lon, foundLat, foundLon))
        : null;
      show([
        [title || 'Unnamed place', STRONG],
        place && [place],
        coordinates,
        [
          `${exact ? 'Nearest mapped address' : 'No house number is mapped here: nearest street or place'}` +
            `${away === null ? '' : `, ${away} m from your click`}`,
          FAINT,
        ],
        ['Address data © OpenStreetMap contributors, via Photon', FAINT],
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
      : 'Click the map to see the address and coordinates there (London only)';
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
