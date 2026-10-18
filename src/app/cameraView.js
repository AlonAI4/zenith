import * as Cesium from 'cesium';

import { CCTV_PRESENTATION } from '../layers/cctv/rendering.js';
import { hitTestWorldOverlay } from '../overlays/worldOverlay.js';
import { CCTV_THUMBNAIL_STYLE } from '../overlays/worldOverlayTokens.js';
import { guard } from './addOns.js';

/**
 * The chosen camera, Zenith's way: the target box's cyan corners round it in
 * place of the original's thin green wireframe, and what it can see lit as a
 * wedge from its heading, field of view and range (a light on the buildings
 * on the 3D map, a fill on the ground on the satellite map). Its full name
 * goes in the camera panel, and on hover over a card whose name was cut.
 */

const CYAN = '#00f6ff';
export const CONE_ALPHA = 0.28;
const ARC_STEPS = 16;
const M_PER_DEG_LAT = 111_320;
/** The light reaches from under the street to this far above the camera. */
const BELOW_GROUND_M = 10;
const ABOVE_CAMERA_M = 25;

/**
 * The ground a camera sees, as a closed ring of [lon, lat] points: from the
 * camera out to its range across its field of view, and back. Null when the
 * camera has no usable facing.
 */
export function viewWedge(
  { lat, lon, headingDeg, fovDeg, rangeM },
  steps = ARC_STEPS,
) {
  const numbers = [lat, lon, headingDeg, fovDeg, rangeM];
  if (!numbers.every(Number.isFinite) || rangeM <= 0 || fovDeg <= 0)
    return null;
  const kx = M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
  const fov = Math.min(fovDeg, 179);
  const ring = [[lon, lat]];
  for (let i = 0; i <= steps; i++) {
    const bearing =
      ((headingDeg - fov / 2 + (fov * i) / steps) * Math.PI) / 180;
    ring.push([
      lon + (Math.sin(bearing) * rangeM) / kx,
      lat + (Math.cos(bearing) * rangeM) / M_PER_DEG_LAT,
    ]);
  }
  ring.push([lon, lat]);
  return ring;
}

/** The four corner brackets of a w by h box, as an SVG path. */
export function cornerBrackets(w, h) {
  const arm = Math.max(8, Math.min(22, w / 4, h / 4));
  return `M0 ${arm}V0H${arm}M${w - arm} 0H${w}V${arm}M${w} ${h - arm}V${h}H${w - arm}M${arm} ${h}H0V${h - arm}`;
}

/** The brackets' size on screen: bigger close up, never lost or huge. */
export function bracketSize(distanceM) {
  if (!(distanceM > 0)) return 64;
  return Math.round(Math.min(140, Math.max(40, 9000 / distanceM)));
}

/** True when a card had to cut this name to fit. */
export const nameWasCut = (name) =>
  String(name ?? '').length > CCTV_THUMBNAIL_STYLE.titleChars;

const STYLE = `
#zenith-camera-corners { position: fixed; left: 0; top: 0; overflow: visible; pointer-events: none; z-index: 40; }
#zenith-camera-corners path { fill: none; stroke: ${CYAN}; stroke-width: 2.5; filter: drop-shadow(0 0 4px rgba(0,246,255,.8)); }
#zenith-cctv-name { color: #e8f4f8; font: 600 12px "JetBrains Mono", monospace; letter-spacing: .02em; margin: 2px 0 4px; overflow-wrap: anywhere; }
#zenith-camera-tip {
  position: fixed; z-index: 60; pointer-events: none; max-width: 320px;
  padding: 4px 8px; border: 1px solid rgba(0,246,255,.55); border-radius: 4px;
  background: rgba(3,9,12,.94); color: #e8f4f8; font: 600 12px "JetBrains Mono", monospace;
}
`;

/**
 * @param {{ viewer: Cesium.Viewer, tileset?: Cesium.Cesium3DTileset }} scene
 * @param {{ _cctvControls?: { cctv?: object } }} styleManager
 * @param {Document} [doc]
 * @param {typeof hitTestWorldOverlay} [hitTest] which card is at a point
 * @returns {() => void}
 */
export function installCameraView(
  { viewer, tileset },
  styleManager,
  doc = document,
  hitTest = hitTestWorldOverlay,
) {
  const cctv = styleManager?._cctvControls?.cctv;
  if (!cctv?.subscribe) return () => {};
  const win = doc.defaultView ?? window;
  const { scene } = viewer;
  const color = Cesium.Color.fromCssColorString(CYAN);
  const on3d = () =>
    Boolean(tileset && tileset.show !== false && !scene.globe.show);

  const style = doc.createElement('style');
  style.textContent = STYLE;
  doc.head.appendChild(style);
  const svgNs = 'http://www.w3.org/2000/svg';
  const corners = doc.createElementNS(svgNs, 'svg');
  corners.id = 'zenith-camera-corners';
  corners.style.display = 'none';
  const cornerPath = doc.createElementNS(svgNs, 'path');
  corners.appendChild(cornerPath);
  doc.body.appendChild(corners);
  const tip = doc.createElement('div');
  tip.id = 'zenith-camera-tip';
  tip.hidden = true;
  doc.body.appendChild(tip);
  const nameLine = doc.createElement('div');
  nameLine.id = 'zenith-cctv-name';
  nameLine.hidden = true;

  const lines = new Cesium.CustomDataSource('zenith-camera-view');
  viewer.dataSources.add(lines);
  // The original's green wireframe for the chosen camera gives way to ours,
  // at once rather than at the camera layer's next redraw.
  CCTV_PRESENTATION.activeWireframe = false;
  cctv.setParams?.({});

  let chosen = null;
  let drawnKey = '';
  let mode = null;
  let volume = null;

  const clear = () => {
    if (volume && !scene.isDestroyed()) scene.primitives.remove(volume);
    volume = null;
    lines.entities.removeAll();
    mode = null;
  };

  const paint = () => {
    clear();
    const ring = chosen && viewWedge(chosen);
    if (!ring) return;
    const open = ring.slice(0, -1);
    mode = on3d() ? '3d' : 'ground';
    if (mode === '3d') {
      const ground = chosen.elevationM - (chosen.mountHeightM || 0);
      volume = scene.primitives.add(
        new Cesium.ClassificationPrimitive({
          geometryInstances: new Cesium.GeometryInstance({
            geometry: new Cesium.PolygonGeometry({
              polygonHierarchy: new Cesium.PolygonHierarchy(
                Cesium.Cartesian3.fromDegreesArray(open.flat()),
              ),
              height: ground - BELOW_GROUND_M,
              extrudedHeight: chosen.elevationM + ABOVE_CAMERA_M,
            }),
            attributes: {
              color: Cesium.ColorGeometryInstanceAttribute.fromColor(
                color.withAlpha(CONE_ALPHA),
              ),
            },
          }),
          classificationType: Cesium.ClassificationType.CESIUM_3D_TILE,
        }),
      );
    } else {
      lines.entities.add({
        polygon: {
          hierarchy: Cesium.Cartesian3.fromDegreesArray(open.flat()),
          material: color.withAlpha(CONE_ALPHA),
          classificationType: Cesium.ClassificationType.TERRAIN,
        },
      });
      lines.entities.add({
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArray(ring.flat()),
          width: 2,
          clampToGround: true,
          material: color.withAlpha(0.9),
          classificationType: Cesium.ClassificationType.TERRAIN,
        },
      });
    }
    scene.requestRender();
  };

  // The chosen camera, from the camera layer while it is on; a calibration
  // that moves or turns it redraws the wedge.
  const follow = (state) => {
    const camera = state?.enabled ? (state.activeCamera ?? null) : null;
    chosen = camera;
    const key = camera
      ? [
          camera.id,
          camera.lat,
          camera.lon,
          camera.headingDeg,
          camera.fovDeg,
          camera.rangeM,
          camera.elevationM,
          camera.mountHeightM,
        ].join(' ')
      : '';
    nameLine.textContent = camera?.name ?? '';
    nameLine.hidden = !camera?.name;
    const meta = doc.getElementById('cctv-meta');
    if (meta && nameLine.parentNode !== meta.parentNode) meta.before(nameLine);
    if (key === drawnKey) return;
    drawnKey = key;
    if (camera) paint();
    else clear();
    if (!camera) corners.style.display = 'none';
  };
  const unsubscribe = cctv.subscribe(follow);

  // Reused on every frame.
  const where = new Cesium.Cartesian3();
  const toward = new Cesium.Cartesian3();
  const at = new Cesium.Cartesian2();
  const earth = new Cesium.EllipsoidalOccluder(Cesium.Ellipsoid.WGS84);
  let box = null;
  const canvasBox = () => (box ??= scene.canvas.getBoundingClientRect());
  const onResize = () => {
    box = null;
  };
  let drawnSize = 0;
  const onFrame = () => {
    if (!chosen) return;
    if (mode && (mode === '3d') !== on3d()) paint();
    Cesium.Cartesian3.fromDegrees(
      chosen.lon,
      chosen.lat,
      chosen.elevationM,
      undefined,
      where,
    );
    Cesium.Cartesian3.subtract(where, scene.camera.positionWC, toward);
    const ahead = Cesium.Cartesian3.dot(toward, scene.camera.directionWC) > 0;
    // Behind the view, or round the far side of the Earth.
    earth.cameraPosition = scene.camera.positionWC;
    const seen =
      ahead &&
      earth.isPointVisible(where) &&
      scene.cartesianToCanvasCoordinates(where, at);
    if (!seen) {
      corners.style.display = 'none';
      return;
    }
    const size = bracketSize(
      Cesium.Cartesian3.distance(where, scene.camera.positionWC),
    );
    const { left, top } = canvasBox();
    corners.style.display = '';
    corners.style.transform = `translate(${left + at.x - size / 2}px, ${top + at.y - size / 2}px)`;
    if (size === drawnSize) return;
    drawnSize = size;
    corners.setAttribute('width', String(size));
    corners.setAttribute('height', String(size));
    cornerPath.setAttribute('d', cornerBrackets(size, size));
  };
  const offFrame = scene.preRender.addEventListener(
    guard('Camera view', onFrame),
  );

  // A card that had to cut its camera's name shows the whole name on hover.
  // Checked when the pointer moves and again after every frame: cards are
  // re-placed under a still pointer, and a hover itself can re-place them.
  let pointer = null;
  const showTip = () => {
    if (!pointer) return;
    const { left, top } = canvasBox();
    const hit = hitTest(pointer.x - left, pointer.y - top, {
      sourceId: 'cctv',
    });
    const name = hit?.entry?.title ?? '';
    tip.hidden = !nameWasCut(name);
    if (tip.hidden) return;
    if (tip.textContent !== name) tip.textContent = name;
    tip.style.left = `${Math.min(pointer.x + 14, win.innerWidth - 330)}px`;
    tip.style.top = `${pointer.y + 16}px`;
  };
  const onMove = (event) => {
    // Over a panel or a button, not the map: no card is being pointed at.
    if (event.target?.tagName !== 'CANVAS') {
      pointer = null;
      tip.hidden = true;
      return;
    }
    pointer = { x: event.clientX, y: event.clientY };
    showTip();
  };
  // The pointer left the window.
  const onOut = (event) => {
    if (event.relatedTarget) return;
    pointer = null;
    tip.hidden = true;
  };
  // On the window, first: the overlay's canvas can sit above the map's, and
  // another layer's handler may stop the event before it bubbles up.
  win.addEventListener('pointermove', onMove, { passive: true, capture: true });
  win.addEventListener('pointerout', onOut, { passive: true, capture: true });
  win.addEventListener('resize', onResize, { passive: true });
  const offPainted = scene.postRender.addEventListener(
    guard('Camera name tip', showTip),
  );

  return () => {
    unsubscribe?.();
    offFrame();
    offPainted();
    win.removeEventListener('pointermove', onMove, { capture: true });
    win.removeEventListener('pointerout', onOut, { capture: true });
    win.removeEventListener('resize', onResize);
    clear();
    if (!viewer.isDestroyed?.()) viewer.dataSources.remove(lines, true);
    CCTV_PRESENTATION.activeWireframe = true;
    cctv.setParams?.({});
    corners.remove();
    tip.remove();
    nameLine.remove();
    style.remove();
  };
}
