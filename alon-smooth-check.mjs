#!/usr/bin/env node
/**
 * Zenith's smoothness check: how fast the app starts and how smoothly the map
 * moves, on the free satellite map with the paid 3D map blocked, at Retina
 * sharpness (1440 x 900, two device pixels per point).
 *
 * It measures, in Chrome:
 * - start: time from opening the page to the app being ready and to the
 *   first map drawn, on a fresh start (nothing cached) and on a reload, and
 *   how many files and bytes the page loads;
 * - standing still: how many frames the map draws in five seconds when
 *   nothing moves, and how busy the page keeps the computer meanwhile;
 * - moving: frames a second and the work per frame while the view turns,
 *   and while it zooms;
 * - memory: the page's JavaScript memory;
 * - which files take the most time while the view moves (a profile).
 *
 *   node alon-smooth-check.mjs [--label "before"] [--runs 2] [--json out.json]
 *
 * Zenith must be running at ZENITH_URL (default http://localhost:4173).
 */
import { writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';

import { launchBrowser, paid3dBlocker, sleep } from './alon-browser.mjs';

const BASE = process.env.ZENITH_URL || 'http://localhost:4173';
const VIEW = 'lat=51.5055&lon=-0.0754&alt=900&heading=20&pitch=-35&map=esri-imagery';
const SIZE = { width: 1440, height: 900, deviceScaleFactor: 2 };
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};
const LABEL = option('label', 'now');
const RUNS = Number(option('runs', '2'));
const JSON_OUT = option('json', null);

/** The page settings a person who chose the satellite map has. */
async function prepare(page) {
  await page.goto(`${BASE}/alon/zenith-favicon.png`);
  await page.evaluate(() => {
    localStorage.setItem('gev.satelliteByChoice', '1');
    localStorage.setItem('gev:first-run-mission:v1', 'suppressed');
    localStorage.setItem('gev.helpCard', 'closed');
  });
}

/** Open the app and time it: ready to use, and first map fully drawn. */
async function timedOpen(page, client, { addOns = true } = {}) {
  let files = 0;
  let bytes = 0;
  const onResponse = (event) => {
    files += 1;
    bytes += event.encodedDataLength || 0;
  };
  client.on('Network.loadingFinished', onResponse);
  // A real page load each time: a jump to the same address would only change the view.
  await page.goto('about:blank');
  const started = Date.now();
  await page.goto(`${BASE}/${addOns ? '' : '?addons=off'}#v=2&${VIEW}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    (wantAddOns) =>
      Boolean(window.__godsEyeView?.viewer) &&
      (!wantAddOns || document.getElementById('zenith-more-toggle')) &&
      !document.elementFromPoint(innerWidth / 2, 50)?.closest('#loading-screen'),
    { timeout: 180_000, polling: 50 },
    addOns,
  );
  const readyMs = Date.now() - started;
  await page.waitForFunction(() => window.__godsEyeView.viewer.scene.globe.tilesLoaded === true, {
    timeout: 120_000,
    polling: 50,
  });
  const mapMs = Date.now() - started;
  client.off('Network.loadingFinished', onResponse);
  return { readyMs, mapMs, files, megabytes: bytes / 1048576 };
}

/** Five seconds without touching anything: frames drawn and how busy the page is. */
async function standingStill(page, client) {
  await sleep(3000);
  const before = await metrics(client);
  const frames = await page.evaluate(async () => {
    const { scene } = window.__godsEyeView.viewer;
    let count = 0;
    const off = scene.postRender.addEventListener(() => {
      count += 1;
    });
    await new Promise((resolve) => setTimeout(resolve, 5000));
    off();
    return count / 5;
  });
  const after = await metrics(client);
  return { idleFrames: frames, idleBusy: (after.TaskDuration - before.TaskDuration) / 5 };
}

/** Keep the view moving and time every frame: turning, or zooming in and out. */
function moving(page, kind) {
  return page.evaluate(async (how) => {
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
        const t = (now - start) / 1000;
        if (how === 'turn') camera.twistRight(Math.sin(t * 2.5) * 0.0006);
        else camera.zoomIn(Math.sin(t * 1.6) * 12);
        scene.requestRender();
        frames += 1;
        if (now - start < 5000) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
    const seconds = (performance.now() - start) / 1000;
    offStart();
    offEnd();
    work.sort((a, b) => a - b);
    return {
      fps: frames / seconds,
      drawn: work.length / seconds,
      workMs: work[Math.floor(work.length / 2)] ?? 0,
      slowMs: work[Math.floor(work.length * 0.95)] ?? 0,
    };
  }, kind);
}

async function metrics(client) {
  const { metrics: list } = await client.send('Performance.getMetrics');
  return Object.fromEntries(list.map(({ name, value }) => [name, value]));
}

/** Which files take the most time while the view turns. */
async function profile(page, client) {
  await client.send('Profiler.enable');
  await client.send('Profiler.setSamplingInterval', { interval: 200 });
  await client.send('Profiler.start');
  await moving(page, 'turn');
  const { profile: result } = await client.send('Profiler.stop');
  const byFile = new Map();
  const ids = new Map(result.nodes.map((node) => [node.id, node]));
  const counts = new Map();
  for (const sample of result.samples) counts.set(sample, (counts.get(sample) || 0) + 1);
  let total = 0;
  for (const [id, count] of counts) {
    const node = ids.get(id);
    const url = node.callFrame.url || `(${node.callFrame.functionName || 'idle'})`;
    if (url === '(idle)' || url === '(program)' || url === '(garbage collector)') {
      total += count;
      if (url !== '(idle)') byFile.set(url, (byFile.get(url) || 0) + count);
      continue;
    }
    const short = url.replace(/^https?:\/\/[^/]+\//, '').replace(/\?.*$/, '');
    byFile.set(short, (byFile.get(short) || 0) + count);
    total += count;
  }
  const share = (count) => (100 * count) / total;
  const all = [...byFile].map(([file, count]) => ({ file, percent: share(count) })).sort((a, b) => b.percent - a.percent);
  return {
    top: all.slice(0, 12),
    zenith: all.filter(({ file }) => /^src\/(app|ui)\/|server\/alon/.test(file)).slice(0, 12),
  };
}

async function oneRun(browser) {
  // A fresh, separate browser profile: nothing cached, as on a first start.
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport(SIZE);
  const block = await paid3dBlocker(page);
  await block(true);
  const client = await page.target().createCDPSession();
  await client.send('Network.enable');
  await client.send('Performance.enable');
  await prepare(page);
  const fresh = await timedOpen(page, client);
  const still = await standingStill(page, client);
  const turn = await moving(page, 'turn');
  const zoom = await moving(page, 'zoom');
  const memory = (await metrics(client)).JSHeapUsedSize / 1048576;
  const reload = await timedOpen(page, client);
  const profiled = await profile(page, client);
  await context.close();
  return { fresh, reload, ...still, turn, zoom, memoryMb: memory, profiled };
}

const better = (a, b) => (a.turn.fps >= b.turn.fps ? a : b);

async function main() {
  try {
    const answer = await fetch(BASE, { signal: AbortSignal.timeout(4000) });
    if (!answer.ok) throw new Error(String(answer.status));
  } catch {
    console.error(`Zenith is not answering at ${BASE}.`);
    process.exit(2);
  }
  const browser = await launchBrowser();
  if (!browser) {
    console.error('No browser to test with.');
    process.exit(2);
  }
  const load = loadavg()[0];
  const runs = [];
  try {
    for (let i = 0; i < RUNS; i++) runs.push(await oneRun(browser));
  } finally {
    await browser.close();
  }
  // The best run for the moving numbers; the quickest start of all runs.
  const best = runs.reduce(better);
  const quickest = (pick) => Math.min(...runs.map(pick));
  const result = {
    label: LABEL,
    when: new Date().toISOString(),
    machineLoad: Number(load.toFixed(1)),
    startReadyS: quickest((run) => run.fresh.readyMs) / 1000,
    startMapS: quickest((run) => run.fresh.mapMs) / 1000,
    reloadReadyS: quickest((run) => run.reload.readyMs) / 1000,
    reloadMapS: quickest((run) => run.reload.mapMs) / 1000,
    files: best.fresh.files,
    megabytes: Number(best.fresh.megabytes.toFixed(1)),
    idleFrames: Math.min(...runs.map((run) => run.idleFrames)),
    idleBusyPercent: Number((100 * Math.min(...runs.map((run) => run.idleBusy))).toFixed(1)),
    turnFps: Number(best.turn.fps.toFixed(1)),
    turnWorkMs: Number(best.turn.workMs.toFixed(1)),
    turnSlowMs: Number(best.turn.slowMs.toFixed(1)),
    zoomFps: Number(best.zoom.fps.toFixed(1)),
    zoomWorkMs: Number(best.zoom.workMs.toFixed(1)),
    memoryMb: Number(best.memoryMb.toFixed(0)),
    profileTop: best.profiled.top.map(({ file, percent }) => `${file} ${percent.toFixed(1)}%`),
    profileZenith: best.profiled.zenith.map(({ file, percent }) => `${file} ${percent.toFixed(1)}%`),
  };
  console.log(JSON.stringify(result, null, 1));
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(result, null, 1));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
