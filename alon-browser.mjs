/**
 * Shared by Zenith's browser checks (alon-browser-test.mjs and
 * alon-speed-check.mjs): finding a browser to drive, and waiting.
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import puppeteer from 'puppeteer';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Browsers these checks could drive, best first. The browser-driving package
 * wants one exact version of its own test browser, which is not always on
 * this Mac (or is only half there), so the run tries each of these in turn:
 * the one named in ZENITH_CHROME, the package's own, test browsers already
 * downloaded by other tools, then Google Chrome itself. Chrome is run with a
 * throwaway profile, so the real one is not touched.
 */
function browserCandidates() {
  const found = [];
  const add = (path) => {
    if (typeof path === 'string' && path && existsSync(path) && !found.includes(path)) found.push(path);
  };
  add(process.env.ZENITH_CHROME);
  try {
    add(puppeteer.executablePath());
  } catch {
    // The package's own browser is not installed.
  }
  const inside = (root, ...appPath) => {
    if (!existsSync(root)) return;
    for (const version of readdirSync(root).sort().reverse()) {
      const base = join(root, version);
      let folders = [];
      try {
        folders = readdirSync(base);
      } catch {
        continue;
      }
      for (const folder of folders) add(join(base, folder, ...appPath));
    }
  };
  const testChrome = ['Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'];
  inside(join(homedir(), '.cache', 'puppeteer', 'chrome'), ...testChrome);
  inside(join(homedir(), 'Library', 'Caches', 'ms-playwright'), ...testChrome);
  inside(join(homedir(), 'Library', 'Caches', 'ms-playwright'), 'Chromium.app', 'Contents', 'MacOS', 'Chromium');
  add('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  return found;
}

/** @returns {Promise<import('puppeteer').Browser | null>} Null when none will start. */
export async function launchBrowser() {
  const flags = process.platform === 'darwin' ? ['--use-angle=metal', '--enable-gpu'] : ['--use-gl=angle'];
  for (const executablePath of browserCandidates()) {
    try {
      return await puppeteer.launch({ headless: true, executablePath, args: flags });
    } catch {
      // Half-installed or too old: try the next one.
    }
  }
  return null;
}


/**
 * The requests that start or use a session of the metered 3D map: Cesium
 * ion's asset for Google's 3D tiles, and Google's tile server. The app asks
 * for them on every page load, even with the satellite map chosen.
 */
export const PAID_3D = ['*://tile.googleapis.com/*', '*://api.cesium.com/v1/assets/2275207/*'];
/**
 * Cesium Moon Terrain (ion asset 2684829): loading it uses Alon's ion
 * allowance, so it is blocked in every run, the 3D-map runs included, until
 * he says yes to one.
 */
export const ASK_FIRST = ['*://api.cesium.com/v1/assets/2684829/*'];

/**
 * Returns a switch that blocks the metered 3D map for this page, or lets it
 * through again. Blocked requests fail inside the browser and are never
 * sent, so a run on the satellite map costs nothing. Chrome's own block list
 * is used, so a check's own request handling keeps working alongside it.
 * @returns {Promise<(blocked: boolean, extra?: string[]) => Promise<unknown>>}
 */
export async function paid3dBlocker(page) {
  const client = await page.createCDPSession();
  await client.send('Network.enable');
  // `extra`: more addresses to block for a while, such as a feed a check
  // wants to see failing.
  return (blocked, extra = []) =>
    client.send('Network.setBlockedURLs', { urls: [...(blocked ? PAID_3D : []), ...ASK_FIRST, ...extra] });
}
