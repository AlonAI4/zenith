#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey, sign, verify } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Updates for the Zenith Mac app, without installing a new app.
 *
 * The app (alon-app/launcher.sh) runs this with the Node inside it. An update
 * is a zip of Zenith's code, described by update.json on the newest GitHub
 * Release. Nothing from a download is used until all of these pass: the
 * description is signed with Zenith's author's key (Ed25519, the public half
 * is built into the app), the version is newer than the one installed, the
 * zip has the size and SHA-256 the signed description gives, and every path
 * in the zip stays inside its folder with no links. The old code stays until
 * the new code has started; if it does not start, the app switches back.
 *
 * Folders, all in ~/Library/Application Support/Zenith (the "data" folder):
 *   app/       the code that runs, with .env (keys) and .gev-cache
 *   app.new/   an update, checked and ready, used at the next start
 *   app.old/   the code before the last update, until the new one starts
 *   updates/   downloads in progress
 */

export const MANIFEST_FIELDS = [
  'version',
  'url',
  'sha256',
  'size',
  'lockHash',
  'minAppVersion',
];
const VERSION = /^\d{1,4}(\.\d{1,4}){0,3}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const MAX_MANIFEST_BYTES = 16 * 1024;
const MAX_PACK_BYTES = 200 * 1024 * 1024;

/** -1, 0 or 1, comparing "1.2" with "1.2.1" number by number. */
export function compareVersions(a, b) {
  const left = String(a).split('.').map(Number);
  const right = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

/** The exact text that is signed: every field, in a fixed order. */
export function signedText(manifest) {
  return [
    'zenith-update',
    ...MANIFEST_FIELDS.map((field) => String(manifest[field])),
  ].join('\n');
}

/** The signature for a description, made with the author's private key. */
export function signManifest(fields, privateKeyPem) {
  return sign(null, Buffer.from(signedText(fields)), privateKeyPem).toString(
    'base64',
  );
}

/** Whether an address may be used: https, or this computer itself for tests. */
export function allowedAddress(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:') return true;
    return (
      parsed.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
    );
  } catch {
    return false;
  }
}

/**
 * Check a downloaded description: its shape, then its signature.
 * @returns {{ ok: true } | { ok: false, why: string }}
 */
export function checkManifest(manifest, publicKeyPem) {
  if (!manifest || typeof manifest !== 'object')
    return { ok: false, why: 'The update description is not readable.' };
  if (
    !VERSION.test(String(manifest.version)) ||
    !VERSION.test(String(manifest.minAppVersion))
  ) {
    return {
      ok: false,
      why: 'The update description has a strange version number.',
    };
  }
  if (!allowedAddress(manifest.url))
    return { ok: false, why: 'The update is not on a safe address.' };
  if (
    !HEX64.test(String(manifest.sha256)) ||
    !HEX64.test(String(manifest.lockHash))
  ) {
    return { ok: false, why: 'The update description is incomplete.' };
  }
  if (
    !Number.isSafeInteger(manifest.size) ||
    manifest.size <= 0 ||
    manifest.size > MAX_PACK_BYTES
  ) {
    return { ok: false, why: 'The update has a strange size.' };
  }
  let good = false;
  try {
    good = verify(
      null,
      Buffer.from(signedText(manifest)),
      createPublicKey(publicKeyPem),
      Buffer.from(String(manifest.signature ?? ''), 'base64'),
    );
  } catch {
    good = false;
  }
  return good
    ? { ok: true }
    : {
        ok: false,
        why: "The update was not signed by Zenith's author, so it was ignored.",
      };
}

/**
 * The names and kinds of every entry in a zip, read from its central
 * directory, without unpacking anything.
 * @param {Buffer} zip
 * @returns {Array<{ name: string, link: boolean }>}
 */
export function zipEntries(zip) {
  let end = -1;
  for (let at = zip.length - 22; at >= Math.max(0, zip.length - 65_557); at--) {
    if (zip.readUInt32LE(at) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new Error('not a zip file');
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(at) !== 0x02014b50)
      throw new Error('broken zip directory');
    const madeBy = zip.readUInt16LE(at + 4) >> 8;
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const unixMode = zip.readUInt32LE(at + 38) >>> 16;
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength);
    const link = madeBy === 3 && (unixMode & 0o170000) === 0o120000;
    entries.push({ name, link });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Every entry must sit inside "Zenith/", with no way out and no links. */
export function checkEntries(entries) {
  for (const { name, link } of entries) {
    if (link)
      return {
        ok: false,
        why: `The update holds a link (${name}), so it was refused.`,
      };
    if (
      !name.startsWith('Zenith/') ||
      name.includes('\\') ||
      name.includes('\0')
    ) {
      return {
        ok: false,
        why: `The update holds a file outside its folder (${name}).`,
      };
    }
    if (name.split('/').some((part) => part === '..' || part === '.')) {
      return {
        ok: false,
        why: `The update holds a path that climbs out (${name}).`,
      };
    }
  }
  return entries.length
    ? { ok: true }
    : { ok: false, why: 'The update is empty.' };
}

/** Any link anywhere under a folder (none should survive unpacking). */
export function findLink(folder) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const full = path.join(folder, entry.name);
    if (entry.isSymbolicLink()) return full;
    if (entry.isDirectory()) {
      const found = findLink(full);
      if (found) return found;
    }
  }
  return null;
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fileHash = (file) => (existsSync(file) ? sha256(readFileSync(file)) : '');
const readVersion = (folder) => {
  try {
    return readFileSync(path.join(folder, '.zenith-version'), 'utf8').trim();
  } catch {
    return '0';
  }
};
/** Copy a folder quickly (an APFS clone where possible), without the download mark. */
function cloneFolder(from, to) {
  execFileSync('/bin/cp', ['-cR', from, to]);
  stripQuarantine(to);
}
function stripQuarantine(target) {
  // The person already allowed this app; its own copied files need no second check.
  try {
    execFileSync('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', target], {
      stdio: 'ignore',
    });
  } catch {
    // Nothing to remove.
  }
}

async function fetchCapped(url, maxBytes, fetchImpl) {
  const answer = await fetchImpl(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!answer.ok) throw new Error(`HTTP ${answer.status}`);
  const chunks = [];
  let total = 0;
  for await (const chunk of answer.body) {
    total += chunk.length;
    if (total > maxBytes) throw new Error('too big');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Look for an update; when there is one, download it, check it and get it
 * ready in app.new for the next start.
 * @returns {Promise<{ state: 'none'|'ready'|'new-app'|'error', version?: string, message?: string }>}
 */
export async function checkForUpdate({
  data,
  appVersion,
  manifestUrl,
  publicKeyPem,
  fetchImpl = fetch,
  npmCi = null,
}) {
  try {
    if (!allowedAddress(manifestUrl))
      return { state: 'error', message: 'The update address is not safe.' };
    let manifest;
    try {
      manifest = JSON.parse(
        (
          await fetchCapped(manifestUrl, MAX_MANIFEST_BYTES, fetchImpl)
        ).toString('utf8'),
      );
    } catch {
      return { state: 'none', message: 'Could not reach the update page.' };
    }
    const shape = checkManifest(manifest, publicKeyPem);
    if (!shape.ok) return { state: 'error', message: shape.why };
    const app = path.join(data, 'app');
    const ready = path.join(data, 'app.new');
    if (compareVersions(manifest.version, readVersion(app)) <= 0)
      return { state: 'none' };
    if (compareVersions(manifest.minAppVersion, appVersion) > 0) {
      return {
        state: 'new-app',
        version: manifest.version,
        message: `Zenith ${manifest.version} needs the new app from the download page.`,
      };
    }
    if (readVersion(ready) === manifest.version)
      return { state: 'ready', version: manifest.version };

    const pack = await fetchCapped(manifest.url, manifest.size, fetchImpl);
    if (pack.length !== manifest.size || sha256(pack) !== manifest.sha256) {
      return {
        state: 'error',
        message:
          'The downloaded update does not match its description, so it was refused.',
      };
    }
    const entries = checkEntries(zipEntries(pack));
    if (!entries.ok) return { state: 'error', message: entries.why };

    const work = path.join(data, 'updates');
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    const zipFile = path.join(work, 'pack.zip');
    writeFileSync(zipFile, pack);
    execFileSync('/usr/bin/ditto', [
      '-x',
      '-k',
      zipFile,
      path.join(work, 'out'),
    ]);
    const code = path.join(work, 'out', 'Zenith');
    const link = findLink(code);
    if (link) {
      rmSync(work, { recursive: true, force: true });
      return {
        state: 'error',
        message: 'The update unpacked a link, so it was refused.',
      };
    }
    if (fileHash(path.join(code, 'package-lock.json')) !== manifest.lockHash) {
      rmSync(work, { recursive: true, force: true });
      return {
        state: 'error',
        message:
          'The update does not match its description, so it was refused.',
      };
    }
    // The packages only change when package-lock.json does; then they are installed fresh.
    if (
      fileHash(path.join(app, 'package-lock.json')) === manifest.lockHash &&
      existsSync(path.join(app, 'node_modules'))
    ) {
      cloneFolder(
        path.join(app, 'node_modules'),
        path.join(code, 'node_modules'),
      );
    } else if (npmCi) {
      await npmCi(code);
    } else {
      rmSync(work, { recursive: true, force: true });
      return {
        state: 'error',
        message: 'This update needs new packages and none could be installed.',
      };
    }
    writeFileSync(path.join(code, '.zenith-version'), manifest.version);
    rmSync(ready, { recursive: true, force: true });
    renameSync(code, ready);
    rmSync(work, { recursive: true, force: true });
    return { state: 'ready', version: manifest.version };
  } catch (error) {
    return {
      state: 'error',
      message: `The update could not be got ready (${error?.message ?? error}).`,
    };
  }
}

/** Carry the keys and the cache from one code folder to the next. */
function carryOver(from, to) {
  for (const name of ['.env', '.gev-cache']) {
    const source = path.join(from, name);
    if (!existsSync(source)) continue;
    rmSync(path.join(to, name), { recursive: true, force: true });
    renameSync(source, path.join(to, name));
  }
}

/**
 * Put a ready update (app.new) in place, keeping the old code as app.old.
 * @returns {{ state: 'applied'|'none', from?: string, to?: string }}
 */
export function applyUpdate(data) {
  const app = path.join(data, 'app');
  const ready = path.join(data, 'app.new');
  const old = path.join(data, 'app.old');
  if (!existsSync(path.join(ready, '.zenith-version')))
    return { state: 'none' };
  const from = readVersion(app);
  const to = readVersion(ready);
  rmSync(old, { recursive: true, force: true });
  if (existsSync(app)) renameSync(app, old);
  renameSync(ready, app);
  if (existsSync(old)) carryOver(old, app);
  return { state: 'applied', from, to };
}

/** The new code did not start: put the old code back. */
export function rollBack(data) {
  const app = path.join(data, 'app');
  const old = path.join(data, 'app.old');
  if (!existsSync(old)) return { state: 'none' };
  carryOver(app, old);
  rmSync(app, { recursive: true, force: true });
  renameSync(old, app);
  return { state: 'rolled-back', version: readVersion(app) };
}

/** The new code started: the old code is no longer needed. */
export function confirmUpdate(data) {
  rmSync(path.join(data, 'app.old'), { recursive: true, force: true });
  return { state: 'confirmed' };
}

/**
 * First open, or an app newer than the code installed: put the code that
 * came inside the app in place, the same careful way as an update.
 */
export function installFromBundle({ data, bundleCode, bundleVersion }) {
  const app = path.join(data, 'app');
  if (existsSync(app) && compareVersions(readVersion(app), bundleVersion) >= 0)
    return { state: 'none' };
  mkdirSync(data, { recursive: true });
  const ready = path.join(data, 'app.new');
  rmSync(ready, { recursive: true, force: true });
  cloneFolder(bundleCode, ready);
  writeFileSync(path.join(ready, '.zenith-version'), bundleVersion);
  return applyUpdate(data);
}

/** Copy the keys that came with Alon's own copy, only when there are none yet. */
export function placePrivateKeys({ data, keysFile }) {
  const target = path.join(data, 'app', '.env');
  if (!keysFile || !existsSync(keysFile) || existsSync(target))
    return { state: 'none' };
  cpSync(keysFile, target);
  execFileSync('/bin/chmod', ['600', target]);
  return { state: 'placed' };
}

async function main(argv) {
  const [command, ...rest] = argv;
  const option = (name) => {
    const at = rest.indexOf(`--${name}`);
    return at >= 0 ? rest[at + 1] : undefined;
  };
  const data = option('data');
  if (!data) throw new Error('--data is needed');
  let result;
  if (command === 'check') {
    const npm = option('npm');
    result = await checkForUpdate({
      data,
      appVersion: option('app-version'),
      manifestUrl: option('manifest-url'),
      publicKeyPem: readFileSync(option('public-key'), 'utf8'),
      npmCi: npm
        ? async (folder) =>
            execFileSync(
              process.execPath,
              [npm, 'ci', '--no-audit', '--no-fund'],
              {
                cwd: folder,
                env: { ...process.env, PUPPETEER_SKIP_DOWNLOAD: '1' },
                stdio: 'ignore',
              },
            )
        : null,
    });
  } else if (command === 'apply') result = applyUpdate(data);
  else if (command === 'rollback') result = rollBack(data);
  else if (command === 'confirm') result = confirmUpdate(data);
  else if (command === 'install') {
    result = installFromBundle({
      data,
      bundleCode: option('bundle-code'),
      bundleVersion: option('bundle-version'),
    });
  } else if (command === 'keys')
    result = placePrivateKeys({ data, keysFile: option('keys') });
  else throw new Error(`unknown command ${command}`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main(process.argv.slice(2)).catch((error) => {
    process.stdout.write(
      `${JSON.stringify({ state: 'error', message: String(error?.message ?? error) })}\n`,
    );
    process.exitCode = 1;
  });
}
