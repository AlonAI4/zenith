import { createRotator } from './rotateGestures.js';

/**
 * Video mode: hide the controls and circle slowly round the spot in the
 * middle of the screen, for recording a clip.
 *
 * Its switch opens a small panel first: how fast, which way round, and
 * Start. The choices are remembered. It reuses the app's own clean view to
 * hide the controls (the map credits stay on screen there, which the map
 * providers require) and this build's rotate helper for the turn, so
 * following a plane circles the plane. Any ordinary key or a click ends it.
 * Modifier keys on their own, and Cmd or Ctrl shortcuts, do not: the Mac's
 * screen recorder is started with one.
 */

const STORAGE_KEY = 'gev.videoMode';
/** Seconds for one full turn at each speed. */
export const TURN_SECONDS = Object.freeze({ slow: 144, normal: 72, fast: 36 });
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
 * The saved choice, or the usual one when nothing sensible is saved.
 * @returns {{ speed: 'slow'|'normal'|'fast', clockwise: boolean }}
 */
export function readChoice(text) {
  try {
    const saved = JSON.parse(text ?? 'null');
    return {
      speed: Object.hasOwn(TURN_SECONDS, saved?.speed) ? saved.speed : 'normal',
      clockwise: saved?.clockwise !== false,
    };
  } catch {
    return { speed: 'normal', clockwise: true };
  }
}

/**
 * Radians to turn for a frame that took this long. Long gaps (a hidden tab,
 * a stall) are capped so the view never jumps.
 * @param {number} elapsedMs
 * @param {{ speed?: string, clockwise?: boolean }} [choice]
 */
export function orbitStep(
  elapsedMs,
  { speed = 'normal', clockwise = true } = {},
) {
  if (!(elapsedMs > 0)) return 0;
  const seconds = TURN_SECONDS[speed] ?? TURN_SECONDS.normal;
  const turn = (Math.min(elapsedMs, 100) / 1000) * ((2 * Math.PI) / seconds);
  return clockwise ? turn : -turn;
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
#video-mode-panel {
  position: fixed;
  top: 92px;
  left: 50%;
  z-index: 181;
  width: min(300px, calc(100vw - 32px));
  transform: translateX(-50%);
  padding: 14px 16px;
  border: 1px solid rgba(0, 246, 255, 0.35);
  border-radius: 12px;
  background: rgba(4, 12, 20, 0.95);
  box-shadow: 0 14px 40px rgba(0, 0, 0, 0.6);
  color: rgba(222, 246, 255, 0.92);
  font: 12px/1.4 var(--font-mono, ui-monospace, monospace);
}
#video-mode-panel[hidden],
body.ui-clean-view #video-mode-panel { display: none; }
#video-mode-panel h2 {
  margin: 0 0 10px;
  font-size: 12px;
  letter-spacing: 0.22em;
  color: #00f6ff;
}
#video-mode-panel .vm-row { display: flex; gap: 6px; margin-bottom: 8px; }
#video-mode-panel button {
  flex: 1;
  padding: 6px 4px;
  border: 1px solid rgba(0, 246, 255, 0.35);
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
#video-mode-panel button[aria-pressed='true'] {
  border-color: #00d4ff;
  background: rgba(0, 212, 255, 0.24);
  color: #fff;
}
#video-mode-panel #video-mode-start {
  margin-top: 4px;
  border-color: #00d4ff;
  font-weight: 700;
  letter-spacing: 0.12em;
}
#video-mode-panel p { margin: 8px 0 0; color: rgba(222, 246, 255, 0.6); }
`;

/**
 * @param {import('cesium').Viewer} viewer
 * @param {{ setCleanView?: (on: boolean) => void, doc?: Document, win?: Window, storage?: Storage }} [options]
 * @returns {() => void} Ends video mode and removes its switch.
 */
export function installVideoMode(
  viewer,
  {
    setCleanView,
    doc = document,
    win = window,
    storage = globalThis.localStorage,
  } = {},
) {
  const rotate = createRotator(viewer);
  const cleanView = (on) => {
    if (setCleanView) setCleanView(on);
    else doc.body.classList.toggle('ui-clean-view', on);
  };
  const load = () => {
    try {
      return readChoice(storage?.getItem(STORAGE_KEY));
    } catch {
      return readChoice(null);
    }
  };
  let choice = load();
  const remember = () => {
    try {
      storage?.setItem(STORAGE_KEY, JSON.stringify(choice));
    } catch {
      // Private windows can refuse storage; the choice still holds this visit.
    }
  };

  const style = doc.createElement('style');
  style.textContent = STYLE;
  doc.head.appendChild(style);
  const hint = doc.createElement('div');
  hint.id = 'video-mode-hint';
  hint.textContent = 'Video mode. Press any key or click to stop.';
  doc.body.appendChild(hint);

  const element = (tag, text) => {
    const node = doc.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const panel = element('section');
  panel.id = 'video-mode-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Video mode');
  panel.hidden = true;
  const option = (text, title, pick, isPicked) => {
    const control = element('button', text);
    control.type = 'button';
    control.title = title;
    control.addEventListener('click', () => {
      pick();
      remember();
      paintChoices();
    });
    return [control, isPicked];
  };
  const options = [
    option(
      'Slow',
      'One turn in about two and a half minutes',
      () => (choice.speed = 'slow'),
      () => choice.speed === 'slow',
    ),
    option(
      'Normal',
      'One turn in about a minute',
      () => (choice.speed = 'normal'),
      () => choice.speed === 'normal',
    ),
    option(
      'Fast',
      'One turn in about half a minute',
      () => (choice.speed = 'fast'),
      () => choice.speed === 'fast',
    ),
    option(
      'Clockwise',
      'The view turns to the right',
      () => (choice.clockwise = true),
      () => choice.clockwise,
    ),
    option(
      'Anticlockwise',
      'The view turns to the left',
      () => (choice.clockwise = false),
      () => !choice.clockwise,
    ),
  ];
  options
    .slice(0, 3)
    .forEach(
      ([control], i) => (control.dataset.speed = ['slow', 'normal', 'fast'][i]),
    );
  options[3][0].dataset.way = 'clockwise';
  options[4][0].dataset.way = 'anticlockwise';
  function paintChoices() {
    for (const [control, isPicked] of options) {
      control.setAttribute('aria-pressed', String(isPicked()));
    }
  }
  const speedRow = element('div');
  speedRow.className = 'vm-row';
  speedRow.append(...options.slice(0, 3).map(([control]) => control));
  const wayRow = element('div');
  wayRow.className = 'vm-row';
  wayRow.append(...options.slice(3).map(([control]) => control));
  const startButton = element('button', 'START');
  startButton.id = 'video-mode-start';
  startButton.type = 'button';
  startButton.title = 'Hide the controls and start circling this spot';
  const startRow = element('div');
  startRow.className = 'vm-row';
  startRow.append(startButton);
  panel.append(
    element('h2', 'VIDEO MODE'),
    speedRow,
    wayRow,
    startRow,
    element(
      'p',
      'Circles the spot in the middle of the screen. Any key or click ends it.',
    ),
  );
  doc.body.appendChild(panel);
  paintChoices();

  const button = doc.createElement('button');
  button.id = 'video-mode-toggle';
  button.type = 'button';
  button.innerHTML = ICON;
  button.title =
    'Video mode: hide the controls and circle this spot, for recording';
  button.setAttribute('aria-label', 'Video mode');
  button.setAttribute('aria-pressed', 'false');

  let active = false;
  let wasClean = false;
  let frameId = 0;
  let hintTimer = 0;
  let last = 0;

  const frame = (now) => {
    if (!active || viewer.isDestroyed()) return;
    rotate(orbitStep(now - last, choice));
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

  const setPanel = (open) => {
    panel.hidden = !open;
    button.setAttribute('aria-pressed', String(open || active));
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
    setPanel(false);
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

  const onEscape = (event) => {
    if (event.key === 'Escape' && !panel.hidden) setPanel(false);
  };
  button.addEventListener('click', () => setPanel(panel.hidden));
  startButton.addEventListener('click', start);
  doc.addEventListener('keydown', onEscape);
  doc.getElementById('top-center-actions')?.appendChild(button);

  return () => {
    stop();
    doc.removeEventListener('keydown', onEscape);
    button.remove();
    panel.remove();
    hint.remove();
    style.remove();
  };
}
