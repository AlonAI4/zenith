import * as Cesium from 'cesium';
import {
  readCameraTargetFrame,
  resetCameraNorth,
  setCameraTargetFrame,
} from '../ui/cameraOrientationControls.js';
import { createRotator } from './rotateGestures.js';
import { guard } from './addOns.js';

/**
 * A compass dial for turning the view by hand.
 *
 * - Drag round the ring: the view turns about the middle of the screen, and
 *   the ring follows the pointer like a real compass card.
 * - Click the N mark: north goes back to the top.
 * - Drag the short arc on the right: the view tilts between straight down
 *   and nearly level.
 *
 * The turning itself is the same code the Q and E keys use.
 */

const STRAIGHT_DOWN_DEG = -89;
const SHALLOWEST_DEG = -12;
const CLICK_SLOP_PX = 4;

// Drawing units are CSS pixels, with the dial's centre at 0,0.
const VIEW = { left: -56, top: -56, width: 126, height: 112 };
const ARC_RADIUS = 60;
/** How far above and below the centre the tilt arc reaches. */
const ARC_HALF_HEIGHT = 38;

/** Degrees clockwise from straight up, for a pointer around a centre. */
export function pointerAngle(centreX, centreY, x, y) {
  const degrees = (Math.atan2(x - centreX, centreY - y) * 180) / Math.PI;
  return (degrees + 360) % 360;
}

/**
 * The short way round from one angle to another, in degrees: positive is
 * clockwise. Going from 350 to 10 is +20, not -340.
 */
export function angleStep(from, to) {
  return ((((to - from) % 360) + 540) % 360) - 180;
}

/** A heading as three digits, the way instruments show it: 15 reads 015°. */
export function headingLabel(degrees) {
  const whole = ((Math.round(degrees) % 360) + 360) % 360;
  return `${String(whole).padStart(3, '0')}°`;
}

/** The tilt for a spot on the arc: 0 is its bottom (straight down), 1 its top. */
export function tiltForFraction(up) {
  const clamped = Math.min(1, Math.max(0, Number(up) || 0));
  return STRAIGHT_DOWN_DEG + clamped * (SHALLOWEST_DEG - STRAIGHT_DOWN_DEG);
}

/** Where on the arc a tilt sits: 0 at the bottom, 1 at the top. */
export function fractionForTilt(pitchDegrees) {
  const up =
    (pitchDegrees - STRAIGHT_DOWN_DEG) / (SHALLOWEST_DEG - STRAIGHT_DOWN_DEG);
  return Math.min(1, Math.max(0, up));
}

function tickPath(everyDegrees, innerRadius, skipEvery = 0) {
  let path = '';
  for (let angle = 0; angle < 360; angle += everyDegrees) {
    if (skipEvery && angle % skipEvery === 0) continue;
    const radians = (angle * Math.PI) / 180;
    const x = Math.sin(radians);
    const y = -Math.cos(radians);
    path += `M${(x * innerRadius).toFixed(2)} ${(y * innerRadius).toFixed(2)}L${(x * 50).toFixed(2)} ${(y * 50).toFixed(2)}`;
  }
  return path;
}

const ARC_X = Math.sqrt(ARC_RADIUS ** 2 - ARC_HALF_HEIGHT ** 2).toFixed(2);
const ARC_PATH = `M${ARC_X} ${-ARC_HALF_HEIGHT}A${ARC_RADIUS} ${ARC_RADIUS} 0 0 1 ${ARC_X} ${ARC_HALF_HEIGHT}`;

const MARKUP = `
<svg viewBox="${VIEW.left} ${VIEW.top} ${VIEW.width} ${VIEW.height}" width="${VIEW.width}" height="${VIEW.height}" role="img" aria-label="Compass">
  <circle class="cd-plate" r="52"/>
  <circle class="cd-inner" r="22"/>
  <path class="cd-cross" d="M-22 0h-6M22 0h6M0 22v6"/>
  <g class="cd-card">
    <path class="cd-ticks" d="${tickPath(10, 46, 30)}"/>
    <path class="cd-ticks cd-ticks-major" d="${tickPath(30, 42)}"/>
    <text class="cd-letter cd-letter-n" y="-33">N</text>
    <text class="cd-letter" transform="rotate(90)" y="-33">E</text>
    <text class="cd-letter" transform="rotate(180)" y="-33">S</text>
    <text class="cd-letter" transform="rotate(270)" y="-33">W</text>
  </g>
  <path class="cd-lubber" d="M0 -47l-4 -8h8z"/>
  <text class="cd-cap" y="-8">HDG</text>
  <text class="cd-read" y="8">000°</text>
  <circle class="cd-grab" data-part="ring" r="39"><title>Drag round the ring to rotate the view (or press Q and E)</title></circle>
  <g class="cd-card">
    <circle class="cd-north-hit" data-part="north" cy="-33" r="9"><title>Click for north up</title></circle>
  </g>
  <path class="cd-arc" d="${ARC_PATH}"/>
  <path class="cd-arc-ends" d="M${ARC_X} ${-ARC_HALF_HEIGHT}h5M${ARC_RADIUS} 0h4M${ARC_X} ${ARC_HALF_HEIGHT}h5"/>
  <circle class="cd-thumb" r="4.5" cx="${ARC_X}" cy="${ARC_HALF_HEIGHT}"/>
  <path class="cd-arc-grab" data-part="tilt" d="${ARC_PATH}"><title>Drag up to tilt the view, down to look straight down</title></path>
</svg>`;

const STYLE = `
#compass-dial {
  position: fixed;
  top: 18px;
  left: calc(50% + 300px);
  z-index: 100;
  color: #00f6ff;
  user-select: none;
  -webkit-user-select: none;
  touch-action: none;
  filter: drop-shadow(0 0 6px rgba(0, 246, 255, 0.2));
}
body.ui-clean-view #compass-dial {
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
}
#compass-dial svg { display: block; overflow: visible; }
#compass-dial text {
  font-family: var(--font-mono, ui-monospace, monospace);
  text-anchor: middle;
  dominant-baseline: central;
  pointer-events: none;
}
.cd-plate { fill: rgba(4, 10, 16, 0.66); stroke: rgba(0, 246, 255, 0.3); }
.cd-inner { fill: none; stroke: rgba(0, 246, 255, 0.22); stroke-dasharray: 2 3; }
.cd-cross { fill: none; stroke: rgba(0, 246, 255, 0.4); }
.cd-ticks { fill: none; stroke: currentColor; opacity: 0.5; }
.cd-ticks-major { stroke-width: 1.5; opacity: 0.95; }
.cd-letter { fill: #8fdcec; font-size: 9px; font-weight: 600; }
.cd-letter-n { fill: #fff; font-size: 12px; font-weight: 700; }
.cd-lubber { fill: #ff9d2e; }
.cd-cap { fill: #5fd6ee; font-size: 8px; letter-spacing: 0.22em; }
.cd-read { fill: #fff; font-size: 15px; font-weight: 600; }
.cd-grab { fill: none; stroke: transparent; stroke-width: 26; pointer-events: stroke; cursor: grab; }
.cd-north-hit { fill: transparent; cursor: pointer; }
.cd-arc { fill: none; stroke: rgba(0, 246, 255, 0.5); stroke-width: 1.5; stroke-linecap: round; }
.cd-arc-ends { fill: none; stroke: rgba(0, 246, 255, 0.5); }
.cd-arc-grab { fill: none; stroke: transparent; stroke-width: 20; stroke-linecap: round; pointer-events: stroke; cursor: ns-resize; }
.cd-thumb { fill: #00f6ff; stroke: #031018; stroke-width: 1.5; pointer-events: none; }
#compass-dial.is-turning .cd-grab,
#compass-dial.is-turning .cd-north-hit { cursor: grabbing; }
`;

/**
 * @param {Cesium.Viewer} viewer
 * @param {Document} [doc]
 * @param {{ onTilted?: () => void }} [options] Called when a drag on the tilt arc ends.
 * @returns {() => void} Removes the dial.
 */
export function installCompassDial(viewer, doc = document, { onTilted } = {}) {
  const rotateView = createRotator(viewer);

  const style = doc.createElement('style');
  style.textContent = STYLE;
  doc.head.appendChild(style);

  const root = doc.createElement('div');
  root.id = 'compass-dial';
  root.innerHTML = MARKUP;
  doc.body.appendChild(root);

  const svg = root.firstElementChild;
  const cards = root.querySelectorAll('.cd-card');
  const readout = root.querySelector('.cd-read');
  const thumb = root.querySelector('.cd-thumb');

  /** The dial's centre and scale on screen. */
  const geometry = () => {
    const box = svg.getBoundingClientRect();
    const scale = box.width / VIEW.width;
    return {
      x: box.left - VIEW.left * scale,
      y: box.top - VIEW.top * scale,
      scale,
    };
  };

  const placeThumb = (up) => {
    const y = ARC_HALF_HEIGHT * (1 - 2 * up);
    thumb.setAttribute('cy', y.toFixed(2));
    thumb.setAttribute('cx', Math.sqrt(ARC_RADIUS ** 2 - y ** 2).toFixed(2));
  };

  let shownHeading = null;
  const syncHeading = () => {
    const heading = Cesium.Math.toDegrees(viewer.camera.heading);
    const tenth = Math.round(heading * 10) / 10;
    if (tenth === shownHeading) return;
    shownHeading = tenth;
    for (const card of cards)
      card.setAttribute('transform', `rotate(${-tenth})`);
    const label = headingLabel(heading);
    if (readout.textContent !== label) readout.textContent = label;
  };

  // Reading the tilt costs a depth read of the screen centre, so it is done
  // when the camera comes to rest, not on every frame.
  const syncTilt = () => {
    if (drag?.part === 'tilt') return;
    const frame = readCameraTargetFrame(viewer);
    if (frame) placeThumb(fractionForTilt(Cesium.Math.toDegrees(frame.pitch)));
  };

  const northUp = () => {
    // The app's own north button eases the turn; use it when it is there.
    const button = doc.getElementById('north-up-view');
    if (button && !button.disabled) button.click();
    else resetCameraNorth(viewer);
  };

  let drag = null;

  const tiltTo = (event) => {
    const { y, scale } = geometry();
    const up =
      (y + ARC_HALF_HEIGHT * scale - event.clientY) /
      (2 * ARC_HALF_HEIGHT * scale);
    // A followed contact moves, so its frame is read fresh each time.
    const frame = viewer.trackedEntity
      ? readCameraTargetFrame(viewer) || drag.frame
      : drag.frame;
    const pitch = tiltForFraction(up);
    if (
      setCameraTargetFrame(viewer, {
        ...frame,
        pitch: Cesium.Math.toRadians(pitch),
      })
    )
      placeThumb(fractionForTilt(pitch));
  };

  const onPointerDown = (event) => {
    const part = event.target?.dataset?.part;
    if (!part || event.button !== 0) return;
    event.preventDefault();
    const centre = geometry();
    drag = {
      part,
      centre,
      startX: event.clientX,
      startY: event.clientY,
      angle: pointerAngle(centre.x, centre.y, event.clientX, event.clientY),
      moved: false,
    };
    if (part === 'tilt') {
      drag.frame = readCameraTargetFrame(viewer);
      if (!drag.frame) {
        drag = null;
        return;
      }
      tiltTo(event);
    }
    svg.setPointerCapture?.(event.pointerId);
    root.classList.toggle('is-turning', part !== 'tilt');
  };

  const onPointerMove = (event) => {
    if (!drag) return;
    if (drag.part === 'tilt') {
      tiltTo(event);
      return;
    }
    if (
      !drag.moved &&
      Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) <
        CLICK_SLOP_PX
    )
      return;
    drag.moved = true;
    const angle = pointerAngle(
      drag.centre.x,
      drag.centre.y,
      event.clientX,
      event.clientY,
    );
    // The ring follows the pointer, so the heading goes the other way.
    rotateView(-Cesium.Math.toRadians(angleStep(drag.angle, angle)));
    drag.angle = angle;
  };

  const onPointerUp = (event) => {
    if (!drag) return;
    const wasClickOnNorth = drag.part === 'north' && !drag.moved;
    const wasTilt = drag.part === 'tilt';
    drag = null;
    root.classList.remove('is-turning');
    svg.releasePointerCapture?.(event.pointerId);
    if (wasClickOnNorth && event.type === 'pointerup') northUp();
    // The app's own tilt button shows whether the view is tilted; tell it.
    if (wasTilt) onTilted?.();
  };

  svg.addEventListener('pointerdown', onPointerDown);
  svg.addEventListener('pointermove', onPointerMove);
  svg.addEventListener('pointerup', onPointerUp);
  svg.addEventListener('pointercancel', onPointerUp);

  const removeHeading = viewer.scene.preRender.addEventListener(
    guard('Compass', syncHeading),
  );
  const removeTilt = viewer.camera.moveEnd.addEventListener(
    guard('Compass', syncTilt),
  );
  syncHeading();
  syncTilt();

  return () => {
    removeHeading();
    removeTilt();
    root.remove();
    style.remove();
  };
}
