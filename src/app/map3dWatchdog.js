import * as Cesium from 'cesium';

/**
 * Keeps the 3D buildings map alive.
 *
 * Google gives the 3D map a session that lasts about three hours. After that
 * every tile request is refused until a new session is asked for, and nothing
 * else in the app asks: a tab left open for an evening lost 3D for good, and
 * the globe went black.
 *
 * When 3D tiles keep failing, this:
 * 1. asks for a new session and hands it to the map. For a session that ran
 *    out, that is the whole cure and nothing else changes on screen;
 * 2. if tiles still fail (no network, say), shows the satellite map and says
 *    so, then keeps trying: each try gets a new session and switches 3D back
 *    on. No reload is needed.
 */

const FAILURES_BEFORE_ACTION = 12;
const FALLBACK_STACK = 'esri-imagery';
/** Failing again this soon after a new session means the session was not the problem. */
const RENEW_GRACE_MS = 60_000;
/** Requests already on their way still carry the old session; let them finish. */
const SETTLE_MS = 3_000;
const FIRST_RETRY_MS = 5_000;
const LONGEST_RETRY_MS = 5 * 60_000;
const TIMEOUT_MS = 10_000;
const NOTICE_MS = 30_000;
const BACK_NOTICE_MS = 6_000;
const NOTICE_ID = 'map3d-notice';
const FALLBACK_MESSAGE =
  '3D map stopped loading. Showing the satellite map and trying to get 3D back.';
const BACK_MESSAGE = '3D map is back.';

/** What to do after an unbroken run of failed tiles. */
export function afterFailures(msSinceNewSession) {
  return msSinceNewSession > RENEW_GRACE_MS ? 'renew' : 'fallback';
}

/** How long to wait before try number `attempt` (0 is the first): 5 s, doubling, up to 5 minutes. */
export function retryDelayMs(attempt) {
  return Math.min(LONGEST_RETRY_MS, FIRST_RETRY_MS * 2 ** Math.max(0, attempt));
}

/** The session token inside the map's starting file, or null. */
export function sessionIn(rootJson) {
  const found = /[?&]session=([^&"\\]+)/.exec(JSON.stringify(rootJson ?? ''));
  return found ? found[1] : null;
}

/**
 * Give every tile the new session, and let tiles that failed be asked for
 * again. Returns how many tiles were touched.
 */
export function applySession(tileset, session) {
  const { FAILED, UNLOADED } = Cesium.Cesium3DTileContentState;
  let touched = 0;
  const waiting = tileset?.root ? [tileset.root] : [];
  while (waiting.length) {
    const tile = waiting.pop();
    const resource = tile._contentResource;
    if (session && resource?.queryParameters?.session) {
      resource.setQueryParameters({ session });
      touched += 1;
    }
    if (tile._contentState === FAILED) tile._contentState = UNLOADED;
    for (const child of tile.children || []) waiting.push(child);
  }
  return touched;
}

/** Ask Google for a new session and hand it to the map. True when it worked. */
async function renewSession(tileset) {
  const root = tileset.resource;
  if (!root?.url) return false;
  const response = await fetch(root.url, {
    // The browser's saved copy holds the old session.
    cache: 'no-store',
    headers: root.headers,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) return false;
  const session = sessionIn(await response.json());
  if (!session) return false;
  applySession(tileset, session);
  return true;
}

function showNotice(doc, text, ms) {
  doc.getElementById(NOTICE_ID)?.remove();
  const notice = doc.createElement('div');
  notice.id = NOTICE_ID;
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
  setTimeout(() => notice.remove(), ms);
}

/**
 * @param {{ viewer: object, tileset?: object, mapStackController?: object }} scene
 * @param {object} [options] Replaceable parts, for tests.
 * @param {(text: string, ms: number) => void} [options.notify]
 * @param {() => Promise<boolean>} [options.renew] Gets a new session.
 * @param {(fn: () => void, ms: number) => unknown} [options.schedule]
 * @param {() => number} [options.now]
 * @param {() => boolean} [options.isHidden] True while the page is not on screen.
 * @param {number} [options.settleMs]
 * @returns {() => void} Stops watching.
 */
export function install3dMapWatchdog(
  { viewer, tileset, mapStackController },
  {
    notify = (text, ms) => showNotice(document, text, ms),
    renew = () => renewSession(tileset),
    schedule = (fn, ms) => setTimeout(fn, ms),
    now = () => Date.now(),
    isHidden = () => globalThis.document?.visibilityState === 'hidden',
    settleMs = SETTLE_MS,
  } = {},
) {
  if (!tileset?.tileFailed || !tileset.tileLoad || !mapStackController)
    return () => {};
  let failures = 0;
  // 'watching', 'renewing' (a new session is being fetched) or 'fallback'
  // (the satellite map is showing and 3D is being tried again).
  let phase = 'watching';
  let renewedAt = -Infinity;
  let attempt = 0;
  let stackBefore = null;
  let switchSeen = null;
  let stopped = false;

  const tryRenew = async () => {
    try {
      return (await renew()) === true;
    } catch {
      return false;
    }
  };
  const pause = (ms) => new Promise((resolve) => schedule(resolve, ms));

  const fallBack = async () => {
    if (!mapStackController.isStackAvailable(FALLBACK_STACK)) {
      phase = 'watching';
      return;
    }
    phase = 'fallback';
    stackBefore = mapStackController.getActiveId?.() ?? null;
    notify(FALLBACK_MESSAGE, NOTICE_MS);
    try {
      await mapStackController.setStack(FALLBACK_STACK, { silent: true });
    } catch {
      // The retry below still runs.
    }
    switchSeen = mapStackController.getSwitchGeneration?.();
    schedule(tryAgain, retryDelayMs(attempt));
  };

  const tryAgain = async () => {
    if (stopped || phase !== 'fallback') return;
    // Picking a map by hand while this waited ends the rescue: the choice wins.
    if (
      mapStackController.getSwitchGeneration?.() !== switchSeen ||
      (mapStackController.getActiveId &&
        mapStackController.getActiveId() !== FALLBACK_STACK)
    ) {
      phase = 'watching';
      return;
    }
    if (isHidden()) {
      schedule(tryAgain, retryDelayMs(attempt));
      return;
    }
    if (!(await tryRenew()) || stopped) {
      attempt += 1;
      schedule(tryAgain, retryDelayMs(attempt));
      return;
    }
    try {
      await mapStackController.setStack(stackBefore || 'photoreal', {
        silent: true,
      });
    } catch {
      attempt += 1;
      schedule(tryAgain, retryDelayMs(attempt));
      return;
    }
    // Still on trial: if tiles fail again within the grace time, it falls
    // back again and waits longer before the next try.
    attempt += 1;
    renewedAt = now();
    failures = 0;
    phase = 'watching';
    notify(BACK_MESSAGE, BACK_NOTICE_MS);
  };

  const onRunOfFailures = async () => {
    if (afterFailures(now() - renewedAt) === 'fallback') {
      await fallBack();
      return;
    }
    phase = 'renewing';
    const renewed = await tryRenew();
    if (stopped) return;
    if (!renewed) {
      await fallBack();
      return;
    }
    // Tiles asked for just before the new session still fail; wait for them,
    // then let those be asked for again too.
    await pause(settleMs);
    if (stopped) return;
    applySession(tileset, null);
    renewedAt = now();
    failures = 0;
    phase = 'watching';
    viewer.scene.requestRender?.();
  };

  const offLoad = tileset.tileLoad.addEventListener(() => {
    failures = 0;
    // Tiles are loading again, so the next trouble starts from a short wait.
    if (phase === 'watching') attempt = 0;
  });
  const offFail = tileset.tileFailed.addEventListener(() => {
    if (phase !== 'watching') return;
    if (viewer.scene.globe.show || !tileset.show) return;
    failures += 1;
    if (failures < FAILURES_BEFORE_ACTION) return;
    failures = 0;
    onRunOfFailures();
  });

  return () => {
    stopped = true;
    offLoad();
    offFail();
  };
}
