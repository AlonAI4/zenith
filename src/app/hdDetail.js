import * as Cesium from 'cesium';
import { guard } from './addOns.js';
import { cinemaRunning } from './cinema.js';

/**
 * An HD switch for the 3D buildings. On, the map asks for finer building
 * tiles sooner, draws at the screen's full resolution, and filters the
 * buildings' pictures so far-off roofs and roads stay clean. It costs more
 * downloads, memory and graphics work, so it can be switched off.
 *
 * It cannot add detail the source does not have: very close to the ground the
 * 3D scan itself is the limit.
 *
 * Full resolution on a Retina screen is four times the pixels, which made the
 * map draw about a quarter as many frames while it moved. So while the view
 * moves it draws at the screen's normal resolution, and a quarter of a
 * second after it stops it draws sharp again: smooth to move, sharp to look at. Video mode and fly-through stay
 * sharp all the way, because they are for recording.
 *
 * Once still, and with nothing on the map moving, it draws one and a half
 * times the screen's pixels and lets the browser shrink the picture: edges
 * and fine texture come out crisper (measured on 18 October 2026 at Wembley
 * and Tower Bridge). Anything moving, such as live planes, keeps the map
 * redrawing, so then it stays at the screen's own pixels.
 */

const STORAGE_KEY = 'gev.hdDetail';
/** Cesium's default is 16: a lower number loads sharper tiles from further away. */
const HD_SCREEN_SPACE_ERROR = 8;
const NORMAL_SCREEN_SPACE_ERROR = 16;
/** Full resolution, but never more than two device pixels per CSS pixel. */
const MAX_PIXEL_RATIO = 2;
/** How long the view must stay still before it is drawn sharp again. */
export const SHARP_AFTER_MS = 250;
/** Still and nothing moving: this many times the screen's pixels. */
export const STILL_SUPERSAMPLE = 1.5;
/** Samples along a slant for anisotropic filtering; 16 is the most GPUs offer. */
const MAX_ANISOTROPY = 16;

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

/** The sharper sampler made from each one Cesium made, to put it back. */
const plainOf = new WeakMap();

/**
 * Google's 3D tiles ask for no mipmaps (smaller copies of a picture, for when
 * it is far away), so Cesium draws far-off roofs and roads from the full-size
 * picture: grainy, and shimmering as the view moves. This turns the plain
 * LINEAR filter into mipmaps with anisotropic filtering, which keeps surfaces
 * seen at a slant sharp. A NEAREST filter (pixel art) is kept, and a picture
 * that cannot have mipmaps (`compressedTextureNoMipmap`, Cesium's own name)
 * only gets the anisotropy.
 * @param {Cesium.Sampler} sampler The sampler Cesium made.
 * @param {{ compressedTextureNoMipmap?: boolean }} options
 * @param {number} anisotropy
 */
export function sharperSampler(
  sampler,
  { compressedTextureNoMipmap = false } = {},
  anisotropy = 1,
) {
  const { LINEAR, LINEAR_MIPMAP_LINEAR } = Cesium.TextureMinificationFilter;
  const mipmaps =
    sampler.minificationFilter === LINEAR && !compressedTextureNoMipmap;
  const sharp = new Cesium.Sampler({
    wrapS: sampler.wrapS,
    wrapT: sampler.wrapT,
    minificationFilter: mipmaps
      ? LINEAR_MIPMAP_LINEAR
      : sampler.minificationFilter,
    magnificationFilter: sampler.magnificationFilter,
    maximumAnisotropy: Math.max(1, anisotropy),
  });
  plainOf.set(sharp, sampler);
  return sharp;
}

/**
 * Makes Cesium build every picture loaded from now on with `sharperSampler`.
 * Mipmaps make Cesium resize a picture whose sides are not powers of two;
 * Google's tiles all are.
 * @param {{ createSampler: Function }} util Cesium's GltfLoaderUtil.
 * @returns {() => void} Puts Cesium's own function back.
 */
export function patchTileSamplers(util, anisotropy) {
  const own = util.createSampler;
  const patched = (options) =>
    sharperSampler(own(options), options, anisotropy);
  util.createSampler = patched;
  return () => {
    if (util.createSampler === patched) util.createSampler = own;
  };
}

/**
 * The pictures of the tiles loaded so far. They live inside Cesium's model of
 * each tile, which is not a public part of Cesium: if that changes, the tiles
 * already loaded keep their filter and the ones loaded after are still sharp.
 */
function tileTextures(tileset) {
  const textures = new Set();
  const take = (reader) => {
    const texture = reader?.texture;
    if (texture && '_sampler' in texture && !texture.isDestroyed?.())
      textures.add(texture);
  };
  const visit = (tile) => {
    for (const node of tile?.content?._model?._sceneGraph?._components?.nodes ??
      []) {
      for (const primitive of node.primitives ?? []) {
        const material = primitive.material;
        for (const part of [
          material,
          material?.metallicRoughness,
          material?.specularGlossiness,
        ]) {
          if (part) Object.values(part).forEach(take);
        }
      }
    }
    for (const child of tile?.children ?? []) visit(child);
  };
  visit(tileset?.root);
  return textures;
}

/** Mipmaps can be made for this picture: not compressed, and on WebGL 1 only with power-of-two sides. */
function canMakeMipmaps(texture) {
  if (Cesium.PixelFormat.isCompressedFormat(texture.pixelFormat)) return false;
  if (texture._context?.webgl2) return true;
  return (
    Cesium.Math.isPowerOfTwo(texture.width) &&
    Cesium.Math.isPowerOfTwo(texture.height)
  );
}

function sharpenTexture(texture, anisotropy) {
  const sampler = texture.sampler;
  if (!sampler || plainOf.has(sampler)) return;
  // Checked first: Cesium's smaller build leaves out the error a compressed
  // picture would throw, and a mipmap filter without mipmaps draws black.
  if (
    sampler.minificationFilter === Cesium.TextureMinificationFilter.LINEAR &&
    !texture._hasMipmap &&
    canMakeMipmaps(texture)
  ) {
    try {
      texture.generateMipmap();
    } catch {
      // Left without mipmaps: it gets the anisotropy only.
    }
  }
  texture.sampler = sharperSampler(
    sampler,
    { compressedTextureNoMipmap: !texture._hasMipmap },
    anisotropy,
  );
}

function plainTexture(texture) {
  const plain = plainOf.get(texture.sampler);
  if (plain) texture.sampler = plain;
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
  let idle = viewer.scene.requestRenderMode === true;
  let unpatch = null;
  const win = doc.defaultView ?? globalThis;

  // The buildings' pictures: sharper for every tile loaded from now on, and
  // for the ones already there.
  const filter = (wanted) => {
    if (wanted === Boolean(unpatch)) return;
    const textures =
      tileset && !tileset.isDestroyed?.() ? tileTextures(tileset) : new Set();
    if (wanted) {
      const anisotropy = Math.min(
        MAX_ANISOTROPY,
        Cesium.ContextLimits.maximumTextureFilterAnisotropy || 1,
      );
      unpatch = patchTileSamplers(Cesium.GltfLoaderUtil, anisotropy);
      textures.forEach((texture) => sharpenTexture(texture, anisotropy));
    } else {
      unpatch();
      unpatch = null;
      textures.forEach(plainTexture);
    }
    // For the browser checks.
    if (doc.body?.dataset)
      doc.body.dataset.hdTextures = wanted ? 'sharp' : 'plain';
  };

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
    const scale = sharp
      ? hdResolutionScale(win.devicePixelRatio) * (idle ? STILL_SUPERSAMPLE : 1)
      : 1;
    if (viewer.resolutionScale !== scale) viewer.resolutionScale = scale;
    viewer.scene.requestRender();
  };

  // Moving means the camera's place or direction changed since the last frame.
  // (Cesium's own move events also fire when the view's shape changes, which
  // a change of resolution does, so they would switch this back and forth.)
  const camera = viewer.camera;
  let last = null;
  const where = () => {
    const p = camera.positionWC;
    const d = camera.directionWC;
    const u = camera.upWC;
    return p && d && u ? [p.x, p.y, p.z, d.x, d.y, d.z, u.x, u.y, u.z] : null;
  };
  const changed = (a, b) =>
    // A millimetre, or about a hundred-thousandth of a degree: smaller changes
    // are rounding after a resize, not a move.
    !a ||
    !b ||
    a.some((value, i) => Math.abs(value - b[i]) > (i < 3 ? 1e-3 : 2e-7));
  const onFrame = () => {
    // The map only redraws on demand when nothing on it moves (see
    // renderGovernor.js); when something does, it redraws every frame.
    const idleNow = viewer.scene.requestRenderMode === true;
    if (idleNow !== idle) {
      idle = idleNow;
      if (on && !moving) apply();
    }
    const now = where();
    const moved = last !== null && changed(now, last);
    last = now;
    if (!moved || !on) return;
    win.clearTimeout?.(still);
    still = win.setTimeout?.(() => {
      moving = false;
      apply();
    }, SHARP_AFTER_MS);
    // Video mode and fly-through are for recording: they stay sharp.
    if (moving || cinemaRunning()) return;
    moving = true;
    apply();
  };
  const offFrame = viewer.scene.preRender?.addEventListener?.(
    guard('HD buildings', onFrame),
  );

  const button = doc.createElement('button');
  button.id = 'hd-detail-toggle';
  button.type = 'button';
  button.textContent = 'HD';
  button.setAttribute('aria-label', 'HD buildings');
  const paint = () => {
    button.setAttribute('aria-pressed', String(on));
    button.title = on
      ? 'HD is on: sharper 3D buildings, cleaner far-off roofs and roads, and extra detail when the view is still. Uses more data and memory. Click for normal detail'
      : 'Turn on HD: sharper 3D buildings (uses more data and memory)';
  };
  button.addEventListener('click', () => {
    on = !on;
    save(on);
    paint();
    filter(on);
    apply();
  });
  paint();
  doc.getElementById('top-center-actions')?.appendChild(button);
  filter(on);
  apply();

  return () => {
    on = false;
    win.clearTimeout?.(still);
    offFrame?.();
    filter(false);
    apply();
    button.remove();
  };
}
