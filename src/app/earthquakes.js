import * as Cesium from 'cesium';
import {
  clearOverlaySource,
  setOverlayEntries,
} from '../overlays/worldOverlay.js';
import { guard } from './addOns.js';
import { closeOnEscape } from './escapeKey.js';
import { showNotice } from './notice.js';

/**
 * Live earthquakes: the last day's earthquakes of magnitude 2.5 and up, as
 * circles sized by strength. Click one for its strength, place and time.
 *
 * The data is the U.S. Geological Survey's public feed, which they publish
 * for programs to read. It needs no key, is refreshed by them every minute,
 * and is asked for here when the switch goes on and every five minutes
 * after. USGS data is a work of the US government and so in the public
 * domain; they are credited on screen while the layer shows.
 */

const STORAGE_KEY = 'gev.earthquakes';
const LAYER_NAME = 'alon-earthquakes';
export const FEED_URL =
  'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson';
const EVENT_PAGE = 'https://earthquake.usgs.gov/earthquakes/eventpage/';
const CREDIT = 'Earthquakes: U.S. Geological Survey';
const REFRESH_MS = 5 * 60_000;
/** After a failed ask, the next tries come sooner, then back to every five minutes. */
const RETRY_MS = [30_000, 60_000, 120_000];
const NOTICE_ID = 'feed-notice';
const TIMEOUT_MS = 12_000;
const MAX_QUAKES = 600;

/**
 * The earthquakes in a feed answer, weakest first so the strong ones are
 * drawn on top. Anything that is not an earthquake (the feed also lists
 * quarry blasts) or is missing a number is left out.
 */
export function parseQuakes(feed) {
  const features = Array.isArray(feed?.features) ? feed.features : [];
  const quakes = [];
  for (const feature of features) {
    const about = feature?.properties ?? {};
    const [lon, lat, depth] = feature?.geometry?.coordinates ?? [];
    if (about.type !== 'earthquake') continue;
    if (![about.mag, about.time, lon, lat].every(Number.isFinite)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    quakes.push({
      id: String(feature.id ?? `${about.time}:${lon}:${lat}`).slice(0, 60),
      mag: about.mag,
      place: String(about.place ?? 'Place not given').slice(0, 120),
      time: about.time,
      lon,
      lat,
      depthKm: Number.isFinite(depth) ? depth : null,
      // Only ever the survey's own page for the event.
      url:
        typeof about.url === 'string' && about.url.startsWith(EVENT_PAGE)
          ? about.url
          : null,
    });
  }
  return quakes.sort((a, b) => a.mag - b.mag).slice(-MAX_QUAKES);
}

/** The circle's width on screen, in pixels: bigger for a stronger quake. */
export function quakeSize(mag) {
  return Math.round(Math.min(46, Math.max(6, 6 + (mag - 2.5) * 7.5)));
}

/** Yellow for light, orange for moderate, red for strong. */
export function quakeColor(mag) {
  if (mag >= 5.5) return '#ff4d4d';
  return mag >= 4 ? '#ff9d3d' : '#ffd84d';
}

/** How long ago, in words. */
export function agoLabel(ms) {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 2) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest >= 5 && hours < 12
    ? `${hours} h ${rest} min ago`
    : `${hours} h ago`;
}

/** The card for one earthquake: a title and the lines under it. */
export function quakeCard(quake, now = Date.now()) {
  const when = new Date(quake.time).toISOString().slice(11, 16);
  return {
    title: `Magnitude ${quake.mag.toFixed(1)}`,
    details: [
      quake.place,
      `${when} UTC · ${agoLabel(now - quake.time)}`,
      quake.depthKm === null
        ? null
        : // Shallow ones, and those under a mountain (depth above sea level), would read 0 or -1 km.
          quake.depthKm < 0.5
          ? 'less than 1 km deep'
          : `${Math.round(quake.depthKm)} km deep`,
    ].filter(Boolean),
  };
}

const ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 12h4l2-6 3.5 12 3-9 1.5 3h5"/></svg>';

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
    // Private windows can refuse storage; the switch still works this visit.
  }
}

/**
 * @param {{ viewer: Cesium.Viewer }} scene
 * @param {Document} [doc]
 * @param {{ fetchFeed?: () => Promise<unknown> }} [options]
 * @returns {() => void} Removes the layer, the switch and the timer.
 */
export function installEarthquakes(
  { viewer },
  doc = document,
  {
    fetchFeed = async () => {
      const answer = await fetch(FEED_URL, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
      if (!answer.ok) throw new Error(`HTTP ${answer.status}`);
      return answer.json();
    },
  } = {},
) {
  const { scene, camera } = viewer;
  let on = readSaved();
  let points = null;
  let quakes = [];
  let selected = null;
  let timer = null;
  let retry = null;
  let failures = 0;
  let asking = 0;
  const credit = new Cesium.Credit(CREDIT, true);

  const button = doc.createElement('button');
  button.id = 'earthquakes-toggle';
  button.type = 'button';
  button.innerHTML = ICON;
  button.setAttribute('aria-label', 'Earthquakes');
  const paint = (note = '') => {
    button.setAttribute('aria-pressed', String(on));
    button.dataset.count = on ? String(quakes.length) : '';
    button.title =
      note ||
      (on
        ? `Hide the earthquakes (${quakes.length} in the last day, magnitude 2.5 and up)`
        : "Show the last day's earthquakes");
  };

  const showCard = () => {
    if (!selected) {
      clearOverlaySource(LAYER_NAME);
      return;
    }
    const { title, details } = quakeCard(selected);
    setOverlayEntries(
      LAYER_NAME,
      [
        {
          id: selected.id,
          position: Cesium.Cartesian3.fromDegrees(selected.lon, selected.lat),
          variant: 'card',
          title,
          details,
          accent: quakeColor(selected.mag),
          pinned: true,
          protected: true,
          priority: 9,
        },
      ],
      { cohortLimit: 4, collisionCapacity: 4 },
    );
  };

  const draw = () => {
    if (!points) {
      points = scene.primitives.add(new Cesium.PointPrimitiveCollection());
    }
    points.removeAll();
    for (const quake of quakes) {
      const color = Cesium.Color.fromCssColorString(quakeColor(quake.mag));
      points.add({
        id: quake,
        position: Cesium.Cartesian3.fromDegrees(quake.lon, quake.lat),
        pixelSize: quakeSize(quake.mag),
        color: color.withAlpha(0.55),
        outlineColor: color,
        outlineWidth: 1.5,
        // Never buried under a mountain or a building. Circles on the far
        // side of the Earth are hidden by hideFarSide instead.
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
    }
    if (selected && !quakes.some((quake) => quake.id === selected.id)) {
      selected = null;
    }
    showCard();
    hideFarSide();
    scene.requestRender();
  };

  // A circle drawn without a depth test would show through the Earth, so
  // each frame the ones over the horizon are hidden.
  function hideFarSide() {
    if (!on || !points || points.length === 0) return;
    const occluder = new Cesium.EllipsoidalOccluder(
      scene.globe.ellipsoid,
      camera.positionWC,
    );
    for (let i = 0; i < points.length; i++) {
      const point = points.get(i);
      point.show = occluder.isPointVisible(point.position);
    }
  }

  const refresh = async () => {
    const mine = ++asking;
    try {
      const found = parseQuakes(await fetchFeed());
      if (mine !== asking || !on) return;
      quakes = found;
      failures = 0;
      clearTimeout(retry);
      retry = null;
      doc.getElementById(NOTICE_ID)?.remove();
      draw();
      paint();
    } catch (error) {
      if (mine !== asking || !on) return;
      console.warn('[earthquakes]', error?.message || error);
      const wait = RETRY_MS[failures] ?? null;
      failures += 1;
      const when = !wait
        ? 'in five minutes'
        : wait < 60_000
          ? `in ${wait / 1000} seconds`
          : `in ${wait / 60_000} minute${wait === 60_000 ? '' : 's'}`;
      const words = `The earthquake feed did not answer. Trying again ${when}.`;
      // On screen, not only in the switch's hover title.
      paint(words);
      showNotice(doc, words, { id: NOTICE_ID, ms: 60_000 });
      clearTimeout(retry);
      retry = wait ? setTimeout(refresh, wait) : null;
    }
  };

  const apply = () => {
    clearInterval(timer);
    timer = null;
    if (on) {
      viewer.creditDisplay.addStaticCredit(credit);
      refresh();
      timer = setInterval(refresh, REFRESH_MS);
    } else {
      asking += 1;
      clearTimeout(retry);
      retry = null;
      failures = 0;
      doc.getElementById(NOTICE_ID)?.remove();
      quakes = [];
      selected = null;
      points?.removeAll();
      clearOverlaySource(LAYER_NAME);
      viewer.creditDisplay.removeStaticCredit(credit);
      scene.requestRender();
    }
    paint();
  };

  const onClick = (click) => {
    if (!on || !points) return;
    const picked = scene.pick(click.position);
    const quake = picked?.collection === points ? picked.id : null;
    // A click on a circle selects it; a click anywhere else puts the card away.
    if (quake === selected) return;
    selected = quake && typeof quake === 'object' ? quake : null;
    showCard();
    scene.requestRender();
  };
  const handler = new Cesium.ScreenSpaceEventHandler(scene.canvas);
  handler.setInputAction(onClick, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  // Escape puts the card away, like a click on empty map.
  const offEscape = closeOnEscape(
    doc.defaultView ?? window,
    () => selected !== null,
    () => {
      selected = null;
      showCard();
      scene.requestRender();
    },
  );
  const removeMoved = scene.preRender.addEventListener(
    guard('Earthquakes', hideFarSide),
  );

  button.addEventListener('click', () => {
    on = !on;
    save(on);
    apply();
  });
  paint();
  doc.getElementById('top-center-actions')?.appendChild(button);
  if (on) apply();

  return () => {
    on = false;
    clearInterval(timer);
    clearTimeout(retry);
    offEscape();
    removeMoved();
    handler.destroy();
    clearOverlaySource(LAYER_NAME);
    if (points) scene.primitives.remove(points);
    viewer.creditDisplay.removeStaticCredit(credit);
    button.remove();
  };
}
