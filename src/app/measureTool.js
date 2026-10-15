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
 *
 * Profile draws a small chart of the height along the path, with its highest
 * and lowest points. Both maps can give heights: the 3D map gives the scanned
 * surface, so roofs and treetops count; the satellite map gives bare ground
 * and needs the terrain that comes with the Cesium key. Both measure from a
 * mathematical Earth shape, not from sea level (about 50 m apart around
 * Britain), so the chart shows height above the lowest point on the path,
 * which that difference does not touch.
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
 * The sum measures the side of the shape away from the North Pole, so a shape
 * round that pole first comes out as the rest of the Earth; the smaller of the
 * two sides is the one that was drawn.
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
  const area = Math.abs((sum * EQUAL_AREA_RADIUS_M * EQUAL_AREA_RADIUS_M) / 2);
  const earth = 4 * Math.PI * EQUAL_AREA_RADIUS_M * EQUAL_AREA_RADIUS_M;
  return Math.min(area, earth - area);
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

/** How many spots along the path the height is read at. */
export const PROFILE_SAMPLES = 96;

/**
 * Evenly spaced spots along a path, each with how far along it is.
 * @returns {{lon: number, lat: number, along: number}[]}
 */
export function pathSamples(points, count = PROFILE_SAMPLES, closed = false) {
  const route = closed && points.length > 2 ? [...points, points[0]] : points;
  if (route.length < 2 || count < 2) return [];
  const legs = [];
  let total = 0;
  for (let i = 1; i < route.length; i++) {
    const length = metresBetween(route[i - 1], route[i]);
    legs.push({ from: route[i - 1], to: route[i], start: total, length });
    total += length;
  }
  if (!(total > 0)) return [];
  const samples = [];
  let leg = 0;
  for (let i = 0; i < count; i++) {
    const along = (total * i) / (count - 1);
    while (leg < legs.length - 1 && along > legs[leg].start + legs[leg].length)
      leg += 1;
    const { from, to, start, length } = legs[leg];
    const fraction =
      length > 0 ? Math.min(1, Math.max(0, (along - start) / length)) : 0;
    let where;
    try {
      where = new Cesium.EllipsoidGeodesic(
        Cesium.Cartographic.fromDegrees(from.lon, from.lat),
        Cesium.Cartographic.fromDegrees(to.lon, to.lat),
      ).interpolateUsingFraction(fraction);
    } catch {
      where = Cesium.Cartographic.fromDegrees(from.lon, from.lat);
    }
    samples.push({
      lon: Cesium.Math.toDegrees(where.longitude),
      lat: Cesium.Math.toDegrees(where.latitude),
      along,
    });
  }
  return samples;
}

/**
 * The lowest and highest of a list of heights, and where they are.
 * Null when fewer than two heights are known, or the ground is level.
 */
export function profileStats(heights) {
  let lowIndex = -1;
  let highIndex = -1;
  let known = 0;
  heights.forEach((height, index) => {
    if (!Number.isFinite(height)) return;
    known += 1;
    if (lowIndex < 0 || height < heights[lowIndex]) lowIndex = index;
    if (highIndex < 0 || height > heights[highIndex]) highIndex = index;
  });
  if (known < 2 || heights[highIndex] - heights[lowIndex] < 0.5) return null;
  return {
    lowIndex,
    highIndex,
    low: heights[lowIndex],
    high: heights[highIndex],
    rise: heights[highIndex] - heights[lowIndex],
  };
}

/** Where along the path something is, in words. */
export function whereAlong(along, total) {
  if (along <= total * 0.005) return 'at the start';
  if (along >= total * 0.995) return 'at the end';
  return `${distanceLabel(along)} along`;
}

/**
 * The chart's line, as the points of an SVG path. Heights that could not be
 * read leave a gap.
 * @returns {string}
 */
export function profileLine(heights, stats, width, height, pad = 6) {
  const usable = Math.max(1, heights.length - 1);
  let path = '';
  let pen = 'M';
  heights.forEach((value, index) => {
    if (!Number.isFinite(value)) {
      pen = 'M';
      return;
    }
    const x = pad + ((width - 2 * pad) * index) / usable;
    const y =
      height - pad - ((height - 2 * pad) * (value - stats.low)) / stats.rise;
    path += `${pen}${x.toFixed(1)} ${y.toFixed(1)}`;
    pen = 'L';
  });
  return path;
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
#measure-profile {
  position: fixed;
  top: 92px;
  left: 50%;
  z-index: 181;
  width: min(380px, calc(100vw - 32px));
  transform: translateX(-50%);
  padding: 12px 14px;
  border: 1px solid rgba(125, 255, 155, 0.45);
  border-radius: 12px;
  background: rgba(4, 12, 20, 0.95);
  box-shadow: 0 14px 40px rgba(0, 0, 0, 0.6);
  color: #d9ffe3;
  font: 12px/1.4 var(--font-mono, ui-monospace, monospace);
}
#measure-profile[hidden],
body.ui-clean-view #measure-profile { display: none; }
#measure-profile .mp-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
  letter-spacing: 0.18em;
  color: #7dff9b;
}
#measure-profile .mp-close {
  width: 24px;
  height: 24px;
  border: 1px solid rgba(125, 255, 155, 0.5);
  border-radius: 50%;
  background: transparent;
  color: inherit;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}
#measure-profile svg { display: block; width: 100%; height: 120px; }
#measure-profile .mp-ends { display: flex; justify-content: space-between; opacity: 0.7; font-size: 10px; }
#measure-profile p { margin: 6px 0 0; }
#measure-profile .mp-note { opacity: 0.65; font-size: 10px; }
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
  const profile = make(
    'measure-profile-open',
    'Profile',
    'Show the height of the ground along the path',
  );
  const clear = make('measure-clear', 'Clear', 'Remove every measuring point');
  readout.append(words, undo, close, profile, clear);

  // The height profile: a small chart in its own panel.
  const SVG = 'http://www.w3.org/2000/svg';
  const CHART = { width: 352, height: 120 };
  const chartPanel = doc.createElement('section');
  chartPanel.id = 'measure-profile';
  chartPanel.setAttribute('role', 'dialog');
  chartPanel.setAttribute('aria-label', 'Height profile');
  chartPanel.hidden = true;
  const chartHead = doc.createElement('div');
  chartHead.className = 'mp-head';
  const chartTitle = doc.createElement('span');
  chartTitle.textContent = 'HEIGHT PROFILE';
  const chartClose = doc.createElement('button');
  chartClose.type = 'button';
  chartClose.className = 'mp-close';
  chartClose.textContent = '×';
  chartClose.title = 'Close the height profile';
  chartClose.setAttribute('aria-label', 'Close the height profile');
  chartHead.append(chartTitle, chartClose);
  const chart = doc.createElementNS(SVG, 'svg');
  chart.setAttribute('viewBox', `0 0 ${CHART.width} ${CHART.height}`);
  chart.setAttribute('preserveAspectRatio', 'none');
  const chartEnds = doc.createElement('div');
  chartEnds.className = 'mp-ends';
  const chartStart = doc.createElement('span');
  const chartEnd = doc.createElement('span');
  chartEnds.append(chartStart, chartEnd);
  const chartWords = doc.createElement('p');
  const chartNote = doc.createElement('p');
  chartNote.className = 'mp-note';
  chartPanel.append(chartHead, chart, chartEnds, chartWords, chartNote);
  doc.body.appendChild(chartPanel);
  /** Where the highest and lowest points are, to mark them on the map too. */
  let marks = [];
  let reading = 0;
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
    profile.hidden = points.length < 2;
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
    for (const mark of marks) {
      labels.push({
        id: mark.id,
        position: mark.position,
        variant: 'label',
        title: mark.title,
        accent: COLOR,
        protected: true,
        priority: 8,
      });
    }
    setOverlayEntries(LAYER_NAME, labels, {
      cohortLimit: 64,
      collisionCapacity: 64,
    });
    scene.requestRender();
  };

  const hideProfile = () => {
    reading += 1;
    chartPanel.hidden = true;
    marks = [];
  };

  const element = (name, attributes) => {
    const node = doc.createElementNS(SVG, name);
    for (const [key, value] of Object.entries(attributes))
      node.setAttribute(key, value);
    return node;
  };

  /** Read the heights along the path and draw the chart. */
  const showProfile = async () => {
    const mine = ++reading;
    const samples = pathSamples(points, PROFILE_SAMPLES, closed);
    if (samples.length < 2) return;
    chartPanel.hidden = false;
    chart.replaceChildren();
    chartStart.textContent = '';
    chartEnd.textContent = '';
    chartWords.textContent = 'Reading the heights…';
    chartNote.textContent = '';
    const spots = samples.map((sample) =>
      Cesium.Cartographic.fromDegrees(sample.lon, sample.lat),
    );
    let heights;
    try {
      // The most detailed heights the map has, loading what it needs. Slow
      // links get what is already on screen instead.
      const detailed = await Promise.race([
        scene.sampleHeightMostDetailed(spots.map((spot) => spot.clone())),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('slow')), 15_000),
        ),
      ]);
      heights = detailed.map((spot) => spot.height);
    } catch {
      heights = spots.map((spot) =>
        scene.sampleHeightSupported ? scene.sampleHeight(spot) : undefined,
      );
    }
    if (mine !== reading) return;
    const stats = profileStats(heights);
    const total = samples.at(-1).along;
    if (!stats) {
      chartWords.textContent =
        'This map has no height differences to show along this path.';
      chartNote.textContent = scene.globe.show
        ? 'The satellite map gets its heights from the terrain that comes with the Cesium key.'
        : '';
      return;
    }
    const line = profileLine(heights, stats, CHART.width, CHART.height);
    const x = (index) =>
      6 + ((CHART.width - 12) * index) / (heights.length - 1);
    chart.append(
      element('path', {
        d: line,
        fill: 'none',
        stroke: COLOR,
        'stroke-width': '1.6',
        'vector-effect': 'non-scaling-stroke',
      }),
      element('circle', {
        cx: x(stats.highIndex).toFixed(1),
        cy: '6',
        r: '3.5',
        fill: COLOR,
      }),
      element('circle', {
        cx: x(stats.lowIndex).toFixed(1),
        cy: String(CHART.height - 6),
        r: '3.5',
        fill: 'none',
        stroke: COLOR,
        'stroke-width': '1.5',
      }),
    );
    chartStart.textContent = 'Start';
    chartEnd.textContent = distanceLabel(total);
    chartWords.textContent = `The highest point is ${distanceLabel(stats.rise)} above the lowest. Highest ${whereAlong(samples[stats.highIndex].along, total)}, lowest ${whereAlong(samples[stats.lowIndex].along, total)}.`;
    chartNote.textContent = scene.globe.show
      ? 'Heights are bare ground, compared with the lowest point on the path.'
      : 'Heights are the scanned surface, so roofs and treetops count. They are compared with the lowest point on the path.';
    const at = (index) =>
      Cesium.Cartesian3.fromRadians(
        spots[index].longitude,
        spots[index].latitude,
        heights[index] + 2,
      );
    marks = [
      {
        id: 'high',
        position: at(stats.highIndex),
        title: `Highest +${distanceLabel(stats.rise)}`,
      },
      { id: 'low', position: at(stats.lowIndex), title: 'Lowest' },
    ];
    draw();
  };

  const isMine = (picked) =>
    picked?.id?.entityCollection?.owner?.name === LAYER_NAME;

  const onClick = (click) => {
    if (!measuring || closed) return;
    hideProfile();
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
    hideProfile();
    profile.hidden = true;
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
    hideProfile();
    // A closed shape opens again; otherwise the last point goes.
    if (closed) closed = false;
    else points.pop();
    if (points.length === 0) wipe();
    else draw();
  });
  close.addEventListener('click', () => {
    if (points.length < 3) return;
    hideProfile();
    closed = true;
    draw();
  });
  clear.addEventListener('click', wipe);
  profile.addEventListener('click', showProfile);
  chartClose.addEventListener('click', () => {
    hideProfile();
    draw();
  });
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
    chartPanel.remove();
    style.remove();
  };
}
