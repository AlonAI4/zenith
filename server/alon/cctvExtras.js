import path from 'node:path';

import { createCctvCatalog } from '../providers/cctv/catalog.js';
import { DIGITRAFFIC_USER } from '../providers/cctv/constants.js';
import { fetchCctvImageFromUpstream } from '../providers/cctv/media.js';
import { readResponseJsonCapped } from '../providers/common/http.js';
import { sameSiteGated } from '../providers/common/same-site.js';
import { defaultSourceRoot } from '../providers/common/source-root.js';
import { createPhotoStore } from './cctvPhotos.js';

/**
 * Zenith's camera extras, written for this build: older pictures from the
 * camera networks that keep their own (Finland, British Columbia and three
 * Caltrans districts), and photos people take of a camera's picture
 * (cctvPhotos.js).
 *
 * Every picture is fetched here from the network's own server, at an address
 * built from a checked camera id and a checked key, and never through the
 * app's /api/cctv/frame route: that one falls back to paid Google Street View
 * when a camera does not answer.
 */

const LIST_CACHE_MS = 60_000;
const LIST_TIMEOUT_MS = 8000;
const LIST_MAX_BYTES = 512 * 1024;
/** BC deletes a picture as soon as it is a day old: never offer the last minutes. */
const DRIVEBC_KEEP_MS = 24 * 3600_000 - 10 * 60_000;

const FINTRAFFIC_ID = /^fi-(c\d{7})$/;
const DRIVEBC_ID = /^drivebc-([1-9]\d{0,6})$/;
// Bay Area (D4) cameras keep frozen pictures dated 1970 or 2041, so only these.
const CALTRANS_ID = /^ca-d(3|7|11)-[a-z0-9_-]{1,80}$/;
const CALTRANS_IMAGE =
  /^https:\/\/cwwp2\.dot\.ca\.gov\/data\/d(3|7|11)\/cctv\/image\/([a-z0-9_-]{1,80})\/\2\.jpg$/;
const CALTRANS_SLOTS = 12;

const FINTRAFFIC_KEY = /^[A-Za-z0-9._-]{8,128}$/;
const DRIVEBC_KEY = /^20\d{12}$/;
const CALTRANS_KEY = /^(?:[1-9]|1[0-2])$/;

/** Which network keeps older pictures for this camera id, or null. */
export function historySource(cameraId) {
  const id = String(cameraId || '');
  if (FINTRAFFIC_ID.test(id)) return 'fintraffic';
  if (DRIVEBC_ID.test(id)) return 'drivebc';
  if (CALTRANS_ID.test(id)) return 'caltrans';
  return null;
}

/** Finland's history answer as [{ time, key }], for this camera's view only. */
export function parseFintrafficHistory(answer, cameraId) {
  const preset = FINTRAFFIC_ID.exec(cameraId)?.[1]?.toUpperCase();
  if (!preset) return [];
  const prefix = `https://weathercam.digitraffic.fi/${preset}.jpg?versionId=`;
  const frames = [];
  for (const one of answer?.presets ?? []) {
    for (const entry of one?.history ?? []) {
      const url = String(entry?.imageUrl ?? '');
      if (!url.startsWith(prefix)) continue;
      const key = url.slice(prefix.length);
      const time = Date.parse(entry?.lastModified);
      if (FINTRAFFIC_KEY.test(key) && Number.isFinite(time))
        frames.push({ time, key });
    }
  }
  return frames.sort((a, b) => a.time - b.time);
}

/** BC's list of UTC times ('YYYYMMDDHHMMSS') as [{ time, key }], newer than a day. */
export function parseDrivebcHistory(answer, now = Date.now()) {
  const frames = [];
  for (const stamp of Array.isArray(answer) ? answer : []) {
    const key = String(stamp);
    if (!DRIVEBC_KEY.test(key)) continue;
    const [, y, mo, d, h, mi, s] =
      /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)$/.exec(key);
    const time = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
    if (now - time < DRIVEBC_KEEP_MS && time <= now + 60_000)
      frames.push({ time, key });
  }
  return frames.sort((a, b) => a.time - b.time);
}

/** The camera's folder name from its Caltrans picture address, or null. */
export function caltransCamera(imageUrl) {
  const found = CALTRANS_IMAGE.exec(String(imageUrl || ''));
  return found ? { district: found[1], cam: found[2] } : null;
}

/**
 * The network's own address for one older picture, or null when the key is
 * not one this camera can have.
 */
export function historyFrameUrl(cameraId, key, camera = null) {
  const source = historySource(cameraId);
  const value = String(key ?? '');
  if (source === 'fintraffic' && FINTRAFFIC_KEY.test(value)) {
    const preset = FINTRAFFIC_ID.exec(cameraId)[1].toUpperCase();
    return `https://weathercam.digitraffic.fi/${preset}.jpg?versionId=${value}`;
  }
  if (source === 'drivebc' && DRIVEBC_KEY.test(value)) {
    const number = DRIVEBC_ID.exec(cameraId)[1];
    return `https://www.drivebc.ca/images/replaytheday/${number}/${value}.jpg`;
  }
  if (source === 'caltrans' && CALTRANS_KEY.test(value) && camera) {
    const { district, cam } = camera;
    return `https://cwwp2.dot.ca.gov/data/d${district}/cctv/image/${cam}/previous/${cam}-${value}.jpg`;
  }
  return null;
}

async function getJson(fetchImpl, url, headers = {}) {
  const answer = await fetchImpl(url, {
    headers: { Accept: 'application/json', ...headers },
    redirect: 'error',
    signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
  });
  if (!answer.ok) throw new Error(`HTTP ${answer.status}`);
  return readResponseJsonCapped(answer, LIST_MAX_BYTES);
}

/**
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {() => Promise<Array<object>>} [options.cameras] The camera list, as the app's own catalog builds it.
 * @param {() => number} [options.now]
 */
export function createCctvExtras({
  fetchImpl = fetch,
  cameras = null,
  now = () => Date.now(),
  sourceRoot = defaultSourceRoot,
  // The Mac app keeps photos next to its other data; otherwise in the cache folder.
  photosDir = process.env.ZENITH_PHOTOS_DIR ||
    path.join(process.cwd(), '.gev-cache', 'cctv-photos'),
} = {}) {
  // The camera list is built a second time, only when a Caltrans camera's
  // history or a photo is first asked for: the app's own list lives inside its
  // camera route.
  let getCameras = null;
  const listCameras =
    cameras ??
    (() => {
      getCameras ??= createCctvCatalog({ sourceRoot });
      return getCameras();
    });
  const lists = new Map();

  const caltransFor = async (cameraId) => {
    const found = (await listCameras()).find(
      (camera) => camera.id === cameraId,
    );
    return caltransCamera(found?.snapshotUrl || found?.url);
  };

  async function loadHistory(cameraId) {
    const source = historySource(cameraId);
    if (source === 'fintraffic') {
      const preset = FINTRAFFIC_ID.exec(cameraId)[1].toUpperCase();
      const answer = await getJson(
        fetchImpl,
        `https://tie.digitraffic.fi/api/weathercam/v1/stations/${preset}/history`,
        { 'Digitraffic-User': DIGITRAFFIC_USER },
      );
      return parseFintrafficHistory(answer, cameraId);
    }
    if (source === 'drivebc') {
      const number = DRIVEBC_ID.exec(cameraId)[1];
      const answer = await getJson(
        fetchImpl,
        `https://www.drivebc.ca/api/webcams/${number}/replayTheDay/`,
      );
      return parseDrivebcHistory(answer, now());
    }
    if (source === 'caltrans') {
      const camera = await caltransFor(cameraId);
      if (!camera) return [];
      // Caltrans lists no times: each picture's Last-Modified header is its time.
      const slots = Array.from({ length: CALTRANS_SLOTS }, (_, index) =>
        String(index + 1),
      );
      const times = await Promise.all(
        slots.map(async (key) => {
          try {
            const answer = await fetchImpl(
              historyFrameUrl(cameraId, key, camera),
              {
                method: 'HEAD',
                redirect: 'error',
                signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
              },
            );
            return answer.ok
              ? Date.parse(answer.headers.get('last-modified'))
              : NaN;
          } catch {
            return NaN;
          }
        }),
      );
      const day = 24 * 3600_000;
      return slots
        .map((key, index) => ({ key, time: times[index] }))
        .filter(
          ({ time }) =>
            Number.isFinite(time) &&
            time <= now() + 60_000 &&
            now() - time < day,
        )
        .sort((a, b) => a.time - b.time);
    }
    return [];
  }

  /** The older pictures this camera's network keeps: [{ time, key }], oldest first. */
  async function history(cameraId) {
    if (!historySource(cameraId)) return [];
    const cached = lists.get(cameraId);
    if (cached && now() - cached.at < LIST_CACHE_MS) return cached.frames;
    const frames = await loadHistory(cameraId).catch(() => []);
    lists.set(cameraId, { at: now(), frames });
    if (lists.size > 200) lists.delete(lists.keys().next().value);
    return frames;
  }

  /**
   * One older picture, fetched from the network's own server, or null.
   * Caltrans keeps its pictures in slots that move on every quarter of an
   * hour, so there the picture must still be the one listed at `time`.
   */
  async function historyFrame(cameraId, key, time = NaN) {
    const caltrans = historySource(cameraId) === 'caltrans';
    const camera = caltrans ? await caltransFor(cameraId) : null;
    const url = historyFrameUrl(cameraId, key, camera);
    if (!url) return null;
    if (caltrans) {
      try {
        const answer = await fetchImpl(url, {
          method: 'HEAD',
          redirect: 'error',
          signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
        });
        const modified = Date.parse(answer.headers.get('last-modified'));
        if (!answer.ok || !(Math.abs(modified - time) <= 60_000)) return null;
      } catch {
        return null;
      }
    }
    const picture = await fetchCctvImageFromUpstream(url, { fetchImpl });
    return picture?.ok ? { ...picture, moves: caltrans } : null;
  }

  const photos = createPhotoStore({
    dir: photosDir,
    listCameras,
    fetchImpl,
    now,
  });
  return { history, historyFrame, photos };
}

const MAX_BODY_BYTES = 2048;

/** A small JSON request body, or null. */
const CASE_FILE_MAX_BYTES = 5 * 1024 * 1024;
const TOO_BIG = Symbol('too big');

/** A JPEG sent by the page, or null when it is something else or too big. */
async function readJpegBody(req, maxBytes) {
  if (!/^image\/jpeg\b/i.test(String(req.headers?.['content-type'] ?? '')))
    return null;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) return TOO_BIG;
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(req) {
  if (
    !/^application\/json\b/i.test(String(req.headers?.['content-type'] ?? ''))
  )
    return null;
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > MAX_BODY_BYTES) return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const send = (res, status, body, type = 'application/json', keep = true) => {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control':
      keep && status === 200 && type !== 'application/json'
        ? 'private, max-age=600'
        : 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};

/** The request handler for /api/alon/cctv. Exported for its tests. */
export function cctvExtrasHandler(extras) {
  return sameSiteGated(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    let parts;
    try {
      parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    } catch {
      send(res, 400, { error: 'Bad address' });
      return;
    }
    try {
      if (
        req.method === 'GET' &&
        parts[0] === 'history' &&
        parts.length === 2
      ) {
        send(res, 200, { frames: await extras.history(parts[1]) });
        return;
      }
      if (
        req.method === 'GET' &&
        parts[0] === 'history' &&
        parts[2] === 'frame' &&
        parts.length === 3
      ) {
        const picture = await extras.historyFrame(
          parts[1],
          url.searchParams.get('key'),
          Number(url.searchParams.get('t')),
        );
        if (picture) {
          send(res, 200, picture.body, picture.contentType, !picture.moves);
        } else send(res, 404, { error: 'No picture from then' });
        return;
      }
      if (
        req.method === 'GET' &&
        parts[0] === 'photo-check' &&
        parts.length === 2
      ) {
        send(res, 200, await extras.photos.permission(parts[1]));
        return;
      }
      if (parts[0] === 'photos' && parts.length === 1) {
        if (req.method === 'GET') {
          send(res, 200, await extras.photos.list());
          return;
        }
        if (req.method === 'POST') {
          const body = await readJsonBody(req);
          if (typeof body?.cameraId !== 'string') {
            send(res, 400, { error: 'Send a camera id' });
            return;
          }
          const { status, ...answer } = await extras.photos.take(body.cameraId);
          send(res, status, answer);
          return;
        }
      }
      if (
        req.method === 'POST' &&
        parts[0] === 'case-files' &&
        parts.length === 1
      ) {
        const body = await readJpegBody(req, CASE_FILE_MAX_BYTES);
        if (body === TOO_BIG) {
          send(res, 413, { error: 'The picture is too big to save' });
          return;
        }
        if (!body) {
          send(res, 400, { error: 'Only a picture of the view can be saved' });
          return;
        }
        const number = (name) => {
          const value = url.searchParams.get(name);
          return value === null ? NaN : Number(value);
        };
        const { status, ...answer } = await extras.photos.keep({
          body,
          title: String(url.searchParams.get('title') ?? '').slice(0, 120),
          lat: number('lat'),
          lon: number('lon'),
        });
        send(res, status, answer);
        return;
      }
      if (parts[0] === 'photos' && parts.length === 2) {
        if (req.method === 'GET') {
          const photo = await extras.photos.read(parts[1]);
          if (photo) send(res, 200, photo.body, photo.contentType);
          else send(res, 404, { error: 'No such photo' });
          return;
        }
        if (req.method === 'DELETE') {
          const gone = await extras.photos.remove(parts[1]);
          send(
            res,
            gone ? 200 : 404,
            gone ? { deleted: parts[1] } : { error: 'No such photo' },
          );
          return;
        }
      }
      send(res, 404, { error: 'Not found' });
    } catch {
      send(res, 500, { error: 'Camera extras failed' });
    }
  });
}

/** The Vite plugin: the same routes on the dev server and the preview server. */
export function alonCctvExtras(options = {}) {
  const extras = createCctvExtras(options);
  // Returns nothing: Vite runs a function returned from these hooks later, as
  // a hook of its own.
  const install = (server) => {
    server.middlewares.use('/api/alon/cctv', cctvExtrasHandler(extras));
  };
  return {
    name: 'alon-cctv-extras',
    configureServer: install,
    configurePreviewServer: install,
  };
}
