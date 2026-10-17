/**
 * This build is called Zenith. It is built on God's Eye View by Bilawal Sidhu
 * (MIT licence), and the line under the title says so.
 */

export const NAME = 'Zenith';
const CREDIT = "BUILT ON GOD'S EYE VIEW";
const GIVE_UP_MS = 30_000;

/** The two-tone title, in the same markup the original uses. */
function paintTitle(host, doc) {
  const accent = doc.createElement('span');
  accent.className = 'title-accent';
  accent.textContent = 'ITH';
  host.replaceChildren('ZEN', accent);
}

/**
 * Rename what is on screen. The header and the loading screen arrive at
 * different times, so this keeps looking for a while.
 * @param {Document} [doc]
 */
export function initBranding(doc = document) {
  doc.title = NAME;
  // The map credits in two lines: the Cesium ion logo on top, and the Google
  // Maps logo (with the other credits) under it, instead of one long row.
  // Cesium sets each part inline itself, so this needs !important.
  const credits = doc.createElement('style');
  credits.id = 'zenith-credit-lines';
  credits.textContent =
    '#cesium-credits .cesium-credit-logoContainer { display: block !important; margin-bottom: 4px; }';
  doc.head?.appendChild(credits);
  const jobs = new Map([
    ['#title-bar h1 > span:not(.title-logo)', (el) => paintTitle(el, doc)],
    [
      '#title-bar .subtitle',
      (el) => {
        el.textContent = CREDIT;
        // Brighter than the faint default, with a dark shadow, so the credit
        // stays readable over a bright satellite picture. Set here rather than
        // in the original's shared colours, which many other parts use.
        el.style.color = 'rgba(232, 234, 237, 0.62)';
        el.style.textShadow = '0 1px 2px #000, 0 0 8px rgba(0, 0, 0, 0.9)';
      },
    ],
    ['#loading-screen h2', (el) => paintTitle(el, doc)],
  ]);
  const apply = () => {
    for (const [selector, paint] of jobs) {
      const el = doc.querySelector(selector);
      if (!el) continue;
      paint(el);
      jobs.delete(selector);
    }
    if (doc.title !== NAME) doc.title = NAME;
    return jobs.size === 0;
  };
  if (apply()) return;
  const observer = new MutationObserver(() => {
    if (apply()) observer.disconnect();
  });
  observer.observe(doc.documentElement, { childList: true, subtree: true });
  setTimeout(() => observer.disconnect(), GIVE_UP_MS);
}
