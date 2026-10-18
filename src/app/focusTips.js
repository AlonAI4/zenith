/**
 * Shows what a top-bar switch does when it is reached with the keyboard.
 *
 * Most switches in the top bar are icons. A mouse user hovers one and the
 * browser shows its title; a keyboard user who tabs to it sees only the
 * icon. While a switch has the keyboard focus, this shows the same words in
 * a small box under it. A click also focuses a switch, but the mouse already
 * has the title, so the box is only for focus that the keyboard moved.
 */

const STYLE = `
#zenith-focus-tip {
  position: fixed;
  z-index: 260;
  max-width: 280px;
  padding: 5px 9px;
  border: 1px solid rgba(0, 246, 255, 0.45);
  border-radius: 6px;
  background: rgba(4, 12, 20, 0.95);
  color: #e8f8ff;
  font: 11px/1.4 var(--font-mono, ui-monospace, monospace);
  pointer-events: none;
}
#zenith-focus-tip[hidden],
body.ui-clean-view #zenith-focus-tip { display: none; }
`;
const TIP_WIDTH = 280;

/**
 * @param {Document} [doc]
 * @returns {() => void} Removes the box and its listeners.
 */
export function installFocusTips(doc = document) {
  const style = doc.createElement('style');
  style.textContent = STYLE;
  doc.head.appendChild(style);
  const tip = doc.createElement('div');
  tip.id = 'zenith-focus-tip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  doc.body.appendChild(tip);

  const hide = () => {
    tip.hidden = true;
  };
  const show = () => {
    const bar = doc.getElementById('top-center-actions');
    const button = doc.activeElement;
    const words = button?.title || button?.getAttribute?.('aria-label');
    const byKeyboard = button?.matches?.(':focus-visible') ?? true;
    if (!bar || !button || button === bar || !bar.contains(button))
      return hide();
    if (!words || !byKeyboard) return hide();
    // Rows in the LAYERS menu and the tray print their own names; a tip
    // under one would cover the next row.
    if (button.closest?.('#zenith-layers-menu, #zenith-tray')) return hide();
    tip.textContent = words;
    const box = button.getBoundingClientRect();
    const width = doc.defaultView?.innerWidth ?? TIP_WIDTH;
    tip.style.top = `${Math.round(box.bottom + 6)}px`;
    tip.style.left = `${Math.round(Math.max(8, Math.min(box.left, width - TIP_WIDTH - 8)))}px`;
    tip.hidden = false;
  };
  // Pressing a switch can change its words ("Show ..." becomes "Hide ...").
  const onClick = () => {
    if (!tip.hidden) show();
  };
  const onKey = (event) => {
    if (event.key === 'Escape') hide();
  };
  doc.addEventListener('focusin', show);
  doc.addEventListener('focusout', hide);
  doc.addEventListener('click', onClick);
  doc.addEventListener('keydown', onKey, true);

  return () => {
    doc.removeEventListener('focusin', show);
    doc.removeEventListener('focusout', hide);
    doc.removeEventListener('click', onClick);
    doc.removeEventListener('keydown', onKey, true);
    tip.remove();
    style.remove();
  };
}
