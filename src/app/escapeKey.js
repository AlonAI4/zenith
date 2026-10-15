/**
 * Escape closes one of this build's panels, and only that.
 *
 * The original app also listens for Escape: it stops following a plane. So
 * with a panel open, one press used to close the panel and drop the plane
 * too. Here the key is heard before anything else on the page (in the
 * "capture" pass on the window). If there is a panel to close, it is closed
 * and the key goes no further; if there is not, the key is passed on
 * untouched and the original app does what it always did.
 *
 * When the keyboard focus was inside the panel, it goes back to the button
 * that opened it: a hidden panel would otherwise drop the focus to the top
 * of the page, and a keyboard user would have to find their place again.
 *
 * @param {Window} win
 * @param {() => boolean} isOpen
 * @param {() => void} close
 * @param {{ panel?: { contains: (node: unknown) => boolean },
 *   opener?: { focus: () => void } }} [focus]
 * @returns {() => void} Stops listening.
 */
export function closeOnEscape(win, isOpen, close, { panel, opener } = {}) {
  const onKey = (event) => {
    if (event.key !== 'Escape' || !isOpen()) return;
    const focusWasInside = Boolean(
      panel && win.document && panel.contains(win.document.activeElement),
    );
    close();
    if (focusWasInside) opener?.focus();
    event.stopImmediatePropagation();
  };
  win.addEventListener('keydown', onKey, true);
  return () => win.removeEventListener('keydown', onKey, true);
}
