/**
 * A help card: what each added switch does, and what clicking the map does.
 *
 * The switches are icons with no words, and whether a click on the map does
 * anything depends on one of them (the map pin). The card says so in plain
 * words, including whether the pin is on right now. It opens by itself the
 * first time; once closed it stays closed until its own "?" switch is pressed.
 */
import { settingsFileControls } from './settingsFile.js';
import { ZENITH_SWITCHES } from './zenithSwitches.js';
import { versionLine, ZENITH_VERSION } from './zenithVersion.js';

const STORAGE_KEY = 'gev.helpCard';
const CLOSED = 'closed';
export const HELP_SWITCH_ID = 'zenith-help-toggle';
const PIN_SWITCH_ID = 'address-lookup-toggle';

/** It opens at the start unless it has been closed before. */
export function opensAtStart(stored) {
  return stored !== CLOSED;
}

/** What a click on empty map does, which depends on the pin switch. */
export function pinLine(pinOn) {
  return pinOn
    ? 'Map pin ON: click any spot for its local time, coordinates and address.'
    : 'Map pin OFF: clicking empty map does nothing. Switch the Map pin on to read a spot.';
}

export const MAP_CLICKS = Object.freeze([
  'Click a plane to follow it. Far out, click its pulsing ring to fly back.',
  'Click a camera marker to fly to it. Its picture shows within about 1 km.',
  'Hover or click a station dot for its name.',
  'With Measure on, each click on the map adds a measuring point instead.',
  'Right-click does nothing.',
]);

export const MOVING = Object.freeze([
  'Drag to move. Scroll to zoom, as far out as you like.',
  'Compass: drag the ring to turn, click N for north, drag the arc to tilt.',
  'Q and E, or Option + scroll, also turn the view.',
  'The ruler on the left is the scale at the centre of the view.',
]);

const ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9.3 9.2a2.8 2.8 0 1 1 4.3 2.4c-1 .6-1.6 1.2-1.6 2.3"/><circle cx="12" cy="17.3" r="0.6" fill="currentColor"/></svg>';

const STYLE = `
#zenith-help {
  position: fixed;
  top: 92px;
  left: 50%;
  z-index: 180;
  width: min(660px, calc(100vw - 32px));
  max-height: calc(100vh - 130px);
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: rgba(0, 246, 255, 0.35) transparent;
  transform: translateX(-50%);
  padding: 14px 16px 16px;
  border: 1px solid rgba(0, 246, 255, 0.35);
  border-radius: 12px;
  background: rgba(4, 12, 20, 0.95);
  box-shadow: 0 14px 40px rgba(0, 0, 0, 0.6);
  color: rgba(222, 246, 255, 0.92);
  font: 11.5px/1.4 var(--font-mono, ui-monospace, monospace);
}
#zenith-help[hidden],
body.ui-clean-view #zenith-help { display: none; }
#zenith-help .zh-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
#zenith-help h2 {
  margin: 0;
  font-size: 12px;
  letter-spacing: 0.22em;
  color: #00f6ff;
}
#zenith-help h3 {
  margin: 11px 0 5px;
  font-size: 10px;
  letter-spacing: 0.18em;
  color: rgba(0, 246, 255, 0.7);
}
#zenith-help .zh-close {
  width: 26px;
  height: 26px;
  border: 1px solid rgba(0, 246, 255, 0.35);
  border-radius: 50%;
  background: transparent;
  color: inherit;
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
}
#zenith-help .zh-switches {
  display: grid;
  grid-template-columns: 1fr 1fr;
  column-gap: 20px;
}
@media (max-width: 640px) {
  #zenith-help .zh-switches { grid-template-columns: 1fr; }
}
#zenith-help .zh-row {
  display: grid;
  grid-template-columns: 30px 1fr;
  gap: 10px;
  align-items: start;
  margin: 5px 0;
}
#zenith-help .zh-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: 1px solid rgba(0, 246, 255, 0.3);
  border-radius: 50%;
  color: #cfefff;
  font-size: 10px;
}
#zenith-help .zh-icon[data-on='true'] {
  border-color: #00d4ff;
  background: rgba(0, 212, 255, 0.24);
}
#zenith-help .zh-name { color: #fff; letter-spacing: 0.06em; }
#zenith-help ul { margin: 0; padding-left: 16px; }
#zenith-help li { margin: 2px 0; }
#zenith-help .zh-pin { color: #ffd27a; }
#zenith-help .zh-new { margin-top: 12px; padding-top: 9px; border-top: 1px solid rgba(0, 246, 255, 0.2); }
#zenith-help .zh-new summary { cursor: pointer; color: rgba(0, 246, 255, 0.85); letter-spacing: 0.06em; }
#zenith-help .zh-new ul { margin-top: 7px; }
`;

/**
 * @param {Document} [doc]
 * @param {{ storage?: Storage, win?: Window }} [options]
 * @returns {() => void} Removes the card and its switch.
 */
export function installHelpCard(
  doc = document,
  { storage = globalThis.localStorage, win = window } = {},
) {
  const read = () => {
    try {
      return storage?.getItem(STORAGE_KEY) ?? null;
    } catch {
      return null;
    }
  };
  const remember = () => {
    try {
      storage?.setItem(STORAGE_KEY, CLOSED);
    } catch {
      // Private windows can refuse storage; the card then opens again next time.
    }
  };

  const style = doc.createElement('style');
  style.textContent = STYLE;
  doc.head.appendChild(style);

  const card = doc.createElement('section');
  card.id = 'zenith-help';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'Zenith controls');
  card.hidden = true;
  doc.body.appendChild(card);

  const button = doc.createElement('button');
  button.id = HELP_SWITCH_ID;
  button.type = 'button';
  button.innerHTML = ICON;
  button.title = 'What the switches and map clicks do';
  button.setAttribute('aria-label', 'Help');
  button.setAttribute('aria-pressed', 'false');

  const element = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const list = (lines) => {
    const ul = element('ul');
    for (const line of lines) ul.appendChild(element('li', '', line));
    return ul;
  };
  const isOn = (id) =>
    doc.getElementById(id)?.getAttribute('aria-pressed') === 'true';

  // Built once and kept, so its message survives the card being redrawn.
  const settingsFile = settingsFileControls(doc, { storage, win });

  // Also built once, so it stays open while the card is redrawn.
  const whatsNew = element('details', 'zh-new');
  whatsNew.id = 'zenith-whats-new';
  whatsNew.append(
    element('summary', '', `What's new in ${versionLine()}`),
    list(ZENITH_VERSION.changes),
  );

  const render = () => {
    const head = element('div', 'zh-head');
    const close = element('button', 'zh-close', '×');
    close.type = 'button';
    close.title = 'Close this card';
    close.setAttribute('aria-label', 'Close this card');
    close.addEventListener('click', () => setOpen(false));
    head.append(element('h2', '', 'ZENITH CONTROLS'), close);

    const rows = element('div', 'zh-switches');
    for (const entry of ZENITH_SWITCHES) {
      const source = doc.getElementById(entry.id);
      if (!source || entry.id === HELP_SWITCH_ID) continue;
      const icon = element('span', 'zh-icon');
      icon.dataset.on = String(isOn(entry.id));
      for (const child of source.childNodes)
        icon.appendChild(child.cloneNode(true));
      const words = element('div');
      words.append(
        element('div', 'zh-name', entry.name),
        element('div', '', entry.what),
      );
      const row = element('div', 'zh-row');
      row.append(icon, words);
      rows.appendChild(row);
    }

    const clicks = list(MAP_CLICKS);
    clicks.prepend(element('li', 'zh-pin', pinLine(isOn(PIN_SWITCH_ID))));

    card.replaceChildren(
      head,
      element('h3', '', 'YOUR SWITCHES'),
      rows,
      element('h3', '', 'CLICKING THE MAP'),
      clicks,
      element('h3', '', 'MOVING AROUND'),
      list(MOVING),
      element('h3', '', 'YOUR SETTINGS'),
      settingsFile,
      whatsNew,
    );
  };

  // Redraw while open when any switch turns on or off, so the card never lies.
  const watcher = new win.MutationObserver(() => {
    if (!card.hidden) render();
  });
  const bar = doc.getElementById('top-center-actions');

  function setOpen(open) {
    if (open) render();
    else if (!card.hidden) remember();
    card.hidden = !open;
    button.setAttribute('aria-pressed', String(open));
  }

  const onKey = (event) => {
    if (event.key === 'Escape' && !card.hidden) setOpen(false);
  };
  button.addEventListener('click', () => setOpen(card.hidden));
  doc.addEventListener('keydown', onKey);
  bar?.appendChild(button);
  if (bar) {
    watcher.observe(bar, {
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-pressed'],
    });
  }
  if (opensAtStart(read())) setOpen(true);

  return () => {
    watcher.disconnect();
    doc.removeEventListener('keydown', onKey);
    button.remove();
    card.remove();
    style.remove();
  };
}
