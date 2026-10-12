import * as Cesium from 'cesium';

/**
 * Rotate the view around the spot at the centre of the screen.
 *
 * Three inputs, because no single one works everywhere:
 * - a two-finger trackpad twist, where the browser reports it (Safari);
 * - Option (Alt) + a two-finger sideways swipe, or Option + mouse wheel;
 * - the Q and E keys.
 */

const KEY_STEP_RAD = Cesium.Math.toRadians(5);
const WHEEL_RAD_PER_PX = Cesium.Math.toRadians(0.25);
// A pinch always carries a little twist; ignore it until it is deliberate.
const TWIST_DEADZONE_DEG = 4;
const PIVOT_HOLD_MS = 400;

/**
 * Radians to rotate for one wheel event, or 0 when it is not a rotate gesture.
 * @param {{altKey?: boolean, ctrlKey?: boolean, deltaX?: number, deltaY?: number}} event
 * @returns {number}
 */
export function wheelRotation(event) {
  if (!event.altKey || event.ctrlKey) return 0;
  const dx = Number(event.deltaX) || 0;
  const dy = Number(event.deltaY) || 0;
  // A trackpad swipe is sideways; a plain mouse wheel only has deltaY.
  const delta = Math.abs(dx) >= Math.abs(dy) ? dx : dy;
  return delta * WHEEL_RAD_PER_PX;
}

/**
 * Radians to rotate for one key press, or 0 for any other key.
 * @param {{key?: string, altKey?: boolean, ctrlKey?: boolean, metaKey?: boolean}} event
 * @returns {number}
 */
export function keyRotation(event) {
  if (event.altKey || event.ctrlKey || event.metaKey) return 0;
  const key = String(event.key || '').toLowerCase();
  if (key === 'e') return KEY_STEP_RAD;
  if (key === 'q') return -KEY_STEP_RAD;
  return 0;
}

/**
 * The point under the screen centre: the visible surface when the scene can
 * report it (terrain, 3D buildings), else the smooth ellipsoid.
 */
function pickPivot(scene, camera) {
  const centre = new Cesium.Cartesian2(
    scene.canvas.clientWidth / 2,
    scene.canvas.clientHeight / 2,
  );
  const seen = scene.pickPositionSupported && scene.pickPosition(centre);
  if (Cesium.defined(seen)) return seen;
  const ray = camera.getPickRay(centre);
  const hit =
    ray && Cesium.IntersectionTests.rayEllipsoid(ray, Cesium.Ellipsoid.WGS84);
  return hit ? Cesium.Ray.getPoint(ray, hit.start) : null;
}

/**
 * @returns {(radians: number) => void} Turns the camera (positive = clockwise
 * heading) while the spot under the screen centre stays put.
 */
export function createRotator(viewer) {
  // One gesture keeps one pivot, so the view does not wander as it turns.
  let held = null;

  return (radians) => {
    if (!radians || viewer.isDestroyed()) return;
    const { scene, camera } = viewer;
    if (!Cesium.Matrix4.equals(camera.transform, Cesium.Matrix4.IDENTITY)) {
      // Following a contact: orbit it, as dragging already does.
      camera.rotateRight(-radians);
    } else {
      const now = Date.now();
      if (!held || now - held.at > PIVOT_HOLD_MS) {
        const pivot = pickPivot(scene, camera);
        // The axis runs from the Earth's centre through the pivot, so the
        // pivot itself does not move.
        held = pivot && {
          axis: Cesium.Cartesian3.normalize(pivot, new Cesium.Cartesian3()),
        };
      }
      if (held) {
        held.at = now;
        camera.rotate(held.axis, radians);
      } else {
        // Looking at space: there is nothing to pivot on.
        camera.twistRight(radians);
      }
    }
    scene.requestRender();
  };
}

/**
 * @param {Cesium.Viewer} viewer
 * @returns {() => void} Removes the listeners.
 */
export function installRotateGestures(viewer) {
  const container = viewer.container;
  const doc = container.ownerDocument;
  const rotateView = createRotator(viewer);

  const onWheel = (event) => {
    const radians = wheelRotation(event);
    if (!radians) return;
    event.preventDefault();
    event.stopPropagation();
    rotateView(radians);
  };

  const onKeyDown = (event) => {
    if (event.target?.matches?.('select, input, textarea, [contenteditable]'))
      return;
    const radians = keyRotation(event);
    if (radians) rotateView(radians);
  };

  // Safari only: `rotation` is degrees since the gesture began.
  let lastTwistDeg = null;
  const onGestureStart = () => {
    lastTwistDeg = null;
  };
  const onGestureChange = (event) => {
    const twist = Number(event.rotation);
    if (!Number.isFinite(twist)) return;
    if (lastTwistDeg === null) {
      if (Math.abs(twist) < TWIST_DEADZONE_DEG) return;
      lastTwistDeg = twist;
      return;
    }
    // Fingers turning clockwise report a negative rotation.
    rotateView(Cesium.Math.toRadians(lastTwistDeg - twist));
    lastTwistDeg = twist;
  };

  container.addEventListener('wheel', onWheel, {
    capture: true,
    passive: false,
  });
  container.addEventListener('gesturestart', onGestureStart);
  container.addEventListener('gesturechange', onGestureChange);
  doc.addEventListener('keydown', onKeyDown);

  return () => {
    container.removeEventListener('wheel', onWheel, { capture: true });
    container.removeEventListener('gesturestart', onGestureStart);
    container.removeEventListener('gesturechange', onGestureChange);
    doc.removeEventListener('keydown', onKeyDown);
  };
}
