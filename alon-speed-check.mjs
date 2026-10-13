#!/usr/bin/env node
/**
 * Zenith's speed check: does any add-on make the map draw clearly slower?
 *
 * It opens the running app in a headless browser, at the sharpness of a
 * Retina screen, looking at the 3D buildings of London, and measures how the
 * map draws while the view is kept moving:
 * - the original app alone (the address option ?addons=off);
 * - this build's add-ons installed with every switch off;
 * - each switch on by itself, then every switch on, without and with HD.
 *
 * Two numbers each: frames a second, and how long the app works on one frame.
 * The browser never draws more than 60 frames a second, so when the map is
 * fast the first number sits at 60 and the second one shows the difference.
 * The check fails when the add-ons cost more than the limits below.
 *
 *   node alon-speed-check.mjs
 *
 * The app must be running (./alon-app.sh start).
 */
import { launchBrowser, sleep } from './alon-browser.mjs';

const BASE = process.env.ZENITH_URL || 'http://localhost:4173';
const VIEW = 'lat=51.5055&lon=-0.0754&alt=900&heading=20&pitch=-35';
const SIZE = { width: 1440, height: 900, deviceScaleFactor: 2 };
const MEASURE_MS = 5000;

/**
 * How much slower the add-ons may make the map before this check fails.
 * Each is a share of the frames the original app draws alone. HD buildings is
 * measured and reported but has no limit: it draws four times the pixels on a
 * Retina screen, which is what it is for.
 */
const LIMITS = {
  // Installed but switched off.
  idleFrames: 0.9,
  idleExtraMs: 2,
  // Any one switch on.
  oneSwitchFrames: 0.8,
  // Time zones is the known exception: its borders are lines on the ground,
  // and ground lines over the 3D buildings need an extra drawing pass.
  timeZonesFrames: 0.6,
  // Every switch on at once, except HD.
  allOnFrames: 0.5,
};

const SWITCHES = [
  ['map-labels-toggle', 'place names'],
  ['train-stations-toggle', 'train stations'],
  ['time-zones-toggle', 'time zones'],
  ['day-night-toggle', 'day and night'],
  ['hd-detail-toggle', 'HD buildings'],
];

async function load(page, { addOns }) {
  await page.goto('about:blank');
  await page.goto(`${BASE}/${addOns ? '' : '?addons=off'}#v=2&${VIEW}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    (wantSwitches) =>
      Boolean(window.__godsEyeView?.viewer) &&
      (!wantSwitches || document.getElementById('zenith-more-toggle')) &&
      !document.elementFromPoint(innerWidth / 2, 50)?.closest('#loading-screen'),
    { timeout: 120_000 },
    addOns,
  );
  await settle(page);
}

/** Wait until the 3D tiles for this view have finished loading. */
async function settle(page) {
  await page
    .waitForFunction(() => window.__godsEyeView.tileset?.tilesLoaded === true, { timeout: 60_000 })
    .catch(() => {});
  await sleep(2500);
}

async function setSwitch(page, id, on) {
  const isOn = await page.evaluate((button) => document.getElementById(button).getAttribute('aria-pressed') === 'true', id);
  if (isOn !== on) await page.click(`#${id}`);
}

/** Keep the view moving for a while and time every frame. */
function measure(page) {
  return page.evaluate(async (ms) => {
    const { scene, camera } = window.__godsEyeView.viewer;
    const work = [];
    let began = 0;
    const offStart = scene.preUpdate.addEventListener(() => {
      began = performance.now();
    });
    const offEnd = scene.postRender.addEventListener(() => {
      work.push(performance.now() - began);
    });
    const start = performance.now();
    let frames = 0;
    await new Promise((resolve) => {
      const step = (now) => {
        // A small roll to and fro: the view keeps changing, the tiles do not.
        camera.twistRight(Math.sin((now - start) / 400) * 0.0006);
        scene.requestRender();
        frames += 1;
        if (now - start < ms) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
    const seconds = (performance.now() - start) / 1000;
    offStart();
    offEnd();
    work.sort((a, b) => a - b);
    return {
      frames: frames / seconds,
      workMs: work[Math.floor(work.length / 2)] ?? 0,
      slowMs: work[Math.floor(work.length * 0.95)] ?? 0,
    };
  }, MEASURE_MS);
}

async function main() {
  try {
    const answer = await fetch(BASE, { signal: AbortSignal.timeout(4000) });
    if (!answer.ok) throw new Error(String(answer.status));
  } catch {
    console.error(`Zenith is not answering at ${BASE}. Start it first: ./alon-app.sh start`);
    process.exit(2);
  }
  const browser = await launchBrowser();
  if (!browser) {
    console.error('No browser to test with. Install Google Chrome, or set ZENITH_CHROME to a Chrome program.');
    process.exit(2);
  }
  const page = await browser.newPage();
  await page.setViewport(SIZE);
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    localStorage.setItem('gev:first-run-mission:v1', 'suppressed');
    localStorage.setItem('gev.helpCard', 'closed');
  });

  const rows = [];
  // Each state is measured twice and the better run kept: a hiccup on this
  // Mac must not read as an add-on being slow.
  const record = async (label) => {
    const first = await measure(page);
    const second = await measure(page);
    const result = second.frames > first.frames ? second : first;
    rows.push({ label, ...result });
    console.log(
      `  ${label.padEnd(30)} ${result.frames.toFixed(1).padStart(5)} frames/s   ${result.workMs.toFixed(1).padStart(5)} ms a frame (slowest ${result.slowMs.toFixed(1)} ms)`,
    );
    return result;
  };

  console.log('Speed check: 1440 x 900 at Retina sharpness, 3D buildings of London\n');
  await load(page, { addOns: false });
  const alone = await record('original app alone');

  await load(page, { addOns: true });
  for (const [id] of SWITCHES) await setSwitch(page, id, false);
  await settle(page);
  const idle = await record('add-ons, every switch off');

  const single = [];
  for (const [id, name] of SWITCHES) {
    await setSwitch(page, id, true);
    await settle(page);
    single.push([id, name, await record(`  + ${name}`)]);
    await setSwitch(page, id, false);
    await settle(page);
  }
  for (const [id] of SWITCHES) await setSwitch(page, id, id !== 'hd-detail-toggle');
  await settle(page);
  const all = await record('every switch on except HD');
  await setSwitch(page, 'hd-detail-toggle', true);
  await settle(page);
  await record('every switch on, HD too');
  for (const [id] of SWITCHES) await setSwitch(page, id, false);
  await browser.close();

  const problems = [];
  if (idle.frames < alone.frames * LIMITS.idleFrames) {
    problems.push(`with every switch off the map draws ${idle.frames.toFixed(0)} frames a second, against ${alone.frames.toFixed(0)} alone`);
  }
  if (idle.workMs > alone.workMs + LIMITS.idleExtraMs) {
    problems.push(`with every switch off each frame takes ${(idle.workMs - alone.workMs).toFixed(1)} ms more work than the original alone`);
  }
  for (const [id, name, result] of single) {
    if (id === 'hd-detail-toggle') continue;
    const limit = id === 'time-zones-toggle' ? LIMITS.timeZonesFrames : LIMITS.oneSwitchFrames;
    if (result.frames < alone.frames * limit) {
      problems.push(`${name} alone drops the map to ${result.frames.toFixed(0)} frames a second`);
    }
  }
  if (all.frames < alone.frames * LIMITS.allOnFrames) {
    problems.push(`with every switch on except HD the map draws ${all.frames.toFixed(0)} frames a second, against ${alone.frames.toFixed(0)} alone`);
  }

  console.log('');
  if (problems.length === 0) {
    console.log('Speed check passed: no add-on makes the map clearly slower than its limit.');
    console.log('HD buildings has no limit: on a Retina screen it draws four times the pixels.');
    process.exit(0);
  }
  for (const problem of problems) console.log(`TOO SLOW  ${problem}`);
  process.exit(1);
}

main().catch((error) => {
  console.error('The speed check itself broke:', error);
  process.exit(3);
});
