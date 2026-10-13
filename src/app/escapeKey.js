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
 * @param {Window} win
 * @param {() => boolean} isOpen
 * @param {() => void} close
 * @returns {() => void} Stops listening.
 */
export function closeOnEscape(win, isOpen, close) {
  const onKey = (event) => {
    if (event.key !== 'Escape' || !isOpen()) return;
    close();
    event.stopImmediatePropagation();
  };
  win.addEventListener('keydown', onKey, true);
  return () => win.removeEventListener('keydown', onKey, true);
}
