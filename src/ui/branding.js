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
  const jobs = new Map([
    ['#title-bar h1 > span:not(.title-logo)', (el) => paintTitle(el, doc)],
    ['#title-bar .subtitle', (el) => (el.textContent = CREDIT)],
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
