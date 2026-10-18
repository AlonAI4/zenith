import * as Cesium from 'cesium';
import {
  clearOverlaySource,
  setOverlayEntries,
} from '../overlays/worldOverlay.js';
import { blip } from './classified.js';
import { closeOnEscape } from './escapeKey.js';
import { showNotice } from './notice.js';

/**
 * Watch zones: circles drawn on the map that raise an alert when a plane, a
 * ship or a satellite comes into one.
 *
 * Add zone, click the map for the middle, then pick the size, a name and
 * what it watches. Each zone is a dashed cyan ring with its name. Every 2
 * seconds the planes, ships and satellites the original's layers already
 * hold are checked against the zones: anything newly inside gives a short
 * notice, the radio blip (with the classified look's blips on) and a line in
 * the panel's alert log. The same thing inside again within 10 minutes is
 * not a new alert, and things already inside when a zone starts watching are
 * not alerts.
 *
 * Fast things are checked along the path they took since the last check, so
 * a satellite (8 km a second) cannot jump over a small zone between two
 * checks. Zones are kept in this browser's storage on this computer only.
 * Everything checked is public plane, ship and satellite data.
 */

const STORAGE_KEY = 'gev.watchZones';
const WATCHING_KEY = 'gev.watchZonesOn';
export const MAX_ZONES = 10;
/** The sizes a zone can have: the distance from its middle to its ring. */
export const ZONE_SIZES_M = Object.freeze([500, 2000, 10_000, 50_000]);
export const KINDS = Object.freeze(['planes', 'ships', 'satellites']);
/** The original's layer for each kind. */
export const LAYER_OF = Object.freeze({
  planes: 'flights',
  ships: 'vessels',
  satellites: 'satellites',
});
export const KIND_NAMES = Object.freeze({
  planes: 'Planes',
  ships: 'Ships',
  satellites: 'Satellites',
});
export const CHECK_MS = 2000;
export const REPEAT_MS = 10 * 60_000;
export const MAX_ALERTS = 50;
export const MAX_ZONE_NAME = 24;
const CYAN = '#00f6ff';
const OVERLAY = 'alon-watch-zones';
const EARTH_M = 6_371_000;
/** A step longer than this between two checks is a jump in the data, not a journey. */
const MAX_STEP_M = 100_000;
/** Satellites are worked out one by one, so only the main catalogue is checked. */
const SATELLITE_LIMIT = 2000;
const RING_POINTS = 72;

/** "500 m", "2 km". */
export const sizeLabel = (m) => (m < 1000 ? `${m} m` : `${m / 1000} km`);

/** A name as it is stored: trimmed, single spaces, not too long. */
export function cleanZoneName(raw) {
  const tidy = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(tidy).slice(0, MAX_ZONE_NAME).join('').trim();
}

const finite = (value, low, high) =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= low &&
  value <= high;

/** True for a stored zone that is safe to use. */
export function isZone(zone) {
  return (
    Boolean(zone) &&
    typeof zone === 'object' &&
    typeof zone.id === 'string' &&
    /^[\w-]{1,40}$/.test(zone.id) &&
    typeof zone.name === 'string' &&
    zone.name.length > 0 &&
    cleanZoneName(zone.name) === zone.name &&
    finite(zone.lat, -90, 90) &&
    finite(zone.lon, -180, 180) &&
    ZONE_SIZES_M.includes(zone.radiusM) &&
    Array.isArray(zone.watch) &&
    zone.watch.length > 0 &&
    zone.watch.every((kind) => KINDS.includes(kind)) &&
    new Set(zone.watch).size === zone.watch.length &&
    typeof zone.on === 'boolean'
  );
}

/** The saved zones from storage text. Anything damaged is left out. */
export function parseZones(text) {
  try {
    const list = JSON.parse(text ?? '[]');
    if (!Array.isArray(list)) return [];
    const ids = new Set();
    return list
      .filter((zone) => isZone(zone) && !ids.has(zone.id) && ids.add(zone.id))
      .slice(0, MAX_ZONES);
  } catch {
    return [];
  }
}

/** The list with a zone added at the end, or unchanged when it is full. */
export function addZone(list, zone) {
  if (!isZone(zone) || list.length >= MAX_ZONES) return list;
  if (list.some((old) => old.id === zone.id)) return list;
  return [...list, zone];
}

export const removeZone = (list, id) => list.filter((zone) => zone.id !== id);

export const switchZone = (list, id, on) =>
  list.map((zone) => (zone.id === id ? { ...zone, on } : zone));

/** Metres between two spots on the Earth. */
export function distanceM(lat1, lon1, lat2, lon2) {
  const k = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * k) / 2) ** 2 +
    Math.cos(lat1 * k) *
      Math.cos(lat2 * k) *
      Math.sin(((lon2 - lon1) * k) / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** True for a spot inside a zone or on its ring. */
export const insideZone = (zone, lat, lon) =>
  distanceM(zone.lat, zone.lon, lat, lon) <= zone.radiusM;

/** Metres east and north of a zone's middle: flat, close enough near a zone. */
function fromMiddle(zone, lat, lon) {
  const k = Math.PI / 180;
  let east = lon - zone.lon;
  if (east > 180) east -= 360;
  if (east < -180) east += 360;
  return {
    x: east * k * EARTH_M * Math.cos(zone.lat * k),
    y: (lat - zone.lat) * k * EARTH_M,
  };
}

/**
 * Whether something is in a zone now, or went through it on its way from
 * where it was at the last check.
 * @param {{ lat: number, lon: number } | undefined} from
 * @param {{ lat: number, lon: number }} to
 */
export function passedThrough(zone, from, to) {
  if (insideZone(zone, to.lat, to.lon)) return true;
  if (!from || distanceM(from.lat, from.lon, to.lat, to.lon) > MAX_STEP_M)
    return false;
  const a = fromMiddle(zone, from.lat, from.lon);
  const b = fromMiddle(zone, to.lat, to.lon);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length2 = dx * dx + dy * dy;
  const t = length2
    ? Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / length2))
    : 0;
  return Math.hypot(a.x + t * dx, a.y + t * dy) <= zone.radiusM;
}

/**
 * Remembers what is inside each zone, so only arrivals become alerts.
 * @param {number} [repeatMs] How long the same thing in the same zone stays
 *   quiet after an alert.
 */
export function createAlerter(repeatMs = REPEAT_MS) {
  // `${zone}|${kind}` → (thing → { inside, at: time of its last alert }).
  const groups = new Map();
  return {
    /**
     * One check of one zone for one kind.
     * @param {Set<string>} inside The things inside now.
     * @returns {string[]} The things that are new alerts.
     */
    sweep(zoneId, kind, inside, nowMs) {
      const group = `${zoneId}|${kind}`;
      let seen = groups.get(group);
      // The first check is the starting point: what is there already is not an arrival.
      const quiet = !seen;
      if (!seen) groups.set(group, (seen = new Map()));
      const fresh = [];
      for (const key of inside) {
        const was = seen.get(key);
        if (was?.inside) continue;
        const alert = !quiet && (!was || nowMs - was.at >= repeatMs);
        seen.set(key, {
          inside: true,
          at: alert ? nowMs : (was?.at ?? Number.NEGATIVE_INFINITY),
        });
        if (alert) fresh.push(key);
      }
      for (const [key, was] of seen) {
        if (inside.has(key)) continue;
        if (nowMs - was.at >= repeatMs) seen.delete(key);
        else was.inside = false;
      }
      return fresh;
    },
    /** Forget a zone's kind (its layer went off, or it stopped watching). */
    reset(zoneId, kind) {
      groups.delete(`${zoneId}|${kind}`);
    },
  };
}

/** "14:02Z": the time in UTC. */
export const zulu = (ms) => `${new Date(ms).toISOString().slice(11, 16)}Z`;

/** The key that tells one plane, ship or satellite from another. */
const keyOf = (kind, record) =>
  String(
    (kind === 'planes'
      ? record.icao24
      : kind === 'ships'
        ? record.mmsi
        : record.noradId) ?? '',
  );

/** The zone's next free number, for its first name: "Zone 3". */
export function nextZoneName(list) {
  for (let n = 1; ; n += 1) {
    const name = `Zone ${n}`;
    if (!list.some((zone) => zone.name === name)) return name;
  }
}

let picking = false;
/** True while the next map click is a new zone's middle: other clicks wait. */
export const isPickingZone = () => picking;

const ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="8.5" stroke-dasharray="3.2 2.4"/><circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none"/></svg>';

const STYLE = `
#watch-zones {
  position: fixed; top: var(--zenith-panel-top, 92px); left: 50%; z-index: 181;
  width: min(340px, calc(100vw - 32px)); max-height: calc(100vh - var(--zenith-panel-top, 92px) - 38px);
  overflow-y: auto; scrollbar-width: thin; scrollbar-color: rgba(0,246,255,.35) transparent;
  transform: translateX(-50%); padding: 14px 16px 12px;
  border: 1px solid rgba(0,246,255,.35); border-radius: 12px; background: rgba(4,12,20,.95);
  box-shadow: 0 14px 40px rgba(0,0,0,.6); color: rgba(222,246,255,.92);
  font: 12px/1.4 var(--font-mono, ui-monospace, monospace); color-scheme: dark;
}
#watch-zones[hidden], body.ui-clean-view #watch-zones { display: none; }
#watch-zones .wz-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
#watch-zones h2, #watch-zones h3 { margin: 0; font-size: 12px; letter-spacing: .22em; color: ${CYAN}; }
#watch-zones h3 { margin-top: 12px; font-size: 11px; letter-spacing: .16em; }
#watch-zones button { border: 1px solid rgba(0,246,255,.35); background: transparent; color: inherit; font: inherit; cursor: pointer; border-radius: 8px; }
#watch-zones button:hover { background: rgba(0,212,255,.16); }
#watch-zones button:disabled { opacity: .4; cursor: default; }
#watch-zones .wz-close, #watch-zones .wz-delete { flex: none; width: 24px; height: 24px; border-radius: 50%; font-size: 14px; line-height: 1; }
#watch-zones .wz-note { margin: 6px 0 0; color: rgba(222,246,255,.6); }
#watch-zones .wz-add { width: 100%; margin-top: 8px; padding: 6px 10px; letter-spacing: .08em; }
#watch-zones form { margin-top: 8px; padding: 8px; border: 1px dashed rgba(0,246,255,.35); border-radius: 8px; }
#watch-zones form[hidden] { display: none; }
#watch-zones fieldset { margin: 6px 0 0; padding: 0; border: 0; display: flex; flex-wrap: wrap; gap: 4px 10px; }
#watch-zones legend { padding: 0; margin-bottom: 2px; color: rgba(222,246,255,.6); font-size: 11px; }
#watch-zones input[type=text] {
  width: 100%; box-sizing: border-box; padding: 6px 9px; border: 1px solid rgba(0,246,255,.35); border-radius: 8px;
  background: rgba(0,0,0,.35); color: #fff; font: inherit;
}
#watch-zones input[type=checkbox], #watch-zones input[type=radio] { accent-color: #00d4ff; }
#watch-zones .wz-buttons { display: flex; gap: 8px; margin-top: 8px; }
#watch-zones .wz-buttons button { flex: 1; padding: 5px 8px; }
#watch-zones ul { margin: 6px 0 0; padding: 0; list-style: none; }
#watch-zones li { display: flex; align-items: center; gap: 8px; margin: 4px 0; }
#watch-zones .wz-go { flex: 1; min-width: 0; padding: 5px 9px; text-align: left; }
#watch-zones .wz-name { display: block; overflow: hidden; color: #fff; text-overflow: ellipsis; white-space: nowrap; }
#watch-zones .wz-what { display: block; font-size: 10px; color: rgba(222,246,255,.6); }
#watch-zones .wz-warn { color: #ffd9a0; }
#watch-zones .wz-warn button { padding: 2px 8px; margin-left: 6px; }
#watch-zones .wz-alert { flex: 1; padding: 4px 8px; text-align: left; font-size: 11px; }
`;

/**
 * @param {{ viewer: Cesium.Viewer }} scene
 * @param {{ dataManager?: object, storage?: Storage, checkMs?: number }} [options]
 *   checkMs: how often zones are checked (tests use a shorter time).
 * @param {Document} [doc]
 * @returns {() => void}
 */
export function installWatchZones(
  { viewer },
  { dataManager, storage = globalThis.localStorage, checkMs = CHECK_MS } = {},
  doc = document,
) {
  const { scene, camera } = viewer;
  const win = doc.defaultView ?? window;

  const read = (key) => {
    try {
      return storage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  };
  let zones = parseZones(read(STORAGE_KEY));
  let watching = read(WATCHING_KEY) !== '0';
  let stored = true;
  const write = () => {
    try {
      storage?.setItem(STORAGE_KEY, JSON.stringify(zones));
      storage?.setItem(WATCHING_KEY, watching ? '1' : '0');
      stored = true;
    } catch {
      stored = false;
    }
  };

  const alerter = createAlerter();
  /** Where each thing was at the last check, by kind. */
  const last = Object.fromEntries(KINDS.map((kind) => [kind, new Map()]));
  const alerts = [];
  /** A zone being added: its middle is chosen, the rest not yet saved. */
  let draft = null;

  const style = doc.createElement('style');
  style.textContent = STYLE;
  doc.head.appendChild(style);

  const element = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  // The rings on the map, and their names through the app's own overlay.
  const rings = new Cesium.CustomDataSource('zenith-watch-zones');
  viewer.dataSources.add(rings);
  const lineColor = Cesium.Color.fromCssColorString(CYAN);
  const dashes = new Cesium.PolylineDashMaterialProperty({
    color: lineColor,
    dashLength: 18,
  });
  // Behind a hill or a building, the ring still shows, fainter.
  const hiddenDashes = new Cesium.PolylineDashMaterialProperty({
    color: lineColor.withAlpha(0.45),
    dashLength: 18,
  });
  /** The ground's height at the zone's middle, on whichever map shows. */
  const groundAt = (zone) => {
    const where = Cesium.Cartographic.fromDegrees(zone.lon, zone.lat);
    const height = scene.globe?.show
      ? scene.globe.getHeight(where)
      : scene.sampleHeightSupported
        ? scene.sampleHeight(where, [rings])
        : undefined;
    return Number.isFinite(height) ? height : 0;
  };
  const draw = () => {
    rings.entities.removeAll();
    const shown = [
      ...(watching ? zones.filter((zone) => zone.on) : []),
      ...(draft ? [draft] : []),
    ];
    const labels = [];
    for (const zone of shown) {
      const height = groundAt(zone) + 25;
      const positions = [];
      for (let i = 0; i <= RING_POINTS; i += 1) {
        const angle = (i / RING_POINTS) * 2 * Math.PI;
        const lat =
          zone.lat +
          ((zone.radiusM * Math.cos(angle)) / EARTH_M) * (180 / Math.PI);
        const lon =
          zone.lon +
          ((zone.radiusM * Math.sin(angle)) /
            (EARTH_M * Math.cos((zone.lat * Math.PI) / 180))) *
            (180 / Math.PI);
        positions.push(Cesium.Cartesian3.fromDegrees(lon, lat, height));
      }
      rings.entities.add({
        polyline: {
          positions,
          width: 2.5,
          arcType: Cesium.ArcType.NONE,
          material: dashes,
          depthFailMaterial: hiddenDashes,
        },
      });
      labels.push({
        id: `zone:${zone.id}`,
        position: positions[0],
        variant: 'label',
        title: zone.name,
        accent: CYAN,
        priority: 3,
      });
    }
    setOverlayEntries(OVERLAY, labels, {
      cohortLimit: MAX_ZONES + 1,
      collisionCapacity: MAX_ZONES + 1,
    });
    scene.requestRender();
  };

  // The panel.
  const panel = element('section');
  panel.id = 'watch-zones';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Watch zones');
  panel.hidden = true;
  const head = element('div', 'wz-head');
  const close = element('button', 'wz-close', '×');
  close.type = 'button';
  close.title = 'Close';
  close.setAttribute('aria-label', 'Close watch zones');
  head.append(element('h2', '', 'WATCH ZONES'), close);

  const watchLabel = element('label');
  const watchBox = element('input');
  watchBox.type = 'checkbox';
  watchBox.id = 'watch-zones-on';
  watchLabel.append(watchBox, ' Watching: rings and alerts on');

  const note = element('p', 'wz-note');
  note.setAttribute('role', 'status');
  const add = element('button', 'wz-add', 'Add zone');
  add.type = 'button';
  add.id = 'watch-zones-add';

  // The new zone's details, shown once its middle is chosen.
  const form = element('form');
  form.hidden = true;
  const nameBox = element('input');
  nameBox.type = 'text';
  nameBox.maxLength = MAX_ZONE_NAME;
  nameBox.autocomplete = 'off';
  nameBox.setAttribute('aria-label', 'Zone name');
  const sizes = element('fieldset');
  sizes.append(element('legend', '', 'Size (middle to ring)'));
  for (const metres of ZONE_SIZES_M) {
    const label = element('label');
    const radio = element('input');
    radio.type = 'radio';
    radio.name = 'watch-zone-size';
    radio.value = String(metres);
    radio.addEventListener('change', () => {
      if (!draft) return;
      draft = { ...draft, radiusM: metres };
      draw();
    });
    label.append(radio, ` ${sizeLabel(metres)}`);
    sizes.appendChild(label);
  }
  const kinds = element('fieldset');
  kinds.append(element('legend', '', 'Watches'));
  for (const kind of KINDS) {
    const label = element('label');
    const box = element('input');
    box.type = 'checkbox';
    box.name = 'watch-zone-kind';
    box.value = kind;
    label.append(box, ` ${KIND_NAMES[kind]}`);
    kinds.appendChild(label);
  }
  const formButtons = element('div', 'wz-buttons');
  const saveZone = element('button', '', 'Save zone');
  saveZone.type = 'submit';
  const cancel = element('button', '', 'Cancel');
  cancel.type = 'button';
  formButtons.append(saveZone, cancel);
  const formNote = element('p', 'wz-note');
  formNote.setAttribute('role', 'status');
  form.append(nameBox, sizes, kinds, formButtons, formNote);

  const list = element('ul');
  list.id = 'watch-zones-list';
  const warnings = element('div');
  warnings.id = 'watch-zones-warnings';
  const alertsHead = element('h3', '', 'ALERTS');
  const alertList = element('ul');
  alertList.id = 'watch-zones-alerts';
  panel.append(
    head,
    watchLabel,
    note,
    add,
    form,
    list,
    warnings,
    alertsHead,
    alertList,
  );
  doc.body.appendChild(panel);

  const letGo = () => {
    viewer.trackedEntity = undefined;
    camera.cancelFlight();
    camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  };
  const flyOver = (lat, lon, height) => {
    letGo();
    const still = win.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat, height),
      orientation: { heading: 0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 },
      duration: still ? 0 : 2.5,
    });
  };

  const renderWarnings = () => {
    const wanted = new Set(
      zones.filter((zone) => zone.on).flatMap((zone) => zone.watch),
    );
    warnings.replaceChildren(
      ...KINDS.filter(
        (kind) => wanted.has(kind) && !dataManager?.isEnabled?.(LAYER_OF[kind]),
      ).map((kind) => {
        const row = element(
          'p',
          'wz-note wz-warn',
          `${KIND_NAMES[kind]} layer off`,
        );
        const button = element('button', '', 'Switch on');
        button.type = 'button';
        button.title = `Switch on the ${KIND_NAMES[kind]} layer, so zones can watch it`;
        button.addEventListener('click', async () => {
          button.disabled = true;
          await dataManager
            ?.setEnabled?.(LAYER_OF[kind], true, { origin: 'user' })
            ?.catch?.(() => {});
          renderWarnings();
        });
        row.appendChild(button);
        return row;
      }),
    );
  };

  const renderAlerts = () => {
    alertsHead.textContent = alerts.length
      ? `ALERTS (${alerts.length})`
      : 'ALERTS';
    if (alerts.length === 0) {
      alertList.replaceChildren(element('li', 'wz-note', 'No alerts yet.'));
      return;
    }
    alertList.replaceChildren(
      ...alerts.map((alert) => {
        const go = element('button', 'wz-alert', alert.line);
        go.type = 'button';
        go.title = 'Fly to where it was';
        go.addEventListener('click', () =>
          flyOver(alert.lat, alert.lon, alert.height),
        );
        const row = element('li');
        row.appendChild(go);
        return row;
      }),
    );
  };

  const render = () => {
    watchBox.checked = watching;
    note.textContent = picking
      ? 'Click the map for the middle of the zone. Escape cancels.'
      : !stored
        ? 'This browser would not save the zones, so they last only until the page is closed.'
        : zones.length === 0
          ? 'No zones yet. Press Add zone, then click the map for its middle.'
          : 'Kept on this computer only. Things already inside when a zone starts watching are not alerts.';
    add.disabled = picking || Boolean(draft) || zones.length >= MAX_ZONES;
    add.textContent =
      zones.length >= MAX_ZONES ? `At most ${MAX_ZONES} zones` : 'Add zone';
    list.replaceChildren(
      ...zones.map((zone) => {
        const on = element('input');
        on.type = 'checkbox';
        on.checked = zone.on;
        on.title = `Watch with ${zone.name}`;
        on.setAttribute('aria-label', `${zone.name} on`);
        on.addEventListener('change', () => {
          zones = switchZone(zones, zone.id, on.checked);
          write();
          changed();
        });
        const go = element('button', 'wz-go');
        go.type = 'button';
        go.title = `Fly to ${zone.name}`;
        go.append(
          element('span', 'wz-name', zone.name),
          element(
            'span',
            'wz-what',
            `${sizeLabel(zone.radiusM)} · ${zone.watch.map((kind) => KIND_NAMES[kind].toLowerCase()).join(', ')}`,
          ),
        );
        go.addEventListener('click', () =>
          flyOver(zone.lat, zone.lon, Math.max(2500, zone.radiusM * 4)),
        );
        const remove = element('button', 'wz-delete', '×');
        remove.type = 'button';
        remove.title = `Delete ${zone.name}`;
        remove.setAttribute('aria-label', `Delete ${zone.name}`);
        remove.addEventListener('click', () => {
          const at = zones.findIndex((other) => other.id === zone.id);
          zones = removeZone(zones, zone.id);
          for (const kind of KINDS) alerter.reset(zone.id, kind);
          write();
          changed();
          const rows = list.querySelectorAll('.wz-go');
          (rows[at] ?? rows[at - 1] ?? add).focus();
        });
        const row = element('li');
        row.append(on, go, remove);
        return row;
      }),
    );
    renderWarnings();
    renderAlerts();
  };

  // One check of every zone against what the layers hold.
  const raise = (zone, record, nowMs) => {
    const name = String(record.id ?? '').slice(0, 40) || 'Unknown';
    const line = `${zulu(nowMs)} · ${name} entered ${zone.name}`;
    alerts.unshift({
      line,
      lat: record.lat,
      lon: record.lon,
      height: Math.max(2500, zone.radiusM * 4),
    });
    if (alerts.length > MAX_ALERTS) alerts.length = MAX_ALERTS;
    showNotice(doc, `ALERT · ${name} entered ${zone.name} · ${zulu(nowMs)}`, {
      id: 'zenith-zone-alert',
      ms: 8000,
    });
    blip('lock', win);
  };
  const sweep = () => {
    const nowMs = Date.now();
    let raised = 0;
    for (const kind of KINDS) {
      const watchers = zones.filter(
        (zone) => zone.on && zone.watch.includes(kind),
      );
      const layerOn = Boolean(dataManager?.isEnabled?.(LAYER_OF[kind]));
      if (!watchers.length || !layerOn) {
        last[kind].clear();
        for (const zone of zones) alerter.reset(zone.id, kind);
        continue;
      }
      const records =
        dataManager.layers
          ?.get?.(LAYER_OF[kind])
          ?.module?.getAnalystRecords?.(
            kind === 'satellites' ? SATELLITE_LIMIT : 1_000_000,
          ) ?? [];
      const found = new Map(watchers.map((zone) => [zone.id, new Map()]));
      const now = new Map();
      for (const record of records) {
        const key = keyOf(kind, record);
        if (
          !key ||
          !Number.isFinite(record.lat) ||
          !Number.isFinite(record.lon)
        )
          continue;
        const to = { lat: record.lat, lon: record.lon };
        const from = last[kind].get(key);
        now.set(key, to);
        for (const zone of watchers) {
          // Most things are nowhere near: a cheap test first.
          if (Math.abs(to.lat - zone.lat) * 111_000 > zone.radiusM + MAX_STEP_M)
            continue;
          if (passedThrough(zone, from, to))
            found.get(zone.id).set(key, record);
        }
      }
      last[kind] = now;
      for (const zone of zones) {
        if (!watchers.includes(zone)) {
          alerter.reset(zone.id, kind);
          continue;
        }
        const inside = found.get(zone.id);
        for (const key of alerter.sweep(
          zone.id,
          kind,
          new Set(inside.keys()),
          nowMs,
        )) {
          raise(zone, inside.get(key), nowMs);
          raised += 1;
        }
      }
    }
    if (!panel.hidden) {
      renderWarnings();
      if (raised) renderAlerts();
    }
  };

  let timer = null;
  const schedule = () => {
    const needed = watching && zones.some((zone) => zone.on);
    if (needed && !timer) {
      timer = win.setInterval(() => {
        try {
          sweep();
        } catch (error) {
          console.warn('[watch-zones]', error?.message || error);
        }
      }, checkMs);
    } else if (!needed && timer) {
      win.clearInterval(timer);
      timer = null;
      for (const kind of KINDS) last[kind].clear();
      for (const zone of zones)
        for (const kind of KINDS) alerter.reset(zone.id, kind);
    }
  };
  const changed = () => {
    draw();
    render();
    schedule();
  };

  const setWatching = (on) => {
    watching = on;
    write();
    changed();
  };
  watchBox.addEventListener('change', () => setWatching(watchBox.checked));
  // Voice control's "watch zones on" and "watch zones off".
  const onSet = (event) => setWatching(Boolean(event.detail?.set));
  win.addEventListener('zenith:set-watching', onSet);

  // Adding a zone: the next click on the map is its middle.
  const stopPicking = () => {
    picking = false;
    doc.body.style.cursor = '';
  };
  const cancelDraft = () => {
    stopPicking();
    draft = null;
    form.hidden = true;
    changed();
  };
  add.addEventListener('click', () => {
    if (zones.length >= MAX_ZONES) return;
    picking = true;
    doc.body.style.cursor = 'crosshair';
    render();
  });
  const handler = new Cesium.ScreenSpaceEventHandler(scene.canvas);
  handler.setInputAction((click) => {
    if (!picking) return;
    const spot =
      (scene.pickPositionSupported && scene.pickPosition(click.position)) ||
      camera.pickEllipsoid(click.position, scene.ellipsoid);
    if (!Cesium.defined(spot)) return;
    const where = Cesium.Cartographic.fromCartesian(spot);
    // The Map pin and the others check isPickingZone() on this same click:
    // it ends once they all have seen it.
    win.setTimeout(stopPicking, 0);
    draft = {
      id: `z${Date.now().toString(36)}`,
      name: nextZoneName(zones),
      lat: Cesium.Math.toDegrees(where.latitude),
      lon: Cesium.Math.toDegrees(where.longitude),
      radiusM: 2000,
      watch: ['planes'],
      on: true,
    };
    nameBox.value = draft.name;
    for (const radio of sizes.querySelectorAll('input'))
      radio.checked = radio.value === String(draft.radiusM);
    for (const box of kinds.querySelectorAll('input'))
      box.checked = draft.watch.includes(box.value);
    formNote.textContent = '';
    form.hidden = false;
    draw();
    render();
    nameBox.focus();
    // Typing replaces the suggested name.
    nameBox.select();
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!draft) return;
    const watch = [...kinds.querySelectorAll('input')]
      .filter((box) => box.checked)
      .map((box) => box.value);
    const zone = {
      ...draft,
      name: cleanZoneName(nameBox.value) || draft.name,
      watch,
    };
    if (!watch.length) {
      formNote.textContent = 'Pick at least one thing to watch.';
      return;
    }
    zones = addZone(zones, zone);
    draft = null;
    form.hidden = true;
    write();
    changed();
    add.focus();
  });
  cancel.addEventListener('click', () => {
    cancelDraft();
    add.focus();
  });
  // Typing a name must not set off the app's one-key shortcuts.
  nameBox.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') event.stopPropagation();
  });

  const button = doc.createElement('button');
  button.id = 'watch-zones-toggle';
  button.type = 'button';
  button.innerHTML = ICON;
  button.title = 'Watch zones: an alert when a plane, ship or satellite enters';
  button.setAttribute('aria-label', 'Watch zones');
  const setOpen = (open) => {
    if (!open && (picking || draft)) cancelDraft();
    panel.hidden = !open;
    button.setAttribute('aria-pressed', String(open));
    if (open) {
      render();
      (add.disabled ? close : add).focus();
    }
  };
  button.addEventListener('click', () => setOpen(panel.hidden));
  close.addEventListener('click', () => setOpen(false));
  // Escape first stops adding a zone, then closes the panel.
  const offEscape = closeOnEscape(
    win,
    () => !panel.hidden,
    () => (picking || draft ? cancelDraft() : setOpen(false)),
    { panel, opener: { focus: () => (panel.hidden ? button : add).focus() } },
  );
  button.setAttribute('aria-pressed', 'false');
  doc.getElementById('top-center-actions')?.appendChild(button);

  draw();
  schedule();

  return () => {
    offEscape();
    stopPicking();
    win.removeEventListener('zenith:set-watching', onSet);
    win.clearInterval(timer);
    handler.destroy();
    clearOverlaySource(OVERLAY);
    if (!viewer.isDestroyed?.()) viewer.dataSources.remove(rings, true);
    button.remove();
    panel.remove();
    style.remove();
  };
}
