/**
 * Makes a toolbar switch that is on look on: filled blue with a glow.
 *
 * The app only did this for its tilt button. The switches this build adds
 * (labels, stations, time zones, the pin, HD) said they were on to screen
 * readers but looked exactly the same on screen, so there was no way to see
 * whether the pin was armed before clicking the map.
 */

const STYLE = `
#top-center-actions button[aria-pressed='true'] {
  border-color: var(--accent, #00d4ff);
  background: rgba(0, 212, 255, 0.24);
  color: #fff;
  box-shadow:
    0 0 0 1px rgba(0, 212, 255, 0.55),
    0 0 16px rgba(0, 212, 255, 0.45);
}
#top-center-actions button[aria-pressed='true']:hover,
#top-center-actions button[aria-pressed='true']:focus-visible {
  background: rgba(0, 212, 255, 0.34);
}
`;

/**
 * @param {Document} [doc]
 * @returns {() => void} Takes the look away again.
 */
export function initToggleLook(doc = document) {
  const style = doc.createElement('style');
  style.textContent = STYLE;
  doc.head.appendChild(style);
  return () => style.remove();
}
