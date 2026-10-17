import * as Cesium from 'cesium';
import { PIN_AT_EVENT } from './addressLookup.js';
import { showNotice } from './notice.js';

/**
 * Typing a street address in the LOCATION search (a house number, then the
 * street) flies to that exact house, looking straight down at it, with the map
 * pin card open on it.
 *
 * The original search goes to a house only when Google answers; with the free
 * services it often lands in the middle of the street, or on the right house
 * number in the wrong town. So an address is looked up here first, in
 * Photon (free OpenStreetMap search, which forgives typing mistakes), and a
 * house counts only when both its number and its street match what was typed.
 * If the number is not on the map, the view goes to that street and says so.
 * Anything that is not an address, or not found, goes to the original search
 * unchanged, which frames towns and countries at their own height.
 */

const PHOTON = 'https://photon.komoot.io/api/';
const TIMEOUT_MS = 6000;
/** Height above the ground for a house, and for a street, looking straight down. */
export const HOUSE_HEIGHT_M = 170;
export const STREET_HEIGHT_M = 450;

/** Street words people shorten or mistype, to their full word. */
const STREET_WORDS = Object.freeze({
  st: 'street',
  str: 'street',
  rd: 'road',
  ave: 'avenue',
  av: 'avenue',
  avn: 'avenue',
  ln: 'lane',
  cl: 'close',
  cres: 'crescent',
  cresc: 'crescent',
  dr: 'drive',
  gdns: 'gardens',
  gdn: 'gardens',
  pl: 'place',
  sq: 'square',
  tce: 'terrace',
  terr: 'terrace',
  gr: 'grove',
  pk: 'park',
  wy: 'way',
  hl: 'hill',
  ct: 'court',
});

/**
 * A house number, then a street, then perhaps a town or postcode after a
 * comma: "10 Downing Street, London". Null for anything else, coordinates
 * included.
 * @returns {{ number: string, street: string, rest: string } | null}
 */
export function parseAddress(text) {
  const found =
    /^\s*(\d{1,5}[a-z]?)(?:\s*[-/]\s*\d{1,5}[a-z]?)?\s*,?\s+([^,\d][^,]*?)\s*(?:,\s*(.*?))?\s*$/i.exec(
      String(text ?? ''),
    );
  if (!found || !/[a-z]{2}/i.test(found[2])) return null;
  return {
    number: found[1].toLowerCase(),
    street: found[2].trim(),
    rest: (found[3] || '').trim(),
  };
}

/** Lower case, no dots or commas, and shortened street words written out. */
export function normalStreet(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[.,']/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => STREET_WORDS[word] || word)
    .join(' ');
}

/** How alike two texts are, from 0 (nothing alike) to 1 (the same). */
export function likeness(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(
        row[j] + 1,
        next[j - 1] + 1,
        row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    row = next;
  }
  return 1 - row[b.length] / Math.max(a.length, b.length);
}

/** Whether a street on the map is the street that was typed, typing mistakes and all. */
export function sameStreet(typed, mapped) {
  return likeness(normalStreet(typed), normalStreet(mapped)) >= 0.8;
}

/**
 * The house, or failing that the street, among Photon's answers.
 * @param {Array<{ geometry?: { coordinates?: number[] }, properties?: object }>} features
 * @param {{ number: string, street: string, rest: string }} address
 * @returns {{ kind: 'house'|'street', lat: number, lon: number, label: string } | null}
 */
export function chooseAddressHit(features, address) {
  const hits = (Array.isArray(features) ? features : [])
    .map((feature) => {
      const [lon, lat] = feature?.geometry?.coordinates || [];
      const about = feature?.properties || {};
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      const street = about.type === 'street' ? about.name : about.street;
      if (!street || !sameStreet(address.street, street)) return null;
      const town = about.city || about.district || about.county || '';
      // A town or postcode after the comma must match too, when one was typed.
      const where = [
        about.city,
        about.district,
        about.county,
        about.postcode,
        about.locality,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (
        address.rest &&
        !where.includes(address.rest.toLowerCase().split(/\s*,\s*/)[0])
      )
        return null;
      return { lat, lon, about, street, town };
    })
    .filter(Boolean);
  const house =
    address.number &&
    hits.find(
      (hit) =>
        String(hit.about.housenumber || '').toLowerCase() === address.number,
    );
  if (house) {
    return {
      kind: 'house',
      lat: house.lat,
      lon: house.lon,
      label: [`${house.about.housenumber} ${house.street}`, house.town]
        .filter(Boolean)
        .join(', '),
    };
  }
  const street = hits.find((hit) => hit.about.type === 'street') || hits[0];
  if (!street) return null;
  return {
    kind: 'street',
    lat: street.lat,
    lon: street.lon,
    label: [street.street, street.town].filter(Boolean).join(', '),
  };
}

/**
 * @param {{ viewer: Cesium.Viewer }} scene
 * @param {Document} [doc]
 * @param {{ fetchImpl?: typeof fetch }} [options]
 * @returns {() => void}
 */
export function installAddressSearch(
  { viewer },
  doc = document,
  { fetchImpl = fetch } = {},
) {
  const win = doc.defaultView ?? window;
  const input = doc.getElementById('location-search');
  if (!input) return () => {};
  let passing = false;
  let request = 0;

  // Hand the search back to the original, as if this add-on were not here.
  const passOn = () => {
    passing = true;
    try {
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    } finally {
      passing = false;
    }
  };

  const fly = (hit) => {
    const carto = Cesium.Cartographic.fromDegrees(hit.lon, hit.lat);
    const ground = viewer.scene.globe?.getHeight?.(carto);
    const above = hit.kind === 'house' ? HOUSE_HEIGHT_M : STREET_HEIGHT_M;
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(
        hit.lon,
        hit.lat,
        (Number.isFinite(ground) ? ground : 50) + above,
      ),
      orientation: { heading: 0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 },
      duration: 3,
      complete: () =>
        win.dispatchEvent(
          new CustomEvent(PIN_AT_EVENT, {
            detail: { lat: hit.lat, lon: hit.lon },
          }),
        ),
    });
  };

  const onKey = async (event) => {
    if (passing || event.key !== 'Enter' || event.target !== input) return;
    const address = parseAddress(input.value);
    if (!address) return;
    event.stopImmediatePropagation();
    event.preventDefault();
    const mine = ++request;
    let hit = null;
    const ask = async (q) => {
      const centre = viewer.camera.positionCartographic;
      const params = new URLSearchParams({ q, limit: '10', lang: 'en' });
      if (centre) {
        // Near the view first, so the street nearby wins over one of the
        // same name far away.
        params.set('lat', Cesium.Math.toDegrees(centre.latitude).toFixed(4));
        params.set('lon', Cesium.Math.toDegrees(centre.longitude).toFixed(4));
      }
      const response = await fetchImpl(`${PHOTON}?${params}`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      return response.ok ? (await response.json())?.features : [];
    };
    try {
      hit = chooseAddressHit(await ask(input.value.trim()), address);
      // An unmapped number can pull in houses of that number on other
      // streets: then the street alone is asked for.
      if (!hit) {
        const street = [address.street, address.rest]
          .filter(Boolean)
          .join(', ');
        hit = chooseAddressHit(await ask(street), { ...address, number: '' });
      }
    } catch (error) {
      console.warn('[address-search]', error?.message || error);
    }
    if (mine !== request) return;
    if (!hit) {
      passOn();
      return;
    }
    input.blur();
    if (hit.kind === 'street') {
      showNotice(
        doc,
        `Number ${address.number} is not on the map: showing ${hit.label}`,
        { id: 'zenith-address-notice', ms: 8000 },
      );
    }
    fly(hit);
  };
  win.addEventListener('keydown', onKey, true);
  return () => win.removeEventListener('keydown', onKey, true);
}
