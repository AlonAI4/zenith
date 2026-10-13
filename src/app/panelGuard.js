import { isTrackingClickGesture } from '../data/trackingClickGesture.js';

/**
 * Stops the Display and CCTV panels opening by themselves.
 *
 * The app opened them in two situations nobody asked for:
 * - Display, whenever a visual preset was chosen (the 2 to 7 keys included),
 *   to show that preset's sliders;
 * - CCTV, whenever the active camera changed, which includes just switching
 *   the cameras layer on, because a first camera is made active straight away.
 * Each time it also saved the panel as open, so it was open at the next start
 * too.
 *
 * Now those two openings are refused. Everything else still works: the
 * panels' own buttons, the saved state being put back at start, and one
 * exception, clicking a camera on the map, which is asking to watch it.
 */

const DISPLAY_PANEL = 'pp-toggles';
const CCTV_PANEL = 'cctv-panel';
/**
 * A camera change this soon after a click on the map was caused by that
 * click: the app reacts to it at once. Kept short so that a click on empty
 * map followed by switching the cameras layer on does not count.
 */
const MAP_CLICK_MS = 500;
const MAP_SELECTOR =
  '#cesiumContainer, #world-overlay-root, #world-overlay-detection-surface';
const CLEANED_KEY = 'gev.panelGuard.cleaned';
/** The app puts its saved panel state back about 1.5 s after starting. */
const CLEAN_AFTER_MS = 3_000;

/**
 * A finished press on the map: a click when it stayed put and was short,
 * a drag otherwise. The limits are the app's own.
 * @param {{ travelPx: number, durationMs: number }} press
 * @returns {'click'|'drag'}
 */
export function pressKind(press) {
  return isTrackingClickGesture(press) ? 'click' : 'drag';
}

/**
 * Whether the app may open a panel right now.
 * @param {object} state
 * @param {string} state.panelId
 * @param {boolean} state.choosingPreset A visual preset is being applied.
 * @param {boolean} state.cameraChanging The CCTV panel is reacting to a new active camera.
 * @param {number} state.msSinceMapClick
 */
export function mayOpen({
  panelId,
  choosingPreset,
  cameraChanging,
  msSinceMapClick,
}) {
  if (panelId === DISPLAY_PANEL && choosingPreset) return false;
  if (panelId === CCTV_PANEL && cameraChanging)
    return msSinceMapClick <= MAP_CLICK_MS;
  return true;
}

/** Runs `owner[name]` as before, with `mark(true)` for as long as it runs. */
function flagWhileRunning(owner, name, mark) {
  const original = owner?.[name];
  if (typeof original !== 'function') return () => {};
  const wasOwn = Object.hasOwn(owner, name);
  owner[name] = function flagged(...args) {
    mark(true);
    try {
      return original.apply(this, args);
    } finally {
      mark(false);
    }
  };
  return () => {
    if (wasOwn) owner[name] = original;
    else delete owner[name];
  };
}

/**
 * @param {object} styleManager The app's panel manager.
 * @param {object} [options] Replaceable parts, for tests.
 * @returns {() => void} Puts everything back.
 */
export function installPanelGuard(
  styleManager,
  {
    doc = globalThis.document,
    now = () => performance.now(),
    storage = globalThis.localStorage,
    schedule = (fn, ms) => setTimeout(fn, ms),
  } = {},
) {
  if (typeof styleManager?.setPanelCollapsed !== 'function') return () => {};
  let choosingPreset = false;
  let cameraChanging = false;
  let lastMapClick = -Infinity;

  // The app's visual settings object is the one that reveals a preset's
  // sliders; it reaches the panels through this manager.
  const undoPreset = flagWhileRunning(
    styleManager._visualSettings ?? styleManager,
    '_revealStyleParameters',
    (on) => {
      choosingPreset = on;
    },
  );
  // On the class, so a rebuilt CCTV panel is covered too.
  const cctvControls = styleManager._cctvControls;
  const undoCamera = flagWhileRunning(
    cctvControls && Object.getPrototypeOf(cctvControls),
    '_renderCctvState',
    (on) => {
      cameraChanging = on;
    },
  );

  const original = styleManager.setPanelCollapsed;
  const wasOwn = Object.hasOwn(styleManager, 'setPanelCollapsed');
  styleManager.setPanelCollapsed = function guarded(
    panelId,
    collapsed,
    options,
  ) {
    if (
      collapsed === false &&
      !options?.restore &&
      !mayOpen({
        panelId,
        choosingPreset,
        cameraChanging,
        msSinceMapClick: now() - lastMapClick,
      })
    )
      return undefined;
    return original.call(this, panelId, collapsed, options);
  };

  // Tell a click on the map from a drag across it.
  let press = null;
  const onDown = (event) => {
    press = event.target?.closest?.(MAP_SELECTOR)
      ? { x: event.clientX, y: event.clientY, at: now(), travelPx: 0 }
      : null;
  };
  const onMove = (event) => {
    if (!press) return;
    press.travelPx += Math.hypot(
      event.clientX - press.x,
      event.clientY - press.y,
    );
    press.x = event.clientX;
    press.y = event.clientY;
  };
  const onUp = () => {
    if (
      press &&
      pressKind({ travelPx: press.travelPx, durationMs: now() - press.at }) ===
        'click'
    )
      lastMapClick = now();
    press = null;
  };
  doc?.addEventListener('pointerdown', onDown, true);
  doc?.addEventListener('pointermove', onMove, true);
  doc?.addEventListener('pointerup', onUp, true);

  // Once: both panels may still be saved as open from before this guard,
  // by the app and not by anyone's choice. Start them closed.
  let cleaned = true;
  try {
    cleaned = storage?.getItem(CLEANED_KEY) === '1';
  } catch {
    // No storage: nothing was saved, so there is nothing to clean.
  }
  if (!cleaned)
    schedule(() => {
      for (const panelId of [DISPLAY_PANEL, CCTV_PANEL])
        styleManager.setPanelCollapsed(panelId, true, { explicit: true });
      try {
        storage?.setItem(CLEANED_KEY, '1');
      } catch {
        // Private windows may refuse storage; it is tried again next start.
      }
    }, CLEAN_AFTER_MS);

  return () => {
    undoPreset();
    undoCamera();
    if (wasOwn) styleManager.setPanelCollapsed = original;
    else delete styleManager.setPanelCollapsed;
    doc?.removeEventListener('pointerdown', onDown, true);
    doc?.removeEventListener('pointermove', onMove, true);
    doc?.removeEventListener('pointerup', onUp, true);
  };
}
