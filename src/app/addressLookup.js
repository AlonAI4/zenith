import * as Cesium from 'cesium';
import { sunLine } from './dayNight.js';
import { closeOnEscape } from './escapeKey.js';
import { isMeasuring } from './measureTool.js';
import {
  isTimeZonePick,
  loadTimeZones,
  zoneAt,
  zoneClock,
} from './timeZones.js';

/**
 * Click the map to read what is there: the local time, ticking, and the
 * coordinates anywhere in the world, and the address there too. One
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
const WIKIPEDIA_ASKER =
  'Zenith (a personal map viewer; one lookup per map click)';
const FAMOUS_RADIUS_M = 150;
const TIMEOUT_MS = 6000;
const MIN_GAP_MS = 1000;
const CACHE_MAX = 64;

/**
 * Keeps address requests at least `gapMs` apart. Each call waits its turn,
 * then resolves true when it may send its request now, or false when a newer
 * click replaced it while it waited: clicks that all waited for the same
 * moment would otherwise go out together.
 * @param {number} gapMs
 * @returns {(isCurrent: () => boolean) => Promise<boolean>}
 */
export function requestGate(
  gapMs,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
) {
  let last = -Infinity;
  return async (isCurrent) => {
    const wait = last + gapMs - now();
    if (wait > 0) await sleep(wait);
    if (!isCurrent()) return false;
    last = now();
    return true;
  };
}
const ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>';

/**
 * Above this camera height a click is not looked up. From that far out an
 * address means nothing, and the lookup services are free ones that ask to
 * be used fairly.
 */
export const ADDRESS_MAX_HEIGHT_M = 300_000;

/** Is the view close enough for an address to mean something? */
export function closeEnoughForAddress(cameraHeightM) {
  return (
    Number.isFinite(cameraHeightM) && cameraHeightM <= ADDRESS_MAX_HEIGHT_M
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

/** How close a numbered house must be to be the house that was clicked. */
export const HOUSE_WITHIN_M = 30;
/** How far away a street may be and still be named as the street here. */
export const STREET_WITHIN_M = 200;

/**
 * The address for a click, chosen from the nearest things the lookup found.
 *
 * Taking only the single nearest thing gave two houses on one street two
 * different answers, because the nearest thing is sometimes a bare postcode
 * and sometimes the street. So: a numbered house close by is the house that
 * was clicked. Failing that, the nearest thing that knows its street names
 * the street, with the nearest numbered house on that street as a guide.
 * Only when nothing nearby knows a street is the nearest name used.
 *
 * @param {Array<{geometry?: {coordinates?: number[]}, properties?: object}>} features
 * @param {number} lat
 * @param {number} lon
 * @returns {{ title: string, place: string, exact: boolean, away: number,
 *   guide: { number: string, away: number } | null } | null}
 */
export function chooseAddress(features, lat, lon) {
  const text = (value) => String(value || '').trim();
  const near = (Array.isArray(features) ? features : [])
    .map((feature) => {
      const [foundLon, foundLat] = feature?.geometry?.coordinates || [];
      const about = feature?.properties || {};
      if (!Number.isFinite(foundLat) || !Number.isFinite(foundLon)) return null;
      return {
        about,
        metres: distanceMetres(lat, lon, foundLat, foundLon),
        number: text(about.housenumber),
        // A street is its own name; anything else says which street it is on.
        street: about.type === 'street' ? text(about.name) : text(about.street),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.metres - b.metres);
  if (near.length === 0) return null;

  const house = near.find(
    (found) => found.number && found.street && found.metres <= HOUSE_WITHIN_M,
  );
  const onStreet =
    house ||
    near.find((found) => found.street && found.metres <= STREET_WITHIN_M);
  const chosen = onStreet || near[0];
  // District, city and postcode: the chosen thing's own, or the nearest that has one.
  const fill = (key) =>
    text(chosen.about[key]) ||
    text(near.find((found) => text(found.about[key]))?.about[key]);
  const place = [fill('district'), fill('city'), fill('postcode')]
    .filter(Boolean)
    .join(', ');

  if (house) {
    return {
      title: describeAddress(house.about).title,
      place,
      exact: true,
      away: Math.round(house.metres),
      guide: null,
    };
  }
  if (onStreet) {
    const numbered = near.find(
      (found) => found.number && found.street === onStreet.street,
    );
    return {
      title: onStreet.street,
      place,
      exact: false,
      away: Math.round(onStreet.metres),
      guide: numbered
        ? { number: numbered.number, away: Math.round(numbered.metres) }
        : null,
    };
  }
  return {
    title: describeAddress(chosen.about).title,
    place,
    exact: false,
    away: Math.round(chosen.metres),
    guide: null,
  };
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
  const mayAsk = requestGate(MIN_GAP_MS);
  const cache = new Map();

  const card = doc.createElement('div');
  card.id = 'address-card';
  // A named region, not a live one: only the address lines are read out when
  // they arrive, never the clock below them that ticks every second.
  card.setAttribute('role', 'region');
  card.setAttribute('aria-label', 'Map pin card');
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
  lines.setAttribute('role', 'status');
  const clock = doc.createElement('div');
  clock.style.cssText =
    'display:none;margin-top:6px;padding-top:6px;border-top:1px solid rgba(120,220,255,.25)';
  const clockTime = doc.createElement('div');
  clockTime.style.cssText =
    'font-weight:700;font-size:15px;letter-spacing:.04em;color:#ffc44d';
  const clockZone = doc.createElement('div');
  clockZone.style.cssText = 'opacity:.7;font-size:11px';
  const clockSun = doc.createElement('div');
  clockSun.id = 'address-card-sun';
  clockSun.style.cssText = 'margin-top:2px;font-size:11px;color:#ffd9a0';
  clock.append(clockTime, clockZone, clockSun);
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
    let sunMinute = '';
    const tick = () => {
      const { time, day, offset, summer, city } = zoneClock(zone);
      const text = `Local time ${time}`;
      if (clockTime.textContent === text) return;
      clockTime.textContent = text;
      // Day or night there, and the next sunrise and sunset in that place's
      // own time. Worked out again each minute.
      if (time.slice(0, 5) !== sunMinute) {
        sunMinute = time.slice(0, 5);
        clockSun.textContent = sunLine(lat, lon, Date.now(), (ms) =>
          zoneClock(zone, new Date(ms)).time.slice(0, 5),
        );
      }
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
  const offEscape = closeOnEscape(
    doc.defaultView ?? window,
    () => card.style.display === 'block',
    hide,
    // The switch is made further down; it exists by the time a key is pressed.
    { panel: card, opener: { focus: () => button.focus() } },
  );

  const askAddress = async (lat, lon) => {
    const response = await fetch(
      // One request for the ten nearest things, not ten requests.
      `${PHOTON_REVERSE}?lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}&limit=10&lang=en`,
      { signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json())?.features || [];
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
        {
          signal: AbortSignal.timeout(TIMEOUT_MS),
          // Wikipedia asks every program to say what it is. A page cannot
          // set the usual header, so it offers this one instead.
          headers: { 'Api-User-Agent': WIKIPEDIA_ASKER },
        },
      );
      if (!response.ok) return null;
      return pickFamousPlace((await response.json())?.query?.pages);
    } catch {
      return null;
    }
  };

  const ask = async (lat, lon, mine) => {
    const key = formatCoordinates(lat, lon);
    if (cache.has(key)) return cache.get(key);
    if (!(await mayAsk(() => mine === request))) return null;
    const [features, famous] = await Promise.all([
      askAddress(lat, lon),
      askFamous(lat, lon),
    ]);
    const found = { features, famous };
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, found);
    return found;
  };

  const onClick = async (click) => {
    // While the measure tool is on, a click on the map is a measuring point.
    if (!on || isMeasuring()) return;
    // A click on a plane, camera or station belongs to that thing. A click
    // on the pin already standing there is a click on the map under it.
    const picked = scene.pick(click.position);
    const onOwnPin =
      Boolean(pins) &&
      (picked?.collection === pins || picked?.primitive?.collection === pins);
    const onMap =
      !picked ||
      onOwnPin ||
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
    card.dataset.lat = lat.toFixed(5);
    card.dataset.lon = lon.toFixed(5);
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

    if (!closeEnoughForAddress(camera.positionCartographic?.height)) {
      show([['Zoom in closer to look up an address', STRONG], coordinates]);
      return;
    }
    show([['Looking up the address…', STRONG], coordinates]);
    try {
      const found = await ask(lat, lon, mine);
      if (mine !== request || !found) return;
      const { features, famous } = found;
      const famousRows = famous
        ? [
            [famous.title, STRONG],
            [
              `Well-known place (Wikipedia), ${famous.metres} m from your click`,
              FAINT,
            ],
          ]
        : [];
      const address = chooseAddress(features, lat, lon);
      if (!address) {
        show([
          ...famousRows,
          ['No address is mapped near here', famous ? '' : STRONG],
          coordinates,
        ]);
        return;
      }
      show([
        ...famousRows,
        [address.title || 'Unnamed place', famous ? '' : STRONG],
        address.place && [address.place],
        coordinates,
        [
          address.exact
            ? `House number as mapped, ${address.away} m from your click`
            : `No house number is mapped here: nearest street or place, ${address.away} m from your click`,
          FAINT,
        ],
        address.guide && [
          `Nearest mapped house number on this street: ${address.guide.number}, ${address.guide.away} m away`,
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
  button.setAttribute('aria-label', 'Map pin');
  const paint = () => {
    button.setAttribute('aria-pressed', String(on));
    button.title = on
      ? 'Stop showing addresses when the map is clicked'
      : 'Click the map to see the local time, the coordinates and the address there';
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
    offEscape();
    handler.destroy();
    if (pins && !scene.isDestroyed()) scene.primitives.remove(pins);
    card.remove();
    button.remove();
  };
}
