import { closeOnEscape } from './escapeKey.js';
import { SWITCH_KEYS, keyLabel } from './switchKeys.js';
import { ZENITH_SWITCHES } from './zenithSwitches.js';

/**
 * A shorter top bar. The map overlays (place names, train stations,
 * earthquakes, time zones, day and night, HD buildings, space view) move into one LAYERS
 * menu, whose button shows how many of them are on. The original's tilt and
 * north-up buttons are hidden, because the compass dial does both (its N
 * still presses the hidden north-up button, which eases the turn).
 *
 * The switches are moved, not copied, so each keeps its click handler and
 * its on/off look. The menu works from the keyboard: arrow keys move between
 * rows, Enter or Space switches one, and Escape or a click outside closes it.
 */

/** The overlays in the LAYERS menu, in their order there. */
export const LAYER_IDS = Object.freeze(
  ZENITH_SWITCHES.filter((entry) => entry.group === 'layers').map(
    (entry) => entry.id,
  ),
);

/** The row an arrow key goes to, wrapping round; null for any other key. */
export function nextRow(index, count, key) {
  if (count < 1) return null;
  if (key === 'ArrowDown') return (index + 1) % count;
  if (key === 'ArrowUp') return (index - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}

const ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3 2.5 8 12 13l9.5-5z"/><path d="m2.5 12 9.5 5 9.5-5"/><path d="m2.5 16 9.5 5 9.5-5"/></svg>';

const STYLE = `
#tilt-map-view, #north-up-view { display: none !important; }
#zenith-layers-toggle { position: relative; }
/* The bar is its own layer at 100: raised while the menu is open, so the
   menu draws over the help card and the other panels. */
#top-center-actions.zl-menu-open { z-index: 190; }
#zenith-layers-toggle[data-on]::after {
  content: attr(data-on);
  position: absolute; top: -5px; right: -5px;
  min-width: 15px; height: 15px; border-radius: 8px;
  background: #00d4ff; color: #031018;
  font: 700 10px/15px var(--font-mono, ui-monospace, monospace); text-align: center;
}
#zenith-layers-menu {
  position: absolute; z-index: 195; display: none; flex-direction: column; gap: 6px;
  min-width: 250px; padding: 10px 12px;
  border: 1px solid rgba(0, 246, 255, 0.35); border-radius: 12px;
  background: rgba(4, 12, 20, 0.95); box-shadow: 0 12px 32px rgba(0, 0, 0, 0.55);
}
#zenith-layers-menu[data-open='true'] { display: flex; }
#zenith-layers-menu .zl-row { display: flex; align-items: center; gap: 10px; }
#zenith-layers-menu .zl-row[hidden] { display: none; }
#zenith-layers-menu .zl-name {
  flex: 1; cursor: pointer; white-space: nowrap;
  font: 11px var(--font-mono, ui-monospace, monospace); letter-spacing: 0.08em;
  text-transform: uppercase; color: rgba(214, 246, 255, 0.88);
}
#zenith-layers-menu .zl-state {
  min-width: 26px; text-align: right;
  font: 700 10px var(--font-mono, ui-monospace, monospace); letter-spacing: 0.1em;
  color: rgba(214, 246, 255, 0.4);
}
#zenith-layers-menu .zl-state::after { content: 'OFF'; }
#zenith-layers-menu .zl-key {
  min-width: 20px; padding: 1px 5px; border: 1px solid rgba(0, 246, 255, 0.35); border-radius: 4px;
  text-align: center; font: 700 10px var(--font-mono, ui-monospace, monospace); color: rgba(214, 246, 255, 0.75);
}
#zenith-layers-menu .zl-row:has(button[aria-pressed='true']) .zl-state { color: #00f6ff; }
#zenith-layers-menu .zl-row:has(button[aria-pressed='true']) .zl-state::after { content: 'ON'; }
`;

/**
 * @param {Document} [doc]
 * @param {Window} [win]
 * @returns {() => void} Puts the overlays back in the bar and removes the menu.
 */
export function installToolbarLayout(doc = document, win = window) {
  const bar = doc.getElementById('top-center-actions');
  if (!bar) return () => {};

  const style = doc.createElement('style');
  style.id = 'zenith-toolbar-layout';
  style.textContent = STYLE;
  doc.head.appendChild(style);

  const toggle = doc.createElement('button');
  toggle.id = 'zenith-layers-toggle';
  toggle.type = 'button';
  toggle.innerHTML = ICON;
  toggle.title =
    'Layers: place names, stations, earthquakes, time zones, day and night, HD, space';
  toggle.setAttribute('aria-label', 'Layers');
  toggle.setAttribute('aria-controls', 'zenith-layers-menu');
  toggle.setAttribute('aria-expanded', 'false');

  const menu = doc.createElement('div');
  menu.id = 'zenith-layers-menu';
  menu.setAttribute('role', 'group');
  menu.setAttribute('aria-label', 'Layers');

  // One row per overlay, made up front so the order never depends on which
  // switch was ready first.
  const names = new Map(ZENITH_SWITCHES.map((entry) => [entry.id, entry.name]));
  const rows = new Map(
    LAYER_IDS.map((id) => {
      const row = doc.createElement('div');
      row.className = 'zl-row';
      row.hidden = true;
      const name = doc.createElement('span');
      name.className = 'zl-name';
      name.textContent = names.get(id);
      name.addEventListener('click', () => doc.getElementById(id)?.click());
      const state = doc.createElement('span');
      state.className = 'zl-state';
      state.setAttribute('aria-hidden', 'true');
      const key = doc.createElement('kbd');
      key.className = 'zl-key';
      key.textContent = SWITCH_KEYS[id] ? keyLabel(SWITCH_KEYS[id]) : '';
      key.title = 'Its key';
      row.append(name, state, key);
      menu.appendChild(row);
      return [id, row];
    }),
  );
  // In the bar, like the narrow window's tray, so the toolbar's button looks
  // still apply to the switches inside it.
  bar.append(toggle, menu);

  const buttons = () =>
    LAYER_IDS.map((id) => doc.getElementById(id)).filter(
      (button) => button && menu.contains(button),
    );
  const showCount = () => {
    const on = buttons().filter(
      (button) => button.getAttribute('aria-pressed') === 'true',
    ).length;
    if (on > 0) toggle.dataset.on = String(on);
    else delete toggle.dataset.on;
  };

  // A switch is taken into its row as soon as it exists: some add-ons make
  // theirs later, when their data is ready.
  const adopt = () => {
    for (const id of LAYER_IDS) {
      const button = doc.getElementById(id);
      const row = rows.get(id);
      if (!button || row.contains(button)) continue;
      row.prepend(button);
      row.hidden = false;
    }
    showCount();
  };
  adopt();
  const watching = new win.MutationObserver((records) => {
    if (records.some((record) => record.type === 'childList')) adopt();
    else showCount();
  });
  watching.observe(bar, { childList: true });
  watching.observe(menu, {
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-pressed'],
  });

  const isOpen = () => menu.dataset.open === 'true';
  const setOpen = (open) => {
    menu.dataset.open = String(open);
    toggle.setAttribute('aria-expanded', String(open));
    bar.classList.toggle('zl-menu-open', open);
  };
  // Under the button, kept inside the window, measured from the bar (the
  // menu sits in it). Worked out on the click, while the button is still
  // showing (in the narrow window's tray, which then closes).
  const place = () => {
    const at = toggle.getBoundingClientRect();
    const from = bar.getBoundingClientRect();
    const width = menu.offsetWidth || 260;
    const room = doc.documentElement.clientWidth;
    const left = Math.min(
      Math.max(8, at.left + at.width / 2 - width / 2),
      room - width - 8,
    );
    menu.style.top = `${Math.round(at.bottom + 10 - from.top)}px`;
    menu.style.left = `${Math.round(left - from.left)}px`;
  };

  const onToggle = (event) => {
    if (isOpen()) {
      setOpen(false);
      return;
    }
    setOpen(true);
    place();
    // Straight to the first row, so Tab and screen readers go through the
    // menu before what follows (the menu sits before its button in the bar).
    buttons()[0]?.focus();
  };
  toggle.addEventListener('click', onToggle);

  const onMenuKey = (event) => {
    const list = buttons().filter((button) => button.offsetParent);
    const at = list.indexOf(doc.activeElement);
    const next = nextRow(Math.max(0, at), list.length, event.key);
    if (next === null || at < 0) return;
    event.preventDefault();
    list[next].focus();
  };
  menu.addEventListener('keydown', onMenuKey);
  // Focus moved on to something else: the menu closes behind it. (A click on
  // a row's name moves focus nowhere, and keeps it open.)
  const onFocusOut = (event) => {
    const to = event.relatedTarget;
    if (to && !menu.contains(to) && to !== toggle) setOpen(false);
  };
  menu.addEventListener('focusout', onFocusOut);

  const onOutside = (event) => {
    if (
      isOpen() &&
      !menu.contains(event.target) &&
      !toggle.contains(event.target)
    )
      setOpen(false);
  };
  doc.addEventListener('pointerdown', onOutside, true);
  const close = () => setOpen(false);
  win.addEventListener('resize', close);
  // Back to the LAYERS button, or, when it is folded into the narrow
  // window's closed tray, to the tray's button.
  const offEscape = closeOnEscape(win, isOpen, close, {
    panel: menu,
    opener: {
      focus: () =>
        (toggle.offsetParent
          ? toggle
          : doc.getElementById('zenith-more-toggle')
        )?.focus(),
    },
  });

  return () => {
    watching.disconnect();
    offEscape();
    win.removeEventListener('resize', close);
    doc.removeEventListener('pointerdown', onOutside, true);
    for (const button of buttons()) bar.appendChild(button);
    bar.classList.remove('zl-menu-open');
    toggle.remove();
    menu.remove();
    style.remove();
  };
}
