import * as Cesium from 'cesium';
import { setCameraTargetFrame } from '../ui/cameraOrientationControls.js';
import { guard } from './addOns.js';

/**
 * Keeps the Earth in the middle of the screen when zooming far out.
 *
 * Zooming keeps whatever tilt the view has. Tilted 60 degrees at street
 * level, the camera backs away along that same slanted line for ever, so the
 * Earth slides down the screen and then off it.
 *
 * While zooming out, this eases the view toward straight down, turning about
 * the spot in the middle of the screen so that spot stays put. The further
 * out, the less tilt is left, and by the height where the whole Earth fits on
 * screen it is looking straight down with the Earth centred.
 *
 * It only acts while zooming out. There is no zoom limit, and the view can
 * still be tilted by hand at any height.
 */

/** Below this height the tilt is never touched. */
const FREE_BELOW_M = 100_000;
/**
 * Each frame the view closes a quarter of the gap to where it should be,
 * within these bounds: quick when far behind, gentle as it arrives.
 */
const CATCH_UP = 0.25;
const MIN_STEP_RAD = Cesium.Math.toRadians(0.3);
const MAX_STEP_RAD = Cesium.Math.toRadians(5);
const DONE_RAD = Cesium.Math.toRadians(0.05);
const NEARLY_DOWN_RAD = Cesium.Math.toRadians(89.9);
/** A scroll counts as still going for this long after its last event. */
const WHEEL_MS = 600;

/**
 * The height from which the whole Earth fits in view.
 * @param {number} radius The Earth's radius, in metres.
 * @param {number} fov The view's field of view across its narrower side, in radians.
 */
export function fitHeight(radius, fov) {
  return radius * (1 / Math.sin(fov / 2) - 1);
}

/**
 * How far from straight down the view may point at a height, in radians.
 * Anything goes near the ground; from there it shrinks smoothly to zero at
 * the height where the whole Earth fits.
 */
export function maxOffNadir(height, fitHeightM, freeBelow = FREE_BELOW_M) {
  if (!(height > freeBelow)) return Math.PI / 2;
  if (!(fitHeightM > freeBelow) || height >= fitHeightM) return 0;
  // Zooming multiplies the height, so "how far out" is measured in ratios.
  const t = Math.log(height / freeBelow) / Math.log(fitHeightM / freeBelow);
  const eased = t * t * (3 - 2 * t);
  return (Math.PI / 2) * (1 - eased);
}

/**
 * The angle between the line of sight and straight down, for a camera
 * looking at a spot on the ground.
 * @param {number} elevation How high the camera sits above the spot's
 * horizon, in radians: a quarter turn is directly overhead.
 * @param {number} range Metres from the spot to the camera.
 * @param {number} radius Metres from the Earth's centre to the spot.
 */
export function offNadirFor(elevation, range, radius) {
  const toCentre = Math.sqrt(
    radius ** 2 + range ** 2 + 2 * radius * range * Math.sin(elevation),
  );
  return Math.asin(
    Math.min(1, Math.max(0, (radius * Math.cos(elevation)) / toCentre)),
  );
}

/**
 * The lowest the camera may sit above the spot's horizon and still be within
 * `limit` of straight down.
 */
export function elevationForOffNadir(limit, range, radius) {
  let low = 0;
  let high = Math.PI / 2;
  if (offNadirFor(low, range, radius) <= limit) return low;
  for (let i = 0; i < 40; i += 1) {
    const middle = (low + high) / 2;
    if (offNadirFor(middle, range, radius) > limit) low = middle;
    else high = middle;
  }
  return high;
}

/**
 * @param {Cesium.Viewer} viewer
 * @returns {() => void} Stops it.
 */
export function installGlobeCentring(viewer) {
  const { scene, camera } = viewer;
  const { canvas } = scene;
  let lastWheel = -Infinity;
  let lastHeight = null;
  let easing = false;
  // The spot in the middle of the screen when the turn began. It is held
  // there until the turn ends: the zoom itself would slide it sideways.
  let anchor = null;
  // The compass direction the camera looks at that spot from, kept the same
  // for the whole turn so the map does not spin as it levels.
  let anchorHeading = null;

  const stop = () => {
    easing = false;
    anchor = null;
    anchorHeading = null;
  };
  const onWheel = () => {
    lastWheel = performance.now();
  };
  // Grabbing the map takes over from an ease still in progress.
  const onPointerDown = stop;
  canvas.addEventListener('wheel', onWheel, { passive: true });
  canvas.addEventListener('pointerdown', onPointerDown);

  const step = () => {
    const height = camera.positionCartographic?.height;
    const before = lastHeight;
    lastHeight = height;
    if (!Number.isFinite(height) || before === null) return;
    // Following a contact, or a view the app is steering: leave it alone.
    if (
      viewer.trackedEntity ||
      !Cesium.Matrix4.equals(camera.transform, Cesium.Matrix4.IDENTITY)
    ) {
      stop();
      return;
    }
    const scrolling = performance.now() - lastWheel < WHEEL_MS;
    if (scrolling && height > before * 1.0002) easing = true;
    else if (height < before * 0.9998) stop();
    if (!easing) return;

    const position = camera.positionWC;
    const down = Cesium.Cartesian3.negate(
      Cesium.Cartesian3.normalize(position, new Cesium.Cartesian3()),
      new Cesium.Cartesian3(),
    );
    const offNadir = Cesium.Cartesian3.angleBetween(camera.directionWC, down);
    const frustum = camera.frustum;
    const fov = Math.min(frustum.fov ?? Infinity, frustum.fovy ?? Infinity);
    const radius = Cesium.Cartesian3.magnitude(position) - height;
    const limit = Number.isFinite(fov)
      ? maxOffNadir(height, fitHeight(radius, fov))
      : Math.PI / 2;
    if (offNadir - limit < DONE_RAD) {
      if (!scrolling) stop();
      return;
    }

    anchor ||= camera.pickEllipsoid(
      new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2),
      scene.ellipsoid,
    );
    if (!anchor) {
      // The middle of the screen is sky: turn the view down until it is not.
      camera.lookDown(Math.min(offNadir - limit, MAX_STEP_RAD));
      scene.requestRender();
      return;
    }
    const frame = Cesium.Transforms.eastNorthUpToFixedFrame(anchor);
    const local = Cesium.Matrix4.multiplyByPoint(
      Cesium.Matrix4.inverseTransformation(frame, new Cesium.Matrix4()),
      position,
      new Cesium.Cartesian3(),
    );
    const range = Cesium.Cartesian3.magnitude(local);
    if (!(range > 1)) return;
    const elevation = Math.asin(Cesium.Math.clamp(local.z / range, -1, 1));
    const wanted = elevationForOffNadir(
      limit,
      range,
      Cesium.Cartesian3.magnitude(anchor),
    );
    // Never lower than it is now, and no more than one step higher.
    const stride = Cesium.Math.clamp(
      (wanted - elevation) * CATCH_UP,
      MIN_STEP_RAD,
      MAX_STEP_RAD,
    );
    const next = Math.min(
      NEARLY_DOWN_RAD,
      Math.max(elevation, Math.min(wanted, elevation + stride)),
    );
    anchorHeading ??= Math.atan2(-local.x, -local.y);
    setCameraTargetFrame(viewer, {
      target: anchor,
      range,
      heading: anchorHeading,
      pitch: -next,
    });
  };

  const removeStep = scene.preUpdate.addEventListener(
    guard('Earth centring', step),
  );

  return () => {
    removeStep();
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('pointerdown', onPointerDown);
  };
}
