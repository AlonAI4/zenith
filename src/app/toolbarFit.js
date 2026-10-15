/**
 * Keeps the top bar clear of its neighbours at every window width.
 *
 * The bar sits between the ZENITH title and the ACTIVE STYLE label, and the
 * compass dial sits beside it. The switches this build adds made the row
 * longer than a narrow window is wide. When the whole row fits, nothing
 * changes. When it does not, the added switches move into a tray that opens
 * from one "more" button, and the compass goes wherever there is room: right
 * of the bar, left of it, or below the top row.
 *
 * The buttons themselves are moved, not copied, so each keeps its own click
 * handler and its on/off look.
 */
import { closeOnEscape } from './escapeKey.js';
import { ZENITH_SWITCHES } from './zenithSwitches.js';

export const GAP = 12;
export const DIAL = Object.freeze({ width: 126, height: 112 });
export const MIN_DIAL_SCALE = 0.6;
const BELOW_ROW_SCALE = 0.75;
/** Under the two header lines the tactical HUD writes on a narrow window. */
const BELOW_ROW_TOP = 190;
/** The dial hangs a little above the bar's own top edge. */
const DIAL_RISE = 14;

/**
 * Does the full row fit: title, bar, dial, then the style label or the edge?
 * @param {{ bar: { left: number, right: number }, titleRight: number,
 *   limitRight: number, dialWidth?: number, gap?: number }} row
 */
export function fitsInline({
  bar,
  titleRight,
  limitRight,
  dialWidth = DIAL.width,
  gap = GAP,
}) {
  return (
    bar.left >= titleRight + gap &&
    bar.right + gap + dialWidth <= limitRight - gap
  );
}

/**
 * Where the compass dial goes, and how big.
 * @returns {{ left: number, top: number, scale: number }}
 */
export function placeDial({
  viewportWidth,
  bar,
  titleRight,
  limitRight,
  dial = DIAL,
  gap = GAP,
}) {
  const top = Math.max(4, bar.top - DIAL_RISE);
  const smallest = dial.width * MIN_DIAL_SCALE;

  const roomRight = limitRight - gap - (bar.right + gap);
  if (roomRight >= smallest) {
    return {
      left: bar.right + gap,
      top,
      scale: Math.min(1, roomRight / dial.width),
    };
  }
  const roomLeft = bar.left - gap - (titleRight + gap);
  if (roomLeft >= smallest) {
    const scale = Math.min(1, roomLeft / dial.width);
    return { left: bar.left - gap - dial.width * scale, top, scale };
  }
  return {
    left: viewportWidth - gap - dial.width * BELOW_ROW_SCALE,
    top: BELOW_ROW_TOP,
    scale: BELOW_ROW_SCALE,
  };
}

const MORE_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="currentColor"><circle cx="5" cy="12" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="19" cy="12" r="1.9"/></svg>';

const STYLE = `
#zenith-more-toggle { position: relative; }
#zenith-more-toggle[hidden] { display: none; }
#zenith-more-toggle[data-on]::after {
  content: attr(data-on);
  position: absolute;
  top: -5px;
  right: -5px;
  min-width: 15px;
  height: 15px;
  border-radius: 8px;
  background: #00d4ff;
  color: #031018;
  font: 700 10px/15px var(--font-mono, ui-monospace, monospace);
  text-align: center;
}
#zenith-tray {
  position: absolute;
  top: calc(100% + 10px);
  right: 0;
  display: none;
  flex-direction: column;
  gap: 8px;
  max-height: calc(100vh - 90px);
  overflow-y: auto;
  padding: 12px 14px;
  border: 1px solid rgba(0, 246, 255, 0.35);
  border-radius: 12px;
  background: rgba(4, 12, 20, 0.94);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.55);
}
#zenith-tray[data-open='true'] { display: flex; }
/* An open tray must be reachable above the help card and saved places. */
#top-center-actions.zt-tray-open { z-index: 190; }
#zenith-tray .zt-row {
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
}
#zenith-tray .zt-name {
  font: 11px var(--font-mono, ui-monospace, monospace);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  white-space: nowrap;
  color: rgba(214, 246, 255, 0.88);
}
`;

/**
 * @param {Document} [doc]
 * @param {Window} [win]
 * @returns {() => void} Puts the switches back in the bar and removes the tray.
 */
export function installToolbarFit(doc = document, win = window) {
  const bar = doc.getElementById('top-center-actions');
  if (!bar) return () => {};

  const style = doc.createElement('style');
  style.textContent = STYLE;
  doc.head.appendChild(style);

  const more = doc.createElement('button');
  more.id = 'zenith-more-toggle';
  more.type = 'button';
  more.innerHTML = MORE_ICON;
  more.title = 'More switches';
  more.setAttribute('aria-label', 'More switches');
  // A plain panel that shows and hides, which aria-expanded describes.
  more.setAttribute('aria-controls', 'zenith-tray');
  more.setAttribute('aria-expanded', 'false');
  more.hidden = true;

  const tray = doc.createElement('div');
  tray.id = 'zenith-tray';
  bar.append(more, tray);

  const names = new Map(ZENITH_SWITCHES.map((entry) => [entry.id, entry.name]));
  const opensPanel = new Set(
    ZENITH_SWITCHES.filter((entry) => entry.panel).map((entry) => entry.id),
  );
  const switches = () =>
    ZENITH_SWITCHES.map((entry) => doc.getElementById(entry.id)).filter(
      Boolean,
    );

  const setOpen = (open) => {
    tray.dataset.open = String(open);
    bar.classList.toggle('zt-tray-open', open);
    more.setAttribute('aria-expanded', String(open));
  };

  const setTrayMode = (inTray) => {
    for (const button of switches()) {
      if (inTray) {
        const row = doc.createElement('div');
        row.className = 'zt-row';
        const name = doc.createElement('span');
        name.className = 'zt-name';
        name.textContent = names.get(button.id);
        name.addEventListener('click', () => button.click());
        tray.appendChild(row);
        row.append(button, name);
      } else {
        bar.insertBefore(button, more);
      }
    }
    if (!inTray) tray.replaceChildren();
    more.hidden = !inTray;
  };

  const showCount = () => {
    const on = switches().filter(
      (button) => button.getAttribute('aria-pressed') === 'true',
    ).length;
    if (on > 0 && !more.hidden) more.dataset.on = String(on);
    else delete more.dataset.on;
  };

  const box = (element) =>
    element && element.getClientRects().length > 0
      ? element.getBoundingClientRect()
      : null;

  const measure = () => {
    const title =
      box(doc.querySelector('#title-bar h1 > span:not(.title-logo)')) ??
      box(doc.querySelector('#title-bar h1'));
    const label = box(doc.getElementById('style-indicator'));
    const viewportWidth = doc.documentElement.clientWidth;
    return {
      viewportWidth,
      bar: bar.getBoundingClientRect(),
      titleRight: title ? title.right : 0,
      limitRight: label ? label.left : viewportWidth,
    };
  };

  let watching = null;
  const fit = () => {
    watching?.disconnect();
    // Measure the full row first; only fold it away when it really is too long.
    setTrayMode(false);
    let row = measure();
    const inline = fitsInline(row);
    if (!inline) {
      setTrayMode(true);
      row = measure();
    } else {
      setOpen(false);
    }
    const dial = doc.getElementById('compass-dial');
    if (dial) {
      const spot = placeDial(row);
      dial.style.left = `${Math.round(spot.left)}px`;
      dial.style.top = `${Math.round(spot.top)}px`;
      dial.style.transformOrigin = 'top left';
      dial.style.transform =
        spot.scale < 1 ? `scale(${spot.scale.toFixed(3)})` : '';
    }
    showCount();
    watching?.observe(bar, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-pressed'],
    });
  };

  let queued = 0;
  const fitSoon = () => {
    win.cancelAnimationFrame(queued);
    queued = win.requestAnimationFrame(fit);
  };

  // A switch added later (some wait for their data) or one turning on or off.
  watching = new win.MutationObserver((records) => {
    const added = (record) =>
      record.type === 'childList' && record.target === bar;
    if (records.some(added)) fitSoon();
    else showCount();
  });

  const onMore = () => setOpen(tray.dataset.open !== 'true');
  const onOutside = (event) => {
    if (tray.dataset.open === 'true' && !bar.contains(event.target))
      setOpen(false);
  };
  more.addEventListener('click', onMore);
  // A switch that opens its own panel closes the tray, so they do not stack.
  const onTrayClick = (event) => {
    const pressed = event.target.closest?.('button');
    if (pressed && opensPanel.has(pressed.id)) setOpen(false);
  };
  tray.addEventListener('click', onTrayClick);
  doc.addEventListener('pointerdown', onOutside, true);
  const offEscape = closeOnEscape(
    win,
    () => tray.dataset.open === 'true',
    () => setOpen(false),
    { panel: tray, opener: more },
  );
  win.addEventListener('resize', fitSoon);
  fit();

  return () => {
    win.cancelAnimationFrame(queued);
    watching.disconnect();
    win.removeEventListener('resize', fitSoon);
    doc.removeEventListener('pointerdown', onOutside, true);
    offEscape();
    for (const button of switches()) bar.insertBefore(button, more);
    more.remove();
    tray.remove();
    style.remove();
  };
}
