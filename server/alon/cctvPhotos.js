import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { fetchCctvImageFromUpstream } from '../providers/cctv/media.js';

/**
 * Photos of camera pictures, taken when someone presses Take photo, kept in
 * Zenith's own files on this computer and never sent anywhere.
 *
 * The page sends only a camera id. The picture is fetched here from the
 * camera network's own server (never through /api/cctv/frame, which can fall
 * back to paid Google Street View) and saved under a name made here, inside
 * the photos folder only.
 */

/**
 * The camera networks whose terms allow saving copies, by the camera
 * catalog's pack name, with the licence each one is under.
 */
export const PHOTO_PACKS = Object.freeze({
  tfl: 'Transport for London (Open Government Licence)',
  ontario: 'Ontario 511 (Open Government Licence – Ontario)',
  calgary: 'City of Calgary (Open Government Licence – City of Calgary)',
  nsw: 'Transport for NSW (CC BY 4.0)',
  vegvesen: 'Statens vegvesen (NLOD)',
  austin: 'City of Austin (public domain)',
  fintraffic: 'Fintraffic (CC BY 4.0)',
});

export const PHOTO_LIMITS = Object.freeze({
  count: 2000,
  bytes: 500 * 1024 * 1024,
  picture: 5 * 1024 * 1024,
});

const CAMERA_ID = /^[A-Za-z0-9._:-]{1,120}$/;
const FILE_NAME = /^\d{13}-[0-9a-f]{8}\.(jpg|png|webp)$/;
const EXTENSION = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
const TYPE = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

/** Whether this camera's picture may be saved, and if not, why, in plain words. */
export function photoPermission(camera) {
  if (!camera)
    return { allowed: false, why: 'This camera is not in the list right now.' };
  if (/video|hls|stream/i.test(String(camera.feedType ?? ''))) {
    return {
      allowed: false,
      why: 'Photos work on cameras that send pictures, not video.',
    };
  }
  if (!PHOTO_PACKS[camera.pack]) {
    return {
      allowed: false,
      why: "Photos are off for this camera: its network's terms do not say copies may be saved.",
    };
  }
  return { allowed: true, why: '' };
}

/** A photo file name from the photos folder's own list, or null. */
export function photoFileName(name) {
  const value = String(name ?? '');
  return FILE_NAME.test(value) ? value : null;
}

/**
 * @param {object} options
 * @param {string} options.dir The photos folder.
 * @param {() => Promise<Array<object>>} options.listCameras
 * @param {typeof fetch} [options.fetchImpl]
 * @param {() => number} [options.now]
 * @param {{count: number, bytes: number, picture: number}} [options.limits]
 */
export function createPhotoStore({
  dir,
  listCameras,
  fetchImpl = fetch,
  now = () => Date.now(),
  limits = PHOTO_LIMITS,
}) {
  const indexFile = path.join(dir, 'photos.json');
  // One change at a time, so two quick presses cannot write the list at once.
  let queue = Promise.resolve();
  const inTurn = (work) => {
    const next = queue.then(work, work);
    queue = next.catch(() => {});
    return next;
  };

  async function readIndex() {
    try {
      const list = JSON.parse(await readFile(indexFile, 'utf8'));
      return Array.isArray(list)
        ? list.filter((photo) => photoFileName(photo?.file))
        : [];
    } catch {
      return [];
    }
  }

  async function writeIndex(list) {
    await mkdir(dir, { recursive: true });
    const temporary = `${indexFile}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(temporary, JSON.stringify(list, null, 1));
    await rename(temporary, indexFile);
  }

  async function findCamera(cameraId) {
    if (!CAMERA_ID.test(String(cameraId ?? ''))) return null;
    return (
      (await listCameras()).find((camera) => camera.id === cameraId) ?? null
    );
  }

  /** May this camera be photographed? */
  async function permission(cameraId) {
    return photoPermission(await findCamera(cameraId));
  }

  /** Every photo, newest first, and whether the folder is full. */
  async function list() {
    const photos = (await readIndex()).sort((a, b) => b.time - a.time);
    const bytes = photos.reduce((sum, photo) => sum + (photo.bytes || 0), 0);
    return {
      photos,
      full: photos.length >= limits.count || bytes >= limits.bytes,
    };
  }

  /**
   * Take a photo of the camera's picture right now.
   * @returns {Promise<{photo?: object, error?: string, status: number}>}
   */
  function take(cameraId) {
    return inTurn(async () => {
      const camera = await findCamera(cameraId);
      const allowed = photoPermission(camera);
      if (!allowed.allowed) return { status: 403, error: allowed.why };
      const photos = await readIndex();
      const used = photos.reduce((sum, photo) => sum + (photo.bytes || 0), 0);
      if (photos.length >= limits.count || used >= limits.bytes) {
        return {
          status: 507,
          error: 'The photos folder is full. Delete some photos to take more.',
        };
      }
      const picture = await fetchCctvImageFromUpstream(
        camera.snapshotUrl || camera.url,
        {
          fetchImpl,
          maxBytes: limits.picture,
        },
      );
      const extension =
        EXTENSION[
          String(picture?.contentType ?? '')
            .split(';')[0]
            .trim()
        ];
      if (!picture?.ok || !extension)
        return {
          status: 502,
          error: 'The camera did not send a picture. Try again in a moment.',
        };
      if (used + picture.body.length > limits.bytes) {
        return {
          status: 507,
          error: 'The photos folder is full. Delete some photos to take more.',
        };
      }
      const time = now();
      const file = `${String(time).padStart(13, '0')}-${randomBytes(4).toString('hex')}.${extension}`;
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, file), picture.body);
      const photo = {
        file,
        cameraId: camera.id,
        name: String(camera.name ?? '').slice(0, 160),
        place: String(camera.city ?? '').slice(0, 80),
        network: PHOTO_PACKS[camera.pack],
        lat: camera.lat,
        lon: camera.lon,
        time,
        bytes: picture.body.length,
      };
      await writeIndex([...photos, photo]);
      return { status: 200, photo };
    });
  }

  /** One photo's bytes, only for a name that is in the photos list. */
  async function read(name) {
    const file = photoFileName(name);
    if (!file || !(await readIndex()).some((photo) => photo.file === file))
      return null;
    try {
      return {
        body: await readFile(path.join(dir, file)),
        contentType: TYPE[file.split('.').pop()],
      };
    } catch {
      return null;
    }
  }

  /** Delete one photo. */
  function remove(name) {
    return inTurn(async () => {
      const file = photoFileName(name);
      const photos = await readIndex();
      if (!file || !photos.some((photo) => photo.file === file)) return false;
      await writeIndex(photos.filter((photo) => photo.file !== file));
      await rm(path.join(dir, file), { force: true });
      return true;
    });
  }

  /**
   * Keep a picture Zenith drew itself: a case file of the map with a target
   * box. Only a JPEG, no bigger than a camera picture, under a name made here.
   * @returns {Promise<{photo?: object, error?: string, status: number}>}
   */
  function keep({ body, title, lat, lon }) {
    return inTurn(async () => {
      const jpeg =
        Buffer.isBuffer(body) &&
        body.length > 3 &&
        body[0] === 0xff &&
        body[1] === 0xd8 &&
        body[2] === 0xff;
      if (!jpeg || body.length > limits.picture)
        return {
          status: 400,
          error: 'Only a picture of the view can be saved',
        };
      const photos = await readIndex();
      const used = photos.reduce((sum, photo) => sum + (photo.bytes || 0), 0);
      if (photos.length >= limits.count || used + body.length > limits.bytes) {
        return {
          status: 507,
          error: 'The photos folder is full. Delete some photos to save more.',
        };
      }
      const time = now();
      const file = `${String(time).padStart(13, '0')}-${randomBytes(4).toString('hex')}.jpg`;
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, file), body);
      const photo = {
        file,
        cameraId: 'case-file',
        name: `Case file: ${String(title ?? '').replace(/[\u0000-\u001f]/g, '')}`.slice(
          0,
          160,
        ),
        place: 'Saved from a target box',
        network: 'Your own picture of the map',
        lat: Number.isFinite(lat) ? lat : null,
        lon: Number.isFinite(lon) ? lon : null,
        time,
        bytes: body.length,
      };
      await writeIndex([...photos, photo]);
      return { status: 200, photo };
    });
  }

  return { permission, list, take, read, remove, keep };
}
