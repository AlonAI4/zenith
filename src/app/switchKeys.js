import { ZENITH_SWITCHES } from './zenithSwitches.js';

/**
 * One key for every switch this build adds, so the whole bar can be used
 * from the keyboard, including the overlays tucked into the LAYERS menu.
 * Every switch's tooltip names its key, and the help card lists them all,
 * with the original app's own keys beside them.
 *
 * A key does nothing while typing in a box, with Cmd, Ctrl or Option held,
 * or in cockpit mode, which has keys of its own.
 */

/** Each switch's key. */
export const SWITCH_KEYS = Object.freeze({
  'zenith-layers-toggle': 'a',
  'map-labels-toggle': 'l',
  'train-stations-toggle': 'r',
  'earthquakes-toggle': 'k',
  'time-zones-toggle': 'z',
  'day-night-toggle': 'n',
  'address-lookup-toggle': 'p',
  'hd-detail-toggle': 'b',
  'classified-toggle': 't',
  'measure-toggle': 'm',
  'saved-places-toggle': 's',
  'video-mode-toggle': 'g',
  'zenith-help-toggle': '?',
});

/**
 * Keys the original app and other add-ons already use: visual presets 1 to
 * 7, the HUD (h), orbit (o), clean view and free voice (v), the layers
 * panel (f), detection (d), cameras and cockpit (c), turning (q, e) and the
 * frame-rate meter (`).
 */
export const TAKEN_KEYS = Object.freeze([
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  'h',
  'o',
  'v',
  'f',
  'd',
  'c',
  'q',
  'e',
  '`',
]);

/** The original app's keys, for the help card's list. */
export const OTHER_KEYS = Object.freeze([
  ['1 to 7', 'Visual presets'],
  ['V', 'Tap: hide the controls. Hold: free voice'],
  ['C', 'Cameras on or off (cockpit when following a plane)'],
  ['F', 'Data layers panel'],
  ['H', 'Heads-up display'],
  ['O', 'Orbit the place in view'],
  ['D', 'Detection labels'],
  ['Q, E', 'Turn the view'],
  ['Esc', 'Close the panel on top'],
]);

/** How a key is written for people: "P", "?". */
export const keyLabel = (key) => key.toUpperCase();

/**
 * The switch a key press is for, or null when it is not one, or the press
 * should go elsewhere (typing, a modifier held, cockpit mode, a repeat).
 */
export function switchForKey(event, { cockpit = false } = {}) {
  if (!event || cockpit || event.repeat || event.isComposing) return null;
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  const target = event.target;
  if (
    target?.closest?.(
      'input, textarea, select, [contenteditable=""], [contenteditable="true"]',
    )
  )
    return null;
  const key = String(event.key || '').toLowerCase();
  for (const [id, wanted] of Object.entries(SWITCH_KEYS)) {
    if (wanted === key) return id;
  }
  return null;
}

/** A tooltip with its key on the end, once: "Map pin (P)". */
export function withKey(title, key) {
  const end = ` (${keyLabel(key)})`;
  const text = String(title || '');
  return text.endsWith(end) ? text : `${text}${end}`;
}

/**
 * @param {Document} [doc]
 * @param {Window} [win]
 * @returns {() => void}
 */
export function installSwitchKeys(doc = document, win = window) {
  const onKey = (event) => {
    const id = switchForKey(event, {
      cockpit: doc.body.classList.contains('cockpit-mode'),
    });
    const button = id && doc.getElementById(id);
    if (!button || button.disabled) return;
    event.preventDefault();
    button.click();
  };
  doc.addEventListener('keydown', onKey);

  // Tooltips name the key. Add-ons rewrite their own titles when switched,
  // so the key is put back whenever it goes missing.
  const tag = () => {
    for (const [id, key] of Object.entries(SWITCH_KEYS)) {
      const button = doc.getElementById(id);
      if (!button) continue;
      const titled = withKey(
        button.title || button.getAttribute('aria-label'),
        key,
      );
      if (button.title !== titled) button.title = titled;
      if (button.getAttribute('aria-keyshortcuts') !== keyLabel(key))
        button.setAttribute('aria-keyshortcuts', keyLabel(key));
    }
  };
  const watching = new win.MutationObserver(tag);
  const watch = () => {
    tag();
    watching.disconnect();
    for (const id of Object.keys(SWITCH_KEYS)) {
      const button = doc.getElementById(id);
      if (button)
        watching.observe(button, {
          attributes: true,
          attributeFilter: ['title'],
        });
    }
  };
  // Some switches are made later, when their data is ready.
  watch();
  const late = win.setTimeout(watch, 3000);

  // The KEYS list at the bottom of the help card.
  const names = new Map(ZENITH_SWITCHES.map((entry) => [entry.id, entry.name]));
  const list = doc.createElement('div');
  list.id = 'zenith-keys';
  const heading = doc.createElement('h3');
  heading.textContent = 'KEYS';
  const table = doc.createElement('dl');
  table.style.cssText =
    'display:grid;grid-template-columns:max-content 1fr;gap:4px 12px;margin:0';
  const row = (key, what) => {
    const term = doc.createElement('dt');
    term.textContent = key;
    term.style.cssText = 'font-weight:700;color:#00f6ff';
    const said = doc.createElement('dd');
    said.textContent = what;
    said.style.margin = '0';
    table.append(term, said);
  };
  for (const [id, key] of Object.entries(SWITCH_KEYS))
    row(keyLabel(key), names.get(id));
  for (const [key, what] of OTHER_KEYS) row(key, what);
  list.append(heading, table);
  // The help card is made a moment later.
  queueMicrotask(() => doc.getElementById('zenith-help')?.appendChild(list));

  return () => {
    doc.removeEventListener('keydown', onKey);
    watching.disconnect();
    win.clearTimeout(late);
    list.remove();
  };
}
