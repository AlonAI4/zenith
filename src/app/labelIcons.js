import { OVERLAY_LABEL_ICONS } from '../overlays/worldOverlayDraw.js';
import { iconMarkup } from './drawnIcons.js';

/**
 * The drawn icon each map label source shows before its names. Only labels
 * that point at a plain spot: a ship or a plane already has its own picture
 * where the leader ends.
 */
export const LABEL_ICONS = Object.freeze({
  'rocket-missions': 'rocket',
  'satellites-iss': 'satellite',
  earthquakes: 'wave',
});

/** A drawn icon as a picture in one colour, for drawing on a canvas. */
export function iconPicture(name, color) {
  const svg = iconMarkup(name)
    .replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ')
    .replaceAll('currentColor', color);
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * Gives the map's labels their icons.
 * @param {{ requestRender?: () => void }} [scene] Redrawn when a picture loads.
 * @returns {() => void} Takes the icons away again.
 */
export function installLabelIcons(scene = {}, win = window) {
  // One picture per icon and colour, made once and looked up every frame.
  const picture = (name) => {
    const byColor = new Map();
    return (color) => {
      let image = byColor.get(color);
      if (!image) {
        image = new win.Image();
        image.onload = () => scene.requestRender?.();
        image.src = iconPicture(name, color);
        byColor.set(color, image);
      }
      return image.complete && image.naturalWidth > 0 ? image : null;
    };
  };
  for (const [source, name] of Object.entries(LABEL_ICONS))
    OVERLAY_LABEL_ICONS.set(source, picture(name));
  return () => {
    for (const source of Object.keys(LABEL_ICONS))
      OVERLAY_LABEL_ICONS.delete(source);
  };
}
