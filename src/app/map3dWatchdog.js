/**
 * The 3D buildings map can stop answering while the app stays open (its
 * session runs out in a tab left open for hours). Nothing else replaces it,
 * so the globe goes black. When every 3D tile request keeps failing, switch
 * to the satellite map and say so.
 */

const FAILURES_BEFORE_FALLBACK = 12;
const FALLBACK_STACK = 'esri-imagery';
const NOTICE_MS = 30_000;
const MESSAGE =
  '3D map stopped loading, so the satellite map is showing. Reload the page to get 3D back.';

function showNotice(doc, text) {
  const notice = doc.createElement('div');
  notice.setAttribute('role', 'status');
  notice.textContent = text;
  notice.title = 'Click to dismiss';
  notice.style.cssText =
    'position:fixed;top:132px;left:50%;transform:translateX(-50%);z-index:200;' +
    'max-width:min(560px,90vw);padding:10px 14px;border-radius:10px;cursor:pointer;' +
    'border:1px solid rgba(255,190,90,.6);background:rgba(20,14,4,.92);color:#ffd9a0;' +
    'font:600 13px/1.4 var(--font-mono,monospace);text-align:center';
  notice.addEventListener('click', () => notice.remove());
  doc.body.appendChild(notice);
  setTimeout(() => notice.remove(), NOTICE_MS);
}

/**
 * @param {{ viewer: object, tileset?: object, mapStackController?: object }} scene
 * @param {{ notify?: (text: string) => void }} [options]
 * @returns {() => void} Stops watching.
 */
export function install3dMapWatchdog(
  { viewer, tileset, mapStackController },
  { notify = (text) => showNotice(document, text) } = {},
) {
  if (!tileset?.tileFailed || !tileset.tileLoad || !mapStackController)
    return () => {};
  let failures = 0;
  let switching = false;

  const offLoad = tileset.tileLoad.addEventListener(() => {
    failures = 0;
  });
  const offFail = tileset.tileFailed.addEventListener(() => {
    failures += 1;
    if (failures < FAILURES_BEFORE_FALLBACK || switching) return;
    // Only when the 3D map is the one on screen.
    if (viewer.scene.globe.show || !tileset.show) return;
    if (!mapStackController.isStackAvailable(FALLBACK_STACK)) return;
    switching = true;
    failures = 0;
    notify(MESSAGE);
    // Silent: the saved map choice stays 3D, so a reload brings it back.
    Promise.resolve(
      mapStackController.setStack(FALLBACK_STACK, { silent: true }),
    )
      .catch(() => {})
      .finally(() => {
        switching = false;
      });
  });

  return () => {
    offLoad();
    offFail();
  };
}
