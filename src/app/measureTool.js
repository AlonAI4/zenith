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
 * A readout beside the scale shows the total and clears everything with one
 * click. Distances are the shortest path over the curved Earth, worded the
 * way the scale words them.
 */

const LAYER_NAME = 'alon-measure';
const COLOR = '#7dff9b';
const HALF_WAY_ROUND_M = Math.PI * 6371008.8;

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

/** Length of a path through the points, in metres. */
export function pathMetres(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += metresBetween(points[i - 1], points[i]);
  }
  return total;
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

/** What the readout says for this many points. */
export function readoutText(points) {
  if (points.length === 0) return 'Click the map to start measuring';
  if (points.length === 1) return 'Click the next spot';
  return `${distanceLabel(pathMetres(points))} · ${points.length} points`;
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
  gap: 10px;
  padding: 6px 8px 6px 12px;
  border: 1px solid rgba(125, 255, 155, 0.45);
  border-radius: 10px;
  background: rgba(4, 12, 20, 0.9);
  color: #d9ffe3;
  font: 12px var(--font-mono, ui-monospace, monospace);
  letter-spacing: 0.06em;
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
  let source = null;

  const style = doc.createElement('style');
  style.textContent = STYLE;
  doc.head.appendChild(style);

  const readout = doc.createElement('div');
  readout.id = 'measure-readout';
  readout.hidden = true;
  const words = doc.createElement('span');
  const clear = doc.createElement('button');
  clear.type = 'button';
  clear.textContent = 'Clear';
  clear.title = 'Remove every measuring point';
  readout.append(words, clear);
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

  const draw = () => {
    words.textContent = readoutText(points);
    clear.hidden = points.length === 0;

    if (!source) {
      source = new Cesium.CustomDataSource(LAYER_NAME);
      viewer.dataSources.add(source);
    }
    source.entities.removeAll();
    for (const point of points) {
      source.entities.add({
        position: Cesium.Cartesian3.fromDegrees(point.lon, point.lat),
        point: {
          pixelSize: 9,
          color,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    }
    if (points.length > 1) {
      source.entities.add({
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArray(
            points.flatMap((point) => [point.lon, point.lat]),
          ),
          clampToGround: true,
          width: 3,
          material: color.withAlpha(0.9),
        },
      });
    }

    // Text on the map goes through the app's own overlay.
    const labels = [];
    if (points.length > 1) {
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
      for (let i = 1; i < points.length; i++) {
        labels.push({
          id: `leg:${i}`,
          position: midpoint(points[i - 1], points[i]),
          variant: 'label',
          title: distanceLabel(metresBetween(points[i - 1], points[i])),
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
    if (!measuring) return;
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
    source?.entities.removeAll();
    clearOverlaySource(LAYER_NAME);
    words.textContent = readoutText(points);
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
  clear.addEventListener('click', wipe);
  paint();
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
