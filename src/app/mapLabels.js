import * as Cesium from 'cesium';
import { resolveImageryHost } from '../maps/imageryHost.js';

/**
 * Place and road names drawn over the map, with one toolbar switch.
 *
 * Two keyless Esri reference layers (the same host and terms as the Esri
 * satellite basemap): roads underneath, places and borders on top. They are
 * draped on whichever surface the active map uses: the globe, or the 3D
 * tileset.
 */

const STORAGE_KEY = 'gev.mapLabels';
const SYNC_MS = 1000;
const ESRI = 'https://services.arcgisonline.com/ArcGIS/rest/services';
// Bottom to top.
const SOURCES = [
  `${ESRI}/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}`,
  `${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`,
];
const TIP_ON = 'Hide place and road labels';
const TIP_OFF = 'Show place and road labels';

function readSaved() {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function save(on) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, on ? '1' : '0');
  } catch {
    // Private windows may refuse storage; the switch still works this visit.
  }
}

/**
 * @param {{ viewer: Cesium.Viewer, tileset?: object }} scene
 * @param {Document} [doc]
 * @returns {() => void} Removes the labels, the switch and the timer.
 */
export function installMapLabels({ viewer, tileset }, doc = document) {
  let on = readSaved();
  let host = null;
  let layers = [];

  const clear = () => {
    if (host && !host.isDestroyed?.()) {
      for (const layer of layers) host.remove(layer, true);
    }
    host = null;
    layers = [];
  };

  // The map source can change under us (satellite globe <-> 3D buildings),
  // and other layers add imagery later, so this re-checks on a slow timer.
  const sync = () => {
    if (viewer.isDestroyed()) return;
    const wanted = on
      ? resolveImageryHost({ viewer, tileset }).collection
      : null;
    if (wanted !== host) {
      clear();
      host = wanted;
      if (host) {
        layers = SOURCES.map((url) =>
          host.addImageryProvider(
            new Cesium.UrlTemplateImageryProvider({
              url,
              maximumLevel: 19,
              credit: 'Labels © Esri and its data providers',
            }),
          ),
        );
      }
      viewer.scene.requestRender();
    }
    if (
      host &&
      layers.some(
        (layer, i) => host.indexOf(layer) !== host.length - layers.length + i,
      )
    ) {
      for (const layer of layers) host.raiseToTop(layer);
      viewer.scene.requestRender();
    }
  };

  const button = doc.createElement('button');
  button.id = 'map-labels-toggle';
  button.type = 'button';
  button.textContent = 'Aa';
  button.setAttribute('aria-label', 'Place and road labels');
  const paint = () => {
    button.setAttribute('aria-pressed', String(on));
    button.title = on ? TIP_ON : TIP_OFF;
  };
  button.addEventListener('click', () => {
    on = !on;
    save(on);
    paint();
    sync();
  });
  paint();
  doc.getElementById('top-center-actions')?.appendChild(button);

  sync();
  const timer = setInterval(sync, SYNC_MS);

  return () => {
    clearInterval(timer);
    clear();
    button.remove();
  };
}
