/**
 * Satellites overhead: the target box and the map pin card get an OVERHEAD
 * section with the next pass over that spot of the International Space
 * Station, the Chinese space station (Tiangong) and the Hubble telescope:
 * "ISS · in 14 min · up to 63° · from the SW", counting down, and
 * "OVERHEAD NOW" while one is more than 10° above the horizon.
 *
 * The passes come from the original's satellites layer, which works them out
 * from the public orbit data once its catalogue has loaded (the Satellites
 * layer switched on once). They are worked out when a box or card opens and
 * once a minute after; in between, only the countdown text changes.
 */

/** The satellites shown, by their catalogue (NORAD) number. */
export const OVERHEAD_SATELLITES = Object.freeze([
  { id: 25544, name: 'ISS' },
  { id: 48274, name: 'Tiangong' },
  { id: 20580, name: 'Hubble' },
]);
/** Above this height in the sky a satellite counts as overhead. */
export const OVERHEAD_MIN_ELEV_DEG = 10;
/** How often the passes are worked out again while a box is open. */
export const RECOUNT_MS = 60_000;
/** The event the target box and the map pin card send when they open or close. */
export const SPOT_EVENT = 'zenith:spot';

const POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/** The compass point a bearing is nearest: 225 → "SW". */
export function compassPoint(azDeg) {
  return POINTS[Math.round((((azDeg % 360) + 360) % 360) / 45) % 8];
}

/** "in 40 s", "in 14 min", "in 3 h 05 min". */
export function untilText(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `in ${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `in ${minutes} min`;
  return `in ${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

/** True while a pass is under way: between rising and setting at 10°. */
export function isOverheadNow(pass, nowMs) {
  return Boolean(pass) && pass.riseMs <= nowMs && nowMs < pass.setMs;
}

/**
 * One line of the section.
 * @param {string} name
 * @param {{ status: string, pass?: object } | null} result What the
 *   satellites layer answered (getNextSatellitePass).
 * @param {number} nowMs
 */
export function passLine(name, result, nowMs) {
  if (!result || result.status === 'no-tle')
    return `${name} · not in the loaded satellites`;
  if (result.status !== 'ok')
    return `${name} · no pass above ${OVERHEAD_MIN_ELEV_DEG}° in the next 24 h`;
  const { pass } = result;
  const peak = `up to ${Math.round(pass.maxElevDeg)}°`;
  const from = `from the ${compassPoint(pass.riseAzDeg)}`;
  const when = isOverheadNow(pass, nowMs)
    ? 'OVERHEAD NOW'
    : untilText(pass.riseMs - nowMs);
  return `${name} · ${when} · ${peak} · ${from}`;
}

/**
 * Whether the passes should be worked out again: a minute has gone, a pass
 * shown has ended, or the catalogue had not loaded (a cheap check, repeated
 * every 2 seconds until it has).
 */
export function needsRecount(state, nowMs) {
  if (!state.results) return true;
  if (!state.loaded) return nowMs - state.at >= 2000;
  if (nowMs - state.at >= RECOUNT_MS) return true;
  return state.results.some(
    (result) => result?.status === 'ok' && result.pass.setMs <= nowMs,
  );
}

const STYLE = `
.zenith-overhead { font: 11px/1.5 var(--font-mono, ui-monospace, monospace); color: #dff8ff; }
#target-box-panel .zenith-overhead { padding: 6px 10px 0; }
#address-card .zenith-overhead { margin-top: 6px; padding-top: 6px; border-top: 1px solid rgba(120,220,255,.25); }
.zenith-overhead .zo-head { color: #00f6ff; font-weight: 700; font-size: 10px; letter-spacing: .14em; }
.zenith-overhead .zo-now { color: #00f6ff; font-weight: 700; }
.zenith-overhead button {
  margin-top: 4px; padding: 2px 8px; border: 1px solid rgba(0,246,255,.5); border-radius: 3px;
  background: rgba(0,246,255,.08); color: #00f6ff; font: 700 10px/1.4 var(--font-mono, monospace); cursor: pointer;
}
`;

/**
 * @param {{ dataManager?: object }} [parts]
 * @param {Document} [doc]
 * @returns {() => void}
 */
export function installOverhead({ dataManager } = {}, doc = document) {
  const win = doc.defaultView ?? window;
  const style = doc.createElement('style');
  style.id = 'zenith-overhead-style';
  style.textContent = STYLE;
  doc.head.appendChild(style);

  const layer = () => dataManager?.layers?.get?.('satellites')?.module;

  /** Each box's section and what it last worked out. */
  const sections = new Map();
  const sectionFor = (host) => {
    if (sections.has(host)) return sections.get(host);
    const element = doc.createElement('div');
    element.className = 'zenith-overhead';
    element.setAttribute('role', 'group');
    element.setAttribute('aria-label', 'Satellites overhead');
    const state = { element, lat: null, lon: null, results: null, at: 0 };
    sections.set(host, state);
    return state;
  };

  const count = (state, nowMs) => {
    const module = layer();
    state.results = OVERHEAD_SATELLITES.map(
      ({ id }) =>
        module?.getNextSatellitePass?.(id, {
          latDeg: state.lat,
          lonDeg: state.lon,
          minElevDeg: OVERHEAD_MIN_ELEV_DEG,
          fromMs: nowMs,
        }) ?? { status: 'no-tle' },
    );
    state.loaded = state.results.some((result) => result.status !== 'no-tle');
    state.at = nowMs;
  };

  const line = (text, className) => {
    const row = doc.createElement('div');
    if (className) row.className = className;
    row.textContent = text;
    return row;
  };

  const paint = (state, nowMs) => {
    const head = line('OVERHEAD', 'zo-head');
    if (!state.loaded) {
      const on = Boolean(dataManager?.isEnabled?.('satellites'));
      // Made again only when the message changes, so the button keeps the focus.
      const shown = on ? 'loading' : 'off';
      if (state.shown === shown) return;
      state.shown = shown;
      if (on) {
        state.element.replaceChildren(head, line('Loading the satellites…'));
        return;
      }
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'zo-switch';
      button.textContent = 'Switch on satellites';
      button.addEventListener('click', () => {
        dataManager?.setEnabled?.('satellites', true, { origin: 'user' });
        state.at = 0;
        paint(state, Date.now());
      });
      state.element.replaceChildren(
        head,
        line('Switch on the Satellites layer to see passes here'),
        button,
      );
      return;
    }
    state.shown = 'passes';
    const rows = OVERHEAD_SATELLITES.map(({ name }, i) => {
      const result = state.results[i];
      return line(
        passLine(name, result, nowMs),
        result?.status === 'ok' && isOverheadNow(result.pass, nowMs)
          ? 'zo-now'
          : '',
      );
    });
    state.element.replaceChildren(head, ...rows);
  };

  let ticker = null;
  const tick = () => {
    const nowMs = Date.now();
    let open = 0;
    for (const state of sections.values()) {
      if (state.lat === null) continue;
      open += 1;
      if (needsRecount(state, nowMs)) count(state, nowMs);
      paint(state, nowMs);
    }
    if (!open) {
      win.clearInterval(ticker);
      ticker = null;
    }
  };

  const onSpot = (event) => {
    const { host, lat, lon, into } = event.detail || {};
    if (!host) return;
    const state = sectionFor(host);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      state.lat = state.lon = null;
      state.element.remove();
      return;
    }
    state.lat = lat;
    state.lon = lon;
    state.results = null;
    state.shown = null;
    if (into) into(state.element);
    tick();
    ticker ??= win.setInterval(tick, 1000);
  };
  win.addEventListener(SPOT_EVENT, onSpot);

  return () => {
    win.removeEventListener(SPOT_EVENT, onSpot);
    win.clearInterval(ticker);
    for (const state of sections.values()) state.element.remove();
    style.remove();
  };
}

/**
 * Tell the Overhead section a box opened on a spot (or closed, with no spot).
 * @param {Window} win
 * @param {string} host Which box: 'target' or 'pin'.
 * @param {{ lat: number, lon: number } | null} spot
 * @param {(section: HTMLElement) => void} [into] Puts the section in the box.
 */
export function announceSpot(win, host, spot, into) {
  win.dispatchEvent(
    new CustomEvent(SPOT_EVENT, {
      detail: { host, lat: spot?.lat ?? null, lon: spot?.lon ?? null, into },
    }),
  );
}
