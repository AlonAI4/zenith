import assert from 'node:assert/strict';
import test from 'node:test';

import * as Cesium from 'cesium';

import { CCTV_PRESENTATION } from '../layers/cctv/rendering.js';
import {
  bracketSize,
  cornerBrackets,
  installCameraView,
  nameWasCut,
  viewWedge,
} from './cameraView.js';
import { fakeDocument } from './fakeDom.mjs';

// A5 Kilburn High Rd / Willesden Ln, as the camera layer gives it.
const KILBURN = {
  id: 'tfl-a5-kilburn',
  name: 'A5 Kilburn High Rd/Willesden Ln',
  lat: 51.5417,
  lon: -0.1977,
  headingDeg: 90,
  fovDeg: 44,
  rangeM: 145,
  elevationM: 74,
  mountHeightM: 6,
};

const metres = ([lon, lat], [lon0, lat0]) => {
  const kx = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  return Math.hypot((lon - lon0) * kx, (lat - lat0) * 111_320);
};

test('viewWedge runs from the camera out to its range across its view and back', () => {
  const ring = viewWedge(KILBURN, 16);
  assert.equal(ring.length, 16 + 3);
  assert.deepEqual(ring[0], [KILBURN.lon, KILBURN.lat]);
  assert.deepEqual(ring.at(-1), ring[0]);
  const here = ring[0];
  for (const point of ring.slice(1, -1)) {
    assert.ok(Math.abs(metres(point, here) - 145) < 0.5);
  }
  // Heading 90 looks east: the middle of the arc is due east of the camera.
  const middle = ring[1 + 8];
  assert.ok(middle[0] > here[0]);
  assert.ok(Math.abs(middle[1] - here[1]) < 1e-9);
  // The two edges sit 22 degrees either side of east, measured in metres.
  const squash = Math.cos((here[1] * Math.PI) / 180);
  const side = (point) =>
    (Math.atan2(point[1] - here[1], (point[0] - here[0]) * squash) * 180) /
    Math.PI;
  assert.ok(Math.abs(side(ring[1]) - 22) < 1);
  assert.ok(Math.abs(side(ring[17]) + 22) < 1);
});

test('viewWedge gives nothing for a camera with no usable facing', () => {
  assert.equal(viewWedge({ ...KILBURN, headingDeg: null }), null);
  assert.equal(viewWedge({ ...KILBURN, rangeM: 0 }), null);
  assert.equal(viewWedge({ ...KILBURN, fovDeg: 0 }), null);
  assert.equal(viewWedge({ ...KILBURN, lat: Number.NaN }), null);
});

test('cornerBrackets draws four corners whose arms stay a sensible length', () => {
  const path = cornerBrackets(64, 64);
  assert.equal(path, 'M0 16V0H16M48 0H64V16M64 48V64H48M16 64H0V48');
  assert.ok(cornerBrackets(200, 200).startsWith('M0 22V0H22'));
  assert.ok(cornerBrackets(20, 20).startsWith('M0 8V0H8'));
});

test('bracketSize grows close up and never gets lost or huge', () => {
  assert.equal(bracketSize(100), 90);
  assert.equal(bracketSize(10), 140);
  assert.equal(bracketSize(10_000), 40);
  assert.equal(bracketSize(0), 64);
  assert.equal(bracketSize(undefined), 64);
});

test('nameWasCut is true only for a name longer than a card shows', () => {
  assert.equal(nameWasCut('A5 Kilburn High Rd/Willesden Ln'), true);
  assert.equal(nameWasCut('Kilburn High Rd'), false);
  assert.equal(nameWasCut(null), false);
});

function fakeMap({ hitTest } = {}) {
  const doc = fakeDocument();
  const panel = doc.createElement('div');
  const meta = doc.createElement('div');
  meta.id = 'cctv-meta';
  panel.appendChild(meta);
  doc.body.appendChild(panel);

  const scene = {
    primitives: {
      list: [],
      add(p) {
        this.list.push(p);
        return p;
      },
      remove(p) {
        this.list = this.list.filter((one) => one !== p);
      },
    },
    globe: { show: true },
    preRender: new Cesium.Event(),
    postRender: new Cesium.Event(),
    canvas: { getBoundingClientRect: () => ({ left: 10, top: 20 }) },
    camera: {
      positionWC: Cesium.Cartesian3.fromDegrees(-0.1977, 51.5417, 400),
      directionWC: new Cesium.Cartesian3(),
    },
    screenPoint: new Cesium.Cartesian2(300, 200),
    cartesianToCanvasCoordinates(_, result) {
      return Cesium.Cartesian2.clone(this.screenPoint, result);
    },
    requestRender() {},
    isDestroyed: () => false,
  };
  // Looking straight down at the camera.
  Cesium.Cartesian3.negate(
    Cesium.Cartesian3.normalize(
      scene.camera.positionWC,
      new Cesium.Cartesian3(),
    ),
    scene.camera.directionWC,
  );
  const dataSources = {
    list: [],
    add(source) {
      this.list.push(source);
    },
    remove(source) {
      this.list = this.list.filter((one) => one !== source);
    },
  };
  const tileset = { show: false };
  const viewer = { scene, dataSources, isDestroyed: () => false };

  let listener = null;
  let state = { enabled: true, activeCamera: null };
  const redraws = { count: 0 };
  const cctv = {
    subscribe(callback) {
      listener = callback;
      callback(state);
      return () => {
        listener = null;
      };
    },
    setParams() {
      redraws.count += 1;
    },
  };
  const choose = (camera) => {
    state = { ...state, activeCamera: camera };
    listener?.(state);
  };
  const switchLayer = (enabled) => {
    state = { ...state, enabled };
    listener?.(state);
  };
  const to3d = () => {
    scene.globe.show = false;
    tileset.show = true;
  };
  const stop = installCameraView(
    { viewer, tileset },
    { _cctvControls: { cctv } },
    doc,
    hitTest,
  );
  const lines = dataSources.list[0];
  return {
    doc,
    scene,
    lines,
    meta,
    choose,
    switchLayer,
    redraws,
    to3d,
    stop,
    listening: () => !!listener,
  };
}

test('choosing a camera lights its view on the ground and names it in the panel', () => {
  const { doc, lines, meta, choose, stop } = fakeMap();
  assert.equal(CCTV_PRESENTATION.activeWireframe, false);
  assert.equal(lines.entities.values.length, 0);

  choose(KILBURN);
  const kinds = lines.entities.values.map((e) =>
    e.polygon ? 'fill' : 'outline',
  );
  assert.deepEqual(kinds, ['fill', 'outline']);
  const name = doc.getElementById('zenith-cctv-name');
  assert.equal(name.textContent, KILBURN.name);
  assert.equal(name.hidden, false);
  // Right above the camera's info line.
  const row = meta.parentNode.children;
  assert.equal(row.indexOf(name) + 1, row.indexOf(meta));

  choose(null);
  assert.equal(lines.entities.values.length, 0);
  assert.equal(name.hidden, true);
  stop();
});

test('switching the camera layer off takes the view, the corners and the name away', () => {
  const { doc, scene, lines, choose, switchLayer, stop } = fakeMap();
  choose(KILBURN);
  scene.preRender.raiseEvent();
  switchLayer(false);
  scene.preRender.raiseEvent();
  assert.equal(lines.entities.values.length, 0);
  assert.equal(
    doc.getElementById('zenith-camera-corners').style.display,
    'none',
  );
  assert.equal(doc.getElementById('zenith-cctv-name').hidden, true);
  switchLayer(true);
  assert.equal(lines.entities.values.length, 2);
  stop();
});

test('on the 3D map the view is a light on the buildings, redrawn on a map switch', () => {
  const { scene, lines, choose, to3d, stop } = fakeMap();
  choose(KILBURN);
  assert.equal(scene.primitives.list.length, 0);
  to3d();
  scene.preRender.raiseEvent();
  assert.equal(scene.primitives.list.length, 1);
  assert.ok(scene.primitives.list[0] instanceof Cesium.ClassificationPrimitive);
  assert.equal(lines.entities.values.length, 0);
  stop();
  assert.equal(scene.primitives.list.length, 0);
});

test('a turned camera is redrawn, the same one is not', () => {
  const { scene, choose, to3d, stop } = fakeMap();
  to3d();
  choose(KILBURN);
  const first = scene.primitives.list[0];
  choose({ ...KILBURN });
  assert.equal(scene.primitives.list[0], first);
  let last = first;
  let camera = KILBURN;
  for (const moved of [
    { headingDeg: 120 },
    { lat: KILBURN.lat + 0.001 },
    { lon: KILBURN.lon + 0.001 },
    { mountHeightM: 9 },
  ]) {
    camera = { ...camera, ...moved };
    choose(camera);
    assert.notEqual(scene.primitives.list[0], last, JSON.stringify(moved));
    assert.equal(scene.primitives.list.length, 1);
    last = scene.primitives.list[0];
  }
  stop();
});

test('the corners sit on the chosen camera, and hide when it is behind the view', () => {
  const { doc, scene, choose, stop } = fakeMap();
  const corners = doc.getElementById('zenith-camera-corners');
  choose(KILBURN);
  scene.preRender.raiseEvent();
  assert.equal(corners.style.display, '');
  const size = Number(corners.getAttribute('width'));
  assert.equal(size, bracketSize(400 - KILBURN.elevationM));
  assert.equal(
    corners.style.transform,
    `translate(${10 + 300 - size / 2}px, ${20 + 200 - size / 2}px)`,
  );

  Cesium.Cartesian3.negate(scene.camera.directionWC, scene.camera.directionWC);
  scene.preRender.raiseEvent();
  assert.equal(corners.style.display, 'none');

  // Looking at it from the other side of the Earth, through the planet.
  scene.camera.positionWC = Cesium.Cartesian3.fromDegrees(
    180 + KILBURN.lon,
    -KILBURN.lat,
    20_000_000,
  );
  const where = Cesium.Cartesian3.fromDegrees(
    KILBURN.lon,
    KILBURN.lat,
    KILBURN.elevationM,
  );
  Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.subtract(
      where,
      scene.camera.positionWC,
      new Cesium.Cartesian3(),
    ),
    scene.camera.directionWC,
  );
  scene.preRender.raiseEvent();
  assert.equal(corners.style.display, 'none');
  stop();
});

test('stopping puts the original green wireframe back and takes everything away', () => {
  const { doc, scene, choose, stop, listening, redraws } = fakeMap();
  // The camera layer redraws as soon as the wireframe is swapped, both ways.
  assert.equal(redraws.count, 1);
  choose(KILBURN);
  stop();
  assert.equal(CCTV_PRESENTATION.activeWireframe, true);
  assert.equal(redraws.count, 2);
  assert.equal(listening(), false);
  assert.equal(scene.preRender.numberOfListeners, 0);
  assert.equal(scene.postRender.numberOfListeners, 0);
  for (const id of [
    'zenith-camera-corners',
    'zenith-camera-tip',
    'zenith-cctv-name',
  ]) {
    assert.equal(doc.getElementById(id), null);
  }
});

test('the name tip hides when no cut name is under the pointer, or it leaves', () => {
  const { doc, scene, stop } = fakeMap();
  const win = doc.defaultView;
  const tip = doc.getElementById('zenith-camera-tip');
  const event = (type, extra) => {
    const one = new Event(type);
    for (const [key, value] of Object.entries(extra)) {
      Object.defineProperty(one, key, { value });
    }
    return one;
  };
  const overMap = { clientX: 300, clientY: 200, target: { tagName: 'CANVAS' } };
  tip.hidden = false;
  win.dispatchEvent(event('pointermove', overMap));
  assert.equal(tip.hidden, true);
  // Checked again after a frame, with the pointer where it was.
  tip.hidden = false;
  scene.postRender.raiseEvent();
  assert.equal(tip.hidden, true);
  // Moving between elements is not leaving the window.
  tip.hidden = false;
  win.dispatchEvent(event('pointerout', { relatedTarget: doc.body }));
  assert.equal(tip.hidden, false);
  win.dispatchEvent(event('pointerout', { relatedTarget: null }));
  assert.equal(tip.hidden, true);
  // Over a panel the map is not being pointed at, whatever is beneath it.
  win.dispatchEvent(event('pointermove', overMap));
  tip.hidden = false;
  win.dispatchEvent(
    event('pointermove', { ...overMap, target: { tagName: 'DIV' } }),
  );
  assert.equal(tip.hidden, true);
  scene.postRender.raiseEvent();
  assert.equal(tip.hidden, true);
  stop();
});

test('a card whose name was cut shows the whole name on hover, only over the map', () => {
  // One card, 100 by 80 at (left, 150) on the map's canvas.
  let card = { title: KILBURN.name };
  let left = 200;
  const hitTest = (x, y, { sourceId }) =>
    sourceId === 'cctv' && x >= left && x < left + 100 && y >= 150 && y < 230
      ? { entry: card }
      : null;
  const { doc, scene, stop } = fakeMap({ hitTest });
  const win = doc.defaultView;
  win.innerWidth = 1280;
  const tip = doc.getElementById('zenith-camera-tip');
  const move = (x, y, tagName = 'CANVAS') => {
    const one = new Event('pointermove');
    Object.defineProperty(one, 'clientX', { value: x });
    Object.defineProperty(one, 'clientY', { value: y });
    Object.defineProperty(one, 'target', { value: { tagName } });
    win.dispatchEvent(one);
  };
  // The canvas starts 10 across and 20 down the page.
  move(260, 200);
  assert.equal(tip.hidden, false);
  assert.equal(tip.textContent, KILBURN.name);
  assert.equal(tip.style.left, '274px');
  assert.equal(tip.style.top, '216px');
  // Off the card.
  move(400, 200);
  assert.equal(tip.hidden, true);
  // A panel over the card.
  move(260, 200, 'DIV');
  assert.equal(tip.hidden, true);
  // A name short enough to fit whole needs no tip.
  card = { title: 'Kilburn High Rd' };
  move(260, 200);
  assert.equal(tip.hidden, true);
  // A card that slides under a still pointer is caught after the frame.
  card = { title: KILBURN.name };
  move(400, 200);
  assert.equal(tip.hidden, true);
  left = 350;
  scene.postRender.raiseEvent();
  assert.equal(tip.hidden, false);
  stop();
});

test('with no camera layer there is nothing to do', () => {
  const stop = installCameraView({ viewer: {} }, {}, fakeDocument());
  stop();
  assert.equal(CCTV_PRESENTATION.activeWireframe, true);
});
