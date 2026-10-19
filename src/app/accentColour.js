import { reportFailure } from './addOns.js';

/**
 * Zenith's highlight colour. The target box, the building light, the camera
 * corners, the watch zones and the Moon boxes all draw in it: cyan, unless
 * another is picked in YOUR SETTINGS on the ZENITH CONTROLS card. The choice
 * is kept in this browser and travels in the settings file.
 *
 * Page styles use the CSS variables --zenith-accent ('#rrggbb') and
 * --zenith-accent-rgb ('r, g, b'), so they change at once. The map's shapes
 * are drawn by Cesium, which cannot read CSS: their files ask accent() when
 * they draw, and onAccent() tells them to draw again.
 */

export const ACCENT_KEY = 'gev.accent';
export const DEFAULT_ACCENT = '#00f6ff';

/** The ready colours in the picker, all bright enough to see on the map. */
export const SWATCHES = Object.freeze(
  [
    ['Cyan', '#00f6ff'],
    ['Green', '#39ff6a'],
    ['Amber', '#ffb000'],
    ['Red', '#ff3b3b'],
    ['Magenta', '#ff3df2'],
    ['White', '#ffffff'],
  ].map(([name, hex]) => Object.freeze({ name, hex })),
);

/**
 * A colour darker than this is refused: on the dark panels and a night map
 * it would hardly show. It is WCAG's relative luminance, 0 for black and 1
 * for white.
 */
export const MIN_LUMINANCE = 0.2;

const HEX = /^#[0-9a-f]{6}$/;

const channels = (hex) =>
  [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));

/** How bright '#rrggbb' looks: WCAG's relative luminance, 0 to 1. */
export function luminance(hex) {
  const [r, g, b] = channels(hex).map((value) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * The colour as '#rrggbb' in small letters, or null when it is not one or is
 * too dark to see.
 * @param {unknown} value
 * @returns {string|null}
 */
export function tidyAccent(value) {
  if (typeof value !== 'string') return null;
  const hex = value.toLowerCase();
  return HEX.test(hex) && luminance(hex) >= MIN_LUMINANCE ? hex : null;
}

/** '#ffb000' as '255, 176, 0', for rgba(var(--zenith-accent-rgb), alpha). */
export const accentRgb = (hex) => channels(hex).join(', ');

let colour = DEFAULT_ACCENT;
let root = null;
let store = null;
const listeners = new Set();

/** The highlight colour now, as '#rrggbb'. */
export const accent = () => colour;

/**
 * Calls back with the new colour each time it changes.
 * @param {(hex: string) => void} callback
 * @returns {() => void} Stops the calls.
 */
export function onAccent(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

const apply = (hex) => {
  colour = hex;
  root?.style.setProperty('--zenith-accent', hex);
  root?.style.setProperty('--zenith-accent-rgb', accentRgb(hex));
  // One drawing that fails must not stop the others from changing.
  for (const callback of listeners) {
    try {
      callback(hex);
    } catch (error) {
      reportFailure('Highlight colour', error);
    }
  }
};

/** Starts with the colour saved in this browser, or cyan. */
export function installAccent(
  doc = document,
  storage = globalThis.localStorage,
) {
  root = doc.documentElement;
  store = storage;
  let saved = null;
  try {
    saved = storage?.getItem(ACCENT_KEY);
  } catch {
    // Storage is blocked: cyan.
  }
  apply(tidyAccent(saved) ?? DEFAULT_ACCENT);
}

/**
 * Picks a new colour and keeps it.
 * @returns {boolean} False, with nothing changed, when it is not a colour or
 *   is too dark.
 */
export function setAccent(value) {
  const hex = tidyAccent(value);
  if (!hex) return false;
  try {
    store?.setItem(ACCENT_KEY, hex);
  } catch {
    // Not kept after a reload, but used until then.
  }
  apply(hex);
  return true;
}

const STYLE = `
#zenith-accent { margin: 0 0 12px; }
#zenith-accent .za-label { margin: 0 0 6px; font-size: 11px; letter-spacing: .16em; color: rgba(222, 246, 255, 0.7); }
#zenith-accent .za-row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
#zenith-accent .za-swatch, #zenith-accent .za-any {
  position: relative; box-sizing: border-box; width: 24px; height: 24px; margin: 0; padding: 0;
  border: 2px solid rgba(255, 255, 255, 0.3); border-radius: 50%; cursor: pointer;
}
#zenith-accent .za-any {
  background: conic-gradient(#ff3b3b, #ffb000, #39ff6a, #00f6ff, #3b6bff, #ff3df2, #ff3b3b);
}
#zenith-accent .za-any input {
  position: absolute; inset: -2px; width: 24px; height: 24px; margin: 0; padding: 0;
  border: 0; opacity: 0; cursor: pointer;
}
#zenith-accent .za-swatch[aria-pressed='true'], #zenith-accent .za-any[data-on='true'] {
  box-shadow: 0 0 0 2px #031018, 0 0 0 4px #ffffff;
}
#zenith-accent .za-swatch:focus-visible, #zenith-accent .za-any:focus-within {
  outline: 2px solid #ffffff; outline-offset: 4px;
}
#zenith-accent .za-note { margin: 6px 0 0; color: #ffb0b0; }
#zenith-accent .za-note:empty { display: none; }
`;

/**
 * The HIGHLIGHT COLOUR row: the six ready colours and "Any colour", which
 * opens the system's colour picker.
 * @param {Document} [doc]
 * @returns {HTMLElement}
 */
export function accentPicker(doc = document) {
  if (!doc.getElementById('zenith-accent-style')) {
    const style = doc.createElement('style');
    style.id = 'zenith-accent-style';
    style.textContent = STYLE;
    doc.head.appendChild(style);
  }
  const make = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const box = make('div');
  box.id = 'zenith-accent';
  const row = make('div', 'za-row');
  row.setAttribute('role', 'group');
  // i18n-ignore: Zenith's add-ons are in English only.
  row.setAttribute('aria-label', 'Highlight colour');
  const note = make('p', 'za-note');
  note.setAttribute('role', 'status');

  const swatches = SWATCHES.map(({ name, hex }) => {
    const button = make('button', 'za-swatch');
    button.type = 'button';
    button.title = name;
    button.setAttribute('aria-label', name);
    button.style.background = hex;
    button.addEventListener('click', () => {
      note.textContent = '';
      setAccent(hex);
    });
    row.appendChild(button);
    return { button, hex };
  });

  // The picker's own input, invisible over the rainbow circle, so a click
  // on the circle is a click on the input in every browser.
  const any = make('label', 'za-any');
  any.title = 'Any colour'; // i18n-ignore
  const input = make('input');
  input.type = 'color';
  input.id = 'zenith-accent-any';
  input.setAttribute('aria-label', 'Any colour'); // i18n-ignore
  const tooDark =
    'That colour is too dark to see on the map. Pick a brighter one.';
  input.addEventListener('change', () => {
    if (setAccent(input.value)) note.textContent = '';
    else {
      note.textContent = tooDark;
      input.value = accent();
    }
  });
  any.appendChild(input);
  row.appendChild(any);
  box.append(make('p', 'za-label', 'HIGHLIGHT COLOUR'), row, note);

  const mark = (hex) => {
    let ready = false;
    for (const swatch of swatches) {
      const on = swatch.hex === hex;
      ready ||= on;
      swatch.button.setAttribute('aria-pressed', String(on));
    }
    any.dataset.on = String(!ready);
    input.value = hex;
  };
  mark(accent());
  onAccent(mark);
  return box;
}
