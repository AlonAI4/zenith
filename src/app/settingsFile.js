import { parsePlaces } from './savedPlaces.js';
import { readChoice } from './videoMode.js';

/**
 * Saving this build's own settings to a file, and loading them back in
 * another browser or on another Mac.
 *
 * Only the settings in the list below ever go into the file or come out of
 * one. A key (an API key or token) is never among them: keys live in the
 * .env file on the Mac that runs the app, not in the browser. A file that is
 * not a Zenith settings file is refused, and every value in a file that is
 * accepted is checked and tidied before it is used.
 */

const ON_OFF = (value) => (value === '1' || value === '0' ? value : null);

/**
 * The settings that can be saved, each with a check that returns the value
 * to store, or null to leave it out.
 */
export const SETTINGS = Object.freeze({
  'gev.mapLabels': ON_OFF,
  'gev.trainStations': ON_OFF,
  'gev.earthquakes': ON_OFF,
  'gev.timeZones': ON_OFF,
  'gev.dayNight': ON_OFF,
  'gev.addressLookup': ON_OFF,
  'gev.hdDetail': ON_OFF,
  'gev.helpCard': (value) => (value === 'closed' ? value : null),
  'gev.videoMode': (value) => JSON.stringify(readChoice(value)),
  'gev.savedPlaces': (value) => JSON.stringify(parsePlaces(value)),
});

export const FILE_NAME = 'zenith-settings.json';
const MAX_FILE_CHARS = 1_000_000;

/**
 * The file's contents, from whatever reads a setting by name.
 * @param {(key: string) => string|null} read
 * @param {Date} [now]
 */
export function buildSettingsFile(read, now = new Date()) {
  const settings = {};
  for (const [key, tidy] of Object.entries(SETTINGS)) {
    const value = read(key);
    const kept = typeof value === 'string' ? tidy(value) : null;
    if (kept !== null) settings[key] = kept;
  }
  return {
    app: 'Zenith',
    kind: 'settings',
    version: 1,
    saved: now.toISOString(),
    settings,
  };
}

/**
 * Read a settings file.
 * @param {string} text
 * @returns {{ ok: true, settings: Record<string, string>, ignored: number }
 *   | { ok: false, why: string }}
 */
export function readSettingsFile(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { ok: false, why: 'That file is empty.' };
  }
  if (text.length > MAX_FILE_CHARS) {
    return {
      ok: false,
      why: 'That file is too big to be a Zenith settings file.',
    };
  }
  let file;
  try {
    file = JSON.parse(text);
  } catch {
    return {
      ok: false,
      why: 'That is not a Zenith settings file: it could not be read.',
    };
  }
  if (
    !file ||
    typeof file !== 'object' ||
    file.app !== 'Zenith' ||
    file.kind !== 'settings' ||
    !file.settings ||
    typeof file.settings !== 'object' ||
    Array.isArray(file.settings)
  ) {
    return { ok: false, why: 'That is not a Zenith settings file.' };
  }
  if (file.version !== 1) {
    return {
      ok: false,
      why: 'That settings file is from a newer Zenith than this one.',
    };
  }
  const settings = {};
  let ignored = 0;
  for (const [key, value] of Object.entries(file.settings)) {
    const tidy = Object.hasOwn(SETTINGS, key) ? SETTINGS[key] : null;
    const kept = tidy && typeof value === 'string' ? tidy(value) : null;
    if (kept === null) ignored += 1;
    else settings[key] = kept;
  }
  if (Object.keys(settings).length === 0) {
    return { ok: false, why: 'That file has no Zenith settings in it.' };
  }
  return { ok: true, settings, ignored };
}

const STYLE = `
#zenith-settings-file .zs-row { display: flex; flex-wrap: wrap; gap: 8px; }
#zenith-settings-file button {
  padding: 5px 10px;
  border: 1px solid rgba(0, 246, 255, 0.35);
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
#zenith-settings-file button:hover { background: rgba(0, 212, 255, 0.16); }
#zenith-settings-file button[hidden] { display: none; }
#zenith-settings-file p { margin: 8px 0 0; color: rgba(222, 246, 255, 0.7); }
#zenith-settings-file p[data-bad='true'] { color: #ffb0b0; }
`;

/**
 * The two buttons and their message line, to put in the help card.
 * @param {Document} [doc]
 * @param {{ storage?: Storage, win?: Window }} [options]
 * @returns {HTMLElement}
 */
export function settingsFileControls(
  doc = document,
  { storage = globalThis.localStorage, win = window } = {},
) {
  if (!doc.getElementById('zenith-settings-style')) {
    const style = doc.createElement('style');
    style.id = 'zenith-settings-style';
    style.textContent = STYLE;
    doc.head.appendChild(style);
  }
  const make = (tag, text) => {
    const node = doc.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const box = make('div');
  box.id = 'zenith-settings-file';
  const row = make('div');
  row.className = 'zs-row';
  const saveButton = make('button', 'Save settings to a file');
  saveButton.type = 'button';
  saveButton.id = 'zenith-settings-save';
  saveButton.title =
    'Your switches and saved places, to move to another browser or Mac. No keys.';
  const loadButton = make('button', 'Load settings from a file');
  loadButton.type = 'button';
  loadButton.id = 'zenith-settings-load';
  const reloadButton = make('button', 'Reload to use them');
  reloadButton.type = 'button';
  reloadButton.id = 'zenith-settings-reload';
  reloadButton.hidden = true;
  const picker = make('input');
  picker.type = 'file';
  picker.accept = '.json,application/json';
  picker.id = 'zenith-settings-picker';
  picker.hidden = true;
  const message = make('p');
  message.id = 'zenith-settings-message';
  row.append(saveButton, loadButton, reloadButton, picker);
  box.append(row, message);

  const say = (text, bad = false) => {
    message.textContent = text;
    message.dataset.bad = String(bad);
  };

  saveButton.addEventListener('click', () => {
    let file;
    try {
      file = buildSettingsFile((key) => storage.getItem(key));
    } catch {
      say('This browser would not let the settings be read.', true);
      return;
    }
    const count = Object.keys(file.settings).length;
    if (count === 0) {
      say('Nothing to save yet: no switch has been changed in this browser.');
      return;
    }
    const link = make('a');
    const url = win.URL.createObjectURL(
      new win.Blob([JSON.stringify(file, null, 2)], {
        type: 'application/json',
      }),
    );
    link.href = url;
    link.download = FILE_NAME;
    doc.body.appendChild(link);
    link.click();
    link.remove();
    win.setTimeout(() => win.URL.revokeObjectURL(url), 10_000);
    say(
      `Saved ${count} setting${count === 1 ? '' : 's'} as ${FILE_NAME}. It holds no keys.`,
    );
  });

  loadButton.addEventListener('click', () => picker.click());
  picker.addEventListener('change', async () => {
    const chosen = picker.files?.[0];
    picker.value = '';
    if (!chosen) return;
    reloadButton.hidden = true;
    if (chosen.size > MAX_FILE_CHARS) {
      say('That file is too big to be a Zenith settings file.', true);
      return;
    }
    let result;
    try {
      result = readSettingsFile(await chosen.text());
    } catch {
      say('That file could not be read.', true);
      return;
    }
    if (!result.ok) {
      say(result.why, true);
      return;
    }
    try {
      for (const [key, value] of Object.entries(result.settings))
        storage.setItem(key, value);
    } catch {
      say('This browser would not let the settings be stored.', true);
      return;
    }
    const count = Object.keys(result.settings).length;
    say(
      `Loaded ${count} setting${count === 1 ? '' : 's'}.` +
        (result.ignored
          ? ` ${result.ignored} other thing${result.ignored === 1 ? ' was' : 's were'} ignored.`
          : ''),
    );
    reloadButton.hidden = false;
  });
  reloadButton.addEventListener('click', () => win.location.reload());

  return box;
}
