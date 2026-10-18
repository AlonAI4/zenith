import * as Cesium from 'cesium';

import { reportFailure } from './addOns.js';

/**
 * Spotlight: how the target box lights up the place it shows.
 *
 * On the 3D map the whole building is lit. An invisible volume from the
 * ground to just above the building's top colours every 3D surface inside it
 * (Cesium calls this classification), so walls, roofs and domes light up
 * while the rest of the map dims a little. The top is measured on the 3D map
 * itself, because OpenStreetMap's height is often only the main roof: 35 m for
 * the Texas Capitol, whose dome is far higher. Glowing rings at the top and
 * the base, joined at the corners, float just outside the walls instead of
 * being painted on them (a line painted on the 3D map smears up every wall).
 *
 * When the box opens, a bright band sweeps up the building, then the light
 * pulses gently. With reduced motion asked for in the computer's settings,
 * neither moves. On the satellite map there are no buildings to light: the
 * outline and a fill are drawn on the ground, and nothing dims.
 */

const CYAN = '#00f6ff';
export const FILL_ALPHA = 0.35;
/** The fill pulses up by this much and back. */
const PULSE_LIFT = 0.1;
export const PULSE_MS = 2000;
export const SWEEP_MS = 800;
/** Above the measured top, so domes, masts and roof edges are inside the light. */
export const HEADROOM_M = 5;
/** Below the ground, so sloping ground at the walls is lit too. */
const BELOW_GROUND_M = 2;
export const MAX_CORNERS = 8;
/** A turn sharper than this along the outline is a corner. */
const CORNER_TURN = (20 * Math.PI) / 180;
/**
 * The light and the rings reach this far past the mapped outline: Google's
 * walls often stand a metre or two outside OpenStreetMap's, and a wall the
 * light stops short of stays unlit (seen on the Texas Capitol's east wing).
 */
export const WALL_SLACK_M = 3;
/** The ground is measured this far outside the outline. */
const OUTSIDE_M = 6;
const INSIDE_POINTS = 36;
const EDGE_POINTS = 24;
const SAMPLE_TIMEOUT_MS = 8000;
/**
 * After the first grid, the highest spot is looked at closer twice, this far
 * each way: a dome's lantern or a spire is thinner than the grid.
 */
const PEAK_REACH_M = [12, 3];
const PEAK_SIDE = 7;
/** The pulse is drawn twenty times a second, not every frame. */
const PULSE_FRAME_MS = 50;
/**
 * Five pulses, then the light holds still: a pulse that never stops would
 * keep the map drawing twenty times a second while the box stays open.
 */
export const PULSE_RUN_MS = 5 * PULSE_MS;
/** Everything but the target is drawn this bright. */
const DIM = 0.55;
const VOLUME_ID = 'zenith-spotlight';

const M_PER_DEG_LAT = 110_574;
const M_PER_DEG_LON = 111_320;

/** The outline without a last point that repeats the first. */
export function openRing(ring) {
  const last = ring[ring.length - 1];
  return ring.length > 1 && last[0] === ring[0][0] && last[1] === ring[0][1]
    ? ring.slice(0, -1)
    : ring;
}

/** Converts between [lon, lat] and metres east and north of the outline. */
function localFrame(ring) {
  const lon0 = ring.reduce((sum, p) => sum + p[0], 0) / ring.length;
  const lat0 = ring.reduce((sum, p) => sum + p[1], 0) / ring.length;
  const kx = M_PER_DEG_LON * Math.cos((lat0 * Math.PI) / 180);
  return {
    to: ([lon, lat]) => [(lon - lon0) * kx, (lat - lat0) * M_PER_DEG_LAT],
    from: ([x, y]) => [lon0 + x / kx, lat0 + y / M_PER_DEG_LAT],
  };
}

function insideLocal(points, x, y) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

/** At most `count` items, spread evenly through the list. */
function spread(list, count) {
  if (list.length <= count) return list;
  const step = list.length / count;
  return Array.from({ length: count }, (_, i) => list[Math.floor(i * step)]);
}

/**
 * The outline moved `metres` outward (inward when negative), each point along
 * the middle of its two sides' outward directions.
 * @param {Array<[number, number]>} ring [lon, lat] points.
 */
export function grownRing(ring, metres) {
  const open = openRing(ring);
  const { to, from } = localFrame(open);
  const p = open.map(to);
  const n = p.length;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = p[i];
    const [x2, y2] = p[(i + 1) % n];
    area += x1 * y2 - x2 * y1;
  }
  const sign = area > 0 ? 1 : -1;
  const outward = (a, b) => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length = Math.hypot(dx, dy) || 1;
    return [(sign * dy) / length, (-sign * dx) / length];
  };
  return p.map((point, i) => {
    const before = outward(p[(i - 1 + n) % n], point);
    const after = outward(point, p[(i + 1) % n]);
    let nx = before[0] + after[0];
    let ny = before[1] + after[1];
    const length = Math.hypot(nx, ny);
    if (length < 1e-6) [nx, ny] = after;
    else [nx, ny] = [nx / length, ny / length];
    // A sharp corner moves further to keep both sides `metres` away, but
    // never more than twice as far.
    const reach = metres / Math.max(0.5, nx * after[0] + ny * after[1]);
    return from([point[0] + nx * reach, point[1] + ny * reach]);
  });
}

/** Where the outline turns most sharply: at most `max` points, in order. */
export function cornerIndexes(ring, max = MAX_CORNERS) {
  const open = openRing(ring);
  const { to } = localFrame(open);
  const p = open.map(to);
  const n = p.length;
  const turns = [];
  for (let i = 0; i < n; i++) {
    const [a, b, c] = [p[(i - 1 + n) % n], p[i], p[(i + 1) % n]];
    let turn = Math.abs(
      Math.atan2(c[1] - b[1], c[0] - b[0]) -
        Math.atan2(b[1] - a[1], b[0] - a[0]),
    );
    if (turn > Math.PI) turn = 2 * Math.PI - turn;
    if (turn >= CORNER_TURN) turns.push({ i, turn });
  }
  return turns
    .sort((x, y) => y.turn - x.turn)
    .slice(0, max)
    .map(({ i }) => i)
    .sort((x, y) => x - y);
}

/**
 * Points to measure the roof at: a grid inside the outline, and the outline
 * pulled in a little for thin or odd shapes.
 */
export function roofPoints(ring, count = INSIDE_POINTS) {
  const open = openRing(ring);
  const { to, from } = localFrame(open);
  const p = open.map(to);
  const xs = p.map((q) => q[0]);
  const ys = p.map((q) => q[1]);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  const step = Math.max(1.5, Math.sqrt(((x1 - x0) * (y1 - y0)) / count));
  const grid = [];
  for (let y = y0 + step / 2; y < y1; y += step) {
    for (let x = x0 + step / 2; x < x1; x += step) {
      if (insideLocal(p, x, y)) grid.push(from([x, y]));
    }
  }
  return [
    ...spread(grid, count),
    ...spread(grownRing(open, -1.5), EDGE_POINTS),
  ];
}

/**
 * A small square of points round one spot, only those inside the outline:
 * a closer look at the highest place found so far.
 */
export function peakPoints(ring, [lon, lat], reachM, side = PEAK_SIDE) {
  const open = openRing(ring);
  const { to, from } = localFrame(open);
  const p = open.map(to);
  const [cx, cy] = to([lon, lat]);
  const step = (2 * reachM) / (side - 1);
  const points = [];
  for (let i = 0; i < side; i++) {
    for (let j = 0; j < side; j++) {
      const x = cx - reachM + i * step;
      const y = cy - reachM + j * step;
      if (insideLocal(p, x, y)) points.push(from([x, y]));
    }
  }
  return points;
}

/** Points just outside the outline, to measure the ground at. */
export function groundPoints(ring) {
  return spread(grownRing(ring, OUTSIDE_M), EDGE_POINTS);
}

/** The ground: low among the heights around, so a tree or a car does not count. */
export function groundHeight(heights) {
  const found = heights.filter(Number.isFinite).sort((a, b) => a - b);
  return found.length >= 3 ? found[Math.floor(found.length / 5)] : undefined;
}

/**
 * The building from its base to its top. OpenStreetMap's height is the
 * least it can be; the measured roof wins when it is higher.
 * @param {{ ground?: number, roofs?: number[], tallM?: number, spotHeight: number }} facts
 * @returns {{ base: number, roof: number }}
 */
export function buildingSpan({ ground, roofs = [], tallM, spotHeight }) {
  const tall = Number.isFinite(tallM) && tallM > 0 ? tallM : 0;
  const base = Number.isFinite(ground) ? ground : spotHeight - tall;
  const roof = Math.max(
    base + tall,
    Number.isFinite(spotHeight) ? spotHeight : -Infinity,
    ...roofs.filter(Number.isFinite),
  );
  return { base, roof };
}

/** The fill's opacity at a moment: a slow rise and fall every two seconds. */
export function pulseAlpha(ms) {
  return (
    FILL_ALPHA +
    PULSE_LIFT * (0.5 - 0.5 * Math.cos((2 * Math.PI * ms) / PULSE_MS))
  );
}

/** The sweeping band's height a moment after opening; null once it is done. */
export function sweepHeight(ms, base, roof) {
  if (!(ms >= 0) || ms > SWEEP_MS) return null;
  const eased = 1 - (1 - ms / SWEEP_MS) ** 3;
  return base + (roof - base) * eased;
}

/**
 * @param {{ viewer: Cesium.Viewer, tileset?: Cesium.Cesium3DTileset }} scene
 * @param {Cesium.CustomDataSource} lines Where the lines and ground shapes go.
 * @param {Window} [win]
 */
export function createSpotlight({ viewer, tileset }, lines, win = globalThis) {
  const { scene } = viewer;
  const color = Cesium.Color.fromCssColorString(CYAN);
  const motion = win.matchMedia?.('(prefers-reduced-motion: reduce)');
  const still = () => motion?.matches === true;
  // Reused on every frame of the pulse.
  const scratchColor = new Cesium.Color();
  const scratchValue = new Uint8Array(4);
  const on3d = () =>
    Boolean(
      tileset &&
      !tileset.isDestroyed?.() &&
      tileset.show !== false &&
      !scene.globe.show,
    );
  let shown = null;
  let volume = null;
  let saved = null;
  let request = 0;
  let pulse = null;
  let frame = null;

  const dim = (on) => {
    if (on && !saved && scene.invertClassificationSupported) {
      saved = {
        invert: scene.invertClassification,
        color: Cesium.Color.clone(scene.invertClassificationColor),
      };
      scene.invertClassification = true;
      scene.invertClassificationColor = new Cesium.Color(DIM, DIM, DIM, 1);
    } else if (!on && saved) {
      scene.invertClassification = saved.invert;
      scene.invertClassificationColor = saved.color;
      saved = null;
    }
  };

  const stopMotion = () => {
    win.clearInterval?.(pulse);
    win.cancelAnimationFrame?.(frame);
    pulse = null;
    frame = null;
  };

  const clear = () => {
    if (volume && !scene.isDestroyed()) scene.primitives.remove(volume);
    volume = null;
    lines.entities.removeAll();
    dim(false);
    stopMotion();
  };

  const glow = (positions, width, alpha) =>
    lines.entities.add({
      polyline: {
        positions,
        width,
        arcType: Cesium.ArcType.NONE,
        material: new Cesium.PolylineGlowMaterialProperty({
          color: color.withAlpha(alpha),
          glowPower: 0.22,
          taperPower: 1,
        }),
        // Behind the building: still there, fainter.
        depthFailMaterial: color.withAlpha(alpha * 0.3),
      },
    });

  const paint3d = () => {
    const { ring, base, roof } = shown;
    const open = openRing(ring);
    const lifted = grownRing(open, WALL_SLACK_M);
    volume = scene.primitives.add(
      new Cesium.ClassificationPrimitive({
        geometryInstances: new Cesium.GeometryInstance({
          id: VOLUME_ID,
          geometry: new Cesium.PolygonGeometry({
            polygonHierarchy: new Cesium.PolygonHierarchy(
              Cesium.Cartesian3.fromDegreesArray(lifted.flat()),
            ),
            height: base - BELOW_GROUND_M,
            extrudedHeight: roof + HEADROOM_M,
          }),
          attributes: {
            color: Cesium.ColorGeometryInstanceAttribute.fromColor(
              color.withAlpha(FILL_ALPHA),
            ),
          },
        }),
        classificationType: Cesium.ClassificationType.CESIUM_3D_TILE,
      }),
    );
    dim(true);
    const loop = (height) =>
      Cesium.Cartesian3.fromDegreesArrayHeights(
        [...lifted, lifted[0]].flatMap(([lon, lat]) => [lon, lat, height]),
      );
    glow(loop(roof), 7, 1);
    glow(loop(base), 7, 0.85);
    for (const i of cornerIndexes(open)) {
      const [lon, lat] = lifted[i];
      glow(
        Cesium.Cartesian3.fromDegreesArrayHeights([
          lon,
          lat,
          base,
          lon,
          lat,
          roof,
        ]),
        5,
        0.8,
      );
    }
    const started = shown.openedAt;
    if (!still() && Date.now() - started <= SWEEP_MS) {
      const band = glow(
        new Cesium.CallbackProperty(
          () => loop(sweepHeight(Date.now() - started, base, roof) ?? roof),
          false,
        ),
        12,
        1,
      );
      const tick = () => {
        scene.requestRender();
        if (Date.now() - started <= SWEEP_MS)
          frame = win.requestAnimationFrame(tick);
        else lines.entities.remove(band);
      };
      frame = win.requestAnimationFrame?.(tick);
    }
    if (!still() && !pulse && Date.now() - started < PULSE_RUN_MS) {
      pulse = win.setInterval?.(() => {
        scene.requestRender();
        if (shown && Date.now() - shown.openedAt < PULSE_RUN_MS) return;
        win.clearInterval(pulse);
        pulse = null;
      }, PULSE_FRAME_MS);
    }
  };

  const paintGround = () => {
    const open = openRing(shown.ring);
    lines.entities.add({
      polygon: {
        hierarchy: Cesium.Cartesian3.fromDegreesArray(open.flat()),
        material: color.withAlpha(FILL_ALPHA),
        classificationType: Cesium.ClassificationType.TERRAIN,
      },
    });
    lines.entities.add({
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArray(
          [...open, open[0]].flat(),
        ),
        width: 3,
        clampToGround: true,
        material: color.withAlpha(0.95),
        classificationType: Cesium.ClassificationType.TERRAIN,
      },
    });
  };

  const paint = () => {
    clear();
    shown.mode = on3d() ? '3d' : 'ground';
    if (shown.mode === '3d') paint3d();
    else paintGround();
    if (globalThis.document?.body?.dataset)
      globalThis.document.body.dataset.spotlight = shown.mode;
    scene.requestRender();
  };

  // The real top and the ground, measured on the 3D map around the outline.
  /** Heights at these places, or null when the map did not answer in time. */
  const sample = async (points) => {
    let timer;
    const found = await Promise.race([
      scene.sampleHeightMostDetailed(
        points.map(([lon, lat]) => Cesium.Cartographic.fromDegrees(lon, lat)),
        // Never our own lines or light: the light's top would read as the roof.
        [...lines.entities.values, volume, VOLUME_ID].filter(Boolean),
      ),
      new Promise((done) => {
        timer = win.setTimeout(done, SAMPLE_TIMEOUT_MS, null);
      }),
    ]).catch(() => null);
    win.clearTimeout(timer);
    return found?.map((place) => place?.height) ?? null;
  };

  const measure = async (mine) => {
    if (!scene.sampleHeightSupported) return;
    const { ring } = shown;
    const roofs = roofPoints(ring);
    const around = groundPoints(ring);
    const heights = await sample([...roofs, ...around]);
    // Hidden, shown again or switched to the satellite map meanwhile.
    const gone = () => mine !== request || shown?.mode !== '3d';
    if (gone() || !heights) return;
    const found = heights.slice(0, roofs.length);
    const ground = groundHeight(heights.slice(roofs.length));
    for (const reach of PEAK_REACH_M) {
      let top = -1;
      found.forEach((h, i) => {
        if (Number.isFinite(h) && (top < 0 || h > found[top])) top = i;
      });
      if (top < 0) break;
      const near = peakPoints(ring, roofs[top], reach);
      const closer = near.length ? await sample(near) : null;
      if (gone()) return;
      if (!closer) break;
      roofs.push(...near);
      found.push(...closer);
    }
    Object.assign(
      shown,
      buildingSpan({
        ground,
        roofs: found,
        tallM: shown.tallM,
        spotHeight: shown.spotHeight,
      }),
    );
    shown.measured = true;
    paint();
  };

  /** Measures on the 3D map; a failure leaves the first guess lit. */
  const startMeasuring = () =>
    measure(request).catch((error) => reportFailure('Spotlight', error));

  const onFrame = () => {
    if (!shown) return;
    // The map was switched between 3D and satellite while the box was open:
    // a measurement still running belongs to the old map.
    if ((shown.mode === '3d') !== on3d()) {
      request += 1;
      paint();
      if (shown.mode === '3d' && !shown.measured) startMeasuring();
      return;
    }
    if (shown.mode !== '3d' || !volume?.ready || still()) return;
    // A volume Cesium could not build is "ready" with no attributes.
    const attributes = volume.getGeometryInstanceAttributes(VOLUME_ID);
    if (!attributes) return;
    const age = Date.now() - shown.openedAt;
    attributes.color = Cesium.ColorGeometryInstanceAttribute.toValue(
      color.withAlpha(
        age < PULSE_RUN_MS ? pulseAlpha(age) : FILL_ALPHA,
        scratchColor,
      ),
      scratchValue,
    );
  };

  return {
    /**
     * Light a place up.
     * @param {Array<[number, number]>} ring Its outline, [lon, lat] points.
     * @param {{ spotHeight: number, tallM?: number }} facts Where it was
     *   clicked, and OpenStreetMap's height if it has one.
     */
    show(ring, { spotHeight, tallM }) {
      request += 1;
      shown = {
        ring,
        tallM,
        spotHeight,
        openedAt: Date.now(),
        measured: false,
        ...buildingSpan({ tallM, spotHeight }),
      };
      paint();
      if (shown.mode === '3d') startMeasuring();
    },
    hide() {
      request += 1;
      shown = null;
      clear();
      if (globalThis.document?.body?.dataset)
        delete globalThis.document.body.dataset.spotlight;
      if (!scene.isDestroyed()) scene.requestRender();
    },
    /** The lit span, { base, roof }, while a place is shown. */
    span: () => shown && { base: shown.base, roof: shown.roof },
    onFrame,
  };
}
