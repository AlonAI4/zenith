/**
 * What video mode and the fly-through have in common: hide the controls for
 * a recording, and give them back on any ordinary key or a click.
 *
 * It uses the app's own clean view to hide the controls. The map credits
 * stay on screen there, which the map providers require; only the clean
 * view's exit button is hidden, so it is not in the recording. Modifier keys
 * on their own, and Cmd or Ctrl shortcuts, do not end it: the Mac's screen
 * recorder is started with one.
 */

const HINT_MS = 3200;
const MODIFIER_KEYS = new Set([
  'Shift',
  'Control',
  'Alt',
  'Meta',
  'CapsLock',
  'Fn',
  'Dead',
]);

/** Does this key press end the recording view? */
export function keyEndsVideo(event) {
  if (MODIFIER_KEYS.has(event.key)) return false;
  return !(event.metaKey || event.ctrlKey);
}

const STYLE = `
#cinema-hint {
  position: fixed;
  left: 50%;
  bottom: 84px;
  z-index: 300;
  transform: translateX(-50%);
  padding: 7px 14px;
  border: 1px solid rgba(0, 246, 255, 0.35);
  border-radius: 10px;
  background: rgba(4, 12, 20, 0.85);
  color: rgba(222, 246, 255, 0.92);
  font: 12px var(--font-mono, ui-monospace, monospace);
  letter-spacing: 0.06em;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.5s;
}
#cinema-hint[data-show='true'] { opacity: 1; }
/* Clean view shows an exit button; a recording should not have it. */
body.zenith-video-mode #clean-view-exit { display: none !important; }
`;

let running = null;

/** True while video mode or a fly-through has the controls hidden. */
export function cinemaRunning() {
  return running !== null;
}

/**
 * Hide the controls until a key or a click.
 * @param {object} options
 * @param {string} options.hint A line shown for a few seconds at the start.
 * @param {() => void} [options.onEnd] Called once when it ends, however it ends.
 * @param {(on: boolean) => void} [options.setCleanView] The app's own clean view.
 * @param {Document} [options.doc]
 * @param {Window} [options.win]
 * @param {{ focus: () => void }} [options.returnFocusTo] Gets the keyboard
 *   focus back when it ends, if the focus fell to the page while the controls
 *   were hidden.
 * @returns {{ end: () => void }}
 */
export function startCinema({
  hint,
  onEnd,
  setCleanView,
  doc = document,
  win = window,
  returnFocusTo,
}) {
  running?.end();
  const cleanView = (on) => {
    if (setCleanView) setCleanView(on);
    else doc.body.classList.toggle('ui-clean-view', on);
  };

  if (!doc.getElementById('cinema-style')) {
    const style = doc.createElement('style');
    style.id = 'cinema-style';
    style.textContent = STYLE;
    doc.head.appendChild(style);
  }
  let line = doc.getElementById('cinema-hint');
  if (!line) {
    line = doc.createElement('div');
    line.id = 'cinema-hint';
    // Read out, so a screen reader hears how to stop the recording view.
    line.setAttribute('role', 'status');
    doc.body.appendChild(line);
  }
  line.textContent = hint;

  const wasClean = doc.body.classList.contains('ui-clean-view');
  let ended = false;
  const session = { end };
  const onKey = (event) => {
    if (!keyEndsVideo(event)) return;
    // The key only ends the recording view; it must not also act as a shortcut.
    event.preventDefault();
    event.stopPropagation();
    end();
  };
  const onPointer = (event) => {
    event.stopPropagation();
    end();
  };

  cleanView(true);
  doc.body.classList.add('zenith-video-mode');
  line.dataset.show = 'true';
  const hintTimer = win.setTimeout(() => {
    line.dataset.show = 'false';
  }, HINT_MS);
  win.addEventListener('keydown', onKey, true);
  win.addEventListener('pointerdown', onPointer, true);
  running = session;

  function end() {
    if (ended) return;
    ended = true;
    if (running === session) running = null;
    win.clearTimeout(hintTimer);
    line.dataset.show = 'false';
    win.removeEventListener('keydown', onKey, true);
    win.removeEventListener('pointerdown', onPointer, true);
    doc.body.classList.remove('zenith-video-mode');
    if (!wasClean) cleanView(false);
    onEnd?.();
    if (!doc.activeElement || doc.activeElement === doc.body) {
      returnFocusTo?.focus();
    }
  }

  return session;
}
