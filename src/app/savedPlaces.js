import * as Cesium from 'cesium';

/**
 * Saved places: star the view on screen, name it, and fly back to it later.
 *
 * One toolbar switch opens a small panel with a name box and the list. A
 * saved place is the camera's position, height, direction and tilt, and the
 * look it was saved with: the visual preset, which map was showing and which
 * data layers were on. Flying to it puts the look back as well. The list
 * is kept in this browser's storage on this computer only: it is never put in
 * the page address, and the copy of the app that gets shared does not hold it.
 */

const STORAGE_KEY = 'gev.savedPlaces';
export const MAX_PLACES = 50;
export const MAX_NAME = 40;
const FLY_SECONDS = 2.5;

/** A name as it will be stored: trimmed, single spaces, not too long. */
export function cleanName(raw) {
  return String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME)
    .trim();
}

const finite = (value, low, high) =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= low &&
  value <= high;

const isWord = (value) =>
  typeof value === 'string' && /^[\w.:-]{1,60}$/.test(value);

/**
 * True for a stored look that is safe to put back. A place saved before
 * looks were remembered has none, and that is fine.
 */
export function isLook(look) {
  if (look === undefined) return true;
  return (
    Boolean(look) &&
    typeof look === 'object' &&
    (look.style === null || isWord(look.style)) &&
    (look.map === null || isWord(look.map)) &&
    Array.isArray(look.layers) &&
    look.layers.length <= 80 &&
    look.layers.every(isWord)
  );
}

/**
 * What has to change to get from the look now to a saved look.
 * @returns {{ style: string|null, map: string|null, toggle: string[] }}
 *   A null means leave it; toggle lists the layers to switch on or off.
 */
export function lookChanges(now, wanted) {
  if (!wanted) return { style: null, map: null, toggle: [] };
  const on = new Set(now.layers);
  const want = new Set(wanted.layers);
  return {
    style: wanted.style && wanted.style !== now.style ? wanted.style : null,
    map: wanted.map && wanted.map !== now.map ? wanted.map : null,
    toggle: [...new Set([...on, ...want])]
      .filter((id) => on.has(id) !== want.has(id))
      .sort(),
  };
}

/** True for a stored record that is safe to fly to. */
export function isPlace(place) {
  return (
    Boolean(place) &&
    isLook(place.look) &&
    typeof place.name === 'string' &&
    cleanName(place.name) === place.name &&
    place.name.length > 0 &&
    finite(place.lon, -180, 180) &&
    finite(place.lat, -90, 90) &&
    finite(place.height, -1000, 1e15) &&
    finite(place.heading, -360, 720) &&
    finite(place.pitch, -90, 90)
  );
}

/** The saved list from storage text. Anything damaged is left out. */
export function parsePlaces(text) {
  try {
    const list = JSON.parse(text ?? '[]');
    return Array.isArray(list) ? list.filter(isPlace).slice(0, MAX_PLACES) : [];
  } catch {
    return [];
  }
}

/**
 * The list with this place added at the top. A place with the same name is
 * replaced, and the oldest drops off when the list is full.
 */
export function addPlace(list, place) {
  if (!isPlace(place)) return list;
  const same = place.name.toLowerCase();
  return [
    place,
    ...list.filter((old) => old.name.toLowerCase() !== same),
  ].slice(0, MAX_PLACES);
}

/** The list without the place of this name. */
export function removePlace(list, name) {
  return list.filter((place) => place.name !== name);
}

/** A short line under the name: where it is and how high the view is. */
export function describePlace(place) {
  const ns = place.lat >= 0 ? 'N' : 'S';
  const ew = place.lon >= 0 ? 'E' : 'W';
  const km = place.height / 1000;
  const high =
    km >= 10
      ? `${Math.round(km).toLocaleString('en-GB')} km up`
      : km >= 1
        ? `${km.toFixed(1)} km up`
        : `${Math.round(place.height)} m up`;
  return `${Math.abs(place.lat).toFixed(2)}°${ns} ${Math.abs(place.lon).toFixed(2)}°${ew} · ${high}`;
}

const ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.6 9.7l5.8-.8z"/></svg>';

const STYLE = `
#saved-places {
  position: fixed;
  top: 92px;
  left: 50%;
  z-index: 181;
  width: min(320px, calc(100vw - 32px));
  max-height: calc(100vh - 130px);
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: rgba(0, 246, 255, 0.35) transparent;
  transform: translateX(-50%);
  padding: 14px 16px 12px;
  border: 1px solid rgba(0, 246, 255, 0.35);
  border-radius: 12px;
  background: rgba(4, 12, 20, 0.95);
  box-shadow: 0 14px 40px rgba(0, 0, 0, 0.6);
  color: rgba(222, 246, 255, 0.92);
  font: 12px/1.4 var(--font-mono, ui-monospace, monospace);
}
#saved-places[hidden],
body.ui-clean-view #saved-places { display: none; }
#saved-places .sp-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
#saved-places h2 {
  margin: 0;
  font-size: 12px;
  letter-spacing: 0.22em;
  color: #00f6ff;
}
#saved-places button {
  border: 1px solid rgba(0, 246, 255, 0.35);
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
#saved-places button:hover { background: rgba(0, 212, 255, 0.16); }
#saved-places .sp-close,
#saved-places .sp-delete {
  flex: none;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  font-size: 14px;
  line-height: 1;
}
#saved-places form { display: flex; gap: 8px; }
#saved-places input {
  flex: 1;
  min-width: 0;
  padding: 6px 9px;
  border: 1px solid rgba(0, 246, 255, 0.35);
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.35);
  color: #fff;
  font: inherit;
}
#saved-places .sp-save { padding: 6px 12px; border-radius: 8px; }
#saved-places .sp-note { margin: 8px 0 0; color: rgba(222, 246, 255, 0.6); }
#saved-places ul { margin: 10px 0 0; padding: 0; list-style: none; }
#saved-places li { display: flex; align-items: center; gap: 8px; margin: 5px 0; }
#saved-places .sp-go {
  flex: 1;
  min-width: 0;
  padding: 6px 9px;
  border-radius: 8px;
  text-align: left;
}
#saved-places .sp-name {
  display: block;
  overflow: hidden;
  color: #fff;
  text-overflow: ellipsis;
  white-space: nowrap;
}
#saved-places .sp-where { display: block; font-size: 10px; color: rgba(222, 246, 255, 0.6); }
`;

/**
 * @param {{ viewer: Cesium.Viewer }} scene
 * @param {Document} [doc]
 * @param {{ storage?: Storage }} [options]
 * @returns {() => void} Removes the panel and its switch.
 */
export function installSavedPlaces(
  { viewer },
  doc = document,
  { storage = globalThis.localStorage, look: parts = {} } = {},
) {
  const { camera } = viewer;
  const { styleManager, mapStackController, dataManager } = parts;

  /** The look now, read from the app's own controls. */
  const readLook = () => ({
    style: styleManager?.activeStyle ?? null,
    map: mapStackController?.getActiveId?.() ?? null,
    layers: [...(dataManager?.getEnabledLayerIds?.() ?? [])].map(String).sort(),
  });

  /** Put a saved look back, changing only what differs. */
  const applyLook = (wanted) => {
    const { style, map, toggle } = lookChanges(readLook(), wanted);
    if (style) styleManager?.setStyle?.(style, { revealParameters: false });
    if (map) {
      // Through the map's own button, so it counts as a map picked by hand.
      const chip = [...doc.querySelectorAll('.map-stack-chip')].find(
        (candidate) => candidate.dataset.stackId === map,
      );
      if (chip) chip.click();
      else mapStackController?.setStack?.(map);
    }
    for (const id of toggle) {
      if (dataManager?.layers?.has?.(id))
        dataManager.toggle(id, { origin: 'user' });
    }
  };
  const read = () => {
    try {
      return parsePlaces(storage?.getItem(STORAGE_KEY));
    } catch {
      return [];
    }
  };
  let places = read();
  let stored = true;
  const write = () => {
    try {
      storage?.setItem(STORAGE_KEY, JSON.stringify(places));
      stored = true;
    } catch {
      stored = false;
    }
  };

  const style = doc.createElement('style');
  style.textContent = STYLE;
  doc.head.appendChild(style);

  const element = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const panel = element('section');
  panel.id = 'saved-places';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Saved places');
  panel.hidden = true;

  const head = element('div', 'sp-head');
  const close = element('button', 'sp-close', '×');
  close.type = 'button';
  close.title = 'Close';
  close.setAttribute('aria-label', 'Close saved places');
  head.append(element('h2', '', 'SAVED PLACES'), close);

  const form = element('form');
  const input = element('input');
  input.type = 'text';
  input.maxLength = MAX_NAME;
  input.placeholder = 'Name this view';
  input.setAttribute('aria-label', 'Name for the view on screen');
  input.autocomplete = 'off';
  const saveButton = element('button', 'sp-save', 'Save');
  saveButton.type = 'submit';
  saveButton.title = 'Save the view on screen under this name';
  form.append(input, saveButton);

  const note = element('p', 'sp-note');
  const list = element('ul');
  panel.append(head, form, note, list);
  doc.body.appendChild(panel);

  const here = () => {
    const where = camera.positionCartographic;
    return {
      lon: Cesium.Math.toDegrees(where.longitude),
      lat: Cesium.Math.toDegrees(where.latitude),
      height: where.height,
      heading: Cesium.Math.toDegrees(camera.heading),
      pitch: Cesium.Math.toDegrees(camera.pitch),
    };
  };

  const flyTo = (place) => {
    applyLook(place.look);
    // Let go of anything being followed, or the view would be pulled back.
    viewer.trackedEntity = undefined;
    camera.cancelFlight();
    camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(
        place.lon,
        place.lat,
        place.height,
      ),
      orientation: {
        heading: Cesium.Math.toRadians(place.heading),
        pitch: Cesium.Math.toRadians(place.pitch),
        roll: 0,
      },
      duration: FLY_SECONDS,
    });
  };

  const render = () => {
    note.textContent = !stored
      ? 'This browser would not save the list, so it lasts only until the page is closed.'
      : places.length === 0
        ? 'Nothing saved yet. Move to a view you like, name it and press Save.'
        : 'A place remembers its map, look and layers. Kept on this computer only.';
    list.replaceChildren(
      ...places.map((place) => {
        const go = element('button', 'sp-go');
        go.type = 'button';
        go.title = `Fly to ${place.name}`;
        go.append(
          element('span', 'sp-name', place.name),
          element('span', 'sp-where', describePlace(place)),
        );
        go.addEventListener('click', () => flyTo(place));
        const remove = element('button', 'sp-delete', '×');
        remove.type = 'button';
        remove.title = `Delete ${place.name}`;
        remove.setAttribute('aria-label', `Delete ${place.name}`);
        remove.addEventListener('click', () => {
          places = removePlace(places, place.name);
          write();
          render();
        });
        const row = element('li');
        row.append(go, remove);
        return row;
      }),
    );
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = cleanName(input.value);
    if (!name) {
      input.focus();
      return;
    }
    places = addPlace(places, { name, ...here(), look: readLook() });
    write();
    input.value = '';
    render();
  });
  // Typing a name must not set off the app's one-key shortcuts.
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') event.stopPropagation();
  });

  const button = doc.createElement('button');
  button.id = 'saved-places-toggle';
  button.type = 'button';
  button.innerHTML = ICON;
  button.title = 'Saved places: star this view and fly back to it later';
  button.setAttribute('aria-label', 'Saved places');
  const setOpen = (open) => {
    if (open) {
      places = read();
      render();
    }
    panel.hidden = !open;
    button.setAttribute('aria-pressed', String(open));
    if (open) input.focus();
  };
  const onKey = (event) => {
    if (event.key === 'Escape' && !panel.hidden) setOpen(false);
  };
  button.addEventListener('click', () => setOpen(panel.hidden));
  close.addEventListener('click', () => setOpen(false));
  doc.addEventListener('keydown', onKey);
  button.setAttribute('aria-pressed', 'false');
  doc.getElementById('top-center-actions')?.appendChild(button);

  return () => {
    doc.removeEventListener('keydown', onKey);
    button.remove();
    panel.remove();
    style.remove();
  };
}
