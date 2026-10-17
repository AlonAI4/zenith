import * as Cesium from 'cesium';
import { guard } from './addOns.js';
import { closeOnEscape } from './escapeKey.js';
import { isMeasuring } from './measureTool.js';

/**
 * Right-click a house, building or park: Zenith highlights it and shows a
 * target box beside it, in Zenith MC's style: cyan bracket corners around the
 * place and a small panel with its public map facts (what it is, its name and
 * address, its size, floors and height). The outline is painted on the 3D
 * buildings and on the ground. Escape, a left click on the map or another
 * right-click clears it. The map pin card has a Target box button that opens
 * the same box from the keyboard.
 *
 * The facts come from OpenStreetMap through Zenith's own server
 * (server/alon/placeFacts.js), which keeps to the services' fair-use rules.
 */

export const ROUTE = '/api/alon/place';
/** Above this camera height a right-click asks to zoom in instead. */
export const TARGET_MAX_HEIGHT_M = 6000;
const CYAN = '#00f6ff';
const TIMEOUT_MS = 20_000;
/** Corners are worked out from at most this many outline points. */
const CORNER_POINTS = 64;

/** "1,234 m²", "2.3 ha" for big parks, "0.5 km²" for very big ones. */
export function formatArea(m2) {
  if (!Number.isFinite(m2) || m2 <= 0) return '';
  if (m2 >= 1_000_000) return `${(m2 / 1_000_000).toFixed(1)} km²`;
  if (m2 >= 10_000) return `${(m2 / 10_000).toFixed(1)} ha`;
  return `${Math.round(m2).toLocaleString('en-GB')} m²`;
}

/**
 * The panel's header and rows for an answer from the facts route.
 * @returns {{ header: string, rows: Array<{ text: string, kind: 'title'|'line'|'faint' }> }}
 */
export function targetRows(facts, lat, lon) {
  const coordinates = {
    text: `${lat.toFixed(5)}, ${lon.toFixed(5)}`,
    kind: 'faint',
  };
  if (!facts?.found) {
    return {
      header: 'TARGET // NO MATCH',
      rows: [
        { text: 'No building or park is mapped at this spot', kind: 'title' },
        coordinates,
      ],
    };
  }
  const size = formatArea(facts.areaM2);
  const build = [
    Number.isFinite(facts.floors) &&
      `${facts.floors} ${facts.floors === 1 ? 'floor' : 'floors'}`,
    Number.isFinite(facts.heightM) && `${Math.round(facts.heightM)} m tall`,
  ]
    .filter(Boolean)
    .join(' · ');
  const rows = [
    { text: facts.name || facts.address || facts.kind, kind: 'title' },
    facts.name && facts.address && { text: facts.address, kind: 'line' },
    facts.place && { text: facts.place, kind: 'line' },
    size && { text: `Area ${size}`, kind: 'line' },
    build && { text: build, kind: 'line' },
    coordinates,
    facts.source && { text: facts.source, kind: 'faint' },
  ].filter(Boolean);
  return {
    header: `TARGET // ${String(facts.kind || 'PLACE').toUpperCase()}`,
    rows,
  };
}

/** Whether a spot is inside a ring of [lon, lat] points. */
export function insideRing(ring, lat, lon) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    )
      inside = !inside;
  }
  return inside;
}

/** The smallest screen box around some window points, or null if none. */
export function screenBox(points, pad = 10) {
  const seen = points.filter(
    (p) => p && Number.isFinite(p.x) && Number.isFinite(p.y),
  );
  if (seen.length === 0) return null;
  const xs = seen.map((p) => p.x);
  const ys = seen.map((p) => p.y);
  return {
    left: Math.min(...xs) - pad,
    top: Math.min(...ys) - pad,
    right: Math.max(...xs) + pad,
    bottom: Math.max(...ys) + pad,
  };
}

const STYLE = `
#target-box { position: fixed; inset: 0; pointer-events: none; z-index: 150; display: none; }
#target-box.open { display: block; }
#target-box-corners { position: absolute; overflow: visible; }
#target-box-corners path { fill: none; stroke: ${CYAN}; stroke-width: 2.5; filter: drop-shadow(0 0 4px rgba(0,246,255,.8)); }
#target-box-panel {
  position: absolute; pointer-events: auto; width: 250px; max-width: calc(100vw - 32px);
  padding: 0 0 8px; border: 1px solid rgba(0,246,255,.55); border-radius: 4px;
  background: rgba(2,10,16,.92); color: #dff8ff; box-shadow: 0 0 18px rgba(0,246,255,.25);
  font: 12px/1.45 var(--font-mono, ui-monospace, monospace);
}
#target-box-panel .tb-head {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 5px 8px 5px 10px; border-bottom: 1px solid rgba(0,246,255,.4);
  background: rgba(0,246,255,.12); color: ${CYAN}; font-weight: 700; letter-spacing: .08em; font-size: 11px;
}
#target-box-panel .tb-head button {
  width: 22px; height: 22px; padding: 0; border: 1px solid rgba(0,246,255,.45); border-radius: 3px;
  background: transparent; color: inherit; font: 13px/1 var(--font-mono, monospace); cursor: pointer;
}
#target-box-panel .tb-rows { padding: 6px 10px 0; }
#target-box-panel .tb-title { color: #fff; font-weight: 700; font-size: 13px; }
#target-box-panel .tb-faint { opacity: .65; font-size: 11px; }
`;

/**
 * @param {{ viewer: Cesium.Viewer }} scene
 * @param {Document} [doc]
 * @returns {() => void} Removes the box, the highlight and the listeners.
 */
export function installTargetBox({ viewer }, doc = document) {
  const { scene, camera } = viewer;
  const win = doc.defaultView ?? window;
  let request = 0;
  let target = null; // { ring, lat, lon, height, low } while a place is shown
  let spot = null; // { lat, lon, height } while waiting for an answer

  const style = doc.createElement('style');
  style.id = 'target-box-style';
  style.textContent = STYLE;
  doc.head.appendChild(style);

  const layer = doc.createElement('div');
  layer.id = 'target-box';
  const svgNs = 'http://www.w3.org/2000/svg';
  const corners = doc.createElementNS(svgNs, 'svg');
  corners.id = 'target-box-corners';
  corners.setAttribute('aria-hidden', 'true');
  const cornerPath = doc.createElementNS(svgNs, 'path');
  corners.appendChild(cornerPath);
  const panel = doc.createElement('div');
  panel.id = 'target-box-panel';
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-label', 'Target box');
  const head = doc.createElement('div');
  head.className = 'tb-head';
  const headText = doc.createElement('span');
  const close = doc.createElement('button');
  close.type = 'button';
  close.textContent = '×';
  close.title = 'Close the target box (Escape)';
  close.setAttribute('aria-label', 'Close the target box');
  head.append(headText, close);
  const rows = doc.createElement('div');
  rows.className = 'tb-rows';
  rows.setAttribute('role', 'status');
  panel.append(head, rows);
  layer.append(corners, panel);
  doc.body.appendChild(layer);

  const highlight = new Cesium.CustomDataSource('zenith-target-box');
  viewer.dataSources.add(highlight);
  const color = Cesium.Color.fromCssColorString(CYAN);

  const show = ({ header, rows: list }) => {
    headText.textContent = header;
    rows.replaceChildren(
      ...list.map(({ text, kind }) => {
        const row = doc.createElement('div');
        row.className = `tb-${kind}`;
        row.textContent = text;
        return row;
      }),
    );
    layer.classList.add('open');
    place();
  };

  const toWindow = (lon, lat, height) =>
    Cesium.SceneTransforms.worldToWindowCoordinates(
      scene,
      Cesium.Cartesian3.fromDegrees(lon, lat, height),
    );

  // Corners around the place, the panel beside them, worked out again on
  // every frame the map draws while the box is open.
  const place = () => {
    if (!layer.classList.contains('open')) return;
    let box = null;
    if (target) {
      const step = Math.max(1, Math.floor(target.ring.length / CORNER_POINTS));
      const points = [];
      for (let i = 0; i < target.ring.length; i += step) {
        const [lon, lat] = target.ring[i];
        points.push(toWindow(lon, lat, target.height));
        if (target.low !== target.height)
          points.push(toWindow(lon, lat, target.low));
      }
      box = screenBox(points);
    } else if (spot) {
      const at = toWindow(spot.lon, spot.lat, spot.height);
      box = at && {
        left: at.x - 22,
        top: at.y - 22,
        right: at.x + 22,
        bottom: at.y + 22,
      };
    }
    const width = win.innerWidth;
    const height = win.innerHeight;
    if (box) {
      const w = Math.max(24, box.right - box.left);
      const h = Math.max(24, box.bottom - box.top);
      const arm = Math.max(8, Math.min(22, w / 4, h / 4));
      corners.style.display = '';
      corners.style.left = `${box.left}px`;
      corners.style.top = `${box.top}px`;
      corners.setAttribute('width', String(w));
      corners.setAttribute('height', String(h));
      cornerPath.setAttribute(
        'd',
        `M0 ${arm}V0H${arm}M${w - arm} 0H${w}V${arm}M${w} ${h - arm}V${h}H${w - arm}M${arm} ${h}H0V${h - arm}`,
      );
    } else corners.style.display = 'none';
    // Beside the place: on its right if there is room, else on its left, and
    // always inside the window.
    const panelW = panel.offsetWidth || 250;
    const panelH = panel.offsetHeight || 140;
    let left = box ? box.right + 14 : width / 2 - panelW / 2;
    if (box && left + panelW > width - 16) left = box.left - 14 - panelW;
    left = Math.min(Math.max(16, left), width - panelW - 16);
    let top = box ? box.top : height / 2;
    top = Math.min(Math.max(80, top), height - panelH - 16);
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  };
  const offFrame = scene.postRender.addEventListener(
    guard('Target box', place),
  );

  let asking = null;
  const hide = () => {
    request += 1;
    // A newer right-click or a close: the answer is no longer wanted.
    asking?.abort();
    asking = null;
    target = null;
    spot = null;
    highlight.entities.removeAll();
    layer.classList.remove('open');
    scene.requestRender();
  };
  let opener = null;
  // Back to the button that opened the box, or, when its card has closed
  // meanwhile, to the Map pin switch.
  const giveBackFocus = () =>
    (opener?.offsetParent
      ? opener
      : opener && doc.getElementById('address-lookup-toggle')
    )?.focus();
  close.addEventListener('click', () => {
    hide();
    giveBackFocus();
  });
  const offEscape = closeOnEscape(
    win,
    () => layer.classList.contains('open'),
    hide,
    { panel, opener: { focus: giveBackFocus } },
  );

  const paint = (ring) => {
    highlight.entities.removeAll();
    const flat = ring.flat();
    highlight.entities.add({
      polygon: {
        hierarchy: Cesium.Cartesian3.fromDegreesArray(flat),
        material: color.withAlpha(0.3),
        classificationType: Cesium.ClassificationType.BOTH,
      },
    });
    highlight.entities.add({
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArray(flat),
        width: 3,
        clampToGround: true,
        material: color.withAlpha(0.95),
        classificationType: Cesium.ClassificationType.BOTH,
      },
    });
    scene.requestRender();
  };

  /** Look up and show the place at a spot. */
  const openAt = async (lat, lon, height = 0) => {
    hide();
    const mine = request;
    spot = { lat, lon, height };
    if ((camera.positionCartographic?.height ?? 0) > TARGET_MAX_HEIGHT_M) {
      show({
        header: 'TARGET // OUT OF RANGE',
        rows: [
          {
            text: 'Zoom in closer to target a building or park',
            kind: 'title',
          },
        ],
      });
      return;
    }
    show({
      header: 'TARGET // ACQUIRING',
      rows: [
        { text: 'Looking up this place…', kind: 'title' },
        { text: `${lat.toFixed(5)}, ${lon.toFixed(5)}`, kind: 'faint' },
      ],
    });
    asking = new AbortController();
    try {
      const response = await fetch(
        `${ROUTE}?lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}`,
        {
          signal: AbortSignal.any([
            asking.signal,
            AbortSignal.timeout(TIMEOUT_MS),
          ]),
        },
      );
      const answer = await response.json().catch(() => ({}));
      if (mine !== request) return;
      if (!response.ok)
        throw new Error(answer.error || `HTTP ${response.status}`);
      if (
        answer.found &&
        Array.isArray(answer.outline) &&
        answer.outline.length >= 4
      ) {
        const tall = Number.isFinite(answer.heightM) ? answer.heightM : 0;
        target = { ring: answer.outline, lat, lon, height, low: height - tall };
        spot = null;
        paint(answer.outline);
      }
      show(targetRows(answer, lat, lon));
    } catch (error) {
      if (mine !== request) return;
      show({
        header: 'TARGET // NO SIGNAL',
        rows: [
          {
            text:
              error?.name === 'TimeoutError'
                ? 'The map facts service took too long. Try again in a moment'
                : String(
                    error?.message || 'The map facts service did not answer',
                  ),
            kind: 'title',
          },
          { text: `${lat.toFixed(5)}, ${lon.toFixed(5)}`, kind: 'faint' },
        ],
      });
    }
  };

  const spotAt = (position) => {
    const found =
      (scene.pickPositionSupported && scene.pickPosition(position)) ||
      camera.pickEllipsoid(position, scene.ellipsoid);
    if (!Cesium.defined(found)) return null;
    const where = Cesium.Cartographic.fromCartesian(found);
    return {
      lat: Cesium.Math.toDegrees(where.latitude),
      lon: Cesium.Math.toDegrees(where.longitude),
      height: where.height,
    };
  };

  const handler = new Cesium.ScreenSpaceEventHandler(scene.canvas);
  handler.setInputAction((click) => {
    if (isMeasuring()) return;
    const at = spotAt(click.position);
    // Another right-click clears the box; on the place already shown, that is all.
    if (!at || (target && insideRing(target.ring, at.lat, at.lon))) {
      hide();
      return;
    }
    opener = null;
    openAt(at.lat, at.lon, at.height);
  }, Cesium.ScreenSpaceEventType.RIGHT_CLICK);
  handler.setInputAction(() => {
    if (layer.classList.contains('open')) hide();
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  // From the keyboard: the map pin card's Target box button opens the box
  // for the pinned spot.
  const fromCard = doc.createElement('button');
  fromCard.type = 'button';
  fromCard.id = 'address-card-target';
  fromCard.textContent = 'Target box';
  fromCard.title = 'Show the target box for the pinned spot';
  fromCard.style.cssText =
    'margin-top:8px;padding:3px 10px;border:1px solid rgba(0,246,255,.45);border-radius:6px;' +
    'background:transparent;color:#00f6ff;font:600 11px/1.4 var(--font-mono,monospace);cursor:pointer';
  fromCard.addEventListener('click', () => {
    const lat = Number(fromCard.parentElement?.dataset.lat);
    const lon = Number(fromCard.parentElement?.dataset.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const where = Cesium.Cartographic.fromDegrees(lon, lat);
    // The top of what is there: on the 3D map the globe is hidden, so its
    // height would be the sea's, not the ground's.
    const sampled = scene.sampleHeightSupported
      ? scene.sampleHeight(where)
      : undefined;
    const top = Number.isFinite(sampled)
      ? sampled
      : (scene.globe?.getHeight?.(where) ?? 0);
    // openAt shows the box at once; the answer fills it in later.
    openAt(lat, lon, top);
    opener = fromCard;
    close.focus();
  });
  // Installed before the Map pin, so that Escape closes this box first; the
  // card is made a moment later.
  queueMicrotask(() =>
    doc.getElementById('address-card')?.appendChild(fromCard),
  );

  return () => {
    hide();
    offEscape();
    offFrame();
    handler.destroy();
    if (!viewer.isDestroyed()) viewer.dataSources.remove(highlight, true);
    layer.remove();
    style.remove();
    fromCard.remove();
  };
}
