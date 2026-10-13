/**
 * Keeps the app's one-key shortcuts from firing when Cmd, Ctrl or Option is
 * held.
 *
 * The app listens for single keys: c switches the cameras layer, v the clean
 * view, f the layers, 1 to 7 the visual presets, and so on. It never checked
 * for a modifier, so Cmd+C (copy) also switched the cameras on or off, Cmd+V
 * (paste) toggled the clean view and Cmd+F (find) toggled the layers.
 *
 * Only what the app hears is changed. The browser still copies, pastes and
 * finds as normal, and Shift works as before.
 */

/** The keys the app treats as shortcuts (src/ui/applicationShortcuts.js). */
const SHORTCUT_KEYS = new Set([
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
]);

/**
 * Whether a key press is one of the app's shortcut keys with Cmd, Ctrl or
 * Option held, and so is meant for the browser or the Mac, not the app.
 * @param {{key?: string, metaKey?: boolean, ctrlKey?: boolean, altKey?: boolean}} event
 */
export function isModifiedShortcut(event) {
  if (!event.metaKey && !event.ctrlKey && !event.altKey) return false;
  return SHORTCUT_KEYS.has(String(event.key || '').toLowerCase());
}

/**
 * @param {Document} [doc]
 * @returns {() => void} Stops guarding.
 */
export function initShortcutGuard(doc = document) {
  const view = doc.defaultView;
  const onKeyDown = (event) => {
    if (isModifiedShortcut(event)) event.stopPropagation();
  };
  // The window hears a key before anything on the page does, so stopping it
  // here keeps it from the app's shortcut listener further in.
  view.addEventListener('keydown', onKeyDown, true);
  return () => view.removeEventListener('keydown', onKeyDown, true);
}
