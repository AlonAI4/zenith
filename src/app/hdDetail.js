import * as Cesium from 'cesium';

/**
 * An HD switch for the 3D buildings. On, the map asks for finer building
 * tiles sooner and draws at the screen's full resolution. It costs more
 * downloads and more graphics work, so it can be switched off.
 *
 * It cannot add detail the source does not have: very close to the ground the
 * 3D scan itself is the limit.
 *
 * Full resolution on a Retina screen is four times the pixels, which made the
 * map draw about a quarter as many frames while it moved. So while the view
 * moves it draws at the screen's normal resolution, and as soon as it stops it
 * draws sharp again: smooth to move, sharp to look at.
 */

const STORAGE_KEY = 'gev.hdDetail';
/** Cesium's default is 16: a lower number loads sharper tiles from further away. */
const HD_SCREEN_SPACE_ERROR = 8;
const NORMAL_SCREEN_SPACE_ERROR = 16;
/** Full resolution, but never more than two device pixels per CSS pixel. */
const MAX_PIXEL_RATIO = 2;
/** How long the view must stay still before it is drawn sharp again. */
export const SHARP_AFTER_MS = 250;

function readSaved() {
  try {
    // On unless it was switched off.
    return globalThis.localStorage?.getItem(STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

function save(on) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, on ? '1' : '0');
  } catch {
    // Private windows may refuse storage; the switch still works this visit.
  }
}

/** The resolution scale that draws `ratio` device pixels at most `cap` deep. */
export function hdResolutionScale(ratio, cap = MAX_PIXEL_RATIO) {
  const devicePixels = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  return Math.min(devicePixels, cap) / devicePixels;
}

/**
 * @param {{ viewer: Cesium.Viewer, tileset?: Cesium.Cesium3DTileset }} scene
 * @param {Document} [doc]
 * @returns {() => void} Puts the normal detail back and removes the switch.
 */
export function installHdDetail({ viewer, tileset }, doc = document) {
  let on = readSaved();
  let moving = false;
  let still = null;
  const win = doc.defaultView ?? globalThis;

  const apply = () => {
    if (viewer.isDestroyed()) return;
    if (tileset && !tileset.isDestroyed?.()) {
      tileset.maximumScreenSpaceError = on
        ? HD_SCREEN_SPACE_ERROR
        : NORMAL_SCREEN_SPACE_ERROR;
    }
    const sharp = on && !moving;
    if (viewer.useBrowserRecommendedResolution !== !sharp) {
      viewer.useBrowserRecommendedResolution = !sharp;
    }
    const scale = sharp ? hdResolutionScale(win.devicePixelRatio) : 1;
    if (viewer.resolutionScale !== scale) viewer.resolutionScale = scale;
    viewer.scene.requestRender();
  };

  const camera = viewer.camera;
  const onMoveStart = () => {
    win.clearTimeout?.(still);
    if (moving || !on) return;
    moving = true;
    apply();
  };
  const onMoveEnd = () => {
    win.clearTimeout?.(still);
    still = win.setTimeout?.(() => {
      moving = false;
      apply();
    }, SHARP_AFTER_MS);
  };
  const offStart = camera?.moveStart?.addEventListener(onMoveStart);
  const offEnd = camera?.moveEnd?.addEventListener(onMoveEnd);

  const button = doc.createElement('button');
  button.id = 'hd-detail-toggle';
  button.type = 'button';
  button.textContent = 'HD';
  button.setAttribute('aria-label', 'HD buildings');
  const paint = () => {
    button.setAttribute('aria-pressed', String(on));
    button.title = on
      ? 'HD is on: sharper 3D buildings, more data. Click for normal detail'
      : 'Turn on HD: sharper 3D buildings (uses more data)';
  };
  button.addEventListener('click', () => {
    on = !on;
    save(on);
    paint();
    apply();
  });
  paint();
  doc.getElementById('top-center-actions')?.appendChild(button);
  apply();

  return () => {
    on = false;
    win.clearTimeout?.(still);
    offStart?.();
    offEnd?.();
    apply();
    button.remove();
  };
}
