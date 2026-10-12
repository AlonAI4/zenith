import * as Cesium from 'cesium';
import {
  readCameraTargetFrame,
  setCameraTargetFrame,
} from '../ui/cameraOrientationControls.js';

/**
 * A marker on whatever is being tracked, for when the view is zoomed far out.
 *
 * While tracking, the zoom has no limit, so a plane soon shrinks to a dot
 * among thousands. Past a set distance this draws a pulsing ring on it with
 * its name, always the same size on screen. Clicking the ring flies back to
 * the normal following distance. It goes when tracking stops.
 */

/** Closer than this the tracked thing is easy to see without help. */
const SHOW_BEYOND_M = 50_000;
/** ...or this many times the distance tracking normally follows from. */
const SHOW_BEYOND_HOME = 4;
/** Follow distance for a tracked thing that does not say its own. */
const DEFAULT_HOME_M = 5_000;
const FLY_MS = 1_100;

/**
 * Whether the marker should be on screen.
 * @param {{ tracking: boolean, range: number, home: number }} state `range`
 * is how far the camera is from the tracked thing, `home` the distance
 * tracking normally follows from, both in metres.
 */
export function markerShows({ tracking, range, home }) {
  if (!tracking || !Number.isFinite(range)) return false;
  const usual = Number.isFinite(home) && home > 0 ? home : DEFAULT_HOME_M;
  return range > Math.max(SHOW_BEYOND_M, usual * SHOW_BEYOND_HOME);
}

/** The name from a tracked label such as "BAW123 · 31000 ft · 450 kts". */
export function shortName(title) {
  return (
    String(title || '')
      .split(' · ')[0]
      .trim() || 'Tracked'
  );
}

/**
 * The camera's distance part-way through flying back. It closes the same
 * fraction of what is left each moment, so it looks smooth from any distance.
 * @param {number} progress 0 at the start, 1 on arrival.
 */
export function flyRange(from, to, progress) {
  const t = Math.min(1, Math.max(0, progress));
  return from * (to / from) ** t;
}

const MARKUP = `
<svg viewBox="-32 -32 64 64" width="64" height="64" aria-hidden="true">
  <circle class="tm-pulse" r="14"/>
  <circle class="tm-ring" r="14"/>
  <path class="tm-ticks" d="M0 -22v-7M0 22v7M-22 0h-7M22 0h7"/>
  <circle class="tm-dot" r="2"/>
</svg>
<span class="tm-name"></span>`;

const STYLE = `
#tracking-marker {
  position: fixed;
  left: 0;
  top: 0;
  z-index: 90;
  display: none;
  flex-direction: column;
  align-items: center;
  margin: -32px 0 0 -32px;
  width: 64px;
  padding: 0;
  border: 0;
  background: none;
  color: #00f6ff;
  cursor: pointer;
}
#tracking-marker.is-shown { display: flex; }
body.ui-clean-view #tracking-marker,
body.cockpit-mode #tracking-marker { display: none; }
#tracking-marker svg { display: block; overflow: visible; }
.tm-ring { fill: rgba(0, 246, 255, 0.08); stroke: currentColor; stroke-width: 2; }
.tm-ticks { fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; }
.tm-dot { fill: currentColor; }
.tm-pulse {
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  transform-origin: center;
  transform-box: fill-box;
  animation: tm-pulse 1.6s ease-out infinite;
}
@keyframes tm-pulse {
  from { transform: scale(1); opacity: 0.9; }
  to { transform: scale(2.4); opacity: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .tm-pulse { animation: none; opacity: 0; }
}
.tm-name {
  margin-top: 2px;
  padding: 2px 7px;
  border: 1px solid rgba(0, 246, 255, 0.55);
  border-radius: 6px;
  background: rgba(4, 10, 16, 0.9);
  color: #e8f8ff;
  font: 600 11px/1.3 var(--font-mono, ui-monospace, monospace);
  letter-spacing: 0.06em;
  white-space: nowrap;
}
#tracking-marker:hover .tm-name,
#tracking-marker:focus-visible .tm-name { border-color: #00f6ff; color: #fff; }
`;

/**
 * @param {Cesium.Viewer} viewer
 * @param {Document} [doc]
 * @returns {() => void} Removes the marker.
 */
export function installTrackingMarker(viewer, doc = document) {
  const { scene } = viewer;

  const style = doc.createElement('style');
  style.textContent = STYLE;
  doc.head.appendChild(style);

  const marker = doc.createElement('button');
  marker.id = 'tracking-marker';
  marker.type = 'button';
  marker.innerHTML = MARKUP;
  const nameTag = marker.querySelector('.tm-name');
  doc.body.appendChild(marker);

  const homeOf = (entity) => {
    const offset = entity.viewFrom?.getValue?.(viewer.clock.currentTime);
    return offset ? Cesium.Cartesian3.magnitude(offset) : DEFAULT_HOME_M;
  };

  let shown = false;
  let shownName = '';
  const sync = () => {
    const entity = viewer.trackedEntity;
    // While something is tracked this reads its position without a depth
    // pick, so it is cheap enough for every frame.
    const frame = entity ? readCameraTargetFrame(viewer) : null;
    const spot =
      frame &&
      markerShows({
        tracking: true,
        range: frame.range,
        home: homeOf(entity),
      }) &&
      scene.cartesianToCanvasCoordinates(frame.target);
    if (!spot) {
      if (shown) marker.classList.remove('is-shown');
      shown = false;
      return;
    }
    const name = shortName(entity.gevLabelModel?.title || entity.name);
    if (name !== shownName) {
      shownName = name;
      nameTag.textContent = name;
      marker.title = `Fly back to ${name}`;
      marker.setAttribute('aria-label', `Fly back to ${name}`);
    }
    const box = scene.canvas.getBoundingClientRect();
    marker.style.transform = `translate(${Math.round(box.left + spot.x)}px, ${Math.round(box.top + spot.y)}px)`;
    if (!shown) marker.classList.add('is-shown');
    shown = true;
  };

  let stopFlying = null;
  const flyBack = () => {
    stopFlying?.();
    const entity = viewer.trackedEntity;
    const start = entity && readCameraTargetFrame(viewer);
    if (!start) return;
    const home = homeOf(entity);
    const began = performance.now();
    const remove = scene.preUpdate.addEventListener(() => {
      const progress = Math.min(1, (performance.now() - began) / FLY_MS);
      const frame =
        viewer.trackedEntity === entity && readCameraTargetFrame(viewer);
      const moved =
        frame &&
        setCameraTargetFrame(viewer, {
          ...frame,
          range: flyRange(
            start.range,
            home,
            Cesium.EasingFunction.CUBIC_IN_OUT(progress),
          ),
        });
      if (!moved || progress === 1) stopFlying?.();
    });
    stopFlying = () => {
      remove();
      stopFlying = null;
    };
    scene.requestRender();
  };
  marker.addEventListener('click', flyBack);

  // The marker sits over the middle of the map: zooming with the pointer on
  // it must still zoom the map. Taking over the zoom also ends a fly-back.
  const onWheel = (event) => {
    event.preventDefault();
    stopFlying?.();
    scene.canvas.dispatchEvent(new WheelEvent('wheel', event));
  };
  marker.addEventListener('wheel', onWheel, { passive: false });
  const onCanvasInput = () => stopFlying?.();
  scene.canvas.addEventListener('pointerdown', onCanvasInput);
  scene.canvas.addEventListener('wheel', onCanvasInput, { passive: true });

  const removeSync = scene.postRender.addEventListener(sync);

  return () => {
    stopFlying?.();
    removeSync();
    scene.canvas.removeEventListener('pointerdown', onCanvasInput);
    scene.canvas.removeEventListener('wheel', onCanvasInput);
    marker.remove();
    style.remove();
  };
}
