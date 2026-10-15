#!/usr/bin/env node
/**
 * Takes the pictures for the Zenith download page (alon-site/shots).
 *
 * Every picture is taken on the satellite map, never on the 3D map: the
 * satellite provider's rules allow screen captures on a website that
 * promotes your own product, with their credit on or near the picture. The
 * 3D map's rules say nothing that clearly allows a still picture, so it is
 * not used. Each picture is refused unless the satellite map is the one
 * showing and its credit line is on screen with nothing over it.
 *
 *   node alon-site-shots.mjs            all the pictures
 *   node alon-site-shots.mjs stations   only the ones whose name has the word
 *
 * The app must be running (./alon-app.sh start). The pictures show live data,
 * so they change a little every time this is run.
 */
import { mkdirSync } from 'node:fs';

import { launchBrowser, paid3dBlocker, sleep } from './alon-browser.mjs';

const BASE = process.env.ZENITH_URL || 'http://localhost:4173';
const OUT = new URL('./alon-site/shots/', import.meta.url).pathname;
const SIZE = { width: 1440, height: 900 };
const only = process.argv[2]?.toLowerCase();

async function until(page, test, ms, why, ...args) {
  const end = Date.now() + ms;
  for (;;) {
    if (await page.evaluate(test, ...args)) return;
    if (Date.now() > end) throw new Error(why);
    await sleep(200);
  }
}

/** Open the app on the satellite map at one view and wait for the pictures of the ground. */
async function open(page, { lat, lon, alt, heading = 0, pitch = -90 }) {
  await page.goto('about:blank');
  await page.goto(`${BASE}/#v=2&lat=${lat}&lon=${lon}&alt=${alt}&heading=${heading}&pitch=${pitch}&map=esri-imagery`, {
    waitUntil: 'domcontentloaded',
  });
  await until(page, () => Boolean(document.getElementById('zenith-more-toggle') && window.__godsEyeView?.viewer), 90_000, 'the app did not start');
  await until(page, () => !document.elementFromPoint(innerWidth / 2, 50)?.closest('#loading-screen'), 60_000, 'the loading screen stayed');
  await sleep(2500);
  await settle(page);
}

const settle = async (page) => {
  await until(page, () => window.__godsEyeView.viewer.scene.globe.tilesLoaded, 45_000, 'the map never finished loading').catch(() => {});
  await sleep(1200);
};

const press = async (page, id) => {
  await page.click(`#${id}`);
  await sleep(400);
};

/** Where a place on the ground is on screen, in pixels. */
const onScreen = (page, lon, lat) =>
  page.evaluate(
    (lon, lat) => {
      const { scene } = window.__godsEyeView.viewer;
      const toRad = Math.PI / 180;
      const at = scene.globe.ellipsoid.cartographicToCartesian({ longitude: lon * toRad, latitude: lat * toRad, height: 0 });
      const spot = scene.cartesianToCanvasCoordinates(at);
      return spot ? [Math.round(spot.x), Math.round(spot.y)] : null;
    },
    lon,
    lat,
  );

const SHOTS = [
  {
    name: 'day-and-night',
    async take(page) {
      // Over the line where night is falling right now, wherever that is.
      const hours = new Date().getUTCHours() + new Date().getUTCMinutes() / 60;
      const sunLon = ((((12 - hours) * 15 + 540) % 360) + 360) % 360 - 180;
      const duskLon = ((sunLon + 78 + 540) % 360) - 180;
      await open(page, { lat: 28, lon: duskLon.toFixed(2), alt: 13_500_000 });
      await press(page, 'day-night-toggle');
      await sleep(5000);
    },
  },
  {
    name: 'earthquakes',
    async take(page) {
      await open(page, { lat: 20, lon: 140, alt: 9_000_000 });
      // The strongest earthquake of the last day, from the same public feed the app reads.
      const strongest = await page.evaluate(async () => {
        const feed = await (await fetch('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson')).json();
        const quakes = feed.features.filter((f) => f.properties.type === 'earthquake' && Number.isFinite(f.properties.mag));
        quakes.sort((a, b) => b.properties.mag - a.properties.mag);
        return quakes[0]?.geometry.coordinates ?? null;
      });
      if (!strongest) throw new Error('the earthquake feed gave nothing to show');
      await open(page, { lat: strongest[1].toFixed(2), lon: strongest[0].toFixed(2), alt: 7_000_000 });
      await press(page, 'earthquakes-toggle');
      await until(page, () => Number(document.getElementById('earthquakes-toggle').dataset.count) > 0, 15_000, 'no earthquakes arrived');
      await sleep(800);
      const spot = await onScreen(page, strongest[0], strongest[1]);
      await page.mouse.click(spot[0], spot[1]);
      await sleep(1500);
    },
  },
  {
    name: 'measure',
    async take(page) {
      // Across Snowdon, the highest mountain in Wales.
      // The view is centred a little north of the summit, so the path sits
      // below the profile panel.
      await open(page, { lat: 53.088, lon: -4.0763, alt: 16_000 });
      await press(page, 'measure-toggle');
      for (const [lon, lat] of [
        [-4.136, 53.066],
        [-4.0763, 53.0685],
        [-4.016, 53.071],
      ]) {
        const spot = await onScreen(page, lon, lat);
        await page.mouse.click(spot[0], spot[1]);
        await sleep(900);
      }
      await page.click('#measure-profile-open');
      await until(page, () => /Highest/i.test(document.getElementById('measure-profile')?.textContent ?? ''), 30_000, 'the height profile never drew');
      await sleep(800);
    },
  },
  {
    name: 'train-stations',
    async take(page) {
      await open(page, { lat: 52.5205, lon: 13.386, alt: 6500 });
      await press(page, 'train-stations-toggle');
      await sleep(3500);
      // Click the main station for its name.
      const spot = await onScreen(page, 13.3694, 52.5251);
      await page.mouse.move(spot[0] - 30, spot[1] - 30);
      await page.mouse.move(spot[0], spot[1], { steps: 6 });
      await sleep(400);
      await page.mouse.click(spot[0], spot[1]);
      await sleep(1500);
    },
  },
  {
    name: 'map-pin',
    async take(page) {
      // The Colosseum in Rome: a landmark, not anybody's home.
      await open(page, { lat: 41.8902, lon: 12.4922, alt: 1100 });
      await press(page, 'address-lookup-toggle');
      await page.mouse.click(SIZE.width / 2, SIZE.height / 2);
      await until(
        page,
        () => {
          const text = document.getElementById('address-card')?.textContent ?? '';
          return text.length > 40 && !/Looking up/.test(text);
        },
        25_000,
        'the map pin card never got its address',
      );
      await sleep(1500);
    },
  },
  {
    name: 'time-zones',
    async take(page) {
      await open(page, { lat: 38, lon: 25, alt: 9_500_000 });
      await press(page, 'time-zones-toggle');
      await sleep(6000);
    },
  },
];

/** Refuse a picture that is not the satellite map with its credit showing. */
async function checkCredits(page) {
  const found = await page.evaluate(() => {
    const map = window.__godsEyeView.mapStackController.getActiveStack()?.id;
    const link = [...document.querySelectorAll('#cesium-credits a')].find((a) => /Esri/.test(a.textContent));
    if (!link) return { map, credit: null };
    const r = link.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      map,
      credit: link.textContent,
      inView: r.width > 0 && r.left >= 0 && r.bottom <= innerHeight,
      clear: Boolean(top) && Boolean(top.closest('#cesium-credits')),
      line: document.getElementById('cesium-credits').innerText.replace(/\s+/g, ' ').trim(),
    };
  });
  if (found.map !== 'esri-imagery') throw new Error(`the map showing is "${found.map}", not the satellite map`);
  if (!found.credit || !found.inView || !found.clear) throw new Error('the satellite credit is not clear on screen');
  return found.line;
}

async function main() {
  const browser = await launchBrowser();
  if (!browser) {
    console.error('No browser to take pictures with.');
    process.exit(2);
  }
  mkdirSync(OUT, { recursive: true });
  const page = await browser.newPage();
  await page.setViewport(SIZE);
  // The app asks for the metered 3D map on every load, even with the
  // satellite map chosen. These pictures never use it, so it is blocked.
  await (await paid3dBlocker(page))(true);
  // A plain file from the same site is enough to set the first-run settings,
  // without loading the whole app once more.
  await page.goto(`${BASE}/alon/zenith-favicon.png`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    localStorage.setItem('gev:first-run-mission:v1', 'suppressed');
    localStorage.setItem('gev.helpCard', 'closed');
    // The satellite map as a person's own choice, so the app does not switch to the 3D map.
    localStorage.setItem('gev.satelliteByChoice', '1');
  });
  let failed = 0;
  for (const shot of SHOTS) {
    if (only && !shot.name.includes(only)) continue;
    try {
      // Each picture starts with every switch off.
      await page.evaluate(() => {
        for (const key of ['dayNight', 'earthquakes', 'timeZones', 'trainStations', 'addressLookup', 'mapLabels']) localStorage.setItem(`gev.${key}`, '0');
      });
      await shot.take(page);
      await settle(page);
      const credits = await checkCredits(page);
      await page.screenshot({ path: `${OUT}${shot.name}.webp`, type: 'webp', quality: 80 });
      console.log(`✓ ${shot.name}  (credits on screen: ${credits})`);
    } catch (error) {
      failed += 1;
      console.log(`✗ ${shot.name}: ${error.message}`);
    }
  }
  await browser.close();
  process.exit(failed ? 1 : 0);
}

main();
