import * as Cesium from 'cesium';
import {
  clearOverlaySource,
  setOverlayEntries,
} from '../overlays/worldOverlay.js';
import { guard } from './addOns.js';
import { closeOnEscape } from './escapeKey.js';

/**
 * Space view and the Moon.
 *
 * SPACE VIEW (a row in the LAYERS menu) switches on the original's
 * Satellites layer and its Celestial ring, and flies out until the Earth,
 * the satellites round it and the Moon are all in the window, the Moon off
 * to one side. Cesium draws the real Moon at its real distance, lit by the
 * Sun at its real phase. Pressing it again flies back to where the view was
 * and puts both switches back as they were.
 *
 * THE MOON: a click on the Moon in space view, the Fly to the Moon button,
 * a search for "Moon" or the voice command "go to the Moon" flies there.
 * Then dragging turns round the Moon (right-drag, or Ctrl or Shift with a
 * drag, tilts and turns the view) and scrolling zooms in to its surface with
 * no zoom limit. Back to Earth (or "back to Earth", or a search for "Earth")
 * returns to where the view was.
 *
 * Close up, Cesium's own Moon picture (256 pixels wide) is a blur. Cesium
 * Moon Terrain (a 3D model of the whole Moon on Cesium ion) is tried first,
 * with the app's own ion token; an ion account only opens it once it has
 * been added from ion's Asset Depot. Otherwise NASA's CGI Moon Kit map
 * (public domain) is used, fetched through Zenith's own server
 * (server/alon/moonMap.js). The bar under the toolbar says which one shows.
 *
 * The six places where Apollo astronauts landed are marked, each with a box
 * like a target box when clicked.
 */

export const MOON_RADIUS_M = 1_737_400;
export const EARTH_RADIUS_M = 6_371_000;
export const MOON_TERRAIN_ASSET = 2684829;
export const MOON_MAP_ROUTE = '/api/alon/moon-map';
/**
 * Earthshine: sunlight the Earth throws back onto the Moon. It lights the
 * Moon's night side faintly, so close up the night side is dim instead of
 * black. A share of the map's own colour, added wherever the Sun is.
 */
export const EARTHSHINE = 0.25;
export const EARTHSHINE_SOURCE = `czm_material czm_getMaterial(czm_materialInput materialInput) {
  czm_material material = czm_getDefaultMaterial(materialInput);
  vec3 colour = texture(image, materialInput.st).rgb;
  material.diffuse = colour;
  material.emission = colour * earthshine;
  return material;
}`;
/** Space view's camera: this far behind the Earth, away from the Moon... */
const BACK_M = 120_000_000;
/** ...and this far to one side, so the Moon is not hidden behind the Earth. */
const SIDE_M = 60_000_000;
/** How much more the view leans towards the Earth than the Moon. */
const EARTH_SHARE = 0.6;
/**
 * Arriving at the Moon: straight down on the side that faces the Earth, high
 * enough for the whole Moon to fit in the window.
 */
export const ARRIVE = Object.freeze({
  lat: 0,
  lon: 0,
  height: 4_500_000,
  heading: 0,
  pitch: -90,
});
/** The lowest the camera goes: the ground, not a zoom limit. */
const GROUND_M = 2;
const FLY_MS = 4000;
const CYAN = '#00f6ff';
const OVERLAY = 'alon-apollo';
/** In space view the Moon is a few pixels across: its name shows where it is. */
const MOON_LABEL = 'alon-moon';

/**
 * Where the Apollo lunar modules landed: NASA's NSSDC table, measured on
 * Lunar Reconnaissance Orbiter images (Mean Earth/Polar Axis, degrees).
 * Apollo 13 did not land.
 */
export const APOLLO_SITES = Object.freeze([
  {
    mission: 'Apollo 11',
    place: 'Tranquility Base, Sea of Tranquillity',
    landed: '20 July 1969',
    lat: 0.67416,
    lon: 23.47314,
  },
  {
    mission: 'Apollo 12',
    place: 'Ocean of Storms',
    landed: '19 November 1969',
    lat: -3.0128,
    lon: -23.4219,
  },
  {
    mission: 'Apollo 14',
    place: 'Fra Mauro highlands',
    landed: '5 February 1971',
    lat: -3.64589,
    lon: -17.47194,
  },
  {
    mission: 'Apollo 15',
    place: 'Hadley Rille, by the Apennine Mountains',
    landed: '30 July 1971',
    lat: 26.13239,
    lon: 3.6333,
  },
  {
    mission: 'Apollo 16',
    place: 'Descartes Highlands',
    landed: '21 April 1972',
    lat: -8.9734,
    lon: 15.5011,
  },
  {
    mission: 'Apollo 17',
    place: 'Taurus-Littrow valley',
    landed: '11 December 1972',
    lat: 20.1911,
    lon: 30.7723,
  },
]);

// Plain vectors, so the camera sums can be tested without a map.
const vec = (x, y, z) => ({ x, y, z });
const add = (a, b) => vec(a.x + b.x, a.y + b.y, a.z + b.z);
const sub = (a, b) => vec(a.x - b.x, a.y - b.y, a.z - b.z);
const scale = (a, k) => vec(a.x * k, a.y * k, a.z * k);
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a, b) =>
  vec(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const length = (a) => Math.sqrt(dot(a, a));
const unit = (a) => scale(a, 1 / length(a));
const RAD = Math.PI / 180;

/**
 * Space view's camera, Earth-centred: behind the Earth as seen from the
 * Moon, off to one side, looking between the two.
 * @param {{ x: number, y: number, z: number }} moon The Moon's centre.
 */
export function spaceViewCamera(moon) {
  const toMoon = unit(moon);
  let side = cross(vec(0, 0, 1), toMoon);
  side = length(side) > 1e-6 ? unit(side) : vec(1, 0, 0);
  const position = add(scale(toMoon, -BACK_M), scale(side, SIDE_M));
  const direction = unit(
    add(
      scale(unit(scale(position, -1)), EARTH_SHARE),
      scale(unit(sub(moon, position)), 1 - EARTH_SHARE),
    ),
  );
  const north = vec(0, 0, 1);
  const up = unit(sub(north, scale(direction, dot(north, direction))));
  return { position, direction, up };
}

/**
 * Where a point shows in a camera's window: x and y from -1 to 1 across it,
 * or null when it is behind the camera.
 */
export function screenSpot(view, point, { fovDeg = 60, aspect = 1.6 } = {}) {
  const to = sub(point, view.position);
  const ahead = dot(to, view.direction);
  if (ahead <= 0) return null;
  const right = cross(view.direction, view.up);
  // Cesium's field of view is across the longer side of the window.
  const t = Math.tan((fovDeg * RAD) / 2);
  const [wide, tall] = aspect >= 1 ? [t, t / aspect] : [t * aspect, t];
  return {
    x: dot(to, right) / ahead / wide,
    y: dot(to, view.up) / ahead / tall,
  };
}

/**
 * The camera over the Moon, in the Moon's own frame (x towards longitude 0,
 * z to its north pole): above a spot, at a height, facing a heading, tilted.
 */
export function moonCameraLocal({ lat, lon, height, heading, pitch }) {
  const la = lat * RAD;
  const lo = lon * RAD;
  const upward = vec(
    Math.cos(la) * Math.cos(lo),
    Math.cos(la) * Math.sin(lo),
    Math.sin(la),
  );
  const east = vec(-Math.sin(lo), Math.cos(lo), 0);
  const north = vec(
    -Math.sin(la) * Math.cos(lo),
    -Math.sin(la) * Math.sin(lo),
    Math.cos(la),
  );
  const local = (e, n, u) =>
    add(add(scale(east, e), scale(north, n)), scale(upward, u));
  const h = heading * RAD;
  const p = pitch * RAD;
  return {
    position: scale(upward, MOON_RADIUS_M + height),
    direction: local(
      Math.cos(p) * Math.sin(h),
      Math.cos(p) * Math.cos(h),
      Math.sin(p),
    ),
    up: local(
      -Math.sin(p) * Math.sin(h),
      -Math.sin(p) * Math.cos(h),
      Math.cos(p),
    ),
  };
}

/** A spot on the Moon in its own frame, this high above the ground. */
export function moonPoint(lat, lon, height = 0) {
  return moonCameraLocal({ lat, lon, height, heading: 0, pitch: -90 }).position;
}

/**
 * A drag over the Moon: the ground follows the pointer, as on the Earth.
 * @param {number} dx Pixels moved right.
 * @param {number} dy Pixels moved down.
 */
export function dragMove(view, dx, dy, { tall, fovyRad }) {
  const perPixel = (2 * view.height * Math.tan(fovyRad / 2)) / tall;
  const h = view.heading * RAD;
  const east = (-dx * Math.cos(h) + dy * Math.sin(h)) * perPixel;
  const north = (dx * Math.sin(h) + dy * Math.cos(h)) * perPixel;
  const lat = Math.max(
    -89.9,
    Math.min(89.9, view.lat + north / MOON_RADIUS_M / RAD),
  );
  let lon = view.lon + east / (MOON_RADIUS_M * Math.cos(view.lat * RAD)) / RAD;
  lon = ((((lon + 180) % 360) + 360) % 360) - 180;
  return { ...view, lat, lon };
}

/** A scroll over the Moon: closer or further by the same share each step. */
export function zoomHeight(height, deltaY) {
  return Math.max(GROUND_M, height * Math.exp(deltaY * 0.0015));
}

/**
 * A scroll with the pointer away from the middle: the camera also moves
 * towards the spot under the pointer (away from it when zooming out), so
 * that spot stays under the pointer, as on the Earth.
 * @param {number} ox Pixels from the middle of the window to the pointer, rightwards.
 * @param {number} oy The same, downwards.
 */
export function zoomAt(view, deltaY, ox, oy, size) {
  const height = zoomHeight(view.height, deltaY);
  const share = 1 - height / view.height;
  return { ...dragMove(view, -ox * share, -oy * share, size), height };
}

/** A right-drag: turn the view and tilt it, never past straight down. */
export function turnTilt(view, dx, dy) {
  return {
    ...view,
    heading: (((view.heading + dx * 0.3) % 360) + 360) % 360,
    pitch: Math.max(-90, Math.min(-5, view.pitch - dy * 0.3)),
  };
}

/**
 * Where the camera is on a flight between two places: round the Earth, not
 * through it. The direction from the Earth's centre turns evenly and the
 * distance from it changes in equal shares, so the path never dips below
 * the nearer end.
 */
export function flightPoint(from, to, t) {
  const eased = t * t * (3 - 2 * t);
  const r0 = length(from);
  const r1 = length(to);
  const a = unit(from);
  const b = unit(to);
  const angle = Math.acos(Math.max(-1, Math.min(1, dot(a, b))));
  let way;
  if (angle < 1e-6) way = a;
  else {
    const s = Math.sin(angle);
    way = add(
      scale(a, Math.sin((1 - eased) * angle) / s),
      scale(b, Math.sin(eased * angle) / s),
    );
  }
  return scale(unit(way), r0 * (r1 / r0) ** eased);
}

/**
 * How long a flight takes: a long trip about 4 seconds, a short one (a flight
 * turned round just after it started) well under one.
 */
export function flightMs(from, to) {
  const far =
    Math.abs(Math.log(length(to) / length(from))) +
    Math.acos(Math.max(-1, Math.min(1, dot(unit(from), unit(to)))));
  return Math.round(500 + (FLY_MS - 500) * Math.min(1, far / 2));
}

/** A point pushed out of a sphere (the Moon) onto its surface, if inside. */
export function clearOf(point, centre, radius) {
  const out = sub(point, centre);
  const far = length(out);
  return far >= radius || far === 0
    ? point
    : add(centre, scale(out, radius / far));
}

/** Text typed in the search box that means the Moon, or the Earth. */
export const meansMoon = (text) =>
  /^\s*(the\s+)?moon\s*$/i.test(String(text ?? ''));
export const meansEarth = (text) =>
  /^\s*(the\s+)?earth\s*$/i.test(String(text ?? ''));

/**
 * A trip away from the Earth and back: what to put back afterwards.
 * @param {{ readView: () => object, getSatellites: () => boolean,
 *   setSatellites: (on: boolean) => void, getCelestial: () => boolean,
 *   setCelestial: (on: boolean) => void }} app
 */
export function createTrip(app) {
  let where = 'earth';
  let saved = null;
  return {
    get where() {
      return where;
    },
    /**
     * Into space view: the Satellites layer on at once (its catalogue takes a
     * moment), the view and both switches remembered.
     */
    space() {
      if (where === 'earth') {
        saved = {
          view: app.readView(),
          satellites: app.getSatellites(),
          celestial: app.getCelestial(),
        };
      } else saved.satellites ??= app.getSatellites();
      saved.celestial ??= app.getCelestial();
      app.setSatellites(true);
      where = 'space';
    },
    /**
     * Arrived out in space: the Celestial ring on. Not before, as the ring
     * switches itself off while the whole Earth is not in the window.
     */
    arrived() {
      if (where === 'space') app.setCelestial(true);
    },
    /** To the Moon: from the Earth, only the view is remembered. */
    moon() {
      if (where === 'earth') saved = { view: app.readView() };
      where = 'moon';
    },
    /** Back: the view to fly to, with the switches put back as they were. */
    earth() {
      if (where === 'earth') return null;
      const back = saved;
      saved = null;
      where = 'earth';
      // Always set, not only when they look different: a layer still loading
      // reads as off, and would otherwise be left on.
      if (typeof back.satellites === 'boolean')
        app.setSatellites(back.satellites);
      if (typeof back.celestial === 'boolean') app.setCelestial(back.celestial);
      return back.view;
    },
  };
}

/** Why Cesium Moon Terrain could not be used, for the bar under the toolbar. */
export function terrainReason(error, hasToken) {
  if (!hasToken) return 'no Cesium ion token is set';
  const status = error?.statusCode;
  if (status === 404)
    return 'it is not in this Cesium ion account: add it from the ion Asset Depot';
  if (status === 401 || status === 403)
    return "this Cesium ion account's token cannot open it";
  return 'Cesium ion could not be reached';
}

const ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="10" cy="14" r="5"/><ellipse cx="10" cy="14" rx="9.2" ry="3.2" transform="rotate(-18 10 14)"/><circle cx="19.5" cy="4.8" r="2.1" fill="currentColor" stroke="none"/></svg>';

const STYLE = `
#space-view-bar {
  position: fixed; top: var(--zenith-panel-top, 92px); left: 50%; transform: translateX(-50%); z-index: 120;
  display: none; align-items: center; gap: 10px; flex-wrap: wrap; justify-content: center;
  max-width: calc(100vw - 32px); padding: 6px 12px; border: 1px solid rgba(0,246,255,.4); border-radius: 10px;
  background: rgba(2,10,16,.88); color: #dff8ff; font: 11px/1.4 var(--font-mono, ui-monospace, monospace);
}
#space-view-bar.open { display: flex; }
body.ui-clean-view #space-view-bar { display: none; }
#space-view-bar .sv-where { color: ${CYAN}; font-weight: 700; letter-spacing: .16em; }
#space-view-bar .sv-surface { opacity: .7; font-size: 10px; }
#space-view-bar button, #zenith-layers-menu .sv-moon {
  padding: 3px 10px; border: 1px solid rgba(0,246,255,.5); border-radius: 6px; background: rgba(0,246,255,.08);
  color: ${CYAN}; font: 700 10px/1.4 var(--font-mono, monospace); letter-spacing: .08em; cursor: pointer;
}
#space-view-bar button[hidden], #zenith-layers-menu .sv-moon[hidden] { display: none; }
#apollo-box { position: fixed; inset: 0; pointer-events: none; z-index: 150; display: none; }
#apollo-box.open { display: block; }
#apollo-box svg { position: absolute; overflow: visible; }
#apollo-box path { fill: none; stroke: ${CYAN}; stroke-width: 2.5; filter: drop-shadow(0 0 4px rgba(0,246,255,.8)); }
#apollo-box-panel {
  position: absolute; pointer-events: auto; width: 250px; max-width: calc(100vw - 32px); padding: 0 0 8px;
  border: 1px solid rgba(0,246,255,.55); border-radius: 4px; background: rgba(2,10,16,.92); color: #dff8ff;
  box-shadow: 0 0 18px rgba(0,246,255,.25); font: 12px/1.45 var(--font-mono, ui-monospace, monospace);
}
#apollo-box-panel .ab-head {
  display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 5px 8px 5px 10px;
  border-bottom: 1px solid rgba(0,246,255,.4); background: rgba(0,246,255,.12); color: ${CYAN};
  font-weight: 700; letter-spacing: .08em; font-size: 11px;
}
#apollo-box-panel .ab-head button {
  width: 22px; height: 22px; padding: 0; border: 1px solid rgba(0,246,255,.45); border-radius: 3px;
  background: transparent; color: inherit; font: 13px/1 var(--font-mono, monospace); cursor: pointer;
}
#apollo-box-panel .ab-rows { padding: 6px 10px 0; }
#apollo-box-panel .ab-title { color: #fff; font-weight: 700; font-size: 13px; }
#apollo-box-panel .ab-faint { opacity: .65; font-size: 11px; }
`;

/**
 * @param {{ viewer: Cesium.Viewer }} scene
 * @param {{ dataManager?: object, styleManager?: object, cesiumToken?: string }} [parts]
 * @param {Document} [doc]
 * @returns {() => void}
 */
export function installSpaceView(
  { viewer },
  { dataManager, styleManager, cesiumToken = '' } = {},
  doc = document,
) {
  const { scene, camera } = viewer;
  const win = doc.defaultView ?? window;
  const canvas = scene.canvas;
  const controller = scene.screenSpaceCameraController;

  const style = doc.createElement('style');
  style.id = 'space-view-style';
  style.textContent = STYLE;
  doc.head.appendChild(style);
  const element = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  // The Moon's frame (its centre and how it is turned), worked out exactly
  // as Cesium's own Moon is drawn, at the map's clock time.
  const axes = new Cesium.IauOrientationAxes();
  const icrfToFixed = new Cesium.Matrix3();
  let frame = null;
  let frameTime = null;
  // Until Cesium's Earth-orientation data has loaded, it turns the sky with
  // a rougher sum, about 0.4 degrees out (2,400 km at the Moon). A frame
  // worked out with it is not kept: Cesium's Moon moves to the exact place
  // as soon as the data arrives.
  let rough = true;
  Promise.resolve(
    Cesium.Transforms.preloadIcrfFixed?.(
      new Cesium.TimeInterval({
        start: Cesium.JulianDate.addDays(
          viewer.clock.currentTime,
          -1,
          new Cesium.JulianDate(),
        ),
        stop: Cesium.JulianDate.addDays(
          viewer.clock.currentTime,
          30,
          new Cesium.JulianDate(),
        ),
      }),
    ),
  ).catch(() => {});
  const moonFrame = () => {
    const time = viewer.clock.currentTime;
    if (frame && !rough && Cesium.JulianDate.equals(time, frameTime))
      return frame;
    rough = !Cesium.defined(
      Cesium.Transforms.computeIcrfToFixedMatrix(time, icrfToFixed),
    );
    if (rough)
      Cesium.Transforms.computeTemeToPseudoFixedMatrix(time, icrfToFixed);
    const rotation = axes.evaluate(time, new Cesium.Matrix3());
    Cesium.Matrix3.transpose(rotation, rotation);
    Cesium.Matrix3.multiply(icrfToFixed, rotation, rotation);
    const centre =
      Cesium.Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame(
        time,
        new Cesium.Cartesian3(),
      );
    Cesium.Matrix3.multiplyByVector(icrfToFixed, centre, centre);
    frame = Cesium.Matrix4.fromRotationTranslation(rotation, centre);
    frameTime = Cesium.JulianDate.clone(time);
    return frame;
  };
  const moonCentre = () =>
    Cesium.Matrix4.getTranslation(moonFrame(), new Cesium.Cartesian3());
  const worldPoint = (p) =>
    Cesium.Matrix4.multiplyByPoint(
      moonFrame(),
      new Cesium.Cartesian3(p.x, p.y, p.z),
      new Cesium.Cartesian3(),
    );
  const worldVector = (p) =>
    Cesium.Matrix4.multiplyByPointAsVector(
      moonFrame(),
      new Cesium.Cartesian3(p.x, p.y, p.z),
      new Cesium.Cartesian3(),
    );
  const plain = (c) => vec(c.x, c.y, c.z);
  const cartesian = (p) => new Cesium.Cartesian3(p.x, p.y, p.z);

  /** Where a flight home will end, while it is under way. */
  let landing = null;
  // Where the view is: on the way home, where it is going, so a trip started
  // again mid-flight comes back to the right place.
  const readView = () =>
    landing ?? {
      position: plain(camera.positionWC),
      direction: plain(camera.directionWC),
      up: plain(camera.upWC),
    };
  /** Where this add-on last put the camera: anything else moving it shows. */
  let placed = null;
  // Set directly: Cesium's setView goes through heading, pitch and roll, and
  // loses the roll when the view looks along the Earth's up.
  const setView = (view) => {
    const direction = Cesium.Cartesian3.normalize(
      cartesian(view.direction),
      new Cesium.Cartesian3(),
    );
    const up = Cesium.Cartesian3.normalize(
      cartesian(view.up),
      new Cesium.Cartesian3(),
    );
    camera.position = cartesian(view.position);
    camera.direction = direction;
    camera.up = up;
    camera.right = Cesium.Cartesian3.normalize(
      Cesium.Cartesian3.cross(direction, up, new Cesium.Cartesian3()),
      new Cesium.Cartesian3(),
    );
    placed = Cesium.Cartesian3.clone(camera.position);
    scene.requestRender();
  };

  const visual = styleManager?._visualSettings ?? styleManager;
  const trip = createTrip({
    readView,
    getSatellites: () => Boolean(dataManager?.isEnabled?.('satellites')),
    setSatellites: (on) =>
      Promise.resolve(
        dataManager?.setEnabled?.('satellites', on, { origin: 'user' }),
      ).catch((error) =>
        console.warn('[space-view] satellites', error?.message || error),
      ),
    getCelestial: () => Boolean(visual?.celestialRingEnabled),
    setCelestial: (on) => visual?.setCelestialRingEnabled?.(on),
  });

  // Flights: round the Earth, the turn of the view eased to match.
  let flight = null;
  let inputsBefore = null;
  const holdInputs = () => {
    inputsBefore ??= controller.enableInputs;
    controller.enableInputs = false;
  };
  const freeInputs = () => {
    if (inputsBefore !== null) controller.enableInputs = inputsBefore;
    inputsBefore = null;
  };
  const fly = (to, done) => {
    viewer.trackedEntity = undefined;
    camera.cancelFlight();
    camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    if (flight) win.cancelAnimationFrame(flight.frame);
    holdInputs();
    const from = {
      position: plain(camera.positionWC),
      direction: plain(camera.directionWC),
      up: plain(camera.upWC),
    };
    const still = win.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const ms = flightMs(from.position, to.position);
    // Round the Moon as well as the Earth: a flight from its far side would
    // otherwise go through it. Never lower than either end of the flight.
    const moon = plain(moonCentre());
    const above = (p) => length(sub(p, moon)) - MOON_RADIUS_M;
    const low = Math.min(above(from.position), above(to.position));
    const keep =
      low < 20 * MOON_RADIUS_M
        ? MOON_RADIUS_M + Math.max(0, Math.min(500_000, low))
        : 0;
    const started = performance.now();
    const step = () => {
      try {
        const t = still ? 1 : Math.min(1, (performance.now() - started) / ms);
        const eased = t * t * (3 - 2 * t);
        const blend = (a, b) => unit(add(scale(a, 1 - eased), scale(b, eased)));
        const direction = blend(from.direction, to.direction);
        let up = blend(from.up, to.up);
        up = unit(sub(up, scale(direction, dot(up, direction))));
        setView({
          position: clearOf(
            flightPoint(from.position, to.position, t),
            moon,
            keep,
          ),
          direction,
          up,
        });
        if (t < 1) {
          flight.frame = win.requestAnimationFrame(guard('Space view', step));
          return;
        }
        flight = null;
        done();
      } catch (error) {
        // A flight that breaks must not leave the Earth's controls off.
        flight = null;
        freeInputs();
        throw error;
      }
    };
    flight = { frame: 0 };
    step();
  };

  // The view over the Moon, and the Apollo sites seen from it.
  let moonView = { ...ARRIVE };
  const sites = scene.primitives.add(new Cesium.PointPrimitiveCollection());
  sites.show = false;
  const siteColor = Cesium.Color.fromCssColorString(CYAN);
  APOLLO_SITES.forEach((site, index) =>
    sites.add({
      id: { apolloSite: index },
      position: Cesium.Cartesian3.ZERO,
      pixelSize: 9,
      color: siteColor,
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 2,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    }),
  );
  /** Each site's place, and whether it faces the camera. */
  const showSites = (on) => {
    sites.show = on;
    if (!on) {
      clearOverlaySource(OVERLAY);
      return;
    }
    const centre = moonCentre();
    const eye = camera.positionWC;
    const labels = [];
    APOLLO_SITES.forEach((site, index) => {
      const at = worldPoint(moonPoint(site.lat, site.lon));
      const point = sites.get(index);
      point.position = at;
      const outward = Cesium.Cartesian3.subtract(
        at,
        centre,
        new Cesium.Cartesian3(),
      );
      const toEye = Cesium.Cartesian3.subtract(
        eye,
        at,
        new Cesium.Cartesian3(),
      );
      point.show = Cesium.Cartesian3.dot(outward, toEye) > 0;
      if (point.show)
        labels.push({
          id: `apollo:${index}`,
          position: at,
          variant: 'label',
          title: site.mission,
          accent: CYAN,
          priority: 6,
        });
    });
    setOverlayEntries(OVERLAY, labels, {
      cohortLimit: APOLLO_SITES.length,
      collisionCapacity: APOLLO_SITES.length,
    });
  };
  /** The camera over the Moon, kept above the 3D terrain when that shows. */
  const placeOverMoon = () => {
    const local = moonCameraLocal(moonView);
    setView({
      position: plain(worldPoint(local.position)),
      direction: plain(worldVector(local.direction)),
      up: plain(worldVector(local.up)),
    });
    showSites(true);
    keepSiteBox();
    // For the browser checks: how high over the Moon the camera is.
    doc.body.dataset.moonHeight = String(Math.round(moonView.height));
  };

  // Cesium's Moon keeps its picture in a material; the earthshine one keeps
  // the same `image` setting, which Cesium updates on every frame.
  let ownMoonMaterial = null;
  const lightNightSide = () => {
    const primitive = scene.moon?._ellipsoidPrimitive;
    if (!primitive || ownMoonMaterial) return;
    ownMoonMaterial = primitive.material;
    primitive.material = new Cesium.Material({
      translucent: false,
      fabric: {
        uniforms: { image: scene.moon.textureUrl, earthshine: EARTHSHINE },
        source: EARTHSHINE_SOURCE,
      },
    });
  };

  // The sharp surface: Cesium Moon Terrain, else NASA's map.
  let terrain = null;
  let surface = null;
  const surfaceNote = element('span', 'sv-surface');
  const loadSurface = () =>
    (surface ??= (async () => {
      let reason = terrainReason(null, Boolean(cesiumToken));
      if (cesiumToken) {
        try {
          const resource = await Cesium.IonResource.fromAssetId(
            MOON_TERRAIN_ASSET,
            { accessToken: cesiumToken },
          );
          const tileset = await Cesium.Cesium3DTileset.fromUrl(resource);
          tileset.modelMatrix = Cesium.Matrix4.clone(moonFrame());
          terrain = scene.primitives.add(tileset);
          // Only drawn (and only loading tiles) while over the Moon.
          terrain.show = trip.where === 'moon';
          return { kind: 'terrain', said: 'Surface: Cesium Moon Terrain (3D)' };
        } catch (error) {
          reason = terrainReason(error, true);
        }
      }
      try {
        // Loaded as a picture, the way Cesium loads its own: the picture's
        // width says which of NASA's maps the server had.
        const size = await new Promise((resolve, reject) => {
          const picture = new Image();
          picture.onload = () => resolve(picture.naturalWidth);
          picture.onerror = () => reject(new Error('no map'));
          picture.src = MOON_MAP_ROUTE;
        });
        if (scene.moon) scene.moon.textureUrl = MOON_MAP_ROUTE;
        scene.requestRender();
        return {
          kind: size >= 8192 ? 'nasa-8k' : 'nasa-2k',
          said: `Surface: NASA CGI Moon Kit map, ${size} pixels wide (Cesium Moon Terrain: ${reason})`,
        };
      } catch {
        return {
          kind: 'cesium',
          said: "Surface: Cesium's own Moon picture (NASA's map could not be fetched)",
        };
      }
    })().then((result) => {
      if (result.kind !== 'terrain') lightNightSide();
      surfaceNote.textContent = result.said;
      doc.body.dataset.moonSurface = result.kind;
      return result;
    }));

  // The bar under the toolbar, and the row's extra button.
  const bar = element('div');
  bar.id = 'space-view-bar';
  bar.setAttribute('role', 'region');
  bar.setAttribute('aria-label', 'Space view');
  const whereText = element('span', 'sv-where');
  const toMoonButton = element('button', '', 'Fly to the Moon');
  toMoonButton.type = 'button';
  toMoonButton.id = 'space-view-moon';
  const toEarthButton = element('button', '', 'Back to Earth');
  toEarthButton.type = 'button';
  toEarthButton.id = 'space-view-earth';
  bar.append(whereText, toMoonButton, toEarthButton, surfaceNote);
  doc.body.appendChild(bar);
  const rowMoon = element('button', 'sv-moon', 'Moon');
  rowMoon.type = 'button';
  rowMoon.id = 'space-view-row-moon';
  rowMoon.title = 'Fly to the Moon';
  rowMoon.hidden = true;

  const toggle = doc.createElement('button');
  toggle.id = 'space-view-toggle';
  toggle.type = 'button';
  toggle.innerHTML = ICON;
  toggle.setAttribute('aria-label', 'Space view');

  const paint = () => {
    const where = trip.where;
    const away = where !== 'earth';
    toggle.setAttribute('aria-pressed', String(away));
    toggle.title = away
      ? 'Back to Earth: the view and switches as they were'
      : 'Space view: the Earth, its satellites and the Moon';
    bar.classList.toggle('open', away);
    whereText.textContent = where === 'moon' ? 'THE MOON' : 'SPACE VIEW';
    toMoonButton.hidden = where === 'moon';
    rowMoon.hidden = where !== 'space';
    // In the LAYERS menu once the menu has taken the switch into its row.
    const row = toggle.closest('.zl-row');
    if (row && rowMoon.parentElement !== row)
      row.insertBefore(rowMoon, row.querySelector('.zl-state'));
    surfaceNote.hidden = where !== 'moon';
    if (away) doc.body.dataset.space = where;
    else delete doc.body.dataset.space;
    if (where !== 'moon') delete doc.body.dataset.moonHeight;
  };

  const nameMoon = (on) => {
    if (!on) {
      clearOverlaySource(MOON_LABEL);
      return;
    }
    setOverlayEntries(
      MOON_LABEL,
      [
        {
          id: 'moon',
          position: moonCentre(),
          variant: 'label',
          title: 'Moon',
          accent: CYAN,
          priority: 8,
        },
      ],
      { cohortLimit: 1, collisionCapacity: 1 },
    );
  };

  const offMoon = () => {
    closeSiteBox();
    showSites(false);
    moonInput(false);
    if (terrain) terrain.show = false;
  };
  const toSpace = () => {
    offMoon();
    trip.space();
    landing = null;
    paint();
    nameMoon(true);
    const view = spaceViewCamera(plain(moonCentre()));
    fly(view, () => {
      freeInputs();
      trip.arrived();
      scene.requestRender();
    });
  };
  const toMoon = () => {
    if (trip.where === 'moon') return;
    trip.moon();
    landing = null;
    moonView = { ...ARRIVE };
    paint();
    nameMoon(false);
    loadSurface();
    const local = moonCameraLocal(moonView);
    fly(
      {
        position: plain(worldPoint(local.position)),
        direction: plain(worldVector(local.direction)),
        up: plain(worldVector(local.up)),
      },
      () => {
        // Over the Moon, this add-on moves the camera: the Earth's own
        // controls would turn it round the Earth instead.
        holdInputs();
        moonInput(true);
        if (terrain) terrain.show = true;
        placeOverMoon();
      },
    );
  };
  const toEarth = () => {
    const view = trip.earth();
    if (!view) return;
    offMoon();
    nameMoon(false);
    paint();
    landing = view;
    fly(view, () => {
      landing = null;
      freeInputs();
      scene.requestRender();
    });
  };

  // Every button works mid-flight too: the flight turns round from where it is.
  toggle.addEventListener('click', () =>
    trip.where === 'earth' ? toSpace() : toEarth(),
  );
  toMoonButton.addEventListener('click', toMoon);
  rowMoon.addEventListener('click', toMoon);
  toEarthButton.addEventListener('click', toEarth);
  const onAsk = (event) => {
    const to = event.detail?.to;
    if (to === 'moon') toMoon();
    else if (to === 'earth') toEarth();
    else if (to === 'space' && trip.where === 'earth') toSpace();
  };
  win.addEventListener('zenith:space', onAsk);

  // A search for the Moon or the Earth (typed, or said as "go to the Moon").
  const onSearch = (event) => {
    if (event.key !== 'Enter' || event.target?.id !== 'location-search') return;
    const text = event.target.value;
    const moon = meansMoon(text);
    if (!moon && !(meansEarth(text) && trip.where !== 'earth')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    event.target.blur?.();
    if (moon) toMoon();
    else toEarth();
  };
  win.addEventListener('keydown', onSearch, true);

  // In space view, a click on the Moon flies there. It is small, so a click
  // near it counts.
  const handler = new Cesium.ScreenSpaceEventHandler(canvas);
  handler.setInputAction((click) => {
    if (trip.where !== 'space' || flight) return;
    const centre = moonCentre();
    const at = Cesium.SceneTransforms.worldToWindowCoordinates(scene, centre);
    if (!at) return;
    const distance = Cesium.Cartesian3.distance(camera.positionWC, centre);
    const fovy = camera.frustum.fovy ?? Math.PI / 3;
    const radius =
      (MOON_RADIUS_M / distance / Math.tan(fovy / 2)) *
      (canvas.clientHeight / 2);
    if (
      Math.hypot(at.x - click.position.x, at.y - click.position.y) <=
      Math.max(18, radius + 10)
    )
      toMoon();
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  // Over the Moon: drag, right-drag and scroll move round it. The events are
  // kept from the Earth's controls and the other add-ons' map clicks.
  const onMoon = () => trip.where === 'moon' && !flight;
  const fromMap = (event) => event.target === canvas;
  let drag = null;
  const tall = () => canvas.clientHeight || 600;
  const fovy = () => camera.frustum.fovy ?? Math.PI / 3;
  const onDown = (event) => {
    if (!onMoon() || !fromMap(event)) return;
    event.stopImmediatePropagation();
    event.preventDefault();
    drag = {
      x: event.clientX,
      y: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
      at: performance.now(),
      turn: event.button === 2 || event.ctrlKey || event.shiftKey,
    };
  };
  const onMove = (event) => {
    if (!drag || !onMoon()) return;
    event.stopImmediatePropagation();
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    drag.x = event.clientX;
    drag.y = event.clientY;
    if (!dx && !dy) return;
    moonView = drag.turn
      ? turnTilt(moonView, dx, dy)
      : dragMove(moonView, dx, dy, { tall: tall(), fovyRad: fovy() });
    placeOverMoon();
  };
  const onUp = (event) => {
    if (!drag) return;
    const was = drag;
    drag = null;
    if (!onMoon()) return;
    event.stopImmediatePropagation();
    const still =
      Math.hypot(event.clientX - was.startX, event.clientY - was.startY) < 5 &&
      performance.now() - was.at < 500;
    if (still && !was.turn) {
      // The nearest site within a fingertip of the click: picking through
      // Cesium misses points this far from the Earth.
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      let best = null;
      APOLLO_SITES.forEach((site, index) => {
        const point = sites.get(index);
        if (!point.show) return;
        const at = Cesium.SceneTransforms.worldToWindowCoordinates(
          scene,
          point.position,
        );
        const away = at ? Math.hypot(at.x - x, at.y - y) : Infinity;
        if (away <= 14 && (!best || away < best.away)) best = { index, away };
      });
      if (best) openSiteBox(best.index);
    }
  };
  const groundHeight = () => {
    // Over the 3D terrain, the ground is found under the camera; NASA's map
    // and Cesium's picture lie on the smooth sphere.
    if (!terrain?.show) return 0;
    const eye = camera.positionWC;
    const down = Cesium.Cartesian3.normalize(
      Cesium.Cartesian3.subtract(moonCentre(), eye, new Cesium.Cartesian3()),
      new Cesium.Cartesian3(),
    );
    const hit = scene.pickFromRay(new Cesium.Ray(eye, down), [sites]);
    if (!hit?.position) return 0;
    return (
      Cesium.Cartesian3.distance(hit.position, moonCentre()) - MOON_RADIUS_M
    );
  };
  const onWheel = (event) => {
    if (!onMoon() || !fromMap(event)) return;
    event.stopImmediatePropagation();
    event.preventDefault();
    const lines = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? 800 : 1;
    const rect = canvas.getBoundingClientRect();
    const wanted = zoomAt(
      moonView,
      event.deltaY * lines,
      event.clientX - rect.left - rect.width / 2,
      event.clientY - rect.top - rect.height / 2,
      { tall: tall(), fovyRad: fovy() },
    );
    const floor =
      wanted.height < 50_000 && event.deltaY < 0
        ? groundHeight() + GROUND_M
        : -Infinity;
    moonView = { ...wanted, height: Math.max(wanted.height, floor) };
    placeOverMoon();
  };
  const onContextMenu = (event) => {
    if (onMoon() && fromMap(event)) event.preventDefault();
  };
  // Safari's two-finger twist turns the Earth view (rotateGestures.js).
  const onGesture = (event) => {
    if (onMoon() && fromMap(event)) {
      event.stopImmediatePropagation();
      event.preventDefault();
    }
  };
  // Listened for only while over the Moon: a page-wide wheel listener that
  // can stop scrolling slows every scroll on the page.
  let listening = false;
  const moonInput = (on) => {
    if (on === listening) return;
    listening = on;
    drag = null;
    const how = on ? 'addEventListener' : 'removeEventListener';
    win[how]('pointerdown', onDown, true);
    win[how]('pointermove', onMove, true);
    win[how]('pointerup', onUp, true);
    win[how]('wheel', onWheel, { capture: true, passive: false });
    win[how]('contextmenu', onContextMenu, true);
    win[how]('gesturestart', onGesture, true);
    win[how]('gesturechange', onGesture, true);
  };

  // Anything that changes the map's clock moves the Moon: everything
  // placed on it follows.
  const offClock = scene.preRender.addEventListener(
    guard('Space view', () => {
      // Something else moved the camera while over the Moon (a place search,
      // a saved place, voice "zoom in"): the Moon is left where it is, with
      // the Earth's controls and both switches back.
      if (
        onMoon() &&
        placed &&
        Cesium.Cartesian3.distance(camera.positionWC, placed) > 1
      ) {
        trip.earth();
        offMoon();
        paint();
        freeInputs();
        return;
      }
      if (
        frame &&
        (rough ||
          !Cesium.JulianDate.equals(viewer.clock.currentTime, frameTime))
      ) {
        moonFrame();
        if (terrain) terrain.modelMatrix = Cesium.Matrix4.clone(frame);
        if (onMoon()) placeOverMoon();
      }
    }),
  );

  // A box like a target box for an Apollo site.
  const box = element('div');
  box.id = 'apollo-box';
  const svgNs = 'http://www.w3.org/2000/svg';
  const corners = doc.createElementNS(svgNs, 'svg');
  corners.setAttribute('aria-hidden', 'true');
  corners.setAttribute('width', '44');
  corners.setAttribute('height', '44');
  const cornerPath = doc.createElementNS(svgNs, 'path');
  cornerPath.setAttribute('d', 'M0 11V0H11M33 0H44V11M44 33V44H33M11 44H0V33');
  corners.appendChild(cornerPath);
  const panel = element('div');
  panel.id = 'apollo-box-panel';
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-label', 'Apollo landing site');
  const head = element('div', 'ab-head');
  const headText = element('span');
  const close = element('button', '', '×');
  close.type = 'button';
  close.title = 'Close (Escape)';
  close.setAttribute('aria-label', 'Close the landing site box');
  head.append(headText, close);
  const rows = element('div', 'ab-rows');
  rows.setAttribute('role', 'status');
  panel.append(head, rows);
  box.append(corners, panel);
  doc.body.appendChild(box);
  let siteOpen = null;
  const keepSiteBox = () => {
    if (siteOpen === null) return;
    const point = sites.get(siteOpen);
    const at =
      point.show &&
      Cesium.SceneTransforms.worldToWindowCoordinates(scene, point.position);
    if (!at) {
      corners.style.display = 'none';
      return;
    }
    corners.style.display = '';
    corners.style.left = `${at.x - 22}px`;
    corners.style.top = `${at.y - 22}px`;
    const width = panel.offsetWidth || 250;
    let left = at.x + 36;
    if (left + width > win.innerWidth - 16) left = at.x - 36 - width;
    panel.style.left = `${Math.max(16, left)}px`;
    panel.style.top = `${Math.min(Math.max(80, at.y - 22), win.innerHeight - (panel.offsetHeight || 130) - 16)}px`;
  };
  const openSiteBox = (index) => {
    const site = APOLLO_SITES[index];
    siteOpen = index;
    headText.textContent = `${site.mission.toUpperCase()} // LANDING SITE`;
    const line = (text, kind) => element('div', `ab-${kind}`, text);
    const ns = site.lat >= 0 ? 'N' : 'S';
    const ew = site.lon >= 0 ? 'E' : 'W';
    rows.replaceChildren(
      line(site.place, 'title'),
      line(`Landed ${site.landed}`, 'line'),
      line(
        `${Math.abs(site.lat).toFixed(4)}° ${ns}, ${Math.abs(site.lon).toFixed(4)}° ${ew}`,
        'faint',
      ),
      line(
        'Lunar module position: NASA NSSDC, from Lunar Reconnaissance Orbiter pictures',
        'faint',
      ),
    );
    box.classList.add('open');
    keepSiteBox();
  };
  const closeSiteBox = () => {
    siteOpen = null;
    box.classList.remove('open');
  };
  close.addEventListener('click', closeSiteBox);
  const offEscape = closeOnEscape(win, () => siteOpen !== null, closeSiteBox, {
    panel,
    opener: { focus: () => toEarthButton.focus() },
  });

  paint();
  doc.getElementById('top-center-actions')?.appendChild(toggle);
  // The LAYERS menu takes the switch into its row a moment later.
  queueMicrotask(paint);

  return () => {
    if (flight) win.cancelAnimationFrame(flight.frame);
    flight = null;
    if (trip.where !== 'earth') trip.earth();
    moonInput(false);
    freeInputs();
    win.removeEventListener('zenith:space', onAsk);
    win.removeEventListener('keydown', onSearch, true);
    offClock();
    offEscape();
    handler.destroy();
    clearOverlaySource(OVERLAY);
    clearOverlaySource(MOON_LABEL);
    if (!scene.isDestroyed?.()) {
      scene.primitives.remove(sites);
      if (terrain) scene.primitives.remove(terrain);
      const primitive = scene.moon?._ellipsoidPrimitive;
      if (ownMoonMaterial && primitive) {
        primitive.material.destroy?.();
        primitive.material = ownMoonMaterial;
      }
    }
    delete doc.body.dataset.space;
    toggle.remove();
    rowMoon.remove();
    bar.remove();
    box.remove();
    style.remove();
  };
}
