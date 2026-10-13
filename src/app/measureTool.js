import * as Cesium from 'cesium';
import {
  clearOverlaySource,
  setOverlayEntries,
} from '../overlays/worldOverlay.js';
import { formatDistance } from './scaleBar.js';
import { isTimeZonePick } from './timeZones.js';

/**
 * A measure tool: click two or more spots and read the distance between them.
 *
 * One toolbar switch. While it is on, each click on the map adds a point. The
 * points are joined by a line that follows the ground, the total is written
 * at the last point, and each leg is labelled once there are three or more.
 * With three points or more the shape can be closed, by clicking the first
 * point again or with a button: it is then filled in and labelled with its
 * area. A readout beside the scale shows the numbers and has Undo, Close
 * shape and Clear. Distances are the shortest path over the curved Earth,
 * worded the way the scale words them.
 */

const LAYER_NAME = 'alon-measure';
const COLOR = '#7dff9b';
const HALF_WAY_ROUND_M = Math.PI * 6371008.8;
/** The radius of a sphere with the same surface area as the Earth. */
const EQUAL_AREA_RADIUS_M = 6371007.2;
/** A click this close to the first point closes the shape, in pixels. */
export const CLOSE_WITHIN_PX = 14;

let measuring = false;

/** True while the measure switch is on, so other click tools stand aside. */
export function isMeasuring() {
  return measuring;
}

/**
 * Shortest distance over the Earth's surface, in metres.
 * @param {{lon: number, lat: number}} a
 * @param {{lon: number, lat: number}} b
 */
export function metresBetween(a, b) {
  try {
    return new Cesium.EllipsoidGeodesic(
      Cesium.Cartographic.fromDegrees(a.lon, a.lat),
      Cesium.Cartographic.fromDegrees(b.lon, b.lat),
    ).surfaceDistance;
  } catch {
    // Exactly opposite sides of the Earth: every direction is equally short.
    return HALF_WAY_ROUND_M;
  }
}

/**
 * Length of a path through the points, in metres. A closed path also counts
 * the leg from the last point back to the first.
 */
export function pathMetres(points, closed = false) {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += metresBetween(points[i - 1], points[i]);
  }
  if (closed && points.length > 2) {
    total += metresBetween(points.at(-1), points[0]);
  }
  return total;
}

/**
 * The area inside a closed shape, in square metres, on the curved Earth.
 * It treats the Earth as a ball of the same surface area, which is right to
 * about half a percent, and it does not matter which way round the points go.
 */
export function ringArea(points) {
  if (points.length < 3) return 0;
  const rad = (degrees) => (degrees * Math.PI) / 180;
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    // The short way round between the two longitudes.
    let turn = rad(b.lon - a.lon);
    if (turn > Math.PI) turn -= 2 * Math.PI;
    if (turn < -Math.PI) turn += 2 * Math.PI;
    sum += turn * (2 + Math.sin(rad(a.lat)) + Math.sin(rad(b.lat)));
  }
  return Math.abs((sum * EQUAL_AREA_RADIUS_M * EQUAL_AREA_RADIUS_M) / 2);
}

/**
 * The middle of a shape, from its corners as points in space.
 * It averages the corners. Adding them without dividing would give a point
 * several Earth radii out, and on a slightly flattened Earth that converts
 * to a latitude some 16 km off.
 * @param {import('cesium').Cartesian3[]} corners
 * @returns {import('cesium').Cartographic|undefined}
 */
export function shapeMiddle(corners) {
  const sum = corners.reduce(
    (total, corner) => Cesium.Cartesian3.add(total, corner, total),
    new Cesium.Cartesian3(),
  );
  Cesium.Cartesian3.divideByScalar(sum, corners.length, sum);
  return Cesium.Cartographic.fromCartesian(sum);
}

/** A distance rounded to what is worth reading, worded like the scale. */
export function distanceLabel(metres) {
  if (!(metres >= 0)) return '';
  if (metres < 1) return formatDistance(metres);
  if (metres < 999.5) return formatDistance(Math.round(metres));
  const km = metres / 1000;
  const factor = km < 10 ? 100 : km < 100 ? 10 : 1;
  return formatDistance((Math.round(km * factor) / factor) * 1000);
}

/** An area rounded to what is worth reading: m² up to a square km, then km². */
export function areaLabel(squareMetres) {
  if (!(squareMetres >= 0)) return '';
  if (squareMetres < 999_500) {
    return `${Math.round(squareMetres).toLocaleString('en-GB')} m²`;
  }
  const km2 = squareMetres / 1e6;
  const factor = km2 < 10 ? 100 : km2 < 100 ? 10 : 1;
  return `${(Math.round(km2 * factor) / factor).toLocaleString('en-GB')} km²`;
}

/** What the readout says. */
export function readoutText(points, closed = false) {
  if (points.length === 0) return 'Click the map to start measuring';
  if (points.length === 1) return 'Click the next spot';
  if (closed) {
    return `Area ${areaLabel(ringArea(points))} · outline ${distanceLabel(pathMetres(points, true))}`;
  }
  return `${distanceLabel(pathMetres(points))} · ${points.length} points`;
}

/**
 * Does a click at this spot on screen close the shape? It does when there are
 * at least three points and the click lands on the first one.
 * @param {{x: number, y: number}} click
 * @param {{x: number, y: number}|null|undefined} first Where the first point is on screen.
 * @param {number} count How many points there are.
 */
export function closesShape(click, first, count) {
  if (count < 3 || !first) return false;
  return Math.hypot(click.x - first.x, click.y - first.y) <= CLOSE_WITHIN_PX;
}

const ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 16.5l13-13 4 4-13 13z"/><path d="M7.5 12.5l1.6 1.6M10.5 9.5l1.6 1.6M13.5 6.5l1.6 1.6"/></svg>';

const STYLE = `
#measure-readout {
  position: fixed;
  left: 54px;
  bottom: 184px;
  z-index: 100;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px 6px 12px;
  border: 1px solid rgba(125, 255, 155, 0.45);
  border-radius: 10px;
  background: rgba(4, 12, 20, 0.9);
  color: #d9ffe3;
  font: 12px var(--font-mono, ui-monospace, monospace);
  letter-spacing: 0.06em;
  white-space: nowrap;
}
#measure-readout[hidden],
body.ui-clean-view #measure-readout { display: none; }
#measure-readout button {
  padding: 3px 9px;
  border: 1px solid rgba(125, 255, 155, 0.5);
  border-radius: 7px;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
#measure-readout button:hover { background: rgba(125, 255, 155, 0.16); }
#measure-readout button[hidden] { display: none; }
`;

/**
 * @param {{ viewer: import('cesium').Viewer }} scene
 * @param {Document} [doc]
 * @returns {() => void} Removes the tool.
 */
export function installMeasureTool({ viewer }, doc = document) {
  const { scene, camera } = viewer;
  const color = Cesium.Color.fromCssColorString(COLOR);
  /** @type {{lon: number, lat: number, position: import('cesium').Cartesian3}[]} */
  let points = [];
  let closed = false;
  let source = null;

  const style = doc.createElement('style');
  style.textContent = STYLE;
  doc.head.appendChild(style);

  const readout = doc.createElement('div');
  readout.id = 'measure-readout';
  readout.hidden = true;
  const words = doc.createElement('span');
  const make = (id, text, title) => {
    const control = doc.createElement('button');
    control.type = 'button';
    control.id = id;
    control.textContent = text;
    control.title = title;
    return control;
  };
  const undo = make('measure-undo', 'Undo', 'Remove the last point');
  const close = make(
    'measure-close',
    'Close shape',
    'Join the last point to the first and show the area inside',
  );
  const clear = make('measure-clear', 'Clear', 'Remove every measuring point');
  readout.append(words, undo, close, clear);
  doc.body.appendChild(readout);

  const midpoint = (a, b) => {
    const half = new Cesium.EllipsoidGeodesic(
      Cesium.Cartographic.fromCartesian(a.position),
      Cesium.Cartographic.fromCartesian(b.position),
    ).interpolateUsingFraction(0.5);
    const heightA = Cesium.Cartographic.fromCartesian(a.position).height;
    const heightB = Cesium.Cartographic.fromCartesian(b.position).height;
    return Cesium.Cartesian3.fromRadians(
      half.longitude,
      half.latitude,
      (heightA + heightB) / 2,
    );
  };

  /**
   * The middle of the shape, for the area label. It sits on top of whatever
   * is there (a roof, a bridge), or the label would be hidden inside it.
   */
  const middle = () => {
    const where = shapeMiddle(points.map((point) => point.position));
    if (!where) return points[0].position;
    const corners =
      points.reduce(
        (total, point) =>
          total + Cesium.Cartographic.fromCartesian(point.position).height,
        0,
      ) / points.length;
    const surface = scene.sampleHeightSupported
      ? scene.sampleHeight(where)
      : undefined;
    return Cesium.Cartesian3.fromRadians(
      where.longitude,
      where.latitude,
      (Number.isFinite(surface) ? surface : corners) + 2,
    );
  };

  const draw = () => {
    words.textContent = readoutText(points, closed);
    undo.hidden = points.length === 0;
    close.hidden = closed || points.length < 3;
    clear.hidden = points.length === 0;

    if (!source) {
      source = new Cesium.CustomDataSource(LAYER_NAME);
      viewer.dataSources.add(source);
    }
    source.entities.removeAll();
    for (const point of points) {
      // Drawn at the very spot that was clicked (a wall, a roof, the
      // ground), so the dot is where the click was and clicking the first
      // dot again lands on it.
      source.entities.add({
        position: point.position,
        point: {
          pixelSize: 9,
          color,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    }
    if (points.length > 1) {
      const route = closed ? [...points, points[0]] : points;
      source.entities.add({
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArray(
            route.flatMap((point) => [point.lon, point.lat]),
          ),
          clampToGround: true,
          width: 3,
          material: color.withAlpha(0.9),
        },
      });
    }
    if (closed) {
      source.entities.add({
        polygon: {
          hierarchy: Cesium.Cartesian3.fromDegreesArray(
            points.flatMap((point) => [point.lon, point.lat]),
          ),
          material: color.withAlpha(0.18),
        },
      });
    }

    // Text on the map goes through the app's own overlay.
    const labels = [];
    if (closed) {
      labels.push({
        id: 'area',
        position: middle(),
        variant: 'label',
        title: areaLabel(ringArea(points)),
        accent: COLOR,
        protected: true,
        priority: 9,
      });
    } else if (points.length > 1) {
      labels.push({
        id: 'total',
        position: points.at(-1).position,
        variant: 'label',
        title: distanceLabel(pathMetres(points)),
        accent: COLOR,
        protected: true,
        priority: 9,
      });
    }
    if (points.length > 2) {
      const last = closed ? points.length : points.length - 1;
      for (let i = 0; i < last; i++) {
        const a = points[i];
        const b = points[(i + 1) % points.length];
        labels.push({
          id: `leg:${i}`,
          position: midpoint(a, b),
          variant: 'label',
          title: distanceLabel(metresBetween(a, b)),
          accent: COLOR,
          priority: 5,
        });
      }
    }
    setOverlayEntries(LAYER_NAME, labels, {
      cohortLimit: 64,
      collisionCapacity: 64,
    });
    scene.requestRender();
  };

  const isMine = (picked) =>
    picked?.id?.entityCollection?.owner?.name === LAYER_NAME;

  const onClick = (click) => {
    if (!measuring || closed) return;
    const first =
      points.length > 0
        ? scene.cartesianToCanvasCoordinates(points[0].position)
        : null;
    if (closesShape(click.position, first, points.length)) {
      closed = true;
      draw();
      return;
    }
    // A click on a plane, camera or station belongs to that thing.
    const picked = scene.pick(click.position);
    const onMap =
      !picked ||
      picked.primitive instanceof Cesium.Cesium3DTileset ||
      picked instanceof Cesium.Cesium3DTileFeature ||
      isTimeZonePick(picked) ||
      isMine(picked);
    if (!onMap) return;
    const spot =
      (scene.pickPositionSupported && scene.pickPosition(click.position)) ||
      camera.pickEllipsoid(click.position, scene.ellipsoid);
    if (!Cesium.defined(spot)) return;
    const where = Cesium.Cartographic.fromCartesian(spot);
    points.push({
      lon: Cesium.Math.toDegrees(where.longitude),
      lat: Cesium.Math.toDegrees(where.latitude),
      position: spot,
    });
    draw();
  };

  const handler = new Cesium.ScreenSpaceEventHandler(scene.canvas);
  handler.setInputAction(onClick, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  const button = doc.createElement('button');
  button.id = 'measure-toggle';
  button.type = 'button';
  button.innerHTML = ICON;
  button.setAttribute('aria-label', 'Measure distance');

  const wipe = () => {
    points = [];
    closed = false;
    source?.entities.removeAll();
    clearOverlaySource(LAYER_NAME);
    words.textContent = readoutText(points);
    undo.hidden = true;
    close.hidden = true;
    clear.hidden = true;
    scene.requestRender();
  };
  const paint = () => {
    button.setAttribute('aria-pressed', String(measuring));
    button.title = measuring
      ? 'Stop measuring and remove the points'
      : 'Measure: click spots on the map to get the distance between them';
    readout.hidden = !measuring;
    scene.canvas.style.cursor = measuring ? 'crosshair' : '';
  };
  button.addEventListener('click', () => {
    measuring = !measuring;
    wipe();
    paint();
  });
  undo.addEventListener('click', () => {
    // A closed shape opens again; otherwise the last point goes.
    if (closed) closed = false;
    else points.pop();
    if (points.length === 0) wipe();
    else draw();
  });
  close.addEventListener('click', () => {
    if (points.length < 3) return;
    closed = true;
    draw();
  });
  clear.addEventListener('click', wipe);
  paint();
  wipe();
  doc.getElementById('top-center-actions')?.appendChild(button);

  return () => {
    measuring = false;
    handler.destroy();
    wipe();
    if (source) viewer.dataSources.remove(source, true);
    scene.canvas.style.cursor = '';
    button.remove();
    readout.remove();
    style.remove();
  };
}
