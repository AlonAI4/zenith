import { readCameraTargetFrame } from '../ui/cameraOrientationControls.js';

/**
 * A distance scale down the left edge: a ruler with a round number beside
 * it, such as 500 m, so the size of things on the map can be judged.
 *
 * It is the scale at the centre of the view. In a tilted view things further
 * away are smaller than the ruler says, and nearer things bigger.
 */

/** The ruler is never longer than this on screen. */
const MAX_PX = 120;
const CHECK_MS = 250;

/**
 * How many metres one screen pixel covers, at a given distance.
 * @param {number} range Metres from the camera to the spot.
 * @param {number} fovy The camera's vertical field of view, in radians.
 * @param {number} heightPx The height of the view in pixels.
 */
export function metresPerPixel(range, fovy, heightPx) {
  if (!(range > 0) || !(fovy > 0) || !(heightPx > 0)) return NaN;
  return (2 * range * Math.tan(fovy / 2)) / heightPx;
}

/** "200 m", "5 km", "2,000 km". */
export function formatDistance(metres) {
  if (metres < 1) return `${Math.round(metres * 100)} cm`;
  if (metres < 1000) return `${metres} m`;
  return `${(metres / 1000).toLocaleString('en-GB')} km`;
}

/**
 * The longest round distance (1, 2 or 5 times a power of ten) whose ruler
 * fits in `maxPx`.
 * @returns {{ metres: number, pixels: number, label: string } | null}
 */
export function niceScale(perPixel, maxPx = MAX_PX) {
  if (!(perPixel > 0) || !Number.isFinite(perPixel)) return null;
  const most = perPixel * maxPx;
  const power = 10 ** Math.floor(Math.log10(most));
  // One times the power always fits, so there is always an answer.
  const metres = [5, 2, 1]
    .map((step) => step * power)
    .find((length) => length <= most);
  // Powers of ten below one are not exact in binary: tidy 0.30000000000000004.
  const tidy = Number(metres.toPrecision(1));
  return {
    metres: tidy,
    pixels: tidy / perPixel,
    label: formatDistance(tidy),
  };
}

const STYLE = `
#scale-bar {
  position: fixed;
  left: 14px;
  bottom: 180px;
  z-index: 100;
  display: none;
  align-items: flex-end;
  gap: 5px;
  color: #00f6ff;
  pointer-events: auto;
  user-select: none;
  -webkit-user-select: none;
}
#scale-bar.is-shown { display: flex; }
body.ui-clean-view #scale-bar { display: none; }
.sb-rule {
  box-sizing: border-box;
  width: 9px;
  border: solid currentColor;
  border-width: 2px 0 2px 2px;
  background:
    linear-gradient(currentColor, currentColor) 0 25% / 4px 1px no-repeat,
    linear-gradient(currentColor, currentColor) 0 50% / 7px 1px no-repeat,
    linear-gradient(currentColor, currentColor) 0 75% / 4px 1px no-repeat;
  filter: drop-shadow(0 0 3px rgba(0, 246, 255, 0.5));
}
.sb-label {
  writing-mode: vertical-rl;
  transform: rotate(180deg);
  color: #dff6ff;
  font: 600 10px/1 var(--font-mono, ui-monospace, monospace);
  letter-spacing: 0.16em;
  white-space: nowrap;
  text-shadow: 0 0 4px rgba(4, 10, 16, 0.9);
}
`;

/**
 * @param {import('cesium').Viewer} viewer
 * @param {Document} [doc]
 * @returns {() => void} Removes the scale.
 */
export function installScaleBar(viewer, doc = document) {
  const { scene, camera } = viewer;

  const style = doc.createElement('style');
  style.textContent = STYLE;
  doc.head.appendChild(style);

  const root = doc.createElement('div');
  root.id = 'scale-bar';
  root.title = 'Scale at the centre of the view';
  const rule = doc.createElement('span');
  rule.className = 'sb-rule';
  const label = doc.createElement('span');
  label.className = 'sb-label';
  root.append(rule, label);
  doc.body.appendChild(root);

  let seen = '';
  const sync = () => {
    if (viewer.isDestroyed()) return;
    // Finding the spot at the centre of the screen costs a depth read, so it
    // is only done when the camera has moved since the last look.
    const now = `${camera.positionWC}|${camera.directionWC}`;
    if (now === seen) return;
    seen = now;
    const frame = readCameraTargetFrame(viewer);
    const scale =
      frame &&
      niceScale(
        metresPerPixel(
          frame.range,
          camera.frustum.fovy,
          scene.canvas.clientHeight,
        ),
      );
    root.classList.toggle('is-shown', Boolean(scale));
    if (!scale) return;
    rule.style.height = `${Math.round(scale.pixels)}px`;
    if (label.textContent !== scale.label) label.textContent = scale.label;
  };

  const timer = setInterval(sync, CHECK_MS);
  sync();

  return () => {
    clearInterval(timer);
    root.remove();
    style.remove();
  };
}
