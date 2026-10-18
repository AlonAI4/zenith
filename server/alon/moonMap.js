import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { sameSiteGated } from '../providers/common/same-site.js';

/**
 * NASA's Moon map for space view, served from this computer.
 *
 * Cesium's own Moon picture is 256 pixels wide, so the Moon is a blur close
 * up. NASA's CGI Moon Kit (Scientific Visualization Studio, public domain,
 * https://svs.gsfc.nasa.gov/4720) has the Lunar Reconnaissance Orbiter's
 * colour map at 8192 pixels wide, but only as a TIFF, which browsers other
 * than Safari cannot show. The first time it is asked for, it is downloaded
 * once (48 MB), turned into a JPEG with the Mac's own sips tool, and kept in
 * .gev-cache. Without sips, the kit's 2048-pixel JPEG is used instead.
 *
 * A page needs the picture from its own address to draw it on the Moon,
 * which NASA's server does not allow directly.
 */

const KIT = 'https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/';
export const MAP_8K = `${KIT}lroc_color_poles_8k.tif`;
export const MAP_2K = `${KIT}lroc_color_2k.jpg`;
const TIMEOUT_MS = 180_000;
/** After the 8k map fails (no sips, NASA slow), the 2k one is used this long. */
const RETRY_BIG_MS = 3_600_000;
const run = promisify(execFile);

/**
 * @param {{ cacheDir?: string, fetchImpl?: typeof fetch,
 *   convert?: (from: string, to: string) => Promise<void>,
 *   now?: () => number }} [options]
 * @returns {() => Promise<{ file: string, size: '8k' | '2k' }>} Gets the
 *   map, downloading it the first time; asks at the same moment share one
 *   download.
 */
export function createMoonMap({
  cacheDir = path.join(process.cwd(), '.gev-cache', 'moon'),
  fetchImpl = globalThis.fetch,
  convert = (from, to) =>
    run(
      '/usr/bin/sips',
      ['-s', 'format', 'jpeg', '-s', 'formatOptions', '85', from, '--out', to],
      { timeout: TIMEOUT_MS },
    ).then(() => {}),
  now = () => Date.now(),
} = {}) {
  const big = path.join(cacheDir, 'lroc-color-8k.jpg');
  const small = path.join(cacheDir, 'lroc-color-2k.jpg');
  const exists = (file) =>
    stat(file).then(
      (info) => info.size > 0,
      () => false,
    );
  const download = async (url, to) => {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok || !response.body)
      throw new Error(`NASA answered ${response.status}`);
    const part = `${to}.part`;
    try {
      await pipeline(Readable.fromWeb(response.body), createWriteStream(part));
      await rename(part, to);
    } finally {
      await rm(part, { force: true });
    }
  };
  let working = null;
  let bigFailedAt = -Infinity;
  const get = async () => {
    if (await exists(big)) return { file: big, size: '8k' };
    await mkdir(cacheDir, { recursive: true });
    if (now() - bigFailedAt >= RETRY_BIG_MS) {
      const tiff = path.join(cacheDir, 'lroc-color-8k.tif');
      const jpeg = `${big}.part.jpg`;
      try {
        await download(MAP_8K, tiff);
        await convert(tiff, jpeg);
        await rename(jpeg, big);
        return { file: big, size: '8k' };
      } catch (error) {
        bigFailedAt = now();
        console.warn('[moon-map] 8k map:', error?.message || error);
      } finally {
        await rm(tiff, { force: true });
        await rm(jpeg, { force: true });
      }
    }
    if (!(await exists(small))) await download(MAP_2K, small);
    return { file: small, size: '2k' };
  };
  return () => {
    working ??= get().finally(() => {
      working = null;
    });
    return working;
  };
}

/** The route: the map as a JPEG, or 502 when NASA could not be reached. */
export function moonMapHandler(getMap) {
  // Only Zenith's own page: another website cannot start the download.
  return sameSiteGated(async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.statusCode = 405;
      response.end();
      return;
    }
    try {
      const { file, size } = await getMap();
      const { size: bytes } = await stat(file);
      response.statusCode = 200;
      response.setHeader('Content-Type', 'image/jpeg');
      response.setHeader('Content-Length', String(bytes));
      response.setHeader('Cache-Control', 'private, max-age=604800');
      response.setHeader('X-Moon-Map', size);
      if (request.method === 'HEAD') {
        response.end();
        return;
      }
      // Sent from the file a piece at a time, not read whole into memory.
      await pipeline(createReadStream(file), response);
    } catch (error) {
      // The page went away part way through: nothing more to send.
      if (response.headersSent) {
        response.destroy?.();
        return;
      }
      response.statusCode = 502;
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({
          error: `NASA's Moon map could not be fetched: ${String(error?.message || error).slice(0, 200)}`,
        }),
      );
    }
  });
}

export function alonMoonMap(options = {}) {
  const handler = moonMapHandler(createMoonMap(options));
  // Returns nothing: Vite runs a function returned from these hooks later.
  const install = (server) => {
    server.middlewares.use('/api/alon/moon-map', handler);
  };
  return {
    name: 'alon-moon-map',
    configureServer: install,
    configurePreviewServer: install,
  };
}
