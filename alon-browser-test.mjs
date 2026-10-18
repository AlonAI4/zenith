#!/usr/bin/env node
/**
 * Zenith's automatic browser test.
 *
 * Opens the running app in a real (headless) browser and checks every add-on
 * this build has: that it started, that its switch works and that it does
 * its job. It does so four times: on the 3D map and on the satellite map, on
 * a wide window and on a narrow one. A few checks that need their own page
 * load run once at the end.
 *
 * It prints one line per check and exits with a failure if any check fails.
 * A check that cannot run (no plane on screen, for example) is reported as
 * skipped with the reason, never as passed.
 *
 *   node alon-browser-test.mjs                 everything
 *   node alon-browser-test.mjs --quick         one setup: 3D map, wide window
 *   node alon-browser-test.mjs --only measure  checks whose name has the word
 *   node alon-browser-test.mjs --setup 4       one of the four setups
 *
 * The app must be running (./alon-app.sh start). A new add-on gets a check
 * here before it is committed.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { launchBrowser, paid3dBlocker, sleep } from './alon-browser.mjs';

const BASE = process.env.ZENITH_URL || 'http://localhost:4173';
const LONDON = 'lat=51.5055&lon=-0.0754&alt=900&heading=20&pitch=-35';
const WIDE = { width: 1440, height: 900 };
const NARROW = { width: 900, height: 800 };

/** The switches this build adds. Keep in step with src/app/zenithSwitches.js. */
const SWITCHES = [
  'zenith-layers-toggle',
  'map-labels-toggle',
  'train-stations-toggle',
  'earthquakes-toggle',
  'time-zones-toggle',
  'day-night-toggle',
  'address-lookup-toggle',
  'hd-detail-toggle',
  'space-view-toggle',
  'classified-toggle',
  'measure-toggle',
  'saved-places-toggle',
  'watch-zones-toggle',
  'video-mode-toggle',
  'zenith-help-toggle',
];
/** The map overlays, which sit in the LAYERS menu; the rest sit in the bar (or its tray). */
const LAYERS = ['map-labels-toggle', 'train-stations-toggle', 'earthquakes-toggle', 'time-zones-toggle', 'day-night-toggle', 'hd-detail-toggle', 'space-view-toggle'];
const BAR_SWITCHES = SWITCHES.filter((id) => !LAYERS.includes(id));
const PARTS = [...SWITCHES, 'compass-dial', 'scale-bar', 'tracking-marker', 'zenith-more-toggle'];
/** Switches a check may leave on by accident; calm() turns them off again. */
const RESETTABLE = [
  'map-labels-toggle',
  'train-stations-toggle',
  'earthquakes-toggle',
  'time-zones-toggle',
  'day-night-toggle',
  'address-lookup-toggle',
  'measure-toggle',
];

const args = process.argv.slice(2);
const quick = args.includes('--quick');
const setupAt = args.indexOf('--setup');
const onlySetup = setupAt >= 0 ? Number(args[setupAt + 1]) : null;
const onlyAt = args.indexOf('--only');
const only = onlyAt >= 0 ? (args[onlyAt + 1] || '').toLowerCase().split(',') : null;

class Skip extends Error {}
const expect = (condition, why) => {
  if (!condition) throw new Error(why);
};
const turn = (from, to) => ((to - from + 540) % 360) - 180;

/** Helpers that live in the page, so each check stays short. */
function pageHelpers() {
  const app = () => window.__godsEyeView;
  const EMOJI = /\p{RGI_Emoji}|(?=[\u{1F000}-\u{1FAFF}])\p{Extended_Pictographic}/v;
  const drawnEmojis = new Set();
  for (const name of ['fillText', 'strokeText']) {
    const own = CanvasRenderingContext2D.prototype[name];
    CanvasRenderingContext2D.prototype[name] = function (text, ...rest) {
      if (typeof text === 'string' && EMOJI.test(text)) drawnEmojis.add(text.slice(0, 60));
      return own.call(this, text, ...rest);
    };
  }
  const deg = (radians) => (radians * 180) / Math.PI;
  window.__zt = {
    viewer: () => app().viewer,
    map: () => app().mapStackController?.getActiveStack?.()?.id ?? null,
    heading: () => deg(app().viewer.camera.heading),
    pitch: () => deg(app().viewer.camera.pitch),
    height: () => app().viewer.camera.positionCartographic.height,
    pressed: (id) => document.getElementById(id)?.getAttribute('aria-pressed') === 'true',
    shown: (element) =>
      Boolean(element) &&
      element.getClientRects().length > 0 &&
      getComputedStyle(element).visibility !== 'hidden',
    entities: (name) => app().viewer.dataSources.getByName(name)[0]?.entities.values.length ?? 0,
    labels: (name) => {
      const found = new RegExp(`"${name}":(\\d+)`).exec(
        JSON.stringify(window.__gevWorldOverlay?.getDiagnostics?.() ?? {}),
      );
      return found ? Number(found[1]) : 0;
    },
    // Labels really drawn on screen this frame, not just handed over.
    painted: (name) => window.__gevWorldOverlay?.getDiagnostics?.().paintedBySource?.[name] ?? 0,
    imagery: () => {
      const { viewer, tileset } = app();
      const host = viewer.scene.globe.show ? viewer.imageryLayers : tileset?.imageryLayers;
      return host ? host.length : -1;
    },
    // Station markers only: a station's billboard carries the station (a name
    // and a kind) as its id. Other billboards, such as the map pin, do not count.
    stationMarkers: () => {
      const primitives = app().viewer.scene.primitives;
      let total = 0;
      for (let i = 0; i < primitives.length; i++) {
        const one = primitives.get(i);
        if (!one || typeof one.length !== 'number' || typeof one.get !== 'function') continue;
        for (let j = 0; j < one.length; j++) {
          const id = one.get(j)?.id;
          if (id && typeof id.name === 'string' && typeof id.kind === 'string') total += 1;
        }
      }
      return total;
    },
    // The picture on screen, shrunk to a small grid of brightness values
    // (0 to 255). Drawn and read in one go, because the map does not keep
    // its picture between frames.
    frame: () => {
      const { scene } = app().viewer;
      scene.render();
      const small = document.createElement('canvas');
      small.width = 96;
      small.height = 60;
      const ctx = small.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(scene.canvas, 0, 0, small.width, small.height);
      const data = ctx.getImageData(0, 0, small.width, small.height).data;
      const grid = [];
      for (let i = 0; i < data.length; i += 4) grid.push(Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]));
      return grid;
    },
    // Emojis anywhere in the page, in CSS-drawn text, or drawn on a canvas
    // (the map's labels). An emoji is what a browser draws in colour; the
    // drawn icons keep the emoji only in a hidden span for screen readers.
    emojis: () => {
      const found = new Set();
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!EMOJI.test(node.data)) continue;
        const holder = node.parentElement;
        if (!holder || holder.closest('.zenith-glyph-text, script, style, template, option')) continue;
        found.add(`${holder.id || holder.className || holder.tagName}: ${node.data.trim().slice(0, 50)}`);
      }
      for (const element of document.querySelectorAll('body *')) {
        for (const part of ['::before', '::after']) {
          const content = getComputedStyle(element, part).content;
          if (content && content !== 'none' && EMOJI.test(content)) found.add(`${element.id || element.className} ${part}: ${content}`);
        }
      }
      // Tooltips and menu choices cannot hold a drawn icon, so they must have none.
      for (const element of document.querySelectorAll('[title], option')) {
        const text = element.tagName === 'OPTION' ? element.textContent : element.title;
        if (EMOJI.test(text)) found.add(`${element.tagName.toLowerCase()} ${element.id || element.className}: ${text.slice(0, 50)}`);
      }
      for (const text of drawnEmojis) found.add(`drawn on a canvas: ${text}`);
      return [...found];
    },
    // The target box's light: what kind, the volumes lighting 3D buildings,
    // and whether the rest of the map is dimmed.
    spotlight: () => {
      const { scene } = app().viewer;
      let volumes = 0;
      for (let i = 0; i < scene.primitives.length; i++) {
        if (scene.primitives.get(i)?.constructor?.name === 'ClassificationPrimitive') volumes += 1;
      }
      return { mode: document.body.dataset.spotlight ?? '', volumes, dimmed: scene.invertClassification === true };
    },
    // Is the map still drawing, and has any add-on been switched off?
    alive: async () => {
      const { scene } = app().viewer;
      const before = scene.frameState.frameNumber;
      for (let i = 0; i < 4; i++) {
        scene.requestRender();
        await new Promise((next) => requestAnimationFrame(next));
      }
      return {
        frames: scene.frameState.frameNumber - before,
        loop: app().viewer.useDefaultRenderLoop,
        notice: document.getElementById('zenith-addon-notice')?.textContent ?? '',
      };
    },
    dayNightDrawn: () => {
      const { viewer, tileset } = app();
      return viewer.scene.globe.show ? viewer.scene.globe.material?.type === 'ZenithDayNight' : Boolean(tileset?.customShader);
    },
    creditsClear: () => {
      const link = document.querySelector('#cesium-credits a, #cesium-credits img');
      if (!link) return false;
      const r = link.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return r.width > 0 && Boolean(top?.closest('#cesium-credits'));
    },
    box: (selector) => {
      const element = document.querySelector(selector);
      if (!window.__zt.shown(element)) return null;
      const r = element.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    },
  };
}

const results = [];
let pageErrors = [];
/** Errors the page wrote to its console. Outside services log some, so they are counted, not failed. */
const consoleErrors = [];

/**
 * What the 3D map's provider has been doing. When the 3D map is slow to come
 * back, this is what tells "the provider is slow or refusing right now"
 * (reported as skipped, with what was seen) from "the app is broken" (a
 * failure).
 */
const SLOW_MS = 8000;
const provider = { pending: new Map(), events: [] };
/** Blocks the metered 3D map (true) or lets it through (false); set up in main(). */
let block3d = async () => {};
/** Answers that came back from the metered 3D map, so far, and when the page was last opened. */
const paid3d = { answers: 0, atOpen: 0 };
const isPaid3d = (url) => /^https?:\/\/(tile\.googleapis\.com\/|api\.cesium\.com\/v1\/assets\/(2275207|2684829)\/)/.test(url);
function watchProvider(page) {
  const isProvider = (url) => {
    try {
      return /(^|\.)cesium\.com$|^tile\.googleapis\.com$/.test(new URL(url).host);
    } catch {
      return false;
    }
  };
  const finished = (request, what) => {
    const started = provider.pending.get(request);
    if (started === undefined) return;
    provider.pending.delete(request);
    const took = Date.now() - started;
    if (what) provider.events.push({ at: Date.now(), what });
    else if (took > SLOW_MS) provider.events.push({ at: Date.now(), what: `an answer took ${Math.round(took / 1000)} s` });
    if (provider.events.length > 400) provider.events.splice(0, 200);
  };
  page.on('request', (request) => {
    if (isProvider(request.url())) provider.pending.set(request, Date.now());
  });
  page.on('response', (response) => {
    if (isPaid3d(response.url())) paid3d.answers += 1;
    finished(response.request(), response.status() >= 400 ? `refused with ${response.status()}` : '');
  });
  page.on('requestfailed', (request) => {
    const why = request.failure()?.errorText ?? 'unknown';
    // Leaving a page cancels what it was loading, and the satellite runs
    // block the metered 3D map on purpose: neither is trouble.
    if (/ERR_ABORTED|ERR_BLOCKED_BY_CLIENT/.test(why)) provider.pending.delete(request);
    else finished(request, `a request failed (${why})`);
  });
}
/** Trouble at the 3D map's provider in the last while, in words; '' when there was none. */
function providerTrouble(withinMs = 45_000) {
  const since = Date.now() - withinMs;
  const seen = provider.events.filter((event) => event.at >= since).map((event) => event.what);
  let waiting = 0;
  for (const started of provider.pending.values()) if (Date.now() - started > SLOW_MS) waiting += 1;
  if (waiting) seen.push(`${waiting} request${waiting === 1 ? '' : 's'} unanswered after ${SLOW_MS / 1000} s`);
  return [...new Set(seen)].slice(0, 3).join(', ');
}

async function until(page, test, ms, why, ...testArgs) {
  const end = Date.now() + ms;
  for (;;) {
    if (await page.evaluate(test, ...testArgs)) return;
    if (Date.now() > end) throw new Error(why);
    await sleep(150);
  }
}

async function open(page, size, hash) {
  await page.setViewport(size);
  await page.goto('about:blank');
  await page.goto(`${BASE}/#v=2&${hash}`, { waitUntil: 'domcontentloaded' });
  await until(
    page,
    () => Boolean(document.getElementById('zenith-more-toggle') && window.__godsEyeView?.viewer),
    90_000,
    'the app did not finish starting',
  );
  // The loading screen fades out over the page and swallows clicks until it
  // has gone.
  await until(
    page,
    () => {
      const top = document.elementFromPoint(innerWidth / 2, 50);
      return Boolean(top) && !top.closest('#loading-screen');
    },
    60_000,
    'the loading screen never went away',
  );
  // Let the first tiles and the saved view settle.
  await sleep(2500);
}

/**
 * True when the 3D map's provider is refusing to load right now. The app then
 * falls back to the satellite map by itself and says so. That is a state of
 * the outside world, not a fault in the app, so checks that need the 3D map
 * are skipped with this as the reason, never counted as passed.
 */
const provider3dDown = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('[role="status"]')].some((notice) =>
      /3D map stopped loading/.test(notice.textContent),
    ),
  );

async function pickMap(page, id) {
  if ((await page.evaluate(() => window.__zt.map())) === id) return;
  await page.evaluate(
    (stack) => document.querySelector(`.map-stack-chip[data-stack-id="${stack}"]`)?.click(),
    id,
  );
  try {
    await until(page, (stack) => window.__zt.map() === stack, 20_000, `the map did not switch to ${id}`, id);
  } catch (error) {
    const trouble = providerTrouble();
    if (id === 'photoreal' && ((await provider3dDown(page)) || trouble)) {
      throw new Skip(`the 3D map provider is not answering properly right now (${trouble || 'the app fell back to satellite by itself'})`);
    }
    throw error;
  }
  // The map chips live in the Visual Presets tray. Close it again, as a
  // person would: on a narrow window it covers the lower left of the map.
  await page.evaluate(() => {
    const panel = document.getElementById('control-panel');
    if (panel && !panel.classList.contains('collapsed')) {
      window.__godsEyeView.styleManager?.setPanelCollapsed?.('control-panel', true, { explicit: true });
    }
  });
  await sleep(3000);
}

const trayOpen = (page) =>
  page.evaluate(() => document.getElementById('zenith-tray')?.dataset.open === 'true');

/**
 * Click one of the switches, opening the tray first when it is folded away.
 * The tray is closed again afterwards unless leaveTray is set (video mode
 * hides it, and a second click would end video mode).
 */
async function press(page, id, { leaveTray = false } = {}) {
  const where = await page.evaluate((button) => {
    const element = document.getElementById(button);
    if (!element) return 'missing';
    if (element.closest('#zenith-layers-menu')) return 'layers';
    return element.closest('#zenith-tray') ? 'tray' : 'bar';
  }, id);
  expect(where !== 'missing', `there is no #${id}`);
  if (where === 'layers') {
    // A map overlay: open the LAYERS menu, press it, close the menu again.
    // Closed by its own button directly: on a narrow window, opening the
    // tray to reach that button would count as a click outside the menu.
    await press(page, 'zenith-layers-toggle');
    await page.click(`#${id}`);
    await page.evaluate(() => document.getElementById('zenith-layers-toggle').click());
    await until(page, () => document.getElementById('zenith-layers-menu').dataset.open !== 'true', 2000, 'the LAYERS menu did not close');
    await sleep(250);
    return;
  }
  const opened = where === 'tray' && !(await trayOpen(page));
  if (opened) await page.click('#zenith-more-toggle');
  await page.click(`#${id}`);
  if (opened && !leaveTray && (await trayOpen(page))) await page.click('#zenith-more-toggle');
  await sleep(250);
}

const pressed = (page, id) => page.evaluate((button) => window.__zt.pressed(button), id);

/** Back to a quiet state, so one failed check does not spoil the next. */
async function calm(page) {
  await page.keyboard.press('Escape');
  for (const id of RESETTABLE) if (await pressed(page, id)) await press(page, id);
  if (await trayOpen(page)) await page.click('#zenith-more-toggle');
}

/** Spots on the map clear of every panel, as fractions of the window. */
const spot = (page, fx, fy) => {
  const { width, height } = page.viewport();
  return [Math.round(width * fx), Math.round(height * fy)];
};
const clickMap = async (page, fx, fy) => {
  const [x, y] = spot(page, fx, fy);
  await page.mouse.click(x, y);
  await sleep(700);
};

/** Hand a file to the settings picker in the help card, as a person would choose it. */
async function chooseSettingsFile(page, text) {
  const folder = mkdtempSync(join(tmpdir(), 'zenith-settings-'));
  const file = join(folder, 'zenith-settings.json');
  try {
    writeFileSync(file, text);
    const picker = await page.$('#zenith-settings-picker');
    await picker.uploadFile(file);
    await picker.evaluate((input) => input.dispatchEvent(new Event('change', { bubbles: true })));
    await until(page, () => document.getElementById('zenith-settings-message').textContent.length > 0, 5000, 'choosing a settings file said nothing');
    await sleep(200);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
  return page.evaluate(() => ({
    said: document.getElementById('zenith-settings-message').textContent,
    bad: document.getElementById('zenith-settings-message').dataset.bad === 'true',
    reload: !document.getElementById('zenith-settings-reload').hidden,
  }));
}

/**
 * Open the app over Heathrow with live flights on and click a plane, so the
 * view follows it. Skips the check when no plane is there to follow.
 */
async function followPlane(page) {
  await open(page, WIDE, 'lat=51.47&lon=-0.45&alt=90000&heading=0&pitch=-89&l=f');
  await sleep(8000);
  const plane = await page.evaluate(() => {
    const viewer = window.__zt.viewer();
    const primitives = viewer.scene.primitives;
    for (let i = 0; i < primitives.length; i++) {
      const one = primitives.get(i);
      if (!one || typeof one.length !== 'number' || typeof one.get !== 'function') continue;
      for (let j = 0; j < one.length; j++) {
        const item = one.get(j);
        if (!item || typeof item.id !== 'string' || !item.position || item.show === false) continue;
        const at = viewer.scene.cartesianToCanvasCoordinates(item.position);
        if (at && at.x > 380 && at.x < 1050 && at.y > 260 && at.y < 640) return [Math.round(at.x), Math.round(at.y)];
      }
    }
    return null;
  });
  if (!plane) throw new Skip('no plane on screen to follow');
  await page.mouse.click(plane[0], plane[1]);
  await sleep(4500);
  if (!(await page.evaluate(() => Boolean(window.__zt.viewer().trackedEntity)))) {
    throw new Skip('the click did not start following a plane');
  }
}

// ── The checks ───────────────────────────────────────────────────────────────

const checks = [
  [
    'everything started',
    async (page) => {
      const state = await page.evaluate((ids) => {
        const viewer = window.__zt.viewer();
        return {
          missing: ids.filter((id) => !document.getElementById(id)),
          notice: document.getElementById('zenith-addon-notice')?.textContent ?? null,
          drawing: viewer.useDefaultRenderLoop && !document.querySelector('.cesium-widget-errorPanel'),
        };
      }, PARTS);
      expect(state.missing.length === 0, `missing: ${state.missing.join(', ')}`);
      expect(!state.notice, `an add-on reported a failure: ${state.notice}`);
      expect(state.drawing, 'the map has stopped drawing');
      expect(pageErrors.length === 0, `page errors: ${pageErrors.slice(0, 2).join(' | ')}`);
    },
  ],
  [
    'top bar and compass fit the window',
    async (page, setup) => {
      const state = await page.evaluate((switches) => {
        const { box } = window.__zt;
        const rects = {
          bar: box('#top-center-actions'),
          dial: box('#compass-dial svg'),
          label: box('#style-indicator'),
          title: box('#title-bar h1 > span:not(.title-logo)') ?? box('#title-bar .title-logo'),
        };
        const hit = (a, b) =>
          a && b && a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
        const pairs = [
          ['dial', 'bar'],
          ['dial', 'label'],
          ['dial', 'title'],
          ['bar', 'title'],
          ['bar', 'label'],
        ];
        return {
          overlaps: pairs.filter(([a, b]) => hit(rects[a], rects[b])).map((pair) => pair.join('+')),
          dialInside: Boolean(rects.dial) && rects.dial.left >= 0 && rects.dial.right <= innerWidth && rects.dial.top >= 0,
          inTray: switches.filter((id) => document.getElementById(id)?.closest('#zenith-tray')).length,
          more: window.__zt.shown(document.getElementById('zenith-more-toggle')),
        };
      }, BAR_SWITCHES);
      expect(state.overlaps.length === 0, `overlapping: ${state.overlaps.join(', ')}`);
      expect(state.dialInside, 'the compass is partly off the window');
      if (setup.narrow) {
        expect(state.inTray === BAR_SWITCHES.length && state.more, 'the switches did not fold into the tray');
        await page.click('#zenith-more-toggle');
        expect(await trayOpen(page), 'the tray did not open');
        await page.keyboard.press('Escape');
        expect(!(await trayOpen(page)), 'Escape did not close the tray');
        // The more button counts the switches in the tray that are on.
        await press(page, 'address-lookup-toggle');
        const badge = await page.evaluate(
          (switches) => ({
            says: document.getElementById('zenith-more-toggle').dataset.on,
            on: String(switches.filter((id) => document.getElementById(id)?.getAttribute('aria-pressed') === 'true').length),
          }),
          BAR_SWITCHES,
        );
        expect(badge.says === badge.on, `with ${badge.on} switches on the more button says "${badge.says}"`);
        // Clicking a switch's name in the tray works like clicking the switch.
        await page.click('#zenith-more-toggle');
        await page.evaluate(() => document.getElementById('address-lookup-toggle').closest('.zt-row').querySelector('.zt-name').click());
        await sleep(300);
        expect(!(await pressed(page, 'address-lookup-toggle')), 'clicking the name Map pin in the tray did not switch it off');
        if (!(await trayOpen(page))) await page.click('#zenith-more-toggle');
        await clickMap(page, 0.5, 0.8);
        expect(!(await trayOpen(page)), 'a click on the map did not close the tray');
      } else {
        expect(state.inTray === 0 && !state.more, 'the switches should sit in the bar on a wide window');
        // Narrowing the window live folds the switches away and keeps what is on.
        await press(page, 'time-zones-toggle');
        const inTray = () =>
          page.evaluate((switches) => switches.filter((id) => document.getElementById(id)?.closest('#zenith-tray')).length, BAR_SWITCHES);
        try {
          await page.setViewport(NARROW);
          await sleep(800);
          expect((await inTray()) === BAR_SWITCHES.length, 'narrowing the window did not fold the switches into the tray');
          expect(await pressed(page, 'time-zones-toggle'), 'folding the switches away switched Time zones off');
          await page.setViewport(WIDE);
          await sleep(800);
          expect((await inTray()) === 0, 'widening the window did not bring the switches back to the bar');
        } finally {
          await page.setViewport(WIDE);
          if (await pressed(page, 'time-zones-toggle')) await press(page, 'time-zones-toggle');
        }
      }
    },
  ],
  [
    'the LAYERS menu: the map overlays in one menu that works from the keyboard, and the compass does tilt and north',
    async (page) => {
      const state = await page.evaluate((layers) => ({
        inMenu: layers.filter((id) => document.getElementById(id)?.closest('#zenith-layers-menu')).length,
        hidden: ['tilt-map-view', 'north-up-view'].every((id) => getComputedStyle(document.getElementById(id)).display === 'none'),
      }), LAYERS);
      expect(state.inMenu === LAYERS.length, `only ${state.inMenu} of the ${LAYERS.length} overlays are in the LAYERS menu`);
      expect(state.hidden, 'the tilt and north buttons still show (the compass does both)');
      const menuOpen = () => page.evaluate(() => document.getElementById('zenith-layers-menu').dataset.open === 'true');
      // From the keyboard: Enter opens it on the first row, arrows move, Space switches, Escape closes.
      const where = await page.evaluate(() => (document.getElementById('zenith-layers-toggle').closest('#zenith-tray') ? 'tray' : 'bar'));
      if (where === 'tray') await page.click('#zenith-more-toggle');
      await page.focus('#zenith-layers-toggle');
      await page.keyboard.press('Enter');
      await sleep(200);
      expect(await menuOpen(), 'Enter did not open the LAYERS menu');
      expect((await page.evaluate(() => document.activeElement?.id)) === LAYERS[0], 'the menu did not start on its first row');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      expect((await page.evaluate(() => document.activeElement?.id)) === LAYERS[2], 'the arrow keys did not move down the menu');
      const before = await pressed(page, LAYERS[2]);
      await page.keyboard.press('Space');
      await sleep(400);
      expect((await pressed(page, LAYERS[2])) !== before, 'Space did not switch the overlay');
      const badge = await page.evaluate((layers) => ({
        says: document.getElementById('zenith-layers-toggle').dataset.on ?? '0',
        on: String(layers.filter((id) => document.getElementById(id)?.getAttribute('aria-pressed') === 'true').length),
      }), LAYERS);
      expect(badge.says === badge.on, `with ${badge.on} overlays on the LAYERS button says "${badge.says}"`);
      await page.keyboard.press('Space');
      await sleep(300);
      await page.keyboard.press('Escape');
      expect(!(await menuOpen()), 'Escape did not close the LAYERS menu');
      // Back to the LAYERS button, or on a narrow window to the closed tray's button.
      const back = where === 'tray' ? 'zenith-more-toggle' : 'zenith-layers-toggle';
      expect((await page.evaluate(() => document.activeElement?.id)) === back, `Escape did not give the focus back to #${back}`);
      // Over the help card (which opens by itself the first time), a row can still be clicked.
      await press(page, 'zenith-help-toggle');
      await press(page, 'zenith-layers-toggle');
      const row = await page.evaluate((id) => {
        const r = document.getElementById(id).getBoundingClientRect();
        return [r.left + r.width / 2, r.top + r.height / 2];
      }, LAYERS[3]);
      const wasOn = await pressed(page, LAYERS[3]);
      await page.mouse.click(row[0], row[1]);
      await sleep(400);
      expect((await pressed(page, LAYERS[3])) !== wasOn, 'a LAYERS row could not be clicked over the help card');
      expect(await menuOpen(), 'clicking a LAYERS row over the help card closed the menu');
      await page.mouse.click(row[0], row[1]);
      await sleep(300);
      await page.evaluate(() => document.getElementById('zenith-layers-toggle').click());
      await press(page, 'zenith-help-toggle');
      // A click on the map closes it too.
      await press(page, 'zenith-layers-toggle');
      expect(await menuOpen(), 'a click did not open the LAYERS menu');
      await clickMap(page, 0.5, 0.8);
      expect(!(await menuOpen()), 'a click on the map did not close the LAYERS menu');
      if (await trayOpen(page)) await page.click('#zenith-more-toggle');
    },
  ],
  [
    'every switch has a key that works it, named in its tooltip, and keys do nothing while typing',
    async (page) => {
      // Each switch's key, from its tooltip: "Map pin (P)".
      const keys = await page.evaluate((ids) => ids.map((id) => {
        const button = document.getElementById(id);
        return [id, /\(([^)]{1})\)$/.exec(button?.title ?? '')?.[1] ?? null];
      }), SWITCHES);
      const untitled = keys.filter(([, key]) => !key).map(([id]) => id);
      expect(untitled.length === 0, `no key in the tooltip of: ${untitled.join(', ')}`);
      const state = (id) =>
        page.evaluate((id) => {
          const button = document.getElementById(id);
          return `${button.getAttribute('aria-pressed')}|${button.getAttribute('aria-expanded')}`;
        }, id);
      await page.evaluate(() => document.activeElement?.blur?.());
      for (const [id, key] of keys) {
        const before = await state(id);
        await page.keyboard.press(key === '?' ? '?' : key.toLowerCase());
        await sleep(500);
        const after = await state(id);
        // And back again, so every switch is left as it was. (A panel may
        // have put the focus in its own box, where a key is typing.)
        await page.evaluate(() => document.activeElement?.blur?.());
        await page.keyboard.press(key === '?' ? '?' : key.toLowerCase());
        await sleep(500);
        expect(after !== before, `the ${key} key did not work #${id}`);
        expect((await state(id)) === before, `pressing ${key} twice did not put #${id} back`);
        await page.evaluate(() => document.activeElement?.blur?.());
      }
      // Typing a P in a box is typing, not the map pin.
      const pin = await state('address-lookup-toggle');
      await page.evaluate(() => {
        const box = document.createElement('input');
        box.id = 'zt-typing';
        document.body.appendChild(box);
        box.focus();
      });
      await page.keyboard.type('pmt');
      expect((await state('address-lookup-toggle')) === pin, 'typing in a box worked the map pin');
      await page.evaluate(() => document.getElementById('zt-typing').remove());
    },
  ],
  [
    "with the HUD on, its bottom corners clear the two-line map credits",
    async (page) => {
      await page.evaluate(() => document.activeElement?.blur?.());
      await page.keyboard.press('h');
      await sleep(700);
      try {
        const clash = await page.evaluate(() => {
          const shown = (el) => el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
          const corners = [...document.querySelectorAll('#intel-hud .hud-bottom-left, #intel-hud .hud-bottom-right')].filter(shown);
          const credits = [...document.querySelectorAll('#cesium-credits .cesium-credit-logoContainer, #cesium-credits .cesium-credit-textContainer')].filter(shown);
          const hit = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
          if (corners.length === 0) return null;
          return corners.some((c) => credits.some((k) => hit(c.getBoundingClientRect(), k.getBoundingClientRect())));
        });
        if (clash === null) throw new Skip('the HUD did not show');
        expect(!clash, 'the HUD sits on the map credits');
      } finally {
        await page.keyboard.press('h');
        await sleep(400);
      }
    },
  ],
  [
    'a switch that is on looks on (blue)',
    async (page) => {
      await press(page, 'time-zones-toggle');
      const colour = await page.evaluate(
        () => getComputedStyle(document.getElementById('time-zones-toggle')).backgroundColor,
      );
      await press(page, 'time-zones-toggle');
      expect(/0, 212, 255/.test(colour), `on-colour was ${colour}`);
    },
  ],
  [
    'compass dial follows and turns the view',
    async (page) => {
      const read = () =>
        page.evaluate(() => ({
          camera: window.__zt.heading(),
          dial: parseInt(document.querySelector('#compass-dial .cd-read').textContent, 10),
        }));
      const before = await read();
      expect(Math.abs(turn(before.camera, before.dial)) <= 1.5, `dial ${before.dial} vs camera ${before.camera.toFixed(1)}`);
      for (let i = 0; i < 3; i++) await page.keyboard.press('e');
      await sleep(500);
      const after = await read();
      expect(Math.abs(turn(before.camera, after.camera)) > 3, 'E did not turn the view');
      expect(Math.abs(turn(after.camera, after.dial)) <= 1.5, 'the dial did not follow the turn');
      const north = await page.evaluate(() => {
        const r = document.querySelector('#compass-dial .cd-north-hit').getBoundingClientRect();
        return [r.left + r.width / 2, r.top + r.height / 2];
      });
      await page.mouse.click(north[0], north[1]);
      await until(page, () => Math.abs(((window.__zt.heading() + 180) % 360) - 180) < 1.5, 6000, 'clicking N did not bring north up');

      const view = () =>
        page.evaluate(() => {
          const { camera } = window.__zt.viewer();
          return { heading: window.__zt.heading(), pitch: (camera.pitch * 180) / Math.PI, height: camera.positionCartographic.height };
        });
      const start = await view();
      // Dragging the tilt arc swings the camera round its target, so its place is put back too.
      await page.evaluate(() => (window.__ztSpot = window.__zt.viewer().camera.position.clone()));
      // The dial's own coordinates: the centre is 56 units in from the top left.
      const dial = await page.evaluate(() => {
        const r = document.querySelector('#compass-dial svg').getBoundingClientRect();
        const unit = r.width / 126;
        return { x: r.left + 56 * unit, y: r.top + 56 * unit, unit };
      });
      const at = (x, y) => [dial.x + x * dial.unit, dial.y + y * dial.unit];
      try {
        // Drag a quarter of the way round the ring, from its left side to its top.
        await page.mouse.move(...at(-39, 0));
        await page.mouse.down();
        for (let step = 1; step <= 10; step++) {
          const angle = Math.PI + (step / 10) * (-Math.PI / 2);
          await page.mouse.move(...at(39 * Math.cos(angle), -39 * Math.sin(angle)));
          await sleep(40);
        }
        await page.mouse.up();
        await sleep(500);
        const turned = await read();
        expect(Math.abs(turn(start.heading, turned.camera)) > 30, `dragging the ring turned the view only ${turn(start.heading, turned.camera).toFixed(1)} degrees`);
        expect(Math.abs(turn(turned.camera, turned.dial)) <= 1.5, 'the dial did not follow the ring drag');

        // Drag the tilt arc to its bottom end: the view looks straight down.
        await page.mouse.move(...at(60, 0));
        await page.mouse.down();
        for (let step = 1; step <= 8; step++) {
          await page.mouse.move(...at(60 - step * 2, step * 6));
          await sleep(40);
        }
        await page.mouse.up();
        await sleep(600);
        const tilted = await view();
        expect(tilted.pitch < -80, `dragging the tilt arc down left the view at ${tilted.pitch.toFixed(1)} degrees`);

        // Option with the wheel turns the view and does not zoom.
        const before = await view();
        await page.mouse.move(...spot(page, 0.5, 0.55));
        await page.keyboard.down('Alt');
        for (let i = 0; i < 5; i++) {
          await page.mouse.wheel({ deltaY: 120 });
          await sleep(80);
        }
        await page.keyboard.up('Alt');
        await sleep(600);
        const wheeled = await view();
        expect(Math.abs(turn(before.heading, wheeled.heading)) > 3, 'Option and the wheel did not turn the view');
        expect(Math.abs(wheeled.height - before.height) / before.height < 0.02, `Option and the wheel zoomed from ${before.height.toFixed(0)} m to ${wheeled.height.toFixed(0)} m`);
      } finally {
        await page.mouse.up().catch(() => {});
        await page.keyboard.up('Alt').catch(() => {});
        await page.evaluate(({ heading, pitch }) => {
          const { camera } = window.__zt.viewer();
          camera.setView({
            destination: window.__ztSpot,
            orientation: { heading: (heading * Math.PI) / 180, pitch: (pitch * Math.PI) / 180, roll: 0 },
          });
          delete window.__ztSpot;
        }, start);
        await sleep(400);
      }
      const back = await view();
      expect(Math.abs(back.height - start.height) < 30, `the view was put back ${back.height.toFixed(0)} m up instead of ${start.height.toFixed(0)} m`);
    },
  ],
  [
    'a right-click on a building shows its target box and highlight, not the map pin card; Escape clears it',
    async (page, setup) => {
      await press(page, 'address-lookup-toggle');
      try {
        // Straight down over Buckingham Palace, so the middle of the window is the palace.
        await page.evaluate(() => {
          const { camera } = window.__zt.viewer();
          window.__ztSpot = camera.positionWC.clone();
          window.__ztLook = { heading: camera.heading, pitch: camera.pitch };
          camera.setView({
            // positionWC is a Cartesian3, so its class makes the new place.
            destination: camera.positionWC.constructor.fromDegrees(-0.14189, 51.5014, 700),
            orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
          });
        });
        await sleep(2500);
        const [x, y] = spot(page, 0.5, 0.5);
        await page.mouse.click(x, y, { button: 'right' });
        await until(page, () => !/ACQUIRING/.test(document.querySelector('#target-box-panel .tb-head')?.textContent ?? 'ACQUIRING'), 25_000, 'the target box never finished looking');
        // The classified look decrypts the name for about a second.
        await sleep(1300);
        const box = await page.evaluate(() => ({
          head: document.querySelector('#target-box-panel .tb-head').textContent,
          text: document.getElementById('target-box-panel').textContent,
          corners: window.__zt.box('#target-box-corners'),
          highlight: window.__zt.entities('zenith-target-box'),
          light: window.__zt.spotlight(),
          card: window.__zt.shown(document.getElementById('address-card')),
        }));
        if (/NO SIGNAL/.test(box.head)) throw new Skip(`the map facts service did not answer: ${box.text}`);
        expect(!box.card, 'a right-click opened the map pin card');
        expect(/PALACE|BUILDING|CASTLE/.test(box.head), `the box says ${box.head}`);
        expect(/Buckingham Palace/.test(box.text), `the box does not name the palace: ${box.text}`);
        if (setup.map === 'esri-imagery') {
          // No buildings to light: a fill and an outline on the ground, nothing dimmed.
          expect(box.light.mode === 'ground', `the light is ${box.light.mode || 'missing'} on the satellite map`);
          expect(box.highlight === 2, `the highlight has ${box.highlight} parts, not a fill and an outline`);
          expect(box.light.volumes === 0 && !box.light.dimmed, 'the satellite map was dimmed or given a 3D light');
        } else {
          // The whole building lit, the rest dimmed, rings at the top and the base.
          expect(box.light.mode === '3d', `the light is ${box.light.mode || 'missing'} on the 3D map`);
          expect(box.light.volumes === 1, `${box.light.volumes} light volumes, not 1`);
          expect(box.light.dimmed, 'the rest of the map was not dimmed');
          expect(box.highlight >= 2, `the highlight has ${box.highlight} lines, not a top and a base ring`);
        }
        expect(box.corners && box.corners.right - box.corners.left > 40, 'no corner brackets around the palace');
        await page.keyboard.press('Escape');
        await sleep(300);
        const cleared = await page.evaluate(() => ({
          open: window.__zt.shown(document.getElementById('target-box-panel')),
          highlight: window.__zt.entities('zenith-target-box'),
          light: window.__zt.spotlight(),
        }));
        expect(!cleared.open && cleared.highlight === 0, 'Escape did not clear the target box');
        expect(!cleared.light.mode && cleared.light.volumes === 0 && !cleared.light.dimmed, `Escape left the light on: ${JSON.stringify(cleared.light)}`);
      } finally {
        await press(page, 'address-lookup-toggle');
        await page.evaluate(() => {
          if (!window.__ztSpot) return;
          const { camera } = window.__zt.viewer();
          camera.setView({ destination: window.__ztSpot, orientation: { ...window.__ztLook, roll: 0 } });
          delete window.__ztSpot;
          delete window.__ztLook;
        });
        await sleep(400);
      }
    },
  ],
  [
    'a right-click finds the buildings that said NO MATCH (Anfield, the Pentagon, Montjuic flats, a Soweto house, an Austin building that said YES); the Capitol stays found, Camp Nou stays NO MATCH',
    async (page, setup) => {
      // Live lookups at the spots from Alon's screenshots: run on the free
      // satellite map only, a few seconds a spot.
      if (setup.map !== 'esri-imagery') throw new Skip('checked on the satellite map only');
      const spots = [
        ['Anfield, main stand', 53.43064, -2.96207, /Anfield/],
        ['Anfield, front', 53.43018, -2.96194, /Anfield/],
        ['the Pentagon', 38.87122, -77.05543, /The Pentagon/],
        ['Montjuic, first block', 41.3649, 2.14152, /BUILDING/],
        ['Montjuic, second block', 41.36496, 2.142, /BUILDING/],
        ['the Texas Capitol', 30.27437, -97.74029, /Texas State Capitol/],
        // Tagged only "yes": the box said TARGET // YES before 1.5.3.
        ['an Austin building', 30.27406, -97.74358, /TARGET \/\/ BUILDING\b/],
        // A house with no OpenStreetMap outline: found in Overture's traced ones.
        ['a Soweto house', -26.2472, 27.84535, /Overture Maps Foundation/],
        ['Spotify Camp Nou', 41.38078, 2.12154, null],
      ];
      const wrong = [];
      const silent = [];
      const areas = {};
      await press(page, 'address-lookup-toggle');
      try {
        await page.evaluate(() => {
          const { camera } = window.__zt.viewer();
          window.__ztSpot = camera.positionWC.clone();
          window.__ztLook = { heading: camera.heading, pitch: camera.pitch };
        });
        for (const [name, lat, lon, says] of spots) {
          // Straight down over the spot, so the middle of the window is it.
          await page.evaluate(([lat, lon]) => {
            const { camera } = window.__zt.viewer();
            camera.setView({
              destination: camera.positionWC.constructor.fromDegrees(lon, lat, 700),
              orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
            });
          }, [lat, lon]);
          await sleep(2500);
          const [x, y] = spot(page, 0.5, 0.5);
          await page.mouse.click(x, y, { button: 'right' });
          await until(page, () => !/ACQUIRING/.test(document.querySelector('#target-box-panel .tb-head')?.textContent ?? 'ACQUIRING'), 30_000, `the target box never finished looking at ${name}`);
          await sleep(1300);
          const box = await page.evaluate(() => ({
            head: document.querySelector('#target-box-panel .tb-head').textContent,
            text: document.getElementById('target-box-panel').textContent,
            highlight: window.__zt.entities('zenith-target-box'),
          }));
          if (process.env.ZT_SHOTS) {
            const file = `${setup.narrow ? 'narrow' : 'wide'}-${name.replace(/\W+/g, '-').toLowerCase()}.png`;
            await page.screenshot({ path: `${process.env.ZT_SHOTS}/${file}`, captureBeyondViewport: false });
          }
          if (/NO SIGNAL/.test(box.head)) silent.push(name);
          else if (!says) {
            if (!/NO MATCH/.test(box.head)) wrong.push(`${name}: expected NO MATCH, the box says ${box.head}`);
          } else if (/NO MATCH/.test(box.head)) wrong.push(`${name}: NO MATCH`);
          else if (!says.test(box.head + box.text)) wrong.push(`${name}: the box does not say ${says}: ${box.text.slice(0, 120)}`);
          else if (box.highlight !== 2) wrong.push(`${name}: the highlight has ${box.highlight} parts, not a fill and an outline`);
          areas[name] = /([\d,.]+ (?:m²|ha|km²))/.exec(box.text)?.[1];
          await page.keyboard.press('Escape');
          await sleep(300);
        }
        // No answer anywhere: the map services are down, not the app. No
        // answer at some spots: a source the app needs there is broken.
        if (silent.length === spots.length) throw new Skip('the map facts services did not answer');
        for (const name of silent) wrong.push(`${name}: NO SIGNAL, a map source failed`);
        if (areas['Montjuic, first block'] && areas['Montjuic, first block'] === areas['Montjuic, second block'])
          wrong.push(`both Montjuic clicks gave a building of ${areas['Montjuic, first block']}: the same one?`);
        expect(wrong.length === 0, wrong.join('; '));
      } finally {
        await press(page, 'address-lookup-toggle');
        await page.evaluate(() => {
          if (!window.__ztSpot) return;
          const { camera } = window.__zt.viewer();
          camera.setView({ destination: window.__ztSpot, orientation: { ...window.__ztLook, roll: 0 } });
          delete window.__ztSpot;
          delete window.__ztLook;
        });
        await sleep(400);
      }
    },
  ],
  [
    'a target box shows the satellites overhead: the switch-on line, then the ISS, Tiangong and Hubble, worked out once a minute',
    async (page) => {
      const section = () => page.evaluate(() => document.querySelector('#target-box-panel .zenith-overhead')?.textContent ?? '');
      const satellites = () => page.evaluate(() => window.__zt.viewer() && window.__godsEyeView.dataManager.isEnabled('satellites'));
      const wasOn = await satellites();
      try {
        const [x, y] = spot(page, 0.5, 0.5);
        await page.mouse.click(x, y, { button: 'right' });
        await until(page, () => /OVERHEAD/.test(document.querySelector('#target-box-panel .zenith-overhead')?.textContent ?? ''), 5000, 'the target box has no OVERHEAD section');
        const first = await section();
        // The catalogue may have loaded earlier in this run; otherwise the switch-on line.
        if (!/ISS · /.test(first)) {
          expect(/Switch on the Satellites layer/.test(first), `the section says: ${first}`);
          await page.click('#target-box-panel .zo-switch');
        }
        try {
          await until(page, () => /ISS · /.test(document.querySelector('#target-box-panel .zenith-overhead')?.textContent ?? ''), 40_000, 'the passes never showed');
        } catch {
          throw new Skip(`the satellites catalogue did not load: ${await section()}`);
        }
        const text = await section();
        for (const name of ['ISS', 'Tiangong', 'Hubble'])
          expect(new RegExp(`${name} · (in \\d+ (s|min)|in \\d+ h \\d\\d min|OVERHEAD NOW|no pass above 10°)`).test(text), `the ${name} line reads: ${text}`);
        expect(/up to \d+° · from the (N|NE|E|SE|S|SW|W|NW)/.test(text), `no peak and direction: ${text}`);
        // The countdown runs from the stored times: no pass is worked out again for a while.
        const asked = await page.evaluate(async () => {
          const module = window.__godsEyeView.dataManager.layers.get('satellites').module;
          const real = module.getNextSatellitePass;
          let count = 0;
          module.getNextSatellitePass = (...args) => {
            count += 1;
            return real(...args);
          };
          await new Promise((done) => setTimeout(done, 4000));
          module.getNextSatellitePass = real;
          return count;
        });
        expect(asked === 0, `passes were worked out ${asked} times in 4 seconds`);
        await page.keyboard.press('Escape');
        await sleep(300);
        expect(!(await section()), 'the section stayed after the box closed');
      } finally {
        if (!wasOn) await page.evaluate(() => window.__godsEyeView.dataManager.setEnabled('satellites', false));
        await sleep(300);
      }
    },
  ],
  [
    'space view shows the Earth and the Moon; Fly to the Moon ends close to it, scrolling zooms in, an Apollo site opens its box, and Back to Earth puts everything back',
    async (page) => {
      const before = await page.evaluate(() => {
        const { viewer, dataManager, styleManager } = window.__godsEyeView;
        const p = viewer.camera.positionWC;
        const visual = styleManager?._visualSettings ?? styleManager;
        return { at: [p.x, p.y, p.z], satellites: dataManager.isEnabled('satellites'), celestial: Boolean(visual?.celestialRingEnabled) };
      });
      const where = () => page.evaluate(() => document.body.dataset.space || 'earth');
      try {
        await press(page, 'space-view-toggle');
        await until(page, () => document.body.dataset.space === 'space', 3000, 'space view did not start');
        await sleep(5000);
        const out = await page.evaluate(() => {
          const { viewer, dataManager, styleManager } = window.__godsEyeView;
          const p = viewer.camera.positionWC;
          const visual = styleManager?._visualSettings ?? styleManager;
          return { km: Math.hypot(p.x, p.y, p.z) / 1000, satellites: dataManager.isEnabled('satellites'), celestial: Boolean(visual?.celestialRingEnabled), moon: window.__zt.painted('alon-moon') };
        });
        expect(out.km > 100_000 && out.km < 200_000, `space view is ${Math.round(out.km)} km from the Earth's centre`);
        expect(out.satellites, 'space view did not switch the Satellites layer on');
        expect(out.celestial, 'space view did not switch the Celestial ring on');
        expect(out.moon === 1, 'the Moon is not on screen in space view');
        await page.click('#space-view-moon');
        await until(page, () => document.body.dataset.space === 'moon' && document.body.dataset.moonHeight, 8000, 'Fly to the Moon did not arrive');
        const arrived = Number(await page.evaluate(() => document.body.dataset.moonHeight));
        expect(arrived <= 5_000_000, `Fly to the Moon ended ${Math.round(arrived / 1000)} km above it`);
        const fromEarth = await page.evaluate(() => {
          const p = window.__godsEyeView.viewer.camera.positionWC;
          return Math.hypot(p.x, p.y, p.z) / 1000;
        });
        expect(fromEarth > 350_000 && fromEarth < 420_000, `over the Moon, the camera is ${Math.round(fromEarth)} km from the Earth`);
        await until(page, () => window.__zt.painted('alon-apollo') >= 3, 5000, 'the Apollo landing sites are not marked');
        // The sharp map: Cesium Moon Terrain is blocked in tests, so NASA's.
        await until(page, () => Boolean(document.body.dataset.moonSurface), 120_000, 'the Moon map never finished loading');
        const surface = await page.evaluate(() => ({ kind: document.body.dataset.moonSurface, said: document.querySelector('#space-view-bar .sv-surface')?.textContent }));
        expect(/^nasa-(8k|2k)$/.test(surface.kind), `the surface is ${surface.kind}: ${surface.said}`);
        expect(/NASA CGI Moon Kit map, \d+ pixels wide \(Cesium Moon Terrain: /.test(surface.said), `the bar says: ${surface.said}`);
        // Earthshine: the night side is dim, not black. Its strength must change the picture.
        const shine = await page.evaluate(() => {
          const uniforms = window.__godsEyeView.viewer.scene.moon?._ellipsoidPrimitive?.material?.uniforms;
          if (!uniforms || !('earthshine' in uniforms)) return null;
          const was = uniforms.earthshine;
          // Strong for a moment, so it shows whatever the Moon's phase.
          uniforms.earthshine = 3;
          const lit = window.__zt.frame();
          uniforms.earthshine = 0;
          const dark = window.__zt.frame();
          uniforms.earthshine = was;
          let brighter = 0;
          for (let i = 0; i < lit.length; i += 1) if (lit[i] > dark[i] + 2) brighter += 1;
          return { was, brighter };
        });
        expect(shine, 'the Moon has no earthshine: its night side draws black');
        expect(shine.was > 0 && shine.brighter > 20, `earthshine ${shine.was} lit only ${shine.brighter} spots of the picture`);
        // An Apollo site's box.
        const site = await page.evaluate(() => {
          const { viewer } = window.__godsEyeView;
          const primitives = viewer.scene.primitives;
          for (let i = 0; i < primitives.length; i += 1) {
            const collection = primitives.get(i);
            if (!collection?.get || !collection.length) continue;
            for (let j = 0; j < collection.length; j += 1) {
              const point = collection.get(j);
              if (point?.id?.apolloSite === undefined || !point.show) continue;
              // Where it is drawn (computeScreenSpacePosition gives it upside down this far out).
              const at = viewer.scene.cartesianToCanvasCoordinates(point.position);
              const rect = viewer.canvas.getBoundingClientRect();
              // Well away from the middle line, so an upside-down sum would miss it.
              if (at && Math.abs(at.y - rect.height / 2) > 60 && at.x > 40 && at.y > 220 && at.x < rect.width - 300 && at.y < rect.height - 160) return { x: rect.left + at.x, y: rect.top + at.y, index: point.id.apolloSite };
            }
          }
          return null;
        });
        expect(site, 'no Apollo site is in a clickable part of the window');
        await page.mouse.click(site.x, site.y);
        await until(page, () => document.getElementById('apollo-box')?.classList.contains('open'), 3000, 'clicking an Apollo site did not open its box');
        const boxText = await page.evaluate(() => document.getElementById('apollo-box-panel').textContent);
        expect(/APOLLO 1\d \/\/ LANDING SITE/.test(boxText) && /Landed \d+ [A-Z][a-z]+ 19\d\d/.test(boxText), `the box says: ${boxText}`);
        await page.keyboard.press('Escape');
        await until(page, () => !document.getElementById('apollo-box').classList.contains('open'), 2000, 'Escape did not close the Apollo box');
        expect((await where()) === 'moon', 'Escape also left the Moon');
        // Scrolling zooms in to the surface.
        const [cx, cy] = spot(page, 0.5, 0.6);
        await page.mouse.move(cx, cy);
        for (let i = 0; i < 10; i += 1) {
          await page.mouse.wheel({ deltaY: -300 });
          await sleep(80);
        }
        await sleep(500);
        const zoomed = Number(await page.evaluate(() => document.body.dataset.moonHeight));
        expect(zoomed < arrived / 20, `scrolling went from ${Math.round(arrived / 1000)} km to ${Math.round(zoomed / 1000)} km above the Moon`);
        // Dragging turns round it.
        await page.mouse.move(cx, cy);
        await page.mouse.down();
        await page.mouse.move(cx - 150, cy - 80, { steps: 6 });
        await page.mouse.up();
        await sleep(300);
        expect((await where()) === 'moon', 'dragging over the Moon left it');
        await page.click('#space-view-earth');
        await until(page, () => !document.body.dataset.space, 3000, 'Back to Earth did not start');
        await sleep(5000);
        const after = await page.evaluate(() => {
          const { viewer, dataManager, styleManager } = window.__godsEyeView;
          const p = viewer.camera.positionWC;
          const visual = styleManager?._visualSettings ?? styleManager;
          return { at: [p.x, p.y, p.z], satellites: dataManager.isEnabled('satellites'), celestial: Boolean(visual?.celestialRingEnabled), controls: viewer.scene.screenSpaceCameraController.enableInputs };
        });
        const off = Math.hypot(after.at[0] - before.at[0], after.at[1] - before.at[1], after.at[2] - before.at[2]);
        expect(off < 20, `Back to Earth ended ${Math.round(off)} m from where the view was`);
        expect(after.satellites === before.satellites && after.celestial === before.celestial, `the switches were not put back: ${JSON.stringify({ before, after })}`);
        expect(after.controls, "the Earth's own controls were left off");
      } finally {
        if ((await where()) !== 'earth') {
          await page.evaluate(() => window.dispatchEvent(new CustomEvent('zenith:space', { detail: { to: 'earth' } })));
          await sleep(5000);
        }
      }
    },
  ],
  [
    'a search for "Moon" flies to the Moon and one for "Earth" flies back; in space view, a click on the Moon flies there; moving the camera another way leaves the Moon',
    async (page) => {
      const search = (text) =>
        page.evaluate((words) => {
          const input = document.getElementById('location-search');
          input.value = words;
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        }, text);
      try {
        await search('Moon');
        await until(page, () => document.body.dataset.space === 'moon' && document.body.dataset.moonHeight, 8000, 'a search for Moon did not fly there');
        await search('Earth');
        await until(page, () => !document.body.dataset.space, 3000, 'a search for Earth did not fly back');
        await sleep(5000);
        await press(page, 'space-view-toggle');
        await until(page, () => document.body.dataset.space === 'space', 3000, 'space view did not start');
        await sleep(5000);
        // Where Cesium draws the Moon (its own Moon object, read for the test).
        const moon = await page.evaluate(() => {
          const { viewer } = window.__godsEyeView;
          const matrix = viewer.scene.moon?._ellipsoidPrimitive?.modelMatrix;
          if (!matrix) return null;
          const centre = viewer.camera.positionWC.constructor.fromElements(matrix[12], matrix[13], matrix[14]);
          const at = viewer.scene.cartesianToCanvasCoordinates(centre);
          const rect = viewer.canvas.getBoundingClientRect();
          return at ? { x: rect.left + at.x, y: rect.top + at.y } : null;
        });
        expect(moon, 'the Moon is not in the window in space view');
        await page.mouse.click(moon.x + 4, moon.y + 3);
        await until(page, () => document.body.dataset.space === 'moon' && document.body.dataset.moonHeight, 8000, 'a click on the Moon did not fly there');
        // Something else moving the camera (here the original's own fly home)
        // leaves the Moon, with the Earth's controls back.
        await page.evaluate(() => window.__godsEyeView.viewer.camera.flyHome(0));
        await until(page, () => !document.body.dataset.space && window.__godsEyeView.viewer.scene.screenSpaceCameraController.enableInputs, 3000, 'moving the camera another way did not leave the Moon');
        expect(!(await page.evaluate(() => window.__godsEyeView.dataManager.isEnabled('satellites'))), 'leaving the Moon that way left the satellites on');
      } finally {
        if (await page.evaluate(() => Boolean(document.body.dataset.space))) {
          await page.evaluate(() => window.dispatchEvent(new CustomEvent('zenith:space', { detail: { to: 'earth' } })));
          await sleep(5000);
        }
      }
    },
  ],
  [
    'a watch zone is added with a click on the map, drawn as a ring with its name, kept across a reload and deleted',
    async (page, setup) => {
      const state = () =>
        page.evaluate(() => ({
          rows: document.querySelectorAll('#watch-zones-list li').length,
          names: [...document.querySelectorAll('#watch-zones-list .wz-name')].map((name) => name.textContent),
          rings: window.__zt.entities('zenith-watch-zones'),
          labels: window.__zt.labels('alon-watch-zones'),
          stored: JSON.parse(localStorage.getItem('gev.watchZones') || '[]').length,
        }));
      await press(page, 'watch-zones-toggle');
      try {
        expect(await page.evaluate(() => window.__zt.shown(document.getElementById('watch-zones'))), 'the Watch zones panel did not open');
        await page.click('#watch-zones-add');
        await clickMap(page, 0.5, 0.62);
        await until(page, () => window.__zt.shown(document.querySelector('#watch-zones form')), 3000, 'clicking the map did not ask for the zone details');
        expect(!(await page.evaluate(() => window.__zt.shown(document.getElementById('address-card')))), 'the click that placed the zone also opened the map pin card');
        await page.keyboard.type('TESTZONE');
        await page.click('#watch-zones form button[type=submit]');
        await until(page, () => document.querySelectorAll('#watch-zones-list li').length === 1, 3000, 'the zone was not added to the list');
        const added = await state();
        expect(added.names[0] === 'TESTZONE', `the zone is called ${added.names[0]}`);
        expect(added.rings === 1, `${added.rings} rings on the map, not 1`);
        await until(page, () => window.__zt.labels('alon-watch-zones') === 1, 3000, 'the ring has no name on the map');
        expect(added.stored === 1, 'the zone was not saved');
        // Across a reload, from this computer's storage.
        await open(page, setup.narrow ? NARROW : WIDE, setup.map === 'esri-imagery' ? `${LONDON}&map=esri-imagery` : LONDON);
        await until(page, () => window.__zt.entities('zenith-watch-zones') === 1, 10_000, 'the zone was not drawn again after a reload');
        await press(page, 'watch-zones-toggle');
        const back = await state();
        expect(back.names.join() === 'TESTZONE', `after a reload the list has ${back.names.join() || 'nothing'}`);
        await page.click('#watch-zones-list .wz-delete');
        await sleep(300);
        const gone = await state();
        expect(gone.rows === 0 && gone.rings === 0 && gone.stored === 0, `after deleting: ${JSON.stringify(gone)}`);
        await until(page, () => window.__zt.labels('alon-watch-zones') === 0, 3000, 'the name stayed on the map after the zone was deleted');
      } finally {
        await page.evaluate(() => {
          for (const remove of document.querySelectorAll('#watch-zones-list .wz-delete')) remove.click();
          localStorage.removeItem('gev.watchZones');
          if (window.__zt.shown(document.getElementById('watch-zones'))) document.getElementById('watch-zones-toggle').click();
        });
        await sleep(300);
      }
    },
  ],
  [
    'watch zones: a plane already inside when its layer comes on is no alert; flying back in gives exactly one, in a notice and the log',
    async (page) => {
      // The centre of the view, and a made-up flights feed: one plane, inside
      // the zone when the layer comes on, then 8 km north of it, then back in.
      const centre = await page.evaluate(() => {
        const viewer = window.__zt.viewer();
        const spot = viewer.camera.pickEllipsoid({ x: viewer.canvas.clientWidth / 2, y: viewer.canvas.clientHeight * 0.62 });
        const where = viewer.scene.globe.ellipsoid.cartesianToCartographic(spot);
        return [(where.longitude * 180) / Math.PI, (where.latitude * 180) / Math.PI];
      });
      const inside = [centre[0], centre[1] + 300 / 111_320];
      const outside = [centre[0], centre[1] + 8000 / 111_320];
      let plane = inside;
      const answer = (request) => {
        const url = new URL(request.url());
        if (url.pathname === '/api/flights') {
          const now = Math.floor(Date.now() / 1000);
          request.respond({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              time: now,
              states: [['7c0001', 'ZTEST01 ', 'Testland', now, now, plane[0], plane[1], 3000, false, 180, 180, 0, null, 3050, '1200', false, 0]],
            }),
          });
        } else {
          request.continue();
        }
      };
      await page.setRequestInterception(true);
      page.on('request', answer);
      const flightsWereOn = await page.evaluate(() => window.__godsEyeView.dataManager.isEnabled('flights'));
      const alertLines = () => page.evaluate(() => [...document.querySelectorAll('#watch-zones-alerts button')].map((line) => line.textContent));
      try {
        await press(page, 'watch-zones-toggle');
        await page.click('#watch-zones-add');
        await clickMap(page, 0.5, 0.62);
        await until(page, () => window.__zt.shown(document.querySelector('#watch-zones form')), 3000, 'clicking the map did not ask for the zone details');
        await page.keyboard.type('HOMEZONE');
        await page.click('#watch-zones form button[type=submit]');
        await until(page, () => document.querySelectorAll('#watch-zones-list li').length === 1, 3000, 'the zone was not added');
        // The flights layer is off: the panel says so, with a button.
        if (!flightsWereOn) {
          await until(page, () => /Planes layer off/.test(document.getElementById('watch-zones-warnings').textContent), 3000, 'the panel did not say the planes layer is off');
          await page.click('#watch-zones-warnings button');
        }
        const seen = () =>
          page.evaluate(() => {
            const record = (window.__godsEyeView.dataManager.layers.get('flights').module.getAnalystRecords(1e6) || []).find((one) => one.icao24 === '7c0001');
            return record ? [record.lon, record.lat] : null;
          });
        try {
          await until(page, () => (window.__godsEyeView.dataManager.layers.get('flights')?.module?.getAnalystRecords?.(1e6) || []).some((one) => one.icao24 === '7c0001'), 60_000, 'the made-up plane never showed');
        } catch {
          throw new Skip('the flights layer did not take the made-up feed');
        }
        await sleep(4500); // two checks with the plane inside since the layer came on: the starting point
        expect((await alertLines()).length === 0, `the plane already inside when its layer came on gave an alert: ${(await alertLines()).join(' | ')}`);
        plane = outside;
        await until(page, (lat) => {
          const record = (window.__godsEyeView.dataManager.layers.get('flights').module.getAnalystRecords(1e6) || []).find((one) => one.icao24 === '7c0001');
          return record && Math.abs(record.lat - lat) < 1e-4;
        }, 60_000, 'the plane never moved out of the zone', plane[1]);
        await sleep(2500);
        expect((await alertLines()).length === 0, `an alert came as the plane left: ${(await alertLines()).join(' | ')}`);
        plane = inside;
        await until(page, (lat) => {
          const record = (window.__godsEyeView.dataManager.layers.get('flights').module.getAnalystRecords(1e6) || []).find((one) => one.icao24 === '7c0001');
          return record && Math.abs(record.lat - lat) < 1e-4;
        }, 60_000, 'the plane never moved into the zone', plane[1]);
        await until(page, () => document.querySelectorAll('#watch-zones-alerts button').length > 0, 6000, 'no alert when the plane entered the zone');
        await sleep(6500); // three more checks with the plane still inside
        const lines = await alertLines();
        expect(lines.length === 1, `${lines.length} alerts, not exactly one: ${lines.join(' | ')}`);
        expect(/^\d\d:\d\dZ · ZTEST01 entered HOMEZONE$/.test(lines[0]), `the alert reads: ${lines[0]}`);
        const notice = await page.evaluate(() => document.getElementById('zenith-zone-alert')?.textContent ?? '');
        expect(/^ALERT · ZTEST01 entered HOMEZONE · \d\d:\d\dZ$/.test(notice), `the notice reads: ${notice || 'nothing'}`);
        expect(await seen(), 'the plane went missing');
      } finally {
        page.off('request', answer);
        await page.setRequestInterception(false);
        await page.evaluate((on) => {
          for (const remove of document.querySelectorAll('#watch-zones-list .wz-delete')) remove.click();
          localStorage.removeItem('gev.watchZones');
          if (!on) window.__godsEyeView.dataManager.setEnabled('flights', false);
          if (window.__zt.shown(document.getElementById('watch-zones'))) document.getElementById('watch-zones-toggle').click();
          document.getElementById('zenith-zone-alert')?.remove();
        }, flightsWereOn);
        await sleep(500);
      }
    },
  ],
  [
    'searching a street address flies to the house, looking down, with the map pin card on it',
    async (page) => {
      await page.evaluate(() => {
        const { camera } = window.__zt.viewer();
        window.__ztSpot = camera.positionWC.clone();
        window.__ztLook = { heading: camera.heading, pitch: camera.pitch };
      });
      try {
        // As a person would: open the LOCATION tray, then the search box.
        await page.click('#location-bar-toggle');
        await sleep(500);
        await page.click('#search-toggle');
        await until(page, () => document.activeElement?.id === 'location-search', 3000, 'the search box did not open');
        await page.keyboard.type('10 Downing Street, London');
        await page.keyboard.press('Enter');
        // 10 Downing Street, as OpenStreetMap has it.
        await until(
          page,
          () => {
            const viewer = window.__zt.viewer();
            const where = viewer.camera.positionCartographic;
            const rad = Math.PI / 180;
            const lat = where.latitude / rad;
            const lon = where.longitude / rad;
            const metres = Math.hypot((lat - 51.50349) * 111_320, (lon + 0.1277) * 111_320 * Math.cos(51.5 * rad));
            const card = document.getElementById('address-card');
            return metres < 150 && window.__zt.pitch() < -80 && window.__zt.shown(card) && /Downing/.test(card.textContent);
          },
          30_000,
          'the search did not land on 10 Downing Street looking down with the card open',
        );
        const height = await page.evaluate(() => window.__zt.height());
        expect(height < 600, `the view stopped ${Math.round(height)} m up, too high to see the house`);
      } finally {
        await page.keyboard.press('Escape');
        await page.evaluate(() => {
          if (!window.__ztSpot) return;
          const { camera } = window.__zt.viewer();
          camera.cancelFlight();
          camera.setView({ destination: window.__ztSpot, orientation: { ...window.__ztLook, roll: 0 } });
          delete window.__ztSpot;
          delete window.__ztLook;
        });
        await sleep(400);
      }
    },
  ],
  [
    'the classified look: on from the start, one switch that is remembered, redacted lines read on focus, no scrambling with reduced motion',
    async (page, setup) => {
      expect(await pressed(page, 'classified-toggle'), 'the classified look is not on from the start');
      const rightClickPalace = async () => {
        await page.evaluate(() => {
          const { camera } = window.__zt.viewer();
          window.__ztSpot ||= camera.positionWC.clone();
          window.__ztLook ||= { heading: camera.heading, pitch: camera.pitch };
          camera.setView({
            destination: camera.positionWC.constructor.fromDegrees(-0.14189, 51.5014, 700),
            orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
          });
        });
        await sleep(2000);
        const [x, y] = spot(page, 0.5, 0.5);
        await page.mouse.click(x, y, { button: 'right' });
        await until(page, () => !/ACQUIRING/.test(document.querySelector('#target-box-panel .tb-head')?.textContent ?? 'ACQUIRING'), 25_000, 'the target box never finished looking');
      };
      try {
        await rightClickPalace();
        const redacted = await page.evaluate(() => {
          const row = document.querySelector('#target-box-panel .tb-redact');
          if (!row) return null;
          const bar = () => getComputedStyle(row, '::after').display;
          const before = bar();
          row.focus();
          return { before, focused: bar() };
        });
        if (!redacted) throw new Skip('the map facts service did not answer');
        expect(redacted.before !== 'none', 'the coordinates line is not under a REDACTED bar');
        expect(redacted.focused === 'none', 'keyboard focus did not lift the REDACTED bar');
        // SAVE CASE FILE puts a picture in My photos (removed again after).
        await page.click('#target-box-panel .tb-case');
        await until(page, () => /Saved|not|could/.test(document.querySelector('#target-box-panel > .tb-faint')?.textContent ?? ''), 15_000, 'saving the case file said nothing');
        const saved = await page.evaluate(async () => {
          const note = document.querySelector('#target-box-panel > .tb-faint').textContent;
          const { photos } = await (await fetch('/api/alon/cctv/photos')).json();
          const mine = photos.find((photo) => photo.cameraId === 'case-file' && Date.now() - photo.time < 60_000);
          if (mine) await fetch(`/api/alon/cctv/photos/${mine.file}`, { method: 'DELETE' });
          return { note, found: Boolean(mine) };
        });
        expect(saved.note === 'Saved to My Photos' && saved.found, `the case file was not saved: ${saved.note}`);
        await page.keyboard.press('Escape');

        await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
        await rightClickPalace();
        const title = () => page.evaluate(() => document.querySelector('#target-box-panel .tb-title')?.textContent);
        const first = await title();
        await sleep(1200);
        expect(first === (await title()), `with reduced motion the name still scrambled (${first})`);
        await page.keyboard.press('Escape');
      } finally {
        await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
        await page.evaluate(() => {
          if (!window.__ztSpot) return;
          const { camera } = window.__zt.viewer();
          camera.setView({ destination: window.__ztSpot, orientation: { ...window.__ztLook, roll: 0 } });
          delete window.__ztSpot;
          delete window.__ztLook;
        });
      }

      await press(page, 'classified-toggle');
      const off = await page.evaluate(() => ({
        body: document.body.classList.contains('zenith-classified'),
        agent: window.__zt.shown(document.getElementById('zenith-agent-line')),
      }));
      expect(!off.body && !off.agent, 'switching the classified look off left parts of it on');
      // Opened again where the run started, so the checks after this one see the usual view.
      await open(page, setup.narrow ? NARROW : WIDE, setup.map === 'esri-imagery' ? `${LONDON}&map=esri-imagery` : LONDON);
      await until(
        page,
        () =>
          Boolean(document.getElementById('classified-toggle') && window.__godsEyeView?.viewer) &&
          !document.elementFromPoint(innerWidth / 2, 50)?.closest('#loading-screen'),
        90_000,
        'the app did not start again',
      );
      await sleep(1000);
      expect(!(await pressed(page, 'classified-toggle')), 'the classified look was not remembered as off');
      await press(page, 'classified-toggle');
      expect(await pressed(page, 'classified-toggle'), 'the classified look did not come back on');
    },
  ],
  [
    'scale follows the zoom',
    async (page) => {
      const metres = () =>
        page.evaluate(() => {
          const found = /([\d.,]+)\s*(cm|km|m)\b/.exec(document.getElementById('scale-bar').textContent);
          if (!found) return null;
          const value = Number(found[1].replace(/,/g, ''));
          return value * { cm: 0.01, m: 1, km: 1000 }[found[2]];
        });
      const before = await metres();
      expect(before > 0, 'the scale shows no distance');
      const [x, y] = spot(page, 0.5, 0.55);
      await page.mouse.move(x, y);
      for (let i = 0; i < 8; i++) {
        await page.mouse.wheel({ deltaY: 300 });
        await sleep(80);
      }
      await sleep(900);
      const after = await metres();
      for (let i = 0; i < 8; i++) {
        await page.mouse.wheel({ deltaY: -300 });
        await sleep(80);
      }
      await sleep(600);
      expect(after > before, `zooming out left the scale at ${after} m (was ${before} m)`);
    },
  ],
  [
    'select all paints nothing blue: only typed fields and the info panels can be selected',
    async (page) => {
      const picked = await page.evaluate(() => {
        document.activeElement?.blur?.();
        document.execCommand('selectAll');
        const text = getSelection().toString().replace(/\s+/g, ' ').trim();
        getSelection().removeAllRanges();
        return text;
      });
      expect(picked.length === 0, `select all took ${picked.length} characters: ${picked.slice(0, 80)}`);
      const field = await page.evaluate(() => {
        const input = document.getElementById('location-search');
        if (!input) return null;
        const was = input.value;
        input.value = 'Kilburn High Road';
        input.select();
        const result = { selected: input.selectionEnd - input.selectionStart, length: input.value.length };
        input.value = was;
        input.blur();
        return result;
      });
      expect(field && field.selected === field.length, `the search box could not select its own text: ${JSON.stringify(field)}`);
    },
  ],
  [
    'with no OpenAI key the mic button starts the free voice, never VOICE SYSTEM ERROR',
    async (page) => {
      const keySet = await page.evaluate(async () => {
        const status = await (await fetch('/api/setup/status', { cache: 'no-store' })).json();
        return status?.keys?.find?.((key) => key.id === 'openai')?.set === true;
      });
      if (keySet) throw new Skip('an OpenAI key is set, so the mic is the paid voice');
      await page.evaluate(() => document.getElementById('gev-voice-button')?.click());
      await sleep(1500);
      const state = await page.evaluate(() => ({
        error: window.__zt.shown(document.querySelector('.gev-voice-error-tray')),
        heard: document.getElementById('zenith-heard')?.textContent ?? '',
      }));
      // A second click stops it again.
      await page.evaluate(() => document.getElementById('gev-voice-button')?.click());
      await sleep(500);
      expect(!state.error, 'the mic button showed VOICE SYSTEM ERROR');
      expect(/LISTENING|VOICE OFF|NOTHING HEARD/.test(state.heard), `the free voice did not answer: ${state.heard || 'nothing shown'}`);
    },
  ],
  [
    'no emojis on screen',
    async (page) => {
      const seen = new Set();
      const look = async (where) => {
        await sleep(700);
        for (const found of await page.evaluate(() => window.__zt.emojis())) seen.add(`${where}: ${found}`);
      };
      await look('at start');
      // The rocket switch flies out to space, and switching it off leaves the
      // view there: kept here and put back at the end for the next check.
      await page.evaluate(() => {
        const { camera } = window.__godsEyeView.viewer;
        window.__emojiView = { destination: camera.positionWC.clone(), orientation: { heading: camera.heading, pitch: camera.pitch, roll: camera.roll } };
      });
      // Every panel, opened the way the app opens it.
      const panels = ['control-panel', 'location-bar', 'data-panel', 'cctv-panel', 'recent-imagery-panel', 'street-level-panel', 'radio-panel', 'scene-panel', 'global-context-panel', 'pp-toggles', 'param-slider-panel'];
      const opened = await page.evaluate((ids) => {
        const styles = window.__godsEyeView.styleManager;
        return ids.filter((id) => {
          if (!document.getElementById(id)) return false;
          styles.setPanelCollapsed(id, false);
          return true;
        });
      }, panels);
      await look('all panels open');
      // The menus and cards of the top bar and the corners.
      for (const [id, name] of [['key-setup-chip', 'key setup'], ['zenith-layers-toggle', 'layers menu'], ['zenith-help-toggle', 'help card']]) {
        if (!(await page.$(`#${id}`))) continue;
        if (id.startsWith('zenith-')) await press(page, id, { leaveTray: true });
        else await page.click(`#${id}`);
        await look(name);
        await page.keyboard.press('Escape');
        if (id === 'zenith-layers-toggle' && (await page.evaluate(() => document.getElementById('zenith-layers-menu')?.dataset.open === 'true'))) {
          await page.evaluate(() => document.getElementById('zenith-layers-toggle').click());
        }
      }
      // Layers that put names on the map: rocket names, bike docks.
      const layers = ['rocket-launches', 'bikeshare'];
      const toggle = (ids) =>
        page.evaluate((list) => {
          for (const id of list) document.querySelector(`.data-toggle-row[data-layer-id="${id}"] .data-toggle-btn`)?.click();
        }, ids);
      await toggle(layers);
      await sleep(8000);
      await look('rockets and bikes on');
      await toggle(layers);
      await page.evaluate((ids) => {
        for (const id of ids) window.__godsEyeView.styleManager.setPanelCollapsed(id, true);
        const { camera } = window.__godsEyeView.viewer;
        camera.cancelFlight();
        camera.setView(window.__emojiView);
      }, opened);
      await sleep(1500);
      const list = [...seen];
      expect(list.length === 0, `${list.length} emoji places, first: ${list.slice(0, 3).join(' | ')}`);
    },
  ],
  [
    'place names',
    async (page) => {
      const before = await page.evaluate(() => window.__zt.imagery());
      await press(page, 'map-labels-toggle');
      await until(page, (n) => window.__zt.imagery() === n + 2, 5000, 'two label layers were not added', before);
      await press(page, 'map-labels-toggle');
      await until(page, (n) => window.__zt.imagery() === n, 5000, 'the label layers were not removed', before);
    },
  ],
  [
    'train stations',
    async (page) => {
      const before = await page.evaluate(() => window.__zt.stationMarkers());
      await press(page, 'train-stations-toggle');
      await until(page, (n) => window.__zt.stationMarkers() > n, 8000, 'no station markers appeared', before);
      await press(page, 'train-stations-toggle');
      await until(page, (n) => window.__zt.stationMarkers() <= n, 5000, 'the station markers stayed', before);
    },
  ],
  [
    'train stations in every country on the list',
    async (page, setup) => {
      // The file the app is served: stops where they should be, none where
      // they should not be.
      const counts = await page.evaluate(async () => {
        const file = await (await fetch('/alon/stations.json')).json();
        const near = (lon, lat) => file.stations.filter((row) => Math.abs(row[0] - lon) < 0.15 && Math.abs(row[1] - lat) < 0.15).length;
        return {
          total: file.stations.length,
          London: near(-0.12, 51.5),
          Edinburgh: near(-3.19, 55.95),
          Cardiff: near(-3.18, 51.48),
          Belfast: near(-5.93, 54.6),
          Berlin: near(13.37, 52.52),
          Rome: near(12.5, 41.9),
          Amsterdam: near(4.9, 52.38),
          Madrid: near(-3.7, 40.42),
          Lisbon: near(-9.14, 38.72),
          'Tel Aviv': near(34.78, 32.08),
          'New York': near(-73.99, 40.75),
          'Los Angeles': near(-118.24, 34.05),
          Chicago: near(-87.63, 41.88),
          Houston: near(-95.37, 29.76),
          Paris: near(2.35, 48.86),
          Dublin: near(-6.26, 53.35),
          Denver: near(-104.99, 39.74),
        };
      });
      for (const [place, count] of Object.entries(counts)) {
        if (place === 'total') continue;
        const none = ['Paris', 'Dublin', 'Denver'].includes(place);
        expect(none ? count === 0 : count >= 5, `${place} has ${count} stops in the stations file`);
      }
      expect(counts.total > 30_000 && counts.total < 60_000, `the stations file has ${counts.total} stops`);
      // Markers really appear in a new country. Only on the satellite map:
      // a jump on the 3D map would spend its metered allowance for nothing new.
      if (setup.map !== 'esri-imagery') return;
      const jump = (lon, lat, height) =>
        page.evaluate(
          (lon, lat, height) => {
            const camera = window.__zt.viewer().camera;
            const was = camera.positionCartographic;
            const back = [(was.longitude * 180) / Math.PI, (was.latitude * 180) / Math.PI, was.height, camera.heading, camera.pitch];
            const toRad = Math.PI / 180;
            const ellipsoid = window.__zt.viewer().scene.globe.ellipsoid;
            camera.setView({
              destination: ellipsoid.cartographicToCartesian({ longitude: lon * toRad, latitude: lat * toRad, height }),
              orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
            });
            return back;
          },
          lon,
          lat,
          height,
        );
      const before = await page.evaluate(() => window.__zt.stationMarkers());
      const home = await jump(13.37, 52.52, 9000);
      await press(page, 'train-stations-toggle');
      let appeared = true;
      try {
        await until(page, (n) => window.__zt.stationMarkers() > n + 20, 8000, 'no station markers appeared over Berlin', before);
      } catch {
        appeared = false;
      }
      await press(page, 'train-stations-toggle');
      await page.evaluate((back) => {
        const toRad = Math.PI / 180;
        const viewer = window.__zt.viewer();
        viewer.camera.setView({
          destination: viewer.scene.globe.ellipsoid.cartographicToCartesian({ longitude: back[0] * toRad, latitude: back[1] * toRad, height: back[2] }),
          orientation: { heading: back[3], pitch: back[4], roll: 0 },
        });
      }, home);
      await sleep(1500);
      expect(appeared, 'no station markers appeared over Berlin');
    },
  ],
  [
    'earthquakes',
    async (page) => {
      // A made-up feed, so the check does not depend on today's earthquakes:
      // one strong quake in the middle of the view, one weak one on the far
      // side of the Earth, and a quarry blast that must be ignored.
      const centre = await page.evaluate(() => {
        const viewer = window.__zt.viewer();
        const spot = viewer.camera.pickEllipsoid({ x: viewer.canvas.clientWidth / 2, y: viewer.canvas.clientHeight / 2 });
        const where = viewer.scene.globe.ellipsoid.cartesianToCartographic(spot);
        return [(where.longitude * 180) / Math.PI, (where.latitude * 180) / Math.PI];
      });
      const quake = (id, mag, lon, lat, type = 'earthquake') => ({
        type: 'Feature',
        id,
        properties: { mag, place: `Test place ${id}`, time: Date.now() - 3 * 3_600_000, type, url: null },
        geometry: { type: 'Point', coordinates: [lon, lat, 12] },
      });
      const feed = {
        type: 'FeatureCollection',
        features: [
          quake('near', 5.6, centre[0], centre[1]),
          quake('far', 3.1, centre[0] > 0 ? centre[0] - 180 : centre[0] + 180, -centre[1]),
          quake('blast', 2.9, centre[0] + 0.01, centre[1], 'quarry blast'),
        ],
      };
      const answer = (request) => {
        if (request.url().startsWith('https://earthquake.usgs.gov/')) {
          request.respond({
            status: 200,
            contentType: 'application/json',
            headers: { 'access-control-allow-origin': '*' },
            body: JSON.stringify(feed),
          });
        } else {
          request.continue();
        }
      };
      await page.setRequestInterception(true);
      page.on('request', answer);
      try {
        await press(page, 'earthquakes-toggle');
        await until(page, () => document.getElementById('earthquakes-toggle').dataset.count === '2', 8000, 'the two earthquakes in the feed were not loaded');
        const drawn = await page.evaluate(() => {
          const viewer = window.__zt.viewer();
          const primitives = viewer.scene.primitives;
          for (let i = 0; i < primitives.length; i++) {
            const one = primitives.get(i);
            if (one && typeof one.get === 'function' && one.length > 0 && typeof one.get(0)?.id?.mag === 'number') {
              const list = [];
              for (let j = 0; j < one.length; j++) {
                const point = one.get(j);
                const at = viewer.scene.cartesianToCanvasCoordinates(point.position);
                list.push({ id: point.id.id, size: point.pixelSize, show: point.show, at: at ? [at.x, at.y] : null });
              }
              return list;
            }
          }
          return [];
        });
        await sleep(400);
        const near = drawn.find((point) => point.id === 'near');
        const far = drawn.find((point) => point.id === 'far');
        expect(drawn.length === 2, `drew ${drawn.length} circles, expected 2 (the blast must be left out)`);
        expect(near.size > far.size, 'the stronger earthquake is not the bigger circle');
        const hidden = await page.evaluate(() => {
          const primitives = window.__zt.viewer().scene.primitives;
          for (let i = 0; i < primitives.length; i++) {
            const one = primitives.get(i);
            if (one && typeof one.get === 'function' && one.length > 0 && typeof one.get(0)?.id?.mag === 'number') {
              for (let j = 0; j < one.length; j++) if (one.get(j).id.id === 'far') return one.get(j).show === false;
            }
          }
          return null;
        });
        expect(hidden === true, 'the earthquake on the far side of the Earth shows through it');
        expect(/U\.S\. Geological Survey/.test(await page.evaluate(() => document.getElementById('cesium-credits').textContent)), 'the survey is not credited on screen');
        await page.mouse.click(near.at[0], near.at[1]);
        await until(page, () => window.__zt.labels('alon-earthquakes') === 1 && window.__zt.painted('alon-earthquakes') >= 1, 5000, 'clicking an earthquake did not show its card');
        await clickMap(page, 0.3, 0.75);
        await until(page, () => window.__zt.labels('alon-earthquakes') === 0, 4000, 'clicking away did not put the card away');
        await press(page, 'earthquakes-toggle');
        const after = await page.evaluate(() => ({
          count: document.getElementById('earthquakes-toggle').dataset.count,
          credit: /U\.S\. Geological Survey/.test(document.getElementById('cesium-credits').textContent),
        }));
        expect(after.count === '' && !after.credit, 'switching off left the earthquakes or their credit behind');
      } finally {
        page.off('request', answer);
        await page.setRequestInterception(false);
      }
    },
  ],
  [
    'time zones',
    async (page) => {
      await press(page, 'time-zones-toggle');
      await until(page, () => window.__zt.entities('alon-time-zones') > 1000, 10_000, 'the zone borders were not drawn');
      await until(page, () => window.__zt.labels('alon-time-zones') > 20, 5000, 'the zone labels were not drawn');
      await press(page, 'time-zones-toggle');
      await until(
        page,
        () => {
          const source = window.__zt.viewer().dataSources.getByName('alon-time-zones')[0];
          return !source || source.show === false || source.entities.values.length === 0;
        },
        5000,
        'the zone borders stayed after switching off',
      );
      // Off means taken off the map, so on again has to bring them back.
      await press(page, 'time-zones-toggle');
      await until(page, () => window.__zt.entities('alon-time-zones') > 1000, 10_000, 'the borders did not come back the second time');
      await press(page, 'time-zones-toggle');
      await until(page, () => window.__zt.entities('alon-time-zones') === 0, 5000, 'the borders stayed after the second switch-off');
    },
  ],
  [
    'map pin shows the local time, and only when it is on',
    async (page) => {
      const card = () =>
        page.evaluate(() => {
          const element = document.getElementById('address-card');
          return window.__zt.shown(element) ? element.textContent : null;
        });
      await clickMap(page, 0.45, 0.6);
      expect((await card()) === null, 'a click opened the card while the pin was off');
      await press(page, 'address-lookup-toggle');
      await clickMap(page, 0.45, 0.6);
      await until(page, () => /Local time\s*\d\d:\d\d:\d\d/.test(document.getElementById('address-card')?.textContent ?? ''), 5000, 'no local time in the card');
      const first = await card();
      expect(/Coordinates/.test(first), 'no coordinates in the card');
      // The right time, not just the right shape: London's clock and offset.
      const clock = await page.evaluate(async () => {
        const { offsetLabel, offsetMinutes } = await import('/src/app/timeZones.js');
        const shown = /Local time\s*(\d\d):(\d\d):(\d\d)/.exec(document.getElementById('address-card').textContent);
        const real = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date()).split(':').map(Number);
        const seconds = (h, m, s) => h * 3600 + m * 60 + s;
        const gap = Math.abs(seconds(...shown.slice(1).map(Number)) - seconds(...real));
        return { off: Math.min(gap, 86_400 - gap), offset: offsetLabel(offsetMinutes('Europe/London')), text: document.getElementById('address-card').textContent };
      });
      expect(clock.off <= 2, `the card's time is ${clock.off} s away from London's`);
      expect(clock.text.includes(clock.offset), `the card does not show London's offset (${clock.offset})`);
      const sun = await page.evaluate(() => document.getElementById('address-card-sun')?.textContent ?? '');
      expect(/^(Day|Twilight|Night) · (sunrise|sunset) \d\d:\d\d · (sunrise|sunset) \d\d:\d\d$/.test(sun), `the sun line said "${sun}"`);
      // It must agree with the shading: the same sun maths, asked directly.
      const agrees = await page.evaluate(async () => {
        const { partOfDay, subsolarPoint } = await import('/src/app/dayNight.js');
        const card = document.getElementById('address-card');
        const lat = Number(card.dataset.lat);
        const lon = Number(card.dataset.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return 'no coordinates to compare';
        const part = partOfDay(lat, lon, subsolarPoint(Date.now()));
        return document.getElementById('address-card-sun').textContent.toLowerCase().startsWith(part) ? 'yes' : `card disagrees with ${part}`;
      });
      expect(agrees === 'yes', `the sun line and the shading disagree: ${agrees}`);
      await sleep(1300);
      expect((await card()) !== first, 'the clock in the card is not ticking');
      await press(page, 'address-lookup-toggle');
      expect((await card()) === null, 'the card stayed after the pin was switched off');
    },
  ],
  [
    'HD buildings',
    async (page, setup) => {
      const read = () =>
        page.evaluate(() => {
          const { canvas } = window.__zt.viewer().scene;
          return {
            on: window.__zt.pressed('hd-detail-toggle'),
            recommended: window.__zt.viewer().useBrowserRecommendedResolution,
            detail: window.__godsEyeView.tileset?.maximumScreenSpaceError ?? null,
            ratio: canvas.width / canvas.clientWidth,
            idle: window.__zt.viewer().scene.requestRenderMode === true,
            textures: document.body.dataset.hdTextures,
          };
        });
      // At one device pixel per screen point HD draws the same as normal, so
      // this runs on a sharp screen, as on a Retina Mac.
      const size = page.viewport();
      await page.setViewport({ ...size, deviceScaleFactor: 2 });
      try {
        await sleep(1000);
        const states = [];
        for (let i = 0; i < 2; i++) {
          await press(page, 'hd-detail-toggle');
          await sleep(900);
          states.push(await read());
        }
        expect(states[0].on !== states[1].on, 'the HD switch did not change');
        for (const state of states) {
          const word = state.on ? 'on' : 'off';
          expect(state.recommended === !state.on, `with HD ${word} the drawing resolution setting disagrees`);
          // Still with nothing moving, HD draws one and a half times the screen's pixels.
          const want = state.on ? (state.idle ? 3 : 2) : 1;
          expect(Math.abs(state.ratio - want) < 0.15, `with HD ${word} the map draws ${state.ratio.toFixed(2)} pixels per screen point, not ${want}`);
          expect(state.textures === (state.on ? 'sharp' : 'plain'), `with HD ${word} the tile pictures are ${state.textures}`);
          if (setup.map === 'photoreal') {
            expect(state.detail === (state.on ? 8 : 16), `with HD ${word} the 3D buildings use detail ${state.detail}`);
          }
        }
      } finally {
        await page.setViewport(size);
        await sleep(600);
      }
    },
  ],
  [
    'measure tool',
    async (page) => {
      const readout = () =>
        page.evaluate(() => {
          const element = document.getElementById('measure-readout');
          return element.hidden ? null : element.querySelector('span').textContent;
        });
      await press(page, 'address-lookup-toggle');
      await press(page, 'measure-toggle');
      expect(/start measuring/.test(await readout()), 'the readout did not appear');
      await clickMap(page, 0.42, 0.58);
      await clickMap(page, 0.58, 0.62);
      const two = await readout();
      expect(/^[\d.,]+ (cm|m|km) · 2 points$/.test(two), `after two clicks the readout said "${two}"`);
      expect((await page.evaluate(() => window.__zt.entities('alon-measure'))) === 3, 'two points and one line were not drawn');
      expect((await page.evaluate(() => window.__zt.labels('alon-measure'))) === 1, 'the total was not labelled on the map');
      expect(!(await page.evaluate(() => window.__zt.shown(document.getElementById('address-card')))), 'the map pin fired while measuring');
      const [x, y] = spot(page, 0.5, 0.7);
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 90, y + 30, { steps: 6 });
      await page.mouse.up();
      await sleep(400);
      expect(/2 points$/.test(await readout()), 'dragging the map added a point');
      // Undo, then closing a shape for its area.
      await clickMap(page, 0.58, 0.74);
      expect(/3 points$/.test(await readout()), 'the third click did not add a point');
      await page.click('#measure-undo');
      expect(/2 points$/.test(await readout()), 'Undo did not remove the last point');
      await clickMap(page, 0.58, 0.74);
      await page.click('#measure-close');
      const shut = await readout();
      expect(/^Area [\d.,]+ (m²|km²) · outline [\d.,]+ (m|km)$/.test(shut), `a closed shape read "${shut}"`);
      expect((await page.evaluate(() => window.__zt.entities('alon-measure'))) === 5, 'three points, the outline and the filling were not drawn');
      expect((await page.evaluate(() => window.__zt.labels('alon-measure'))) === 4, 'the area and the three sides were not labelled');
      // The area label always shows. Side labels may give way to each other.
      await until(page, () => window.__zt.painted('alon-measure') >= 1, 4000, 'no measuring label is drawn on screen');
      await clickMap(page, 0.5, 0.5);
      expect((await readout()) === shut, 'a click changed a closed shape');
      await page.click('#measure-undo');
      expect(/3 points$/.test(await readout()), 'Undo did not reopen the shape');
      const first = await page.evaluate(() => {
        const viewer = window.__zt.viewer();
        const entity = viewer.dataSources.getByName('alon-measure')[0].entities.values[0];
        const at = viewer.scene.cartesianToCanvasCoordinates(entity.position.getValue());
        return at ? [at.x, at.y] : null;
      });
      expect(first, 'the first point is not on screen');
      await page.mouse.click(first[0], first[1]);
      await sleep(600);
      expect(/^Area /.test(await readout()), 'clicking the first point did not close the shape');
      await page.click('#measure-clear');
      expect(/start measuring/.test(await readout()), 'Clear did not clear');
      await press(page, 'measure-toggle');
      expect((await readout()) === null, 'the readout stayed after switching off');
      await press(page, 'address-lookup-toggle');
    },
  ],
  [
    'day and night',
    async (page, setup) => {
      const state = () =>
        page.evaluate(() => {
          const { viewer, tileset } = window.__godsEyeView;
          return {
            tiles: Boolean(tileset?.customShader),
            globe: Boolean(viewer.scene.globe.material),
            credit: /NASA/.test(document.getElementById('cesium-credits')?.textContent ?? ''),
          };
        });
      await press(page, 'day-night-toggle');
      await sleep(1500);
      const on = await state();
      // The time slider: six hours ahead turns the sun a quarter of the way
      // round, and Now brings it back. The click card's clock is not touched.
      const sunLon = () =>
        page.evaluate(() => {
          const { viewer, tileset } = window.__godsEyeView;
          const sun = tileset?.customShader?.uniforms?.u_sun?.value ?? viewer.scene.globe.material?.uniforms?.sunDir;
          return sun ? (Math.atan2(sun.y, sun.x) * 180) / Math.PI : null;
        });
      const sliderShown = await page.evaluate(() => window.__zt.shown(document.getElementById('day-night-time')));
      const lonNow = await sunLon();
      await page.evaluate(() => {
        const slider = document.querySelector('#day-night-time input');
        slider.value = '360';
        slider.dispatchEvent(new Event('input', { bubbles: true }));
      });
      const lonLater = await sunLon();
      const label = await page.evaluate(() => document.querySelector('#day-night-time span').textContent);
      await page.click('#day-night-time button');
      const lonBack = await sunLon();
      await press(page, 'day-night-toggle');
      await sleep(1300);
      const off = await state();
      const shaded = setup.map === 'photoreal' ? on.tiles && !on.globe : on.globe && !on.tiles;
      expect(shaded, `the wrong surface was shaded: ${JSON.stringify(on)}`);
      expect(sliderShown, 'the time slider did not appear');
      expect(Math.abs(turn(lonLater, lonNow) - 90) < 1, `six hours ahead moved the sun ${turn(lonLater, lonNow).toFixed(1)} degrees`);
      expect(/6 h ahead$/.test(label), `the slider label said "${label}"`);
      expect(Math.abs(turn(lonBack, lonNow)) < 0.5, 'Now did not return to the real time');
      expect(on.credit, 'the NASA credit is not on screen');
      expect(!(await page.evaluate(() => window.__zt.shown(document.getElementById('day-night-time')))), 'the time slider stayed after switching off');
      expect(!off.tiles && !off.globe && !off.credit, `it did not switch off cleanly: ${JSON.stringify(off)}`);
    },
  ],
  [
    'nothing of mine covers the map credits or each other',
    async (page) => {
      await press(page, 'day-night-toggle');
      await press(page, 'measure-toggle');
      await clickMap(page, 0.42, 0.5);
      await clickMap(page, 0.58, 0.5);
      const state = await page.evaluate(() => {
        const rect = (element) => {
          const r = element.getBoundingClientRect();
          return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
        };
        const hit = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
        // The credits box itself has no size; its contents do.
        const credits = [...document.querySelectorAll('#cesium-credits *')]
          .filter((node) => node.children.length === 0)
          .map(rect)
          .filter((r) => r.right - r.left > 4 && r.bottom - r.top > 4 && r.left < innerWidth);
        const mine = ['#day-night-time', '#measure-readout', '#scale-bar', '#compass-dial svg']
          .map((selector) => [selector, document.querySelector(selector)])
          .filter(([, element]) => window.__zt.shown(element))
          .map(([selector, element]) => [selector, rect(element)]);
        const covering = mine.filter(([, r]) => credits.some((credit) => hit(r, credit))).map(([selector]) => selector);
        const clashing = [];
        for (let i = 0; i < mine.length; i++) {
          for (let j = i + 1; j < mine.length; j++) {
            if (hit(mine[i][1], mine[j][1])) clashing.push(`${mine[i][0]} and ${mine[j][0]}`);
          }
        }
        return { credits: credits.length, shown: mine.length, covering, clashing };
      });
      await page.click('#measure-clear');
      await press(page, 'measure-toggle');
      await press(page, 'day-night-toggle');
      expect(state.credits > 0, 'no map credits were found on screen');
      expect(state.shown === 4, `only ${state.shown} of my four panels were showing`);
      expect(state.covering.length === 0, `covering the map credits: ${state.covering.join(', ')}`);
      expect(state.clashing.length === 0, `overlapping: ${state.clashing.join('; ')}`);
    },
  ],
  [
    'saved places',
    async (page) => {
      const camera = () =>
        page.evaluate(() => ({
          lat: (window.__zt.viewer().camera.positionCartographic.latitude * 180) / Math.PI,
          height: window.__zt.height(),
          heading: window.__zt.heading(),
        }));
      const names = () =>
        page.evaluate(() => [...document.querySelectorAll('#saved-places .sp-name')].map((n) => n.textContent));
      const look = () =>
        page.evaluate(() => ({
          clean: document.body.classList.contains('ui-clean-view'),
          style: /style=([a-z]+)/.exec(location.hash)?.[1] ?? null,
        }));
      const saved = await camera();
      const lookBefore = await look();
      await press(page, 'saved-places-toggle');
      // The letters are app shortcuts: typing a name must not set them off.
      await page.type('#saved-places input', '  Test   place chv ');
      await page.keyboard.press('Enter');
      expect((await names())[0] === 'Test place chv', `saved as "${(await names())[0]}"`);
      const lookAfter = await look();
      expect(lookAfter.clean === lookBefore.clean && lookAfter.style === lookBefore.style, 'typing a name set off a shortcut');
      expect(!/Test|place/.test(await page.evaluate(() => location.hash)), 'the name leaked into the page address');
      await page.evaluate(() => {
        const { camera } = window.__zt.viewer();
        camera.setView({ destination: camera.position.constructor.fromDegrees(2.35, 48.85, 300000) });
      });
      await sleep(500);
      await page.click('#saved-places .sp-go');
      await sleep(4200);
      const back = await camera();
      expect(Math.abs(back.lat - saved.lat) < 0.001 && Math.abs(back.height - saved.height) < 5, 'it did not fly back to the saved view');
      expect(Math.abs(turn(saved.heading, back.heading)) < 1, 'it flew back facing the wrong way');
      await page.click('#saved-places .sp-delete');
      expect((await names()).length === 0, 'delete did not remove the place');
      // A place remembers the look: the visual preset and the layers that were on.
      const layerState = () =>
        page.evaluate(() => ({
          style: window.__godsEyeView.styleManager.activeStyle,
          layers: [...window.__godsEyeView.dataManager.getEnabledLayerIds()].sort().join(','),
        }));
      const plain = await layerState();
      const spare = await page.evaluate(() => {
        const manager = window.__godsEyeView.dataManager;
        return ['satellites', 'flights'].find((id) => manager.layers.has(id) && !manager.isEnabled(id)) ?? null;
      });
      await page.evaluate((id) => {
        window.__godsEyeView.styleManager.setStyle('noir', { revealParameters: false });
        if (id) window.__godsEyeView.dataManager.toggle(id, { origin: 'user' });
      }, spare);
      await sleep(1500);
      const dressed = await layerState();
      await page.type('#saved-places input', 'With a look');
      await page.keyboard.press('Enter');
      await page.evaluate((id) => {
        window.__godsEyeView.styleManager.setStyle('normal', { revealParameters: false });
        if (id) window.__godsEyeView.dataManager.toggle(id, { origin: 'user' });
      }, spare);
      await sleep(1500);
      expect(JSON.stringify(await layerState()) === JSON.stringify(plain), 'could not put the plain look back before the test');
      await page.click('#saved-places .sp-go');
      await sleep(3500);
      const restored = await layerState();
      // Leave things as they were found.
      await page.click('#saved-places .sp-delete');
      await page.evaluate((id) => {
        window.__godsEyeView.styleManager.setStyle('normal', { revealParameters: false });
        if (id && window.__godsEyeView.dataManager.isEnabled(id)) window.__godsEyeView.dataManager.toggle(id, { origin: 'user' });
      }, spare);
      await sleep(1200);
      expect(dressed.style === 'noir', `could not set the noir look for the test (${dressed.style})`);
      expect(JSON.stringify(restored) === JSON.stringify(dressed), `flying to the place gave ${JSON.stringify(restored)}, it was saved with ${JSON.stringify(dressed)}`);
      await page.keyboard.press('Escape');
      expect(await page.evaluate(() => document.getElementById('saved-places').hidden), 'Escape did not close the panel');
    },
  ],
  [
    'video mode',
    async (page) => {
      const state = () =>
        page.evaluate(() => ({
          clean: document.body.classList.contains('ui-clean-view'),
          on: window.__zt.pressed('video-mode-toggle'),
          heading: window.__zt.heading(),
          credits: [...document.querySelectorAll('#cesium-credits *')].some((node) => {
            const r = node.getBoundingClientRect();
            return r.width > 20 && r.height > 5 && r.left >= 0 && r.bottom <= innerHeight;
          }),
          exit: window.__zt.shown(document.getElementById('clean-view-exit')),
        }));
      // The switch opens a panel first: speed, direction, Start.
      await press(page, 'video-mode-toggle', { leaveTray: true });
      expect(!(await page.evaluate(() => document.getElementById('video-mode-panel').hidden)), 'the video panel did not open');
      expect(!(await trayOpen(page)), 'the tray stayed open over the video panel');
      await page.click('#video-mode-panel [data-speed="normal"]');
      await page.click('#video-mode-panel [data-way="clockwise"]');
      await page.click('#video-mode-start');
      await sleep(600);
      const start = await state();
      expect(start.clean && start.on, 'video mode did not hide the controls');
      expect(start.credits, 'the map credits are not visible in video mode');
      expect(!start.exit, 'the exit button would show in a recording');
      await sleep(2000);
      const later = await state();
      const rate = turn(start.heading, later.heading) / 2;
      expect(rate > 3 && rate < 8, `the view turned at ${rate.toFixed(1)} degrees a second`);
      // Starting a screen recording (Cmd+Shift+5) must not end it.
      await page.keyboard.down('Meta');
      await page.keyboard.down('Shift');
      await page.keyboard.press('5');
      await page.keyboard.up('Shift');
      await page.keyboard.up('Meta');
      expect((await state()).on, 'a Cmd shortcut ended video mode');
      await page.keyboard.press('v');
      await sleep(500);
      const end = await state();
      expect(!end.on && !end.clean, 'a key did not end video mode cleanly');
      const stopped = await state();
      await sleep(800);
      expect(Math.abs(turn(stopped.heading, (await state()).heading)) < 0.05, 'the view kept turning');
      // Fast and the other way round, and the choice is remembered.
      await press(page, 'video-mode-toggle', { leaveTray: true });
      await page.click('#video-mode-panel [data-speed="fast"]');
      await page.click('#video-mode-panel [data-way="anticlockwise"]');
      await page.click('#video-mode-start');
      await sleep(600);
      const fastA = await state();
      await sleep(2000);
      const fastB = await state();
      await page.keyboard.press('Escape');
      await sleep(400);
      const fastRate = turn(fastA.heading, fastB.heading) / 2;
      const saved = await page.evaluate(() => localStorage.getItem('gev.videoMode'));
      await press(page, 'video-mode-toggle', { leaveTray: true });
      const remembered = await page.evaluate(() => [
        document.querySelector('#video-mode-panel [data-speed="fast"]').getAttribute('aria-pressed'),
        document.querySelector('#video-mode-panel [data-way="anticlockwise"]').getAttribute('aria-pressed'),
      ]);
      await page.click('#video-mode-panel [data-speed="normal"]');
      await page.click('#video-mode-panel [data-way="clockwise"]');
      await page.keyboard.press('Escape');
      expect(fastRate < -7 && fastRate > -13, `fast and anticlockwise turned at ${fastRate.toFixed(1)} degrees a second`);
      expect(saved === '{"speed":"fast","clockwise":false}', `the choice was saved as ${saved}`);
      expect(remembered.join() === 'true,true', 'the panel did not show the remembered choice');
      expect(await page.evaluate(() => document.getElementById('video-mode-panel').hidden), 'Escape did not close the video panel');

      // A click on the map ends it too, and that click does not also drop a pin.
      await press(page, 'address-lookup-toggle');
      try {
        await press(page, 'video-mode-toggle', { leaveTray: true });
        await page.click('#video-mode-start');
        await sleep(800);
        expect((await state()).on, 'video mode did not start again');
        const [x, y] = spot(page, 0.5, 0.6);
        await page.mouse.click(x, y);
        await sleep(1200);
        const clicked = await state();
        expect(!clicked.on && !clicked.clean, 'a click on the map did not end video mode');
        expect(!(await page.evaluate(() => window.__zt.shown(document.getElementById('address-card')))), 'the click that ended video mode also opened the map pin card');
      } finally {
        if ((await state()).on) await page.keyboard.press('Escape');
        await press(page, 'address-lookup-toggle');
      }
    },
  ],
  [
    'help card',
    async (page) => {
      const card = () =>
        page.evaluate(() => {
          const element = document.getElementById('zenith-help');
          const r = element.getBoundingClientRect();
          return {
            open: !element.hidden,
            rows: element.querySelectorAll('.zh-row').length,
            pin: element.querySelector('.zh-pin')?.textContent ?? '',
            inside: r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
          };
        });
      await press(page, 'zenith-help-toggle');
      const open = await card();
      expect(open.open && open.inside, 'the help card did not open inside the window');
      expect(open.rows === SWITCHES.length - 1, `the card lists ${open.rows} switches, expected ${SWITCHES.length - 1}`);
      expect(/pin OFF/.test(open.pin), 'the card does not say the pin is off');
      await press(page, 'address-lookup-toggle');
      expect(/pin ON/.test((await card()).pin), 'the card did not notice the pin being switched on');
      await press(page, 'address-lookup-toggle');
      await page.keyboard.press('Escape');
      expect(!(await card()).open, 'Escape did not close the help card');
      expect((await page.evaluate(() => localStorage.getItem('gev.helpCard'))) === 'closed', 'closing was not remembered');
    },
  ],
  [
    'version and what is new',
    async (page) => {
      const { ZENITH_VERSION, versionLine } = await import('./src/app/zenithVersion.js');
      await press(page, 'zenith-help-toggle');
      const read = () =>
        page.evaluate(() => {
          const box = document.getElementById('zenith-whats-new');
          const card = document.getElementById('zenith-help').getBoundingClientRect();
          const r = box.getBoundingClientRect();
          return {
            title: box.querySelector('summary').textContent,
            open: box.open,
            lines: [...box.querySelectorAll('li')].map((li) => li.textContent),
            // A closed list keeps its place in the page, so ask the browser.
            shown: box.querySelector('li').checkVisibility(),
            inside: r.left >= card.left && r.right <= card.right + 1,
          };
        });
      const closed = await read();
      expect(closed.title.includes(versionLine()), `the card says "${closed.title}", expected ${versionLine()}`);
      expect(!closed.open && !closed.shown, 'the list of changes was open before being asked for');
      await page.evaluate(() => {
        const summary = document.querySelector('#zenith-whats-new summary');
        summary.scrollIntoView({ block: 'center' });
        summary.click();
      });
      await sleep(250);
      const opened = await read();
      expect(opened.open && opened.shown, 'clicking the title did not open the list of changes');
      expect(opened.lines.length === ZENITH_VERSION.changes.length && opened.lines[0] === ZENITH_VERSION.changes[0], 'the list in the card is not the list for this build');
      expect(opened.inside, 'the list sticks out of the help card');
      // A switch changing redraws the card: the list must stay open.
      await press(page, 'address-lookup-toggle');
      const redrawn = await read();
      await press(page, 'address-lookup-toggle');
      await page.evaluate(() => (document.getElementById('zenith-whats-new').open = false));
      await page.keyboard.press('Escape');
      expect(redrawn.open, 'the list closed itself when the card was redrawn');
    },
  ],
  [
    'settings file: saved without keys, a bad file refused, a good one loaded',
    async (page) => {
      await press(page, 'zenith-help-toggle');
      const before = await page.evaluate(() => {
        // Catch the file the Save button makes, where a person would get a download.
        const real = URL.createObjectURL.bind(URL);
        window.__savedSettings = null;
        URL.createObjectURL = (blob) => {
          window.__savedSettings = blob;
          return real(blob);
        };
        localStorage.setItem('gev.testOnlySecretKey', 'sk-live-do-not-export');
        document.getElementById('zenith-settings-message').textContent = '';
        document.getElementById('zenith-settings-save').click();
        URL.createObjectURL = real;
        return { video: localStorage.getItem('gev.videoMode'), places: localStorage.getItem('gev.savedPlaces') };
      });
      const saved = await page.evaluate(async () => (window.__savedSettings ? window.__savedSettings.text() : null));
      await page.evaluate(() => localStorage.removeItem('gev.testOnlySecretKey'));
      expect(saved, 'Save made no file');
      const file = JSON.parse(saved);
      expect(file.app === 'Zenith' && file.kind === 'settings' && file.version === 1, 'the saved file is not marked as a Zenith settings file');
      expect(file.settings['gev.helpCard'] === 'closed', 'the saved file is missing a setting this browser has');
      expect(!/sk-live|token|secret|apikey|api_key/i.test(saved), 'the saved file holds something that looks like a key');
      expect(Object.keys(file.settings).every((key) => key.startsWith('gev.')), 'the saved file holds a setting that is not this build\'s');

      // A file that is not ours, and a damaged one: refused, nothing stored.
      for (const text of ['{"hello":"world"}', saved.slice(0, 40), '']) {
        await page.evaluate(() => (document.getElementById('zenith-settings-message').textContent = ''));
        const refused = await chooseSettingsFile(page, text);
        expect(refused.bad && !refused.reload, `a bad file was not refused ("${refused.said}")`);
      }
      expect((await page.evaluate(() => localStorage.getItem('gev.videoMode'))) === before.video, 'a refused file still changed a setting');

      // A good file, with one thing in it that must not get through.
      const incoming = structuredClone(file);
      incoming.settings['gev.videoMode'] = '{"speed":"fast","clockwise":false}';
      incoming.settings.CESIUM_ION_TOKEN = 'should-be-ignored';
      await page.evaluate(() => (document.getElementById('zenith-settings-message').textContent = ''));
      const loaded = await chooseSettingsFile(page, JSON.stringify(incoming));
      const after = await page.evaluate(() => ({
        video: localStorage.getItem('gev.videoMode'),
        token: localStorage.getItem('CESIUM_ION_TOKEN'),
        inside: (() => {
          const r = document.getElementById('zenith-settings-file').getBoundingClientRect();
          const card = document.getElementById('zenith-help').getBoundingClientRect();
          return r.left >= card.left && r.right <= card.right + 1;
        })(),
      }));
      // Put this browser back the way it was before judging.
      await page.evaluate((was) => {
        if (was.video === null) localStorage.removeItem('gev.videoMode');
        else localStorage.setItem('gev.videoMode', was.video);
      }, before);
      await page.keyboard.press('Escape');
      expect(!loaded.bad && loaded.reload, `a good file was not loaded ("${loaded.said}")`);
      expect(/1 other thing was ignored/.test(loaded.said), `the card did not say one thing was ignored ("${loaded.said}")`);
      expect(after.video === '{"speed":"fast","clockwise":false}', 'the loaded setting was not stored');
      expect(after.token === null, 'something that is not a setting was stored');
      expect(after.inside, 'the settings buttons stick out of the help card');
    },
  ],
  [
    'Cmd+C, Cmd+V and Cmd+F do not set off shortcuts',
    async (page) => {
      const state = () =>
        page.evaluate(() => ({
          style: /style=([a-z]+)/.exec(location.hash)?.[1] ?? null,
          clean: document.body.classList.contains('ui-clean-view'),
          cctv: document.getElementById('cctv-panel')?.classList.contains('collapsed'),
          layers: /[#&]l=([^&]*)/.exec(location.hash)?.[1] ?? '',
        }));
      const before = await state();
      for (const key of ['c', 'v', '3', 'f']) {
        await page.keyboard.down('Meta');
        await page.keyboard.press(key);
        await page.keyboard.up('Meta');
      }
      await sleep(1200);
      const after = await state();
      expect(JSON.stringify(after) === JSON.stringify(before), `a Cmd shortcut changed the app: ${JSON.stringify(after)}`);
    },
  ],
  [
    'choosing a look does not open the Display panel',
    async (page) => {
      const panel = () => page.evaluate(() => document.getElementById('pp-toggles').classList.contains('collapsed'));
      expect(await panel(), 'the Display panel was already open');
      await page.keyboard.press('6');
      await sleep(1500);
      const shut = await panel();
      const style = await page.evaluate(() => /style=([a-z]+)/.exec(location.hash)?.[1]);
      await page.keyboard.press('1');
      await sleep(1200);
      expect(style === 'noir', `key 6 chose "${style}", expected noir`);
      expect(shut, 'choosing a look opened the Display panel');
    },
  ],
  [
    'the Earth stays centred when zooming far out, with no zoom limit, and the tilt comes back',
    async (page) => {
      const home = await page.evaluate(() => location.hash);
      const [x, y] = spot(page, 0.5, 0.55);
      await page.mouse.move(x, y);
      // Scroll until far out. How far one notch goes depends on how busy the
      // browser is, so this keeps going until it is there, within a limit.
      for (let i = 0; i < 300; i++) {
        await page.mouse.wheel({ deltaY: 500 });
        await sleep(40);
        if (i % 10 === 9 && (await page.evaluate(() => window.__zt.height())) > 25_000_000) break;
      }
      await sleep(1500);
      const far = await page.evaluate(() => {
        const viewer = window.__zt.viewer();
        const centre = viewer.scene.cartesianToCanvasCoordinates(new viewer.camera.position.constructor(0, 0, 0));
        return {
          height: window.__zt.height(),
          pitch: window.__zt.pitch(),
          offX: centre ? Math.abs(centre.x - viewer.canvas.clientWidth / 2) / viewer.canvas.clientWidth : 1,
          offY: centre ? Math.abs(centre.y - viewer.canvas.clientHeight / 2) / viewer.canvas.clientHeight : 1,
        };
      });
      // No zoom limit: more scrolling must keep going out, well past where
      // the Earth fits.
      let further = far.height;
      for (let i = 0; i < 300 && further <= far.height * 2; i++) {
        await page.mouse.wheel({ deltaY: 800 });
        await sleep(30);
        if (i % 10 === 9) further = await page.evaluate(() => window.__zt.height());
      }
      await sleep(600);
      further = await page.evaluate(() => window.__zt.height());
      // Tilt memory: zooming back in gives back the tilt the view started with.
      const startPitch = Number(/pitch=(-?[\d.]+)/.exec(home)[1]);
      for (let i = 0; i < 400; i++) {
        await page.mouse.wheel({ deltaY: -400 });
        await sleep(25);
        if (i % 20 === 19 && (await page.evaluate(() => window.__zt.height())) < 3000) break;
      }
      await sleep(1200);
      const backIn = await page.evaluate(() => ({ height: window.__zt.height(), pitch: window.__zt.pitch() }));
      // Put the view back for the checks that follow.
      await page.evaluate((hash) => {
        const { camera } = window.__zt.viewer();
        const get = (key) => Number(new RegExp(`${key}=(-?[\\d.]+)`).exec(hash)[1]);
        camera.setView({
          destination: camera.position.constructor.fromDegrees(get('lon'), get('lat'), get('alt')),
          orientation: { heading: (get('heading') * Math.PI) / 180, pitch: (get('pitch') * Math.PI) / 180, roll: 0 },
        });
      }, home);
      await sleep(1500);
      expect(far.height > 20_000_000, `scrolling out only reached ${Math.round(far.height / 1000)} km`);
      expect(far.pitch < -85, `far out the view is tilted (${far.pitch.toFixed(0)} degrees)`);
      expect(far.offX < 0.06 && far.offY < 0.06, 'far out the Earth is not in the middle of the screen');
      expect(further > far.height * 2, 'zooming out stopped: there is a zoom limit');
      expect(backIn.height < 100_000, `scrolling back in only reached ${Math.round(backIn.height / 1000)} km`);
      expect(Math.abs(backIn.pitch - startPitch) < 5, `after zooming back in the tilt was ${backIn.pitch.toFixed(0)} degrees, it started at ${startPitch}`);
    },
  ],
  [
    'one add-on failing does not stop the map or the other add-ons',
    async (page) => {
      // An add-on made to fail on purpose, wired in the way the real ones are.
      const result = await page.evaluate(async () => {
        const { guard } = await import('/src/app/addOns.js');
        const viewer = window.__zt.viewer();
        let calls = 0;
        const remove = viewer.scene.preRender.addEventListener(
          guard('Test add-on', () => {
            calls += 1;
            throw new Error('made to fail by the browser test');
          }),
        );
        const alive = await window.__zt.alive();
        await new Promise((done) => setTimeout(done, 300));
        const notice = document.getElementById('zenith-addon-notice');
        const said = notice?.textContent ?? '';
        remove();
        notice?.remove();
        return { calls, said, ...alive };
      });
      expect(result.calls === 1, `the failing add-on was called ${result.calls} times, expected once and then never again`);
      expect(result.frames >= 3 && result.loop, 'the map stopped drawing when one add-on failed');
      expect(/Test add-on has a problem and was switched off/.test(result.said), `the notice said "${result.said}"`);
      // And another add-on still does its job.
      const before = await page.evaluate(() => window.__zt.stationMarkers());
      await press(page, 'train-stations-toggle');
      await until(page, (n) => window.__zt.stationMarkers() > n, 8000, 'train stations stopped working after another add-on failed', before);
      await press(page, 'train-stations-toggle');
    },
  ],
  [
    'every visual preset, close to the ground and far out, with the add-ons on',
    async (page, setup) => {
      const DRAWN = ['map-labels-toggle', 'train-stations-toggle', 'time-zones-toggle', 'day-night-toggle'];
      const home = await page.evaluate(() => {
        const camera = window.__zt.viewer().camera;
        const at = camera.positionCartographic;
        return [at.longitude, at.latitude, at.height, camera.heading, camera.pitch];
      });
      const goTo = (lon, lat, height, heading, pitch) =>
        page.evaluate(
          (lon, lat, height, heading, pitch) => {
            const viewer = window.__zt.viewer();
            viewer.camera.setView({
              destination: viewer.scene.globe.ellipsoid.cartographicToCartesian({ longitude: lon, latitude: lat, height }),
              orientation: { heading, pitch, roll: 0 },
            });
          },
          lon,
          lat,
          height,
          heading,
          pitch,
        );
      const problems = [];
      let styles = [];
      try {
        for (const where of ['close', 'far']) {
          if (where === 'far') {
            // Over the line where night is falling right now, so half the
            // view is in daylight and half in the dark at any hour.
            const hours = new Date().getUTCHours() + new Date().getUTCMinutes() / 60;
            const duskLon = (((12 - hours) * 15 + 78 + 540) % 360) - 180;
            await goTo((duskLon * Math.PI) / 180, (25 * Math.PI) / 180, 11_000_000, 0, -Math.PI / 2);
            await sleep(3000);
          }
          for (const id of DRAWN) if (!(await pressed(page, id))) await press(page, id);
          await until(page, () => window.__zt.dayNightDrawn() && window.__zt.entities('alon-time-zones') > 0, 15_000, `${where}: day and night or time zones did not come on`);
          await sleep(1200);
          for (let key = 1; key <= 7; key++) {
            await page.keyboard.press(String(key));
            await sleep(1300);
            const state = await page.evaluate(async (ids) => ({
              style: /style=([a-z]+)/.exec(location.hash)?.[1] ?? 'normal',
              alive: await window.__zt.alive(),
              dayNight: window.__zt.dayNightDrawn(),
              zones: window.__zt.entities('alon-time-zones'),
              on: ids.filter((id) => window.__zt.pressed(id)).length,
              credits: window.__zt.creditsClear(),
              slider: window.__zt.shown(document.getElementById('day-night-time')),
              parts: ['compass-dial', 'scale-bar'].filter((id) => window.__zt.shown(document.getElementById(id))).length,
            }), DRAWN);
            const tag = `${where}, preset ${key} (${state.style})`;
            styles.push(state.style);
            if (!(state.alive.frames >= 3 && state.alive.loop)) problems.push(`${tag}: the map stopped drawing`);
            if (state.alive.notice) problems.push(`${tag}: ${state.alive.notice}`);
            if (!state.dayNight) problems.push(`${tag}: the day and night shading was taken off the map`);
            if (!(state.zones > 0)) problems.push(`${tag}: the time zone borders went away`);
            if (state.on !== DRAWN.length) problems.push(`${tag}: only ${state.on} of ${DRAWN.length} switches stayed on`);
            if (!state.credits) problems.push(`${tag}: the map credits are covered or gone`);
            if (!state.slider) problems.push(`${tag}: the time slider is not showing`);
            if (state.parts !== 2) problems.push(`${tag}: the compass or the scale is not showing`);
            if (pageErrors.length) problems.push(`${tag}: page error ${pageErrors[0]}`);
            if (where === 'far') {
              // Proof on the screen itself: the picture with day and night on
              // differs from the picture with it off, by far more than two
              // pictures in a row differ (some presets flicker on purpose).
              const withIt = await page.evaluate(() => [window.__zt.frame(), window.__zt.frame()]);
              await press(page, 'day-night-toggle');
              await sleep(500);
              const without = await page.evaluate(() => window.__zt.frame());
              await press(page, 'day-night-toggle');
              await until(page, () => window.__zt.dayNightDrawn(), 8000, `${tag}: day and night did not come back on`);
              const differs = (a, b) => a.reduce((sum, value, at) => sum + Math.abs(value - b[at]), 0) / a.length;
              const change = differs(withIt[0], without);
              const flicker = differs(withIt[0], withIt[1]);
              if (process.env.ZT_DEBUG) console.log(`    ${tag}: change ${change.toFixed(2)}, flicker ${flicker.toFixed(2)}`);
              if (!(change > 1 && change > 3 * flicker)) {
                problems.push(`${tag}: switching day and night off changed the picture by ${change.toFixed(2)} (flicker ${flicker.toFixed(2)}), so it is not reaching the screen`);
              }
            }
          }
          await page.keyboard.press('1');
          await sleep(900);
        }
      } finally {
        await page.keyboard.press('1');
        await sleep(600);
        for (const id of DRAWN) if (await pressed(page, id)) await press(page, id);
        await goTo(...home);
        await sleep(2000);
      }
      const names = [...new Set(styles)];
      expect(names.length === 7, `the number keys reached ${names.length} presets (${names.join(', ')}), expected 7`);
      expect(problems.length === 0, problems.slice(0, 4).join(' | ') + (problems.length > 4 ? ` | and ${problems.length - 4} more` : ''));
      void setup;
    },
  ],
  [
    'Escape closes the map pin card, the height profile and the measure tool',
    async (page, setup) => {
      // On the satellite runs only; the camera goes 500 km up for the pin, so
      // the card asks for no address (the address service is a courtesy one).
      if (setup.map !== 'esri-imagery') return;
      const shown = (id) =>
        page.evaluate((id) => {
          const node = document.getElementById(id);
          return Boolean(node) && node.style.display !== 'none' && !node.hidden && node.getClientRects().length > 0;
        }, id);
      const pressed = (id) => page.evaluate((id) => document.getElementById(id)?.getAttribute('aria-pressed'), id);
      const press = (id) => page.evaluate((id) => document.getElementById(id)?.click(), id);
      const saved = await page.evaluate(() => {
        const { camera } = window.__godsEyeView.viewer;
        const p = camera.positionWC;
        const k = 1 + 500_000 / 6_371_000;
        const before = { x: p.x, y: p.y, z: p.z, heading: camera.heading, pitch: camera.pitch, roll: camera.roll };
        camera.setView({ destination: { x: p.x * k, y: p.y * k, z: p.z * k }, orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
        return before;
      });
      const { width, height } = page.viewport();
      try {
        if ((await pressed('address-lookup-toggle')) !== 'true') await press('address-lookup-toggle');
        await sleep(800);
        await page.mouse.click(Math.round(width / 2), Math.round(height / 2));
        await until(page, () => document.getElementById('address-card')?.style.display === 'block', 10_000, 'the map pin card did not open');
        await page.keyboard.press('Escape');
        expect(!(await shown('address-card')), 'Escape left the map pin card open');
        await press('address-lookup-toggle');
        await press('measure-toggle');
        await page.mouse.click(Math.round(width / 2 - 80), Math.round(height / 2));
        await sleep(300);
        await page.mouse.click(Math.round(width / 2 + 80), Math.round(height / 2 + 40));
        await sleep(500);
        await press('measure-profile-open');
        await until(page, () => document.getElementById('measure-profile')?.hidden === false, 10_000, 'the height profile did not open');
        await page.keyboard.press('Escape');
        expect(!(await shown('measure-profile')), 'Escape left the height profile open');
        expect((await pressed('measure-toggle')) === 'true', 'the first Escape should only close the profile');
        await page.keyboard.press('Escape');
        expect((await pressed('measure-toggle')) === 'false', 'the second Escape should stop measuring');
      } finally {
        if ((await pressed('measure-toggle')) === 'true') await press('measure-toggle');
        if ((await pressed('address-lookup-toggle')) === 'true') await press('address-lookup-toggle');
        await page.evaluate((at) => {
          window.__godsEyeView.viewer.camera.setView({ destination: { x: at.x, y: at.y, z: at.z }, orientation: { heading: at.heading, pitch: at.pitch, roll: at.roll } });
        }, saved);
      }
    },
  ],
  [
    'menus work with the keyboard',
    async (page) => {
      const collapse = '#scene-panel .panel-collapse-btn';
      await page.click(collapse);
      await sleep(600);
      try {
        await page.click('#scene-panel .gev-menu-btn');
        await sleep(400);
        const read = () =>
          page.evaluate(() => {
            const panel = document.querySelector('.gev-menu');
            if (!panel) return null;
            const list = panel.querySelector('[role=listbox]');
            const rows = [...panel.querySelectorAll('[role=option]')];
            const active = panel.querySelector('.gev-menu-row.is-active');
            const pointsAt = document.activeElement?.getAttribute('aria-activedescendant');
            return { name: list?.getAttribute('aria-label'), rows: rows.length, at: rows.indexOf(active), pointed: Boolean(pointsAt) && pointsAt === active?.id };
          });
        const opened = await read();
        expect(opened, 'the menu did not open');
        expect(opened.name, 'the list has no name for a screen reader');
        expect(opened.pointed, 'the focus does not point at the highlighted row');
        await page.keyboard.press('End');
        const end = await read();
        expect(end.at === end.rows - 1 && end.pointed, 'End did not reach the last row');
        await page.keyboard.press('Home');
        expect((await read()).at === 0, 'Home did not reach the first row');
        await page.keyboard.press('Tab');
        await sleep(300);
        expect((await read()) === null, 'Tab left the menu open');
      } finally {
        await page.click(collapse).catch(() => {});
        await sleep(400);
      }
    },
  ],
  [
    'a top-bar switch reached with Tab says what it does',
    async (page) => {
      await page.evaluate(() => document.activeElement?.blur?.());
      let inBar = false;
      for (let i = 0; i < 40 && !inBar; i += 1) {
        await page.keyboard.press('Tab');
        inBar = await page.evaluate(() => document.getElementById('top-center-actions')?.contains(document.activeElement));
      }
      expect(inBar, 'Tab never reached the top bar');
      const tip = await page.evaluate(() => {
        const box = document.getElementById('zenith-focus-tip');
        const focused = document.activeElement;
        return { shown: Boolean(box) && !box.hidden, text: box?.textContent, wanted: focused?.title || focused?.getAttribute('aria-label') };
      });
      expect(tip.shown && tip.text === tip.wanted, `the focus tip shows "${tip.text}" for a switch that says "${tip.wanted}"`);
      await page.keyboard.press('Escape');
      expect(await page.evaluate(() => document.getElementById('zenith-focus-tip')?.hidden), 'Escape left the focus tip showing');
      await page.evaluate(() => document.activeElement?.blur?.());
    },
  ],
  [
    "the credit under the title is shown, word for word, and nothing covers it",
    async (page) => {
      const found = await page.evaluate(() => {
        const credit = document.querySelector('#title-bar .subtitle');
        if (!credit || credit.getClientRects().length === 0) return null;
        const box = credit.getBoundingClientRect();
        const dial = document.getElementById('compass-dial')?.getBoundingClientRect();
        const overlaps = Boolean(dial) && dial.left < box.right && dial.right > box.left && dial.top < box.bottom && dial.bottom > box.top;
        return { text: credit.textContent, overlaps };
      });
      expect(found, 'the credit under the title is not shown');
      expect(found.text === "BUILT ON GOD'S EYE VIEW", `the credit says "${found.text}"`);
      expect(!found.overlaps, 'the compass dial covers the credit');
    },
  ],
  [
    'on a narrow window the tray closes after turning on Map pin',
    async (page, setup) => {
      if (!setup.narrow) return;
      const trayOpen = () => page.evaluate(() => document.getElementById('zenith-tray')?.dataset.open === 'true');
      await page.click('#zenith-more-toggle');
      await sleep(400);
      expect(await trayOpen(), 'the tray did not open');
      await page.click('#address-lookup-toggle');
      await sleep(400);
      const closed = !(await trayOpen());
      await page.evaluate(() => document.getElementById('address-lookup-toggle')?.click());
      expect(closed, 'the tray stayed open over the map after turning on Map pin');
    },
  ],
  [
    'a failed earthquake feed says so on screen',
    async (page, setup) => {
      const toggle = () => page.evaluate(() => document.getElementById('earthquakes-toggle')?.click());
      const on = () => page.evaluate(() => document.getElementById('earthquakes-toggle')?.getAttribute('aria-pressed') === 'true');
      if (await on()) await toggle();
      await block3d(setup.map === 'esri-imagery', ['*://earthquake.usgs.gov/*']);
      try {
        await toggle();
        await until(
          page,
          () => /earthquake feed did not answer/i.test(document.getElementById('feed-notice')?.textContent ?? ''),
          20_000,
          'no message on screen when the earthquake feed did not answer',
        );
      } finally {
        await block3d(setup.map === 'esri-imagery');
        if (await on()) await toggle();
        await page.evaluate(() => document.getElementById('feed-notice')?.remove());
      }
    },
  ],
  [
    'satellite runs send nothing to the paid 3D map',
    async (page, setup) => {
      // Only the satellite runs block it; the 3D runs need it.
      if (setup.map !== 'esri-imagery') return;
      expect((await page.evaluate(() => window.__zt.map())) === 'esri-imagery', 'the satellite run is not on the satellite map');
      const answers = paid3d.answers - paid3d.atOpen;
      expect(answers === 0, `${answers} answer${answers === 1 ? '' : 's'} came back from the metered 3D map during a satellite run`);
    },
  ],
];

/** Checks that need their own page load. They run once, at the end. */
const soloChecks = [
  [
    'looking back on a camera shows an older picture with its real time',
    async (page) => {
      // On the satellite map: free, and the camera panel works the same.
      await page.evaluate(() => localStorage.setItem('gev.satelliteByChoice', '1'));
      await block3d(true);
      try {
        await open(page, WIDE, 'lat=60.2&lon=24.9&alt=60000&heading=0&pitch=-89&l=c&map=esri-imagery');
        await page.evaluate(() =>
          window.__godsEyeView.styleManager?.setPanelCollapsed?.('cctv-panel', false, { explicit: true }),
        );
        const ids = await page.evaluate(async () => {
          const { sources } = await (await fetch('/api/cctv/sources')).json();
          const pick = (test) => sources.filter((one) => test(one.id)).slice(0, 6).map((one) => one.id);
          return { finland: pick((id) => /^fi-c\d{7}$/.test(id)), california: pick((id) => /^ca-d(3|7|11)-/.test(id)) };
        });
        for (const [where, candidates, step] of [
          ['Finland', ids.finland, '3 h'],
          ['California', ids.california, '1 h'],
        ]) {
          expect(candidates.length, `no ${where} camera in the list`);
          // A camera can be switched off for a while and have a gap: try a few.
          let clicked = null;
          let live = '';
          for (const id of candidates) {
            live = await page.evaluate(() => document.getElementById('cctv-frame')?.getAttribute('src') ?? '');
            await page.evaluate((camera) => window.__godsEyeView.styleManager._cctvControls.cctv.selectCamera(camera, { focus: true }), id);
            try {
              await until(
                page,
                (label) => [...document.querySelectorAll('#cctv-history .ch-row button')].some((one) => one.textContent === label),
                20_000,
                'no step',
                step,
              );
            } catch {
              continue;
            }
            clicked = await page.evaluate((label) => {
              const button = [...document.querySelectorAll('#cctv-history .ch-row button')].find((one) => one.textContent === label);
              const r = button.getBoundingClientRect();
              return [r.left + r.width / 2, r.top + r.height / 2];
            }, step);
            break;
          }
          expect(clicked, `none of ${candidates.length} ${where} cameras has a ${step} step`);
          await page.mouse.click(clicked[0], clicked[1]);
          await until(page, () => !document.getElementById('cctv-history-view').hidden, 20_000, `the ${where} picture from ${step} ago never showed`);
          const shown = await page.evaluate(() => ({
            said: document.getElementById('cctv-history-time').textContent,
            size: document.querySelector('#cctv-history-view img').naturalWidth,
            live: document.getElementById('cctv-frame')?.getAttribute('src') ?? '',
          }));
          expect(shown.size > 100, `the ${where} older picture is empty`);
          const ago = /^Picture from \d\d:\d\d, (?:(\d+) h)? ?(?:(\d+) min)? ago$/.exec(shown.said);
          expect(ago && (ago[1] || ago[2]), `the ${where} picture says "${shown.said}"`);
          const hours = Number(ago[1] ?? 0) + Number(ago[2] ?? 0) / 60;
          const wanted = parseFloat(step);
          expect(Math.abs(hours - wanted) <= Math.max(0.25, wanted * 0.25), `the ${step} step showed a picture from ${hours.toFixed(2)} h ago`);
          expect(!live || /\/api\/cctv\/frame\//.test(shown.live), 'the live picture was replaced');
          await page.keyboard.press('Escape');
          await sleep(300);
          expect(await page.evaluate(() => document.getElementById('cctv-history-view').hidden), `Escape did not go back to the live ${where} picture`);
        }
      } finally {
        await block3d(false);
      }
    },
  ],
  [
    'a photo of a London camera is kept: after a reload it is in My photos and in its times',
    async (page) => {
      await page.evaluate(() => localStorage.setItem('gev.satelliteByChoice', '1'));
      await block3d(true);
      const center = async (selector) => {
        const r = await page.evaluate((s) => {
          const box = document.querySelector(s)?.getBoundingClientRect();
          return box ? [box.left + box.width / 2, box.top + box.height / 2] : null;
        }, selector);
        expect(r, `there is no ${selector}`);
        return r;
      };
      const openCamera = async (id) => {
        await open(page, WIDE, 'lat=51.5055&lon=-0.0754&alt=2500&heading=0&pitch=-89&l=c&map=esri-imagery');
        await page.evaluate(() =>
          window.__godsEyeView.styleManager?.setPanelCollapsed?.('cctv-panel', false, { explicit: true }),
        );
        await page.evaluate((camera) => window.__godsEyeView.styleManager._cctvControls.cctv.selectCamera(camera, { focus: true }), id);
        await until(page, () => !document.getElementById('cctv-history')?.hidden, 30_000, 'the camera tools never showed');
      };
      let taken = null;
      try {
        const id = await page.evaluate(async () => {
          const { sources } = await (await fetch('/api/cctv/sources')).json();
          return sources.find((one) => one.pack === 'tfl' && one.feedType === 'image')?.id ?? null;
        });
        expect(id, 'no London camera in the list');
        await openCamera(id);
        await until(page, () => !document.getElementById('cctv-photo-take').disabled, 60_000, 'Take photo never came on for a London camera');
        const before = await page.evaluate(async () => (await (await fetch('/api/alon/cctv/photos')).json()).photos.map((photo) => photo.file));
        await page.mouse.click(...(await center('#cctv-photo-take')));
        await until(page, () => /Photo saved/.test(document.getElementById('cctv-history-time').textContent), 30_000, 'the photo was not saved');
        taken = await page.evaluate(
          async (old) => (await (await fetch('/api/alon/cctv/photos')).json()).photos.find((photo) => !old.includes(photo.file)) ?? null,
          before,
        );
        expect(taken && taken.cameraId === id, 'the new photo is not in the photo list');

        // A fresh page: the photo is still there.
        await openCamera(id);
        await until(
          page,
          () => [...document.querySelectorAll('#cctv-history .ch-row button')].some((button) => /^Photo \d\d:\d\d$/.test(button.textContent)),
          20_000,
          "after a reload the photo is not in the camera's times",
        );
        await page.mouse.click(...(await center('#cctv-photos-open')));
        await until(page, (file) => Boolean(document.querySelector(`#my-photos [data-file="${file}"]`)), 10_000, 'the photo is not in My photos', taken.file);
        await page.mouse.click(...(await center(`#my-photos [data-file="${taken.file}"]`)));
        await until(page, () => document.querySelector('#my-photos .mp-big img')?.naturalWidth > 100, 10_000, 'the photo did not open large');

        // Delete asks first, then the photo is gone.
        await page.mouse.click(...(await center('#my-photos .mp-big .mp-row .mp-danger')));
        await page.mouse.click(...(await center('#my-photos .mp-big .mp-row:not([hidden]) .mp-danger')));
        await until(page, (file) => !document.querySelector(`#my-photos [data-file="${file}"]`), 10_000, 'Delete did not remove the photo', taken.file);
        taken = null;
        await page.keyboard.press('Escape');
        expect(await page.evaluate(() => document.getElementById('my-photos').hidden), 'Escape did not close My photos');
      } finally {
        // Never leave a test photo behind.
        if (taken) await page.evaluate((file) => fetch(`/api/alon/cctv/photos/${file}`, { method: 'DELETE' }), taken.file).catch(() => {});
        await block3d(false);
      }
    },
  ],
  [
    'the 3D map comes back by itself',
    async (page) => {
      await page.evaluate(() => localStorage.removeItem('gev.satelliteByChoice'));
      await open(page, WIDE, `${LONDON}&map=esri-imagery`);
      try {
        await until(page, () => window.__zt.map() === 'photoreal', 20_000, 'the app stayed on the satellite map');
      } catch (error) {
        const trouble = providerTrouble();
        if ((await provider3dDown(page)) || trouble) {
          throw new Skip(`the 3D map provider is not answering properly right now (${trouble || 'the app fell back to satellite by itself'})`);
        }
        throw error;
      }
    },
  ],
  [
    'a satellite map picked by hand is kept',
    async (page) => {
      await open(page, WIDE, LONDON);
      await pickMap(page, 'esri-imagery');
      await sleep(4000);
      expect((await page.evaluate(() => window.__zt.map())) === 'esri-imagery', 'the hand-picked satellite map was switched away');
      await pickMap(page, 'photoreal');
    },
  ],
  [
    'a saved place brings its map back',
    async (page) => {
      await open(page, WIDE, LONDON);
      await pickMap(page, 'esri-imagery');
      await press(page, 'saved-places-toggle');
      await page.type('#saved-places input', 'On satellite');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Escape');
      await pickMap(page, 'photoreal');
      await press(page, 'saved-places-toggle');
      await page.click('#saved-places .sp-go');
      await until(page, () => window.__zt.map() === 'esri-imagery', 15_000, 'flying to the place did not bring the satellite map back');
      // It was put back the way a person picks it, so it must stay.
      await sleep(5000);
      const stayed = (await page.evaluate(() => window.__zt.map())) === 'esri-imagery';
      await page.click('#saved-places .sp-delete');
      await page.keyboard.press('Escape');
      await pickMap(page, 'photoreal');
      expect(stayed, 'the satellite map was switched away again after a few seconds');
    },
  ],
  [
    'fly-through between saved places',
    async (page) => {
      await open(page, WIDE, LONDON);
      const where = () =>
        page.evaluate(() => {
          const at = window.__zt.viewer().camera.positionCartographic;
          return { lon: (at.longitude * 180) / Math.PI, lat: (at.latitude * 180) / Math.PI, height: at.height };
        });
      const look = () =>
        page.evaluate(() => ({
          clean: document.body.classList.contains('ui-clean-view'),
          exit: window.__zt.shown(document.getElementById('clean-view-exit')),
          panel: !document.getElementById('saved-places').hidden,
          credits: [...document.querySelectorAll('#cesium-credits *')].some((node) => {
            const r = node.getBoundingClientRect();
            return r.width > 20 && r.height > 5 && r.left >= 0 && r.bottom <= innerHeight;
          }),
        }));
      const save = async (name) => {
        await page.type('#saved-places input', name);
        await page.keyboard.press('Enter');
      };
      // Ticks stay while the page is open, so only tick the ones not yet ticked.
      const tickAll = async () => {
        for (const box of await page.$$('#saved-places .sp-pick')) {
          if (!(await box.evaluate((input) => input.checked))) await box.click();
        }
      };
      const first = await where();
      await press(page, 'saved-places-toggle');
      await save('Stop one');
      expect(await page.evaluate(() => document.getElementById('saved-places-fly').hidden), 'Fly through shows with only one place');
      await page.evaluate(() => {
        const { camera } = window.__zt.viewer();
        camera.setView({ destination: camera.position.constructor.fromDegrees(1.3, 51.2, 4000) });
      });
      await sleep(600);
      await save('Stop two');
      expect(await page.evaluate(() => document.getElementById('saved-places-fly').disabled), 'Fly through is ready before anything is ticked');
      await tickAll();
      expect(/Fly through 2 places/.test(await page.evaluate(() => document.getElementById('saved-places-fly').textContent)), 'ticking two places did not ready the button');

      // The list is newest first, so it goes to "Stop two", then "Stop one".
      await page.click('#saved-places-fly');
      await sleep(800);
      const during = await look();
      expect(during.clean && !during.exit && !during.panel, `the controls were not hidden for the fly-through: ${JSON.stringify(during)}`);
      expect(during.credits, 'the map credits are not visible during the fly-through');
      await until(page, () => !document.body.classList.contains('ui-clean-view'), 40_000, 'the fly-through never finished');
      const end = await where();
      expect(Math.abs(end.lon - first.lon) < 0.01 && Math.abs(end.lat - first.lat) < 0.01 && Math.abs(end.height - first.height) < 50, `it ended at ${end.lon.toFixed(2)}, ${end.lat.toFixed(2)}, not at the last place`);

      // A key ends it part way, and the view stops moving.
      await press(page, 'saved-places-toggle');
      await tickAll();
      await page.click('#saved-places-fly');
      await sleep(5000);
      await page.keyboard.press('x');
      await sleep(500);
      const stoppedAt = await where();
      await sleep(1200);
      const later = await where();
      const after = await look();
      await press(page, 'saved-places-toggle');
      for (let i = 0; i < 2; i++) await page.click('#saved-places .sp-delete');
      await page.keyboard.press('Escape');
      expect(!after.clean, 'a key did not end the fly-through');
      expect(Math.abs(later.lon - stoppedAt.lon) < 1e-6 && Math.abs(later.height - stoppedAt.height) < 0.5, 'the view kept flying after it was ended');
    },
  ],
  [
    'height profile along a measured line, on both maps',
    async (page) => {
      // Hills: a line across the Lake District, from a lake over the fells.
      await open(page, WIDE, 'lat=54.48&lon=-2.9&alt=40000&heading=0&pitch=-89');
      const profileOf = async (mapName) => {
        await press(page, 'measure-toggle');
        await clickMap(page, 0.46, 0.75);
        await clickMap(page, 0.54, 0.3);
        // Asked before the ground has loaded, the satellite map answers that
        // there are no height differences: wait for it first.
        await until(page, () => window.__godsEyeView.viewer.scene.globe.tilesLoaded || !window.__godsEyeView.viewer.scene.globe.show, 20_000, 'the ground never finished loading').catch(() => {});
        await page.click('#measure-profile-open');
        await until(page, () => /highest point is|no height differences/.test(document.querySelector('#measure-profile p').textContent), 30_000, `the ${mapName} gave no answer about heights`);
        const result = await page.evaluate(() => {
          const panel = document.getElementById('measure-profile');
          const words = panel.querySelector('p').textContent;
          const rise = /highest point is ([\d.,]+) (m|km) above/.exec(words);
          return {
            words,
            rise: rise ? Number(rise[1].replace(/,/g, '')) * (rise[2] === 'km' ? 1000 : 1) : 0,
            line: panel.querySelector('svg path')?.getAttribute('d')?.length ?? 0,
            dots: panel.querySelectorAll('svg circle').length,
            note: panel.querySelector('.mp-note').textContent,
            labels: window.__zt.labels('alon-measure'),
          };
        });
        // Adding a point makes the chart out of date: it must close.
        await clickMap(page, 0.6, 0.5);
        const closedAfterChange = await page.evaluate(() => document.getElementById('measure-profile').hidden);
        await press(page, 'measure-toggle');
        expect(result.rise > 150, `the ${mapName} found a rise of ${result.rise} m across the fells: "${result.words}"`);
        expect(result.line > 200 && result.dots === 2, `the ${mapName} chart was not drawn`);
        expect(result.labels === 3, `the highest and lowest points were not marked on the ${mapName}`);
        expect(closedAfterChange, `the chart stayed open on the ${mapName} after the path changed`);
        return result;
      };
      const tiles = await profileOf('3D map');
      expect(/scanned surface/.test(tiles.note), 'the 3D map chart does not say it measures the scanned surface');
      await pickMap(page, 'esri-imagery');
      const ground = await profileOf('satellite map');
      await pickMap(page, 'photoreal');
      expect(/bare ground/.test(ground.note), 'the satellite chart does not say it measures bare ground');
    },
  ],
  [
    'the map pin gives an address outside London, one lookup per click',
    async (page) => {
      // Paris, with the two lookup services answered here so the check does
      // not lean on them, and so their requests can be counted.
      await open(page, WIDE, 'lat=48.8606&lon=2.3376&alt=900&heading=0&pitch=-60');
      let photon = 0;
      let wikipedia = 0;
      let asker = null;
      const answer = (request) => {
        const url = request.url();
        if (url.startsWith('https://photon.komoot.io/')) {
          photon += 1;
          const at = new URL(url).searchParams;
          request.respond({
            status: 200,
            contentType: 'application/json',
            headers: { 'access-control-allow-origin': '*' },
            // The nearest thing is a bare postcode, then the street, then a
            // numbered house too far away to be the one clicked: the card must
            // name the street, and give the number only as a guide.
            body: JSON.stringify({
              features: [
                { geometry: { type: 'Point', coordinates: [Number(at.get('lon')), Number(at.get('lat')) + 0.0001] }, properties: { type: 'other', name: '75001', postcode: '75001', city: 'Paris' } },
                { geometry: { type: 'Point', coordinates: [Number(at.get('lon')), Number(at.get('lat')) + 0.0003] }, properties: { type: 'street', name: 'Rue de Test', postcode: '75001', city: 'Paris' } },
                { geometry: { type: 'Point', coordinates: [Number(at.get('lon')), Number(at.get('lat')) + 0.0005] }, properties: { type: 'house', housenumber: '99', street: 'Rue de Test', city: 'Paris' } },
              ],
            }),
          });
        } else if (url.startsWith('https://en.wikipedia.org/')) {
          if (request.method() === 'OPTIONS') {
            request.respond({
              status: 204,
              headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'api-user-agent', 'access-control-allow-methods': 'GET' },
            });
            return;
          }
          wikipedia += 1;
          asker = request.headers()['api-user-agent'] ?? null;
          request.respond({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"query":{"pages":[]}}' });
        } else {
          request.continue();
        }
      };
      const cardText = () => page.evaluate(() => (window.__zt.shown(document.getElementById('address-card')) ? document.getElementById('address-card').textContent : ''));
      await page.setRequestInterception(true);
      page.on('request', answer);
      try {
        await press(page, 'address-lookup-toggle');
        await clickMap(page, 0.5, 0.6);
        await until(page, () => /Rue de Test/.test(document.getElementById('address-card')?.textContent ?? ''), 10_000, 'no address appeared for a click in Paris');
        const text = await cardText();
        expect(/^Rue de Test/.test(text.replace(/^×/, '').trim()), `the card is not headed by the street: ${text.slice(0, 80)}`);
        expect(/Nearest mapped house number on this street: 99/.test(text), 'the nearest house number was not given as a guide');
        expect(/Paris/.test(text) && !/London only/.test(text), `the card said: ${text.slice(0, 120)}`);
        expect(photon === 1 && wikipedia === 1, `one click made ${photon} address lookups and ${wikipedia} Wikipedia lookups`);
        expect(/Zenith/.test(asker ?? ''), 'the Wikipedia lookup did not say what program is asking');
        // The same spot again is answered from memory.
        await clickMap(page, 0.5, 0.6);
        await sleep(1500);
        expect(photon === 1, 'clicking the same spot again asked the address service again');
        // From far out an address means nothing, so none is asked for.
        await page.evaluate(() => {
          const { camera } = window.__zt.viewer();
          camera.setView({ destination: camera.position.constructor.fromDegrees(2.34, 48.86, 2_000_000) });
        });
        await sleep(1200);
        // The old pin stands in the middle of this view. Click on the pin
        // itself: that is a click on the map under it, not on a thing.
        const pin = await page.evaluate(() => {
          const viewer = window.__zt.viewer();
          const card = document.getElementById('address-card');
          const toRad = Math.PI / 180;
          const at = viewer.scene.globe.ellipsoid.cartographicToCartesian({ longitude: Number(card.dataset.lon) * toRad, latitude: Number(card.dataset.lat) * toRad, height: 0 });
          const spot = viewer.scene.cartesianToCanvasCoordinates(at);
          return [Math.round(spot.x), Math.round(spot.y)];
        });
        await page.mouse.click(pin[0], pin[1] - 10);
        await until(page, () => /Zoom in closer/.test(document.getElementById('address-card')?.textContent ?? ''), 5000, 'a click on the pin itself, from far out, did not ask to zoom in');
        expect(/Local time/.test(await cardText()), 'from far out the card lost its local time');
        expect(photon === 1 && wikipedia === 1, 'a click from far out still asked the lookup services');
        await press(page, 'address-lookup-toggle');
      } finally {
        page.off('request', answer);
        await page.setRequestInterception(false);
      }
    },
  ],
  [
    'settings loaded from a file take effect after the reload',
    async (page) => {
      await open(page, WIDE, LONDON);
      const was = await page.evaluate(() => {
        const keep = { dayNight: localStorage.getItem('gev.dayNight'), places: localStorage.getItem('gev.savedPlaces') };
        localStorage.setItem('gev.dayNight', '0');
        localStorage.removeItem('gev.savedPlaces');
        return keep;
      });
      await press(page, 'zenith-help-toggle');
      const loaded = await chooseSettingsFile(
        page,
        JSON.stringify({
          app: 'Zenith',
          kind: 'settings',
          version: 1,
          settings: {
            'gev.dayNight': '1',
            'gev.savedPlaces': JSON.stringify([{ name: 'From a file', lon: -0.0754, lat: 51.5055, height: 900, heading: 20, pitch: -35 }]),
          },
        }),
      );
      expect(!loaded.bad && loaded.reload, `the file was not loaded ("${loaded.said}")`);
      await page.click('#zenith-settings-reload');
      await sleep(1500);
      await until(page, () => Boolean(document.getElementById('zenith-more-toggle') && window.__godsEyeView?.viewer && window.__zt), 90_000, 'the app did not come back after the reload');
      await until(page, () => !document.elementFromPoint(innerWidth / 2, 50)?.closest('#loading-screen'), 60_000, 'the loading screen never went away');
      await sleep(1500);
      const dayNight = await pressed(page, 'day-night-toggle');
      await press(page, 'saved-places-toggle');
      const listed = await page.evaluate(() => document.getElementById('saved-places')?.textContent.includes('From a file'));
      await page.keyboard.press('Escape');
      if (dayNight) await press(page, 'day-night-toggle');
      await page.evaluate((keep) => {
        for (const [key, value] of [['gev.dayNight', keep.dayNight], ['gev.savedPlaces', keep.places]]) {
          if (value === null) localStorage.removeItem(key);
          else localStorage.setItem(key, value);
        }
      }, was);
      expect(dayNight, 'day and night was not on after loading a file that switches it on');
      expect(listed, 'the saved place from the file is not in the list');
    },
  ],
  [
    'tracking marker when following a plane',
    async (page) => {
      await followPlane(page);
      const marker = () => page.evaluate(() => window.__zt.shown(document.getElementById('tracking-marker')) && getComputedStyle(document.getElementById('tracking-marker')).display !== 'none');
      expect(!(await marker()), 'the marker shows while the plane is close');
      // The classified look locks on to what is followed.
      const lock = await page.evaluate(() => ({
        shown: window.__zt.shown(document.getElementById('zenith-lock')),
        text: document.querySelector('#zenith-lock .zl-tag')?.textContent ?? '',
      }));
      expect(lock.shown && /^TRACKING\s+\S/.test(lock.text), `no lock-on reticle on the followed plane (${lock.text})`);
      await page.mouse.move(720, 450);
      // Scroll until far out: how far one notch goes depends on how busy the
      // browser is, so a fixed number of notches can stop short.
      for (let i = 0; i < 300 && (await page.evaluate(() => window.__zt.height())) < 2_000_000; i++) {
        await page.mouse.wheel({ deltaY: 400 });
        await sleep(50);
      }
      await sleep(1500);
      expect(await marker(), 'no marker after zooming far out');
      await page.click('#tracking-marker');
      await sleep(3500);
      const back = await page.evaluate(() => ({ height: window.__zt.height(), tracked: Boolean(window.__zt.viewer().trackedEntity) }));
      expect(back.tracked && back.height < 100_000, 'clicking the marker did not fly back to the plane');
      expect(!(await marker()), 'the marker stayed after flying back');
    },
  ],
  [
    'the add-ons work while following a plane',
    async (page) => {
      // Carries on from the check before when that one left a plane followed.
      const following = () => page.evaluate(() => Boolean(window.__zt.viewer()?.trackedEntity));
      if (!(await following().catch(() => false))) await followPlane(page);
      const problems = [];
      const note = async (what) => {
        const state = await page.evaluate(() => window.__zt.alive());
        if (!(state.frames >= 3 && state.loop)) problems.push(`${what}: the map stopped drawing`);
        if (state.notice) problems.push(`${what}: ${state.notice}`);
        if (pageErrors.length) problems.push(`${what}: page error ${pageErrors[0]}`);
        if (!(await following())) problems.push(`${what}: the plane stopped being followed`);
      };
      try {
        for (const id of ['map-labels-toggle', 'train-stations-toggle', 'time-zones-toggle', 'day-night-toggle', 'earthquakes-toggle']) {
          await press(page, id);
          await sleep(900);
          if (!(await pressed(page, id))) problems.push(`${id} did not switch on`);
          await note(id);
        }
        const drawn = await page.evaluate(() => ({
          dayNight: window.__zt.dayNightDrawn(),
          zones: window.__zt.entities('alon-time-zones'),
          parts: ['compass-dial', 'scale-bar'].filter((id) => window.__zt.shown(document.getElementById(id))).length,
          credits: window.__zt.creditsClear(),
        }));
        if (!drawn.dayNight) problems.push('day and night is not drawn');
        if (!(drawn.zones > 0)) problems.push('the time zone borders are not drawn');
        if (drawn.parts !== 2) problems.push('the compass or the scale is not showing');
        if (!drawn.credits) problems.push('the map credits are covered or gone');
        // Escape closes a panel of this build and nothing else: the original
        // app also uses Escape to stop following, and must not hear this one.
        for (const [id, panelId] of [
          ['video-mode-toggle', 'video-mode-panel'],
          ['zenith-help-toggle', 'zenith-help'],
          ['saved-places-toggle', 'saved-places'],
        ]) {
          await press(page, id, { leaveTray: true });
          const shown = (selector) => page.evaluate((one) => window.__zt.shown(document.getElementById(one)), selector);
          if (!(await shown(panelId))) problems.push(`#${panelId} did not open`);
          await page.keyboard.press('Escape');
          await sleep(500);
          if (await shown(panelId)) problems.push(`Escape did not close #${panelId}`);
          await note(`Escape on #${panelId}`);
        }
        // The measure tool takes the clicks while it is on. The original app
        // stops following a plane on any click on empty map (it does so with
        // every add-on left out too), so the follow is not expected to
        // outlive these clicks: only the tool itself is checked.
        await press(page, 'measure-toggle');
        await clickMap(page, 0.3, 0.72);
        await clickMap(page, 0.42, 0.78);
        const readout = await page.evaluate(() => document.getElementById('measure-readout')?.textContent ?? '');
        if (!/\d.*(m|km)\b.*2 points/.test(readout)) problems.push(`the measure tool read "${readout}" after two clicks`);
        const after = await page.evaluate(() => window.__zt.alive());
        if (!(after.frames >= 3 && after.loop) || after.notice) problems.push(`measure tool: the map stopped drawing or an add-on was switched off (${after.notice})`);
        await page.click('#measure-clear').catch(() => {});
        await press(page, 'measure-toggle');
      } finally {
        await calm(page).catch(() => {});
        if (await pressed(page, 'earthquakes-toggle')) await press(page, 'earthquakes-toggle');
      }
      expect(problems.length === 0, problems.slice(0, 4).join(' | '));
    },
  ],
  [
    'camera picture cards only near the middle of the view',
    async (page) => {
      // On the satellite map: the rule is the same on both, and this keeps
      // one more load off the metered 3D map.
      await page.evaluate(() => localStorage.setItem('gev.satelliteByChoice', '1'));
      await block3d(true);
      try {
        await open(page, WIDE, 'lat=51.5055&lon=-0.0754&alt=2500&heading=0&pitch=-89&l=c&map=esri-imagery');
        const REACH_KM = 1;
        // Where the cameras are, and how the view sees them.
        const look = () =>
          page.evaluate((reachKm) => {
            const viewer = window.__zt.viewer();
            const { scene, camera } = viewer;
            const ellipsoid = scene.globe.ellipsoid;
            let markers = null;
            for (let i = 0; i < scene.primitives.length; i++) {
              const one = scene.primitives.get(i);
              if (one && typeof one.get === 'function' && one.length > 500 && typeof one.get(0).id === 'string') markers = one;
            }
            if (!markers) return null;
            const middle = camera.pickEllipsoid({ x: scene.canvas.clientWidth / 2, y: scene.canvas.clientHeight / 2 });
            const here = ellipsoid.cartesianToCartographic(middle);
            const km = (a, b) => {
              const dLat = b.latitude - a.latitude;
              const dLon = (b.longitude - a.longitude) * Math.cos((a.latitude + b.latitude) / 2);
              return Math.hypot(dLat, dLon) * 6371;
            };
            const cameras = [];
            let inReach = 0;
            let onScreen = 0;
            for (let i = 0; i < markers.length; i++) {
              const at = ellipsoid.cartesianToCartographic(markers.get(i).position);
              if (Math.abs(at.latitude - here.latitude) > 0.004 || Math.abs(at.longitude - here.longitude) > 0.006) continue;
              cameras.push([at.longitude, at.latitude]);
              if (km(here, at) <= reachKm) inReach += 1;
              const spot = scene.cartesianToCanvasCoordinates(markers.get(i).position);
              if (spot && spot.x > 0 && spot.y > 0 && spot.x < scene.canvas.clientWidth && spot.y < scene.canvas.clientHeight) onScreen += 1;
            }
            const overlay = window.__gevWorldOverlay.getDiagnostics();
            return {
              inReach,
              onScreen,
              cameras,
              here: [here.longitude, here.latitude],
              cards: overlay.entriesBySource?.cctv ?? 0,
              painted: overlay.paintedBySource?.cctv ?? 0,
            };
          }, REACH_KM);
        const moveTo = (lon, lat) =>
          page.evaluate(
            (lon, lat) => {
              const viewer = window.__zt.viewer();
              viewer.camera.setView({
                destination: viewer.scene.globe.ellipsoid.cartographicToCartesian({ longitude: lon, latitude: lat, height: 2500 }),
                orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
              });
            },
            lon,
            lat,
          );
        try {
          await until(page, () => window.__gevWorldOverlay.getDiagnostics().entriesBySource?.cctv > 0, 25_000, 'no camera cards');
        } catch {
          throw new Skip('the camera list or its pictures did not load');
        }
        await sleep(3000);
        const busy = await look();
        if (!busy) throw new Skip('the camera markers could not be found');
        expect(busy.inReach >= 1, 'the test view has no camera within 1 km of its middle');
        expect(busy.cards >= 1, 'no picture card for cameras within 1 km of the middle');
        expect(busy.cards <= busy.inReach, `${busy.cards} picture cards, but only ${busy.inReach} cameras are within 1 km of the middle`);

        // A spot whose middle has no camera within reach, but with cameras
        // towards the edges of the screen: there must be no picture card.
        const quiet = await page.evaluate(
          (cameras, here) => {
            const toKm = (lon, lat, to) => [(to[0] - lon) * Math.cos(lat) * 6371, (to[1] - lat) * 6371];
            for (let dy = -0.003; dy <= 0.003; dy += 0.0002) {
              for (let dx = -0.004; dx <= 0.004; dx += 0.0002) {
                const lon = here[0] + dx;
                const lat = here[1] + dy;
                let near = 0;
                let edge = 0;
                for (const camera of cameras) {
                  const [x, y] = toKm(lon, lat, camera);
                  const far = Math.hypot(x, y);
                  if (far <= 1.2) near += 1;
                  else if (Math.abs(x) <= 1.35 && Math.abs(y) <= 0.8) edge += 1;
                }
                if (near === 0 && edge >= 1) return [lon, lat];
              }
            }
            return null;
          },
          busy.cameras,
          busy.here,
        );
        if (quiet) {
          await moveTo(quiet[0], quiet[1]);
          await until(page, () => (window.__gevWorldOverlay.getDiagnostics().entriesBySource?.cctv ?? 0) === 0, 20_000, 'picture cards stayed although no camera is within 1 km of the middle');
          const empty = await look();
          expect(empty.inReach === 0, 'the quiet spot was not quiet after all');
          expect(empty.onScreen >= 1, 'no camera marker on screen at the quiet spot, so the check proves nothing');
          expect(empty.cards === 0 && empty.painted === 0, `${empty.cards} picture cards with no camera within 1 km of the middle`);
        }
        // Back onto a camera: its card returns.
        await moveTo(busy.cameras[0][0], busy.cameras[0][1]);
        await until(page, () => window.__gevWorldOverlay.getDiagnostics().paintedBySource?.cctv > 0, 20_000, 'the picture card did not come back when the view was centred on a camera');
        if (!quiet) throw new Skip('picture cards show near cameras, but no spot without a nearby camera was found to test the opposite');
      } finally {
        await page.evaluate(() => localStorage.removeItem('gev.satelliteByChoice'));
        await block3d(false);
      }
    },
  ],
  [
    'the chosen camera gets cyan corners and its view lit, its full name in the panel, and no green box',
    async (page) => {
      await page.evaluate(() => localStorage.setItem('gev.satelliteByChoice', '1'));
      await block3d(true);
      try {
        // West of A5 Kilburn High Rd/Willesden Ln, looking east along its view.
        await open(page, WIDE, 'lat=51.5417&lon=-0.2012&alt=230&heading=90&pitch=-32&l=c&hud=tactical&hv=1&map=esri-imagery');
        await page.evaluate(() =>
          window.__godsEyeView.styleManager?.setPanelCollapsed?.('cctv-panel', false, { explicit: true }),
        );
        const NAME = 'A5 Kilburn High Rd/Willesden Ln';
        await until(page, (name) => [...document.querySelectorAll('#cctv-camera-select option')].some((one) => one.textContent.includes(name)), 40_000, 'the A5 Kilburn camera never reached the camera list', NAME);
        await page.evaluate((name) => {
          const option = [...document.querySelectorAll('#cctv-camera-select option')].find((one) => one.textContent.includes(name));
          window.__godsEyeView.styleManager._cctvControls.cctv.selectCamera(option.value, { focus: false });
        }, NAME);
        for (const size of [WIDE, NARROW]) {
          await page.setViewport(size);
          await sleep(2500);
          const seen = await page.evaluate(() => {
            const v = window.__godsEyeView.viewer;
            const cam = window.__godsEyeView.styleManager._cctvControls.cctv.getUIState().activeCamera;
            const C = v.camera.positionWC.constructor;
            const at = v.scene.cartesianToCanvasCoordinates(C.fromDegrees(cam.lon, cam.lat, cam.elevationM));
            const box = v.scene.canvas.getBoundingClientRect();
            const corners = document.getElementById('zenith-camera-corners');
            const r = corners.getBoundingClientRect();
            const t = v.clock.currentTime;
            let green = 0;
            for (let i = 0; i < v.dataSources.length; i++) {
              const source = v.dataSources.get(i);
              if (source.name === 'zenith-camera-view') continue;
              for (const e of source.entities.values) {
                const c = e.polyline && e.isShowing ? e.polyline.material?.color?.getValue?.(t) : null;
                if (c && c.green > 0.85 && c.red > 0.5 && c.red < 0.9 && c.blue < 0.6) green++;
              }
            }
            const name = document.getElementById('zenith-cctv-name');
            return {
              view: [cam.headingDeg, cam.fovDeg, cam.rangeM],
              miss: at ? Math.hypot(r.left + r.width / 2 - (box.left + at.x), r.top + r.height / 2 - (box.top + at.y)) : null,
              shown: getComputedStyle(corners).display !== 'none',
              wedge: v.dataSources.getByName('zenith-camera-view')[0]?.entities.values.map((e) => (e.polygon ? 'fill' : 'outline')).join(' '),
              green,
              name: name?.textContent,
              nameShown: Boolean(name && !name.hidden && name.getBoundingClientRect().height > 0),
              nameFirst: name?.nextElementSibling === document.getElementById('cctv-meta'),
            };
          });
          const where = `${size.width} px wide`;
          expect(seen.view.join() === '90,44,145', `${where}: the camera is not the A5 Kilburn one (HDG/FOV/RANGE ${seen.view.join(', ')})`);
          expect(seen.shown && seen.miss !== null && seen.miss < 3, `${where}: the cyan corners are not on the camera (${seen.miss} px off)`);
          expect(seen.wedge === 'fill outline', `${where}: the camera's view is not lit on the ground (${seen.wedge})`);
          expect(seen.green === 0, `${where}: ${seen.green} lines of the old green box are still shown`);
          expect(seen.name === NAME && seen.nameShown && seen.nameFirst, `${where}: the panel does not show the camera's full name above its details`);
        }
      } finally {
        await page.evaluate(() => localStorage.removeItem('gev.satelliteByChoice'));
        await block3d(false);
      }
    },
  ],
  [
    'camera names never cover each other, and a cut name shows in full on hover',
    async (page) => {
      await page.evaluate(() => localStorage.setItem('gev.satelliteByChoice', '1'));
      await block3d(true);
      try {
        // Alon's Kilburn view, higher, where callouts and picture cards crowd.
        await open(page, WIDE, 'lat=51.5417&lon=-0.1977&alt=450&heading=135&pitch=-14&l=c&hud=tactical&hv=1&map=esri-imagery');
        await sleep(9000);
        // Hover a picture card whose name was cut, while the cards are still.
        const card = await page.evaluate(async () => {
          // The app's own copy of the overlay (same address, query included).
          const url = performance.getEntriesByType('resource').map((one) => one.name).find((name) => name.includes('/src/overlays/worldOverlay.js'));
          if (!url) return null;
          const overlay = await import(url);
          const box = window.__godsEyeView.viewer.scene.canvas.getBoundingClientRect();
          for (const r of overlay.overlayCardRects('cctv')) {
            const hit = overlay.hitTestWorldOverlay(r.x + r.w / 2, r.y + r.h / 2, { sourceId: 'cctv' });
            if (hit && hit.entry.title.length > 15) return { x: box.left + r.x + r.w / 2, y: box.top + r.y + r.h / 2, title: hit.entry.title };
          }
          return null;
        });
        let hovered = false;
        if (card) {
          await page.mouse.move(card.x - 4, card.y - 4);
          await sleep(150);
          await page.mouse.move(card.x, card.y);
          await sleep(300);
          const tip = await page.evaluate(async (at) => {
            const one = document.getElementById('zenith-camera-tip');
            const url = performance.getEntriesByType('resource').map((entry) => entry.name).find((name) => name.includes('/src/overlays/worldOverlay.js'));
            const box = window.__godsEyeView.viewer.scene.canvas.getBoundingClientRect();
            const under = (await import(url)).hitTestWorldOverlay(at.x - box.left, at.y - box.top, { sourceId: 'cctv' });
            return { shown: !one.hidden, text: one.textContent, under: under?.entry.title ?? 'no card', top: document.elementFromPoint(at.x, at.y)?.id || document.elementFromPoint(at.x, at.y)?.tagName };
          }, card);
          // Cards can be re-placed under a still pointer: the tip must name the
          // cut card under it when read, whichever that is now.
          hovered = tip.under.length > 15;
          if (hovered) expect(tip.shown && tip.text === tip.under, `hovering the card for ${tip.under} showed ${tip.shown ? tip.text : 'nothing'} (first aimed at ${card.title}, top element ${tip.top})`);
          else expect(!tip.shown, `a tip (${tip.text}) showed with no cut card under the pointer (${tip.under})`);
          await page.mouse.move(5, 450);
        }
        await page.evaluate(() => window.__godsEyeView.styleManager.setDetection({ mode: 'dense' }));
        await sleep(9000);
        // Every label drawn on the overlay, frame by frame.
        await page.evaluate(() => {
          window.__names = [];
          let now = [];
          const own = CanvasRenderingContext2D.prototype.fillText;
          CanvasRenderingContext2D.prototype.fillText = function (text, x, y, ...rest) {
            if (typeof text === 'string' && text.trim().length > 2 && this.globalAlpha > 0.05 && this.canvas.id === 'world-overlay-canvas') {
              const m = this.getTransform();
              const px = parseFloat(/(\d+(\.\d+)?)px/.exec(this.font)?.[1] || '10');
              const w = this.measureText(text).width * m.a;
              const h = px * m.d;
              const X = m.a * x + m.c * y + m.e;
              const Y = m.b * x + m.d * y + m.f;
              const top = this.textBaseline === 'top' ? Y : this.textBaseline === 'middle' ? Y - h / 2 : Y - h * 0.8;
              now.push({ text, x0: X, x1: X + w, y0: top, y1: top + h });
            }
            return own.call(this, text, x, y, ...rest);
          };
          const tick = () => {
            if (now.length) window.__names.push(now);
            now = [];
            if (window.__names.length < 2000) requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
        // Turn slowly so labels come, go and fade.
        await page.evaluate(async () => {
          const { camera, scene } = window.__godsEyeView.viewer;
          const h0 = camera.heading;
          const p0 = camera.pitch;
          const start = performance.now();
          await new Promise((done) => {
            const step = (t) => {
              camera.setView({ orientation: { heading: h0 + ((t - start) / 7500) * 0.75, pitch: p0, roll: 0 } });
              scene.requestRender();
              if (t - start < 7500) requestAnimationFrame(step);
              else done();
            };
            requestAnimationFrame(step);
          });
        });
        const counted = await page.evaluate(() => {
          let bad = 0;
          let pair = '';
          for (const list of window.__names) {
            let hit = false;
            for (let i = 0; i < list.length; i++)
              for (let j = i + 1; j < list.length; j++) {
                const a = list[i];
                const b = list[j];
                if (Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 2 && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 2) {
                  hit = true;
                  pair = `${a.text} / ${b.text}`;
                }
              }
            if (hit) bad++;
          }
          return { frames: window.__names.length, bad, pair };
        });
        expect(counted.frames >= 60, `only ${counted.frames} frames were drawn while turning`);
        expect(counted.bad === 0, `names covered each other in ${counted.bad} of ${counted.frames} frames, e.g. ${counted.pair}`);
        if (!hovered) throw new Skip('no names covered each other, but no cut camera card was on screen to hover');
      } finally {
        await page.evaluate(() => localStorage.removeItem('gev.satelliteByChoice'));
        await block3d(false);
      }
    },
  ],
  [
    'a launch label at Starbase is a dark plate with a drawn rocket, bigger text and a ringed spot',
    async (page) => {
      await page.evaluate(() => localStorage.setItem('gev.satelliteByChoice', '1'));
      await block3d(true);
      try {
        // Alon's Starbase view (25°59'52.82"N 97°09'24.01"W, heading 228).
        await open(page, WIDE, 'lat=25.99801&lon=-97.15667&alt=60&heading=228&pitch=-12&l=x&hud=tactical&hv=1&map=esri-imagery');
        // Texts, pictures and circles drawn on the overlay, in CSS px.
        await page.evaluate(() => {
          window.__launch = { texts: [], pictures: [], rings: [] };
          const proto = CanvasRenderingContext2D.prototype;
          const css = (ctx, x, y) => {
            const m = ctx.getTransform();
            return { x: (m.a * x + m.c * y + m.e) / devicePixelRatio, y: (m.b * x + m.d * y + m.f) / devicePixelRatio, scale: m.a / devicePixelRatio };
          };
          const ours = (ctx) => ctx.canvas.id === 'world-overlay-canvas';
          const ownText = proto.fillText;
          proto.fillText = function (text, x, y, ...rest) {
            if (ours(this)) window.__launch.texts.push({ text, font: this.font, ...css(this, x, y) });
            return ownText.call(this, text, x, y, ...rest);
          };
          const ownImage = proto.drawImage;
          proto.drawImage = function (image, ...rest) {
            if (ours(this) && rest.length >= 4 && String(image?.src ?? '').startsWith('data:image/svg+xml')) {
              const [dx, dy, dw, dh] = rest;
              const at = css(this, dx, dy);
              window.__launch.pictures.push({ svg: decodeURIComponent(image.src).slice(0, 400), right: at.x + dw * at.scale, middle: at.y + (dh * at.scale) / 2 });
            }
            return ownImage.call(this, image, ...rest);
          };
          const ownArc = proto.arc;
          proto.arc = function (x, y, r, ...rest) {
            if (ours(this)) window.__launch.rings.push(r * css(this, x, y).scale);
            return ownArc.call(this, x, y, r, ...rest);
          };
        });
        const painted = () => window.__gevWorldOverlay.getDiagnostics().paintedBySource?.['rocket-missions'] > 0;
        await until(page, painted, 30_000, 'no launch label was drawn at Starbase');
        await page.evaluate(() => {
          window.__launch.texts.length = 0;
          window.__launch.pictures.length = 0;
          window.__launch.rings.length = 0;
          window.__godsEyeView.viewer.scene.requestRender();
        });
        await sleep(1500);
        const seen = await page.evaluate(() => window.__launch);
        const label = seen.texts.find((one) => /^[A-Z0-9 ./|-]{3,}$/.test(one.text) && /12px/.test(one.font) && /600/.test(one.font));
        expect(label, `no launch title in bold 12 px text (saw ${seen.texts.slice(0, 4).map((one) => `${one.text} ${one.font}`).join('; ')})`);
        // The drawn rocket sits just left of that title, level with it.
        const icon = label && seen.pictures.find((one) => /<path|<circle|<rect/.test(one.svg) && label.x - one.right > 2 && label.x - one.right < 9 && Math.abs(one.middle - label.y) < 4);
        expect(icon, `no drawn icon just left of ${label?.text} (pictures at ${seen.pictures.slice(0, 3).map((one) => `${Math.round(one.right)},${Math.round(one.middle)}`).join('; ')}; text at ${Math.round(label?.x)},${Math.round(label?.y)})`);
        // The ring on the spot is 5.5 CSS px across its radius, whatever the zoom.
        expect(seen.rings.some((r) => Math.abs(r - 5.5) < 0.75), `no 5.5 px ring on the launch spot (circles of ${[...new Set(seen.rings.map((r) => r.toFixed(1)))].slice(0, 6).join(', ')} px)`);
      } finally {
        await page.evaluate(() => localStorage.removeItem('gev.satelliteByChoice'));
        await block3d(false);
      }
    },
  ],
];

// ── The run ──────────────────────────────────────────────────────────────────

async function run(label, list, page, setup) {
  for (const [name, check] of list) {
    if (only && !only.some((word) => name.toLowerCase().includes(word))) continue;
    pageErrors = pageErrors.slice(0, 0);
    // A check with its own page load starts from nothing saved, so that one
    // check stopping half-way cannot make the next one fail too.
    if (list === soloChecks) {
      await page
        .evaluate(() => {
          localStorage.removeItem('gev.savedPlaces');
          localStorage.removeItem('gev.satelliteByChoice');
        })
        .catch(() => {});
    }
    try {
      await check(page, setup);
      // A check also fails when the page threw while it ran, even if what it
      // looked at came out right.
      if (pageErrors.length) throw new Error(`the page threw an error: ${pageErrors[0]}`);
      results.push({ label, name, state: 'pass' });
      console.log(`  ✓ ${name}`);
    } catch (error) {
      const skipped = error instanceof Skip;
      if (!skipped) {
        // What was on screen, and how the 3D provider was doing, go in the report.
        const showing = await page.evaluate(() => window.__zt?.map?.() ?? 'nothing').catch(() => 'unknown');
        const trouble = providerTrouble();
        error.message += ` [map showing: ${showing}${trouble ? `; 3D provider: ${trouble}` : ''}]`;
      }
      results.push({ label, name, state: skipped ? 'skip' : 'fail', why: error.message });
      console.log(`  ${skipped ? '–' : '✗'} ${name}: ${skipped ? 'skipped, ' : ''}${error.message}`);
      if (!skipped) await calm(page).catch(() => {});
    }
  }
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
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  watchProvider(page);
  block3d = await paid3dBlocker(page);
  await page.evaluateOnNewDocument(pageHelpers);

  // A new browser has no saved settings. Keep the two first-run panels out of
  // the way: the original's welcome launcher, and this build's help card. A
  // plain file from the same site is enough to set them, without loading the
  // whole app (and the metered 3D map) once more.
  await page.setViewport(WIDE);
  await page.goto(`${BASE}/alon/zenith-favicon.png`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    localStorage.setItem('gev:first-run-mission:v1', 'suppressed');
    localStorage.setItem('gev.helpCard', 'closed');
    // The once-a-day secure-link sequence would cover the first checks.
    localStorage.setItem('gev.secureLinkDay', new Date().toISOString().slice(0, 10));
  });

  const setups = [
    { map: 'photoreal', narrow: false, label: '3D map, wide window' },
    { map: 'photoreal', narrow: true, label: '3D map, narrow window' },
    { map: 'esri-imagery', narrow: false, label: 'satellite map, wide window' },
    { map: 'esri-imagery', narrow: true, label: 'satellite map, narrow window' },
  ]
    .slice(0, quick ? 1 : 4)
    .filter((_, index) => onlySetup === null || index + 1 === onlySetup);

  // With --only, a page that none of the named checks needs is not opened:
  // every load of the 3D map counts against a metered allowance.
  const wanted = (list) =>
    !only || list.some(([name]) => only.some((word) => name.toLowerCase().includes(word)));
  for (const setup of setups) {
    if (!wanted(checks)) break;
    console.log(`\n${setup.label}`);
    try {
      // The satellite runs start on the satellite map, chosen as a person
      // would, with the metered 3D map blocked: they cost nothing.
      const free = setup.map === 'esri-imagery';
      await block3d(free);
      if (free) await page.evaluate(() => localStorage.setItem('gev.satelliteByChoice', '1'));
      paid3d.atOpen = paid3d.answers;
      await open(page, setup.narrow ? NARROW : WIDE, free ? `${LONDON}&map=esri-imagery` : LONDON);
      await pickMap(page, setup.map);
    } catch (error) {
      const skipped = error instanceof Skip;
      results.push({ label: setup.label, name: 'open the app', state: skipped ? 'skip' : 'fail', why: error.message });
      console.log(`  ${skipped ? '–' : '✗'} open the app: ${skipped ? 'skipped, ' : ''}${error.message}`);
      continue;
    }
    await run(setup.label, checks, page, setup);
  }
  if (!quick && onlySetup === null && wanted(soloChecks)) {
    console.log('\nown page loads');
    await block3d(false);
    await pickMap(page, 'photoreal').catch(() => {});
    await run('own page loads', soloChecks, page, { map: 'photoreal', narrow: false });
  }

  await browser.close();
  const count = (state) => results.filter((result) => result.state === state).length;
  console.log(`\n${count('pass')} passed, ${count('fail')} failed, ${count('skip')} skipped`);
  if (consoleErrors.length) {
    console.log(`${consoleErrors.length} console error${consoleErrors.length === 1 ? '' : 's'} (not failures; the first: ${consoleErrors[0].slice(0, 160)})`);
  }
  for (const result of results.filter((entry) => entry.state === 'fail')) {
    console.log(`FAILED  ${result.label} · ${result.name}: ${result.why}`);
  }
  process.exit(count('fail') === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('The browser test itself broke:', error);
  process.exit(3);
});
