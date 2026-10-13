import { createRotator } from './rotateGestures.js';

/**
 * Video mode: hide the controls and circle slowly round the spot in the
 * middle of the screen, for recording a clip.
 *
 * It reuses the app's own clean view to hide the controls (the map credits
 * stay on screen there, which the map providers require) and this build's
 * rotate helper for the turn, so following a plane circles the plane. Any
 * ordinary key or a click ends it. Modifier keys on their own, and Cmd or
 * Ctrl shortcuts, do not: the Mac's screen recorder is started with one.
 */

/** One full turn takes this long. */
export const TURN_SECONDS = 72;
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

/**
 * Radians to turn for a frame that took this long. Long gaps (a hidden tab,
 * a stall) are capped so the view never jumps.
 */
export function orbitStep(elapsedMs) {
  if (!(elapsedMs > 0)) return 0;
  return (Math.min(elapsedMs, 100) / 1000) * ((2 * Math.PI) / TURN_SECONDS);
}

/** Does this key press end video mode? */
export function keyEndsVideo(event) {
  if (MODIFIER_KEYS.has(event.key)) return false;
  return !(event.metaKey || event.ctrlKey);
}

const ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="6.5" width="12.5" height="11" rx="2.2"/><path d="M15.5 10.5l5-2.6v8.2l-5-2.6z"/></svg>';

const STYLE = `
#video-mode-hint {
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
#video-mode-hint[data-show='true'] { opacity: 1; }
/* Clean view shows an exit button; a recording should not have it. */
body.zenith-video-mode #clean-view-exit { display: none !important; }
`;

/**
 * @param {import('cesium').Viewer} viewer
 * @param {{ setCleanView?: (on: boolean) => void, doc?: Document, win?: Window }} [options]
 * @returns {() => void} Ends video mode and removes its switch.
 */
export function installVideoMode(
  viewer,
  { setCleanView, doc = document, win = window } = {},
) {
  const rotate = createRotator(viewer);
  const cleanView = (on) => {
    if (setCleanView) setCleanView(on);
    else doc.body.classList.toggle('ui-clean-view', on);
  };

  const style = doc.createElement('style');
  style.textContent = STYLE;
  doc.head.appendChild(style);
  const hint = doc.createElement('div');
  hint.id = 'video-mode-hint';
  hint.textContent = 'Video mode. Press any key or click to stop.';
  doc.body.appendChild(hint);

  const button = doc.createElement('button');
  button.id = 'video-mode-toggle';
  button.type = 'button';
  button.innerHTML = ICON;
  button.title =
    'Video mode: hide the controls and circle this spot. Any key or click ends it';
  button.setAttribute('aria-label', 'Video mode');
  button.setAttribute('aria-pressed', 'false');

  let active = false;
  let wasClean = false;
  let frameId = 0;
  let hintTimer = 0;
  let last = 0;

  const frame = (now) => {
    if (!active || viewer.isDestroyed()) return;
    rotate(orbitStep(now - last));
    last = now;
    viewer.scene.requestRender();
    frameId = win.requestAnimationFrame(frame);
  };

  const onKey = (event) => {
    if (!keyEndsVideo(event)) return;
    // The key only ends video mode; it must not also act as a shortcut.
    event.preventDefault();
    event.stopPropagation();
    stop();
  };
  const onPointer = (event) => {
    event.stopPropagation();
    stop();
  };

  function stop() {
    if (!active) return;
    active = false;
    win.cancelAnimationFrame(frameId);
    win.clearTimeout(hintTimer);
    hint.dataset.show = 'false';
    win.removeEventListener('keydown', onKey, true);
    win.removeEventListener('pointerdown', onPointer, true);
    doc.body.classList.remove('zenith-video-mode');
    if (!wasClean) cleanView(false);
    button.setAttribute('aria-pressed', 'false');
  }

  function start() {
    if (active) return;
    active = true;
    wasClean = doc.body.classList.contains('ui-clean-view');
    cleanView(true);
    doc.body.classList.add('zenith-video-mode');
    button.setAttribute('aria-pressed', 'true');
    hint.dataset.show = 'true';
    hintTimer = win.setTimeout(() => {
      hint.dataset.show = 'false';
    }, HINT_MS);
    win.addEventListener('keydown', onKey, true);
    win.addEventListener('pointerdown', onPointer, true);
    last = win.performance.now();
    frameId = win.requestAnimationFrame(frame);
  }

  button.addEventListener('click', start);
  doc.getElementById('top-center-actions')?.appendChild(button);

  return () => {
    stop();
    button.remove();
    hint.remove();
    style.remove();
  };
}
