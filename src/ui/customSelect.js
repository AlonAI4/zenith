/**
 * Draws the app's dropdown menus in its own style instead of the operating
 * system's. Each native <select> stays in the page, hidden, as the source of
 * truth: the app keeps reading and setting it, and this only mirrors it.
 */

const SEARCH_FROM = 12;
const MAX_ROWS = 250;
const SYNC_MS = 400;
const CHEVRON =
  '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';

const STYLE = `
.gev-menu-native {
  position: absolute !important;
  width: 1px !important;
  height: 1px !important;
  margin: 0 !important;
  padding: 0 !important;
  border: 0 !important;
  opacity: 0 !important;
  pointer-events: none !important;
}
.gev-menu-btn {
  display: inline-flex;
  flex: 1 1 auto;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
  max-width: 100%;
  padding: 6px 10px;
  border: 1px solid rgba(120, 220, 255, 0.28);
  border-radius: 8px;
  background: rgba(8, 18, 28, 0.72);
  color: #dff6ff;
  font: 500 12px/1.2 var(--font-mono, monospace);
  letter-spacing: 0.04em;
  text-align: left;
  cursor: pointer;
}
.gev-menu-btn:hover,
.gev-menu-btn[aria-expanded='true'] {
  border-color: rgba(0, 246, 255, 0.75);
  color: #fff;
}
.gev-menu-btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.gev-menu-btn > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.gev-menu-btn > svg {
  flex: none;
  opacity: 0.8;
}
.gev-menu {
  position: fixed;
  z-index: 400;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid rgba(0, 246, 255, 0.5);
  border-radius: 10px;
  background: rgba(4, 10, 16, 0.97);
  box-shadow: 0 14px 40px rgba(0, 0, 0, 0.6);
  color: #dff6ff;
  font: 500 12px/1.3 var(--font-mono, monospace);
}
.gev-menu input {
  margin: 8px;
  padding: 6px 8px;
  border: 1px solid rgba(120, 220, 255, 0.35);
  border-radius: 6px;
  outline: none;
  background: rgba(8, 18, 28, 0.9);
  color: #fff;
  font: inherit;
}
.gev-menu input:focus {
  border-color: #00f6ff;
}
.gev-menu-list {
  overflow: auto;
  padding: 4px;
}
.gev-menu-group {
  padding: 8px 8px 4px;
  color: #5fd6ee;
  font-size: 10px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}
.gev-menu-row {
  overflow: hidden;
  padding: 6px 8px;
  border-radius: 6px;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}
.gev-menu-row[aria-selected='true'] {
  color: #00f6ff;
}
.gev-menu-row.is-active,
.gev-menu-row:hover {
  background: rgba(0, 246, 255, 0.14);
  color: #fff;
}
.gev-menu-note {
  padding: 6px 10px 8px;
  font-size: 10px;
  opacity: 0.65;
}
`;

/**
 * The rows a menu shows for a search: group headings, then their options.
 * @param {Array<{label: string, value: string, group?: string}>} options
 * @param {string} query
 * @param {number} [cap]
 * @returns {{ rows: Array<{heading?: string, label?: string, value?: string}>, matched: number }}
 */
export function menuRows(options, query, cap = MAX_ROWS) {
  const needle = String(query || '')
    .trim()
    .toLowerCase();
  const matches = options.filter(
    (option) =>
      !needle ||
      option.label.toLowerCase().includes(needle) ||
      String(option.group || '')
        .toLowerCase()
        .includes(needle),
  );
  const rows = [];
  let heading = null;
  for (const option of matches.slice(0, cap)) {
    const group = option.group || '';
    if (group && group !== heading) rows.push({ heading: group });
    heading = group;
    rows.push({ label: option.label, value: option.value });
  }
  return { rows, matched: matches.length };
}

function readOptions(select) {
  return Array.from(select.options).map((option) => ({
    label: option.textContent.trim(),
    value: option.value,
    group:
      option.parentElement?.tagName === 'OPTGROUP'
        ? option.parentElement.label
        : '',
  }));
}

/**
 * @param {Document} [doc]
 * @returns {() => void} Stops mirroring and gives the native menus back.
 */
export function initCustomSelects(doc = document) {
  const style = doc.createElement('style');
  style.textContent = STYLE;
  doc.head.appendChild(style);

  const buttons = new Map();
  let openMenu = null;
  let menusOpened = 0;

  const close = () => {
    if (!openMenu) return;
    // Cleared first: removing the panel moves the focus, which calls close.
    const menu = openMenu;
    openMenu = null;
    menu.button.setAttribute('aria-expanded', 'false');
    menu.panel.remove();
  };

  const syncOne = (select, button) => {
    const name = select.getAttribute('aria-label') || 'Menu';
    const current = select.selectedOptions[0]?.textContent.trim() || name;
    const label = button.firstElementChild;
    if (label.textContent !== current) label.textContent = current;
    if (button.disabled !== select.disabled) button.disabled = select.disabled;
    if (button.title !== name) button.title = name;
    // Read out as the menu's name and its choice, such as "Style: Normal".
    const spoken = `${name}: ${current}`;
    if (button.getAttribute('aria-label') !== spoken)
      button.setAttribute('aria-label', spoken);
  };

  const open = (select, button) => {
    close();
    const options = readOptions(select);
    const name = select.getAttribute('aria-label') || 'Menu';
    const menuId = `gev-menu-${(menusOpened += 1)}`;
    const panel = doc.createElement('div');
    panel.className = 'gev-menu';
    // Focusable, so a click on a row keeps the focus inside the menu.
    panel.tabIndex = -1;
    const search = doc.createElement('input');
    search.type = 'search';
    search.placeholder = `Search ${options.length} options`;
    search.setAttribute('aria-label', 'Search this menu');
    const list = doc.createElement('div');
    list.className = 'gev-menu-list';
    list.id = menuId;
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', name);
    list.tabIndex = -1;
    search.setAttribute('aria-controls', menuId);
    // Whichever has the keyboard focus says which row is highlighted, so a
    // screen reader reads each row as the arrow keys reach it.
    const keys = options.length >= SEARCH_FROM ? search : list;
    const note = doc.createElement('div');
    note.className = 'gev-menu-note';
    if (options.length >= SEARCH_FROM) panel.append(search);
    panel.append(list, note);

    let active = -1;
    let rowEls = [];
    const setActive = (index) => {
      rowEls[active]?.classList.remove('is-active');
      active = Math.max(0, Math.min(rowEls.length - 1, index));
      rowEls[active]?.classList.add('is-active');
      rowEls[active]?.scrollIntoView({ block: 'nearest' });
      if (rowEls[active])
        keys.setAttribute('aria-activedescendant', rowEls[active].id);
      else keys.removeAttribute('aria-activedescendant');
    };
    const choose = (value) => {
      close();
      button.focus();
      if (select.value === value) return;
      select.value = value;
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
      syncOne(select, button);
    };
    const draw = () => {
      const { rows, matched } = menuRows(options, search.value);
      rowEls = [];
      list.replaceChildren(
        ...rows.map((row) => {
          const el = doc.createElement('div');
          if (row.heading) {
            el.className = 'gev-menu-group';
            el.textContent = row.heading;
            return el;
          }
          el.className = 'gev-menu-row';
          el.id = `${menuId}-opt-${rowEls.length}`;
          el.setAttribute('role', 'option');
          el.setAttribute('aria-selected', String(row.value === select.value));
          el.textContent = row.label;
          el.addEventListener('click', () => choose(row.value));
          rowEls.push(el);
          return el;
        }),
      );
      const shown = rowEls.length;
      note.textContent =
        matched === 0
          ? 'Nothing matches'
          : shown < matched
            ? `Showing ${shown} of ${matched}. Type to narrow it down`
            : '';
      note.hidden = !note.textContent;
      active = -1;
      const selected = rowEls.findIndex(
        (el) => el.getAttribute('aria-selected') === 'true',
      );
      setActive(selected >= 0 ? selected : 0);
    };

    panel.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        // Close the menu only; the app has its own Esc shortcuts.
        event.stopPropagation();
        close();
        button.focus();
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setActive(active + (event.key === 'ArrowDown' ? 1 : -1));
      } else if (
        (event.key === 'Home' || event.key === 'End') &&
        event.target !== search
      ) {
        // In the search box these two move the text cursor instead.
        event.preventDefault();
        setActive(event.key === 'Home' ? 0 : rowEls.length - 1);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        rowEls[active]?.click();
      }
    });
    // Tab, or a click elsewhere, takes the focus out: the menu closes.
    panel.addEventListener('focusout', (event) => {
      const to = event.relatedTarget;
      // Not to its own button: that click closes the menu by itself.
      if (openMenu?.panel === panel && !panel.contains(to) && to !== button)
        close();
    });
    search.addEventListener('input', draw);

    doc.body.appendChild(panel);
    const box = button.getBoundingClientRect();
    const view = doc.defaultView;
    const width = Math.min(Math.max(box.width, 240), 440, view.innerWidth - 16);
    const below = view.innerHeight - box.bottom;
    const above = box.top;
    const up = below < 260 && above > below;
    panel.style.width = `${width}px`;
    panel.style.left = `${Math.max(8, Math.min(box.left, view.innerWidth - width - 8))}px`;
    panel.style.maxHeight = `${Math.min(440, (up ? above : below) - 12)}px`;
    if (up) panel.style.bottom = `${view.innerHeight - box.top + 4}px`;
    else panel.style.top = `${box.bottom + 4}px`;

    button.setAttribute('aria-expanded', 'true');
    openMenu = { button, panel };
    draw();
    keys.focus();
  };

  const wrap = (select) => {
    if (buttons.has(select) || select.multiple) return;
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'gev-menu-btn';
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false');
    button.innerHTML = `<span></span>${CHEVRON}`;
    button.addEventListener('click', () => {
      if (openMenu?.button === button) close();
      else open(select, button);
    });
    select.classList.add('gev-menu-native');
    select.tabIndex = -1;
    select.after(button);
    buttons.set(select, button);
    syncOne(select, button);
  };

  const sync = () => {
    for (const select of doc.querySelectorAll('select')) wrap(select);
    for (const [select, button] of buttons) {
      if (!select.isConnected) {
        button.remove();
        buttons.delete(select);
      } else syncOne(select, button);
    }
  };

  const onPointerDown = (event) => {
    if (!openMenu) return;
    if (openMenu.panel.contains(event.target)) return;
    if (openMenu.button.contains(event.target)) return;
    close();
  };
  doc.addEventListener('pointerdown', onPointerDown, true);
  doc.defaultView.addEventListener('resize', close);
  sync();
  // The app changes selections from code, which fires no event to listen for.
  const timer = setInterval(sync, SYNC_MS);

  return () => {
    clearInterval(timer);
    close();
    doc.removeEventListener('pointerdown', onPointerDown, true);
    doc.defaultView.removeEventListener('resize', close);
    for (const [select, button] of buttons) {
      select.classList.remove('gev-menu-native');
      select.removeAttribute('tabindex');
      button.remove();
    }
    buttons.clear();
    style.remove();
  };
}
