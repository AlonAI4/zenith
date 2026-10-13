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
import { launchBrowser, sleep } from './alon-browser.mjs';

const BASE = process.env.ZENITH_URL || 'http://localhost:4173';
const LONDON = 'lat=51.5055&lon=-0.0754&alt=900&heading=20&pitch=-35';
const WIDE = { width: 1440, height: 900 };
const NARROW = { width: 900, height: 800 };

/** The switches this build adds. Keep in step with src/app/zenithSwitches.js. */
const SWITCHES = [
  'map-labels-toggle',
  'train-stations-toggle',
  'time-zones-toggle',
  'day-night-toggle',
  'address-lookup-toggle',
  'hd-detail-toggle',
  'measure-toggle',
  'saved-places-toggle',
  'video-mode-toggle',
  'zenith-help-toggle',
];
const PARTS = [...SWITCHES, 'compass-dial', 'scale-bar', 'tracking-marker', 'zenith-more-toggle'];
/** Switches a check may leave on by accident; calm() turns them off again. */
const RESETTABLE = [
  'map-labels-toggle',
  'train-stations-toggle',
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
    imagery: () => {
      const { viewer, tileset } = app();
      const host = viewer.scene.globe.show ? viewer.imageryLayers : tileset?.imageryLayers;
      return host ? host.length : -1;
    },
    billboards: () => {
      const primitives = app().viewer.scene.primitives;
      let total = 0;
      for (let i = 0; i < primitives.length; i++) {
        const one = primitives.get(i);
        if (one && typeof one.length === 'number' && typeof one.get === 'function') {
          total += one.length;
        }
      }
      return total;
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

async function pickMap(page, id) {
  if ((await page.evaluate(() => window.__zt.map())) === id) return;
  await page.evaluate(
    (stack) => document.querySelector(`.map-stack-chip[data-stack-id="${stack}"]`)?.click(),
    id,
  );
  await until(page, (stack) => window.__zt.map() === stack, 20_000, `the map did not switch to ${id}`, id);
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
    return element.closest('#zenith-tray') ? 'tray' : 'bar';
  }, id);
  expect(where !== 'missing', `there is no #${id}`);
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
      }, SWITCHES);
      expect(state.overlaps.length === 0, `overlapping: ${state.overlaps.join(', ')}`);
      expect(state.dialInside, 'the compass is partly off the window');
      if (setup.narrow) {
        expect(state.inTray === SWITCHES.length && state.more, 'the switches did not fold into the tray');
        await page.click('#zenith-more-toggle');
        expect(await trayOpen(page), 'the tray did not open');
        await page.keyboard.press('Escape');
        expect(!(await trayOpen(page)), 'Escape did not close the tray');
      } else {
        expect(state.inTray === 0 && !state.more, 'the switches should sit in the bar on a wide window');
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
      const before = await page.evaluate(() => window.__zt.billboards());
      await press(page, 'train-stations-toggle');
      await until(page, (n) => window.__zt.billboards() > n, 8000, 'no station markers appeared', before);
      await press(page, 'train-stations-toggle');
      await until(page, (n) => window.__zt.billboards() <= n, 5000, 'the station markers stayed', before);
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
    async (page) => {
      const read = () =>
        page.evaluate(() => ({
          on: window.__zt.pressed('hd-detail-toggle'),
          recommended: window.__zt.viewer().useBrowserRecommendedResolution,
        }));
      const before = await read();
      expect(before.recommended === !before.on, 'the HD switch and the drawing resolution disagree');
      await press(page, 'hd-detail-toggle');
      const after = await read();
      await press(page, 'hd-detail-toggle');
      expect(after.on !== before.on && after.recommended === !after.on, 'the HD switch did not change the resolution');
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
      await page.click('#measure-readout button');
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
      await page.click('#measure-readout button');
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
      await press(page, 'video-mode-toggle', { leaveTray: true });
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
    'Cmd+C and friends do not set off shortcuts',
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
    'the Earth stays centred when zooming far out, with no zoom limit',
    async (page) => {
      const home = await page.evaluate(() => location.hash);
      const [x, y] = spot(page, 0.5, 0.55);
      await page.mouse.move(x, y);
      for (let i = 0; i < 60; i++) {
        await page.mouse.wheel({ deltaY: 500 });
        await sleep(40);
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
      for (let i = 0; i < 40; i++) {
        await page.mouse.wheel({ deltaY: 800 });
        await sleep(30);
      }
      await sleep(600);
      const further = await page.evaluate(() => window.__zt.height());
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
    },
  ],
];

/** Checks that need their own page load. They run once, at the end. */
const soloChecks = [
  [
    'the 3D map comes back by itself',
    async (page) => {
      await page.evaluate(() => localStorage.removeItem('gev.satelliteByChoice'));
      await open(page, WIDE, `${LONDON}&map=esri-imagery`);
      await until(page, () => window.__zt.map() === 'photoreal', 20_000, 'the app stayed on the satellite map');
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
    'tracking marker when following a plane',
    async (page) => {
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
      const marker = () => page.evaluate(() => window.__zt.shown(document.getElementById('tracking-marker')) && getComputedStyle(document.getElementById('tracking-marker')).display !== 'none');
      expect(!(await marker()), 'the marker shows while the plane is close');
      await page.mouse.move(720, 450);
      for (let i = 0; i < 40; i++) {
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
];

// ── The run ──────────────────────────────────────────────────────────────────

async function run(label, list, page, setup) {
  for (const [name, check] of list) {
    if (only && !only.some((word) => name.toLowerCase().includes(word))) continue;
    pageErrors = pageErrors.slice(0, 0);
    try {
      await check(page, setup);
      results.push({ label, name, state: 'pass' });
      console.log(`  ✓ ${name}`);
    } catch (error) {
      const skipped = error instanceof Skip;
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
  await page.evaluateOnNewDocument(pageHelpers);

  // A new browser has no saved settings. Keep the two first-run panels out of
  // the way: the original's welcome launcher, and this build's help card.
  await page.setViewport(WIDE);
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    localStorage.setItem('gev:first-run-mission:v1', 'suppressed');
    localStorage.setItem('gev.helpCard', 'closed');
  });

  const setups = [
    { map: 'photoreal', narrow: false, label: '3D map, wide window' },
    { map: 'photoreal', narrow: true, label: '3D map, narrow window' },
    { map: 'esri-imagery', narrow: false, label: 'satellite map, wide window' },
    { map: 'esri-imagery', narrow: true, label: 'satellite map, narrow window' },
  ]
    .slice(0, quick ? 1 : 4)
    .filter((_, index) => onlySetup === null || index + 1 === onlySetup);

  for (const setup of setups) {
    console.log(`\n${setup.label}`);
    try {
      await open(page, setup.narrow ? NARROW : WIDE, LONDON);
      await pickMap(page, setup.map);
    } catch (error) {
      results.push({ label: setup.label, name: 'open the app', state: 'fail', why: error.message });
      console.log(`  ✗ open the app: ${error.message}`);
      continue;
    }
    await run(setup.label, checks, page, setup);
  }
  if (!quick && onlySetup === null) {
    console.log('\nown page loads');
    await pickMap(page, 'photoreal').catch(() => {});
    await run('own page loads', soloChecks, page, { map: 'photoreal', narrow: false });
  }

  await browser.close();
  const count = (state) => results.filter((result) => result.state === state).length;
  console.log(`\n${count('pass')} passed, ${count('fail')} failed, ${count('skip')} skipped`);
  for (const result of results.filter((entry) => entry.state === 'fail')) {
    console.log(`FAILED  ${result.label} · ${result.name}: ${result.why}`);
  }
  process.exit(count('fail') === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('The browser test itself broke:', error);
  process.exit(3);
});
