import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  allowedAddress,
  applyUpdate,
  checkEntries,
  checkForUpdate,
  checkManifest,
  compareVersions,
  confirmUpdate,
  installFromBundle,
  placePrivateKeys,
  rollBack,
  signManifest,
  zipEntries,
} from './appUpdate.mjs';

const keys = generateKeyPairSync('ed25519');
const PUBLIC = keys.publicKey.export({ type: 'spki', format: 'pem' });
const PRIVATE = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });
const other = generateKeyPairSync('ed25519').privateKey.export({
  type: 'pkcs8',
  format: 'pem',
});
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const LOCK = '{"lockfileVersion":3}';

/** A stored (uncompressed) zip, with links where asked: enough for these tests. */
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, body = '', link = false } of files) {
    const nameBytes = Buffer.from(name);
    const data = Buffer.from(body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(10, 4);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(10, 6);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(((link ? 0o120777 : 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** A code pack, made the way the release script makes it (ditto). */
function makePack(root, files) {
  const folder = path.join(root, 'pack-src', 'Zenith');
  rmSync(path.join(root, 'pack-src'), { recursive: true, force: true });
  mkdirSync(folder, { recursive: true });
  for (const [name, body] of Object.entries(files))
    writeFileSync(path.join(folder, name), body);
  const zip = path.join(root, 'pack.zip');
  rmSync(zip, { force: true });
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', folder, zip]);
  return readFileSync(zip);
}

function manifestFor(pack, fields = {}) {
  const manifest = {
    version: '1.2.1',
    url: 'https://github.com/AlonAI4/zenith/releases/download/v1.2.1/Zenith-code-1.2.1.zip',
    sha256: sha(pack),
    size: pack.length,
    lockHash: sha(LOCK),
    minAppVersion: '1.2',
    ...fields,
  };
  return {
    ...manifest,
    signature: signManifest(manifest, fields.key ?? PRIVATE),
  };
}

function serve(manifest, pack) {
  const asked = [];
  return {
    asked,
    fetchImpl: async (url) => {
      asked.push(url);
      if (url.endsWith('update.json'))
        return new Response(JSON.stringify(manifest));
      if (url === manifest.url) return new Response(pack);
      return new Response('missing', { status: 404 });
    },
  };
}

function installed(root, version = '1.2.0', lock = LOCK) {
  const data = path.join(root, 'data');
  const app = path.join(data, 'app');
  mkdirSync(path.join(app, 'node_modules', 'vite'), { recursive: true });
  mkdirSync(path.join(app, '.gev-cache'), { recursive: true });
  writeFileSync(path.join(app, '.zenith-version'), version);
  writeFileSync(path.join(app, 'package-lock.json'), lock);
  writeFileSync(path.join(app, 'node_modules', 'vite', 'index.js'), 'vite');
  writeFileSync(path.join(app, '.env'), 'KEY=secret');
  writeFileSync(path.join(app, '.gev-cache', 'tiles'), 'cache');
  writeFileSync(path.join(app, 'main.js'), 'old');
  return data;
}

const MANIFEST_URL =
  'https://github.com/AlonAI4/zenith/releases/latest/download/update.json';

test('versions compare number by number', () => {
  assert.equal(compareVersions('1.2.1', '1.2'), 1);
  assert.equal(compareVersions('1.2', '1.2.0'), 0);
  assert.equal(compareVersions('1.10', '1.9'), 1);
  assert.equal(compareVersions('0', '1.2'), -1);
});

test('only https, or this computer for tests', () => {
  assert.ok(allowedAddress('https://github.com/x'));
  assert.ok(allowedAddress('http://127.0.0.1:8123/update.json'));
  assert.ok(!allowedAddress('http://example.com/update.json'));
  assert.ok(!allowedAddress('file:///etc/passwd'));
  assert.ok(!allowedAddress('not a url'));
});

test('a description passes only with the right signature and a sane shape', () => {
  const pack = Buffer.from('pack');
  const good = manifestFor(pack);
  assert.deepEqual(checkManifest(good, PUBLIC), { ok: true });
  for (const [what, changed] of [
    ['a changed version', { ...good, version: '9.9.9' }],
    ['a changed hash', { ...good, sha256: sha(Buffer.from('other')) }],
    ['a changed address', { ...good, url: 'https://evil.example/x.zip' }],
    ['a signature from another key', manifestFor(pack, { key: other })],
    ['no signature', { ...good, signature: '' }],
    [
      'plain http elsewhere',
      manifestFor(pack, { url: 'http://evil.example/x.zip' }),
    ],
    ['a silly size', manifestFor(pack, { size: 10 ** 12 })],
    ['a strange version', manifestFor(pack, { version: '1.2; rm -rf' })],
  ]) {
    assert.equal(checkManifest(changed, PUBLIC).ok, false, what);
  }
});

test('zip entries that climb out, sit outside Zenith/ or are links are refused', () => {
  const fine = makeZip([
    { name: 'Zenith/' },
    { name: 'Zenith/main.js', body: 'x' },
  ]);
  assert.deepEqual(checkEntries(zipEntries(fine)), { ok: true });
  for (const [what, files] of [
    ['../', [{ name: 'Zenith/../../evil.sh', body: 'x' }]],
    ['absolute', [{ name: '/etc/evil', body: 'x' }]],
    ['outside', [{ name: 'Other/main.js', body: 'x' }]],
    ['link', [{ name: 'Zenith/home', body: '/Users', link: true }]],
    ['backslash', [{ name: 'Zenith\\..\\evil', body: 'x' }]],
  ]) {
    assert.equal(checkEntries(zipEntries(makeZip(files))).ok, false, what);
  }
  assert.throws(() => zipEntries(Buffer.from('not a zip at all, sorry')));
});

test('an update is checked, got ready in app.new, applied, confirmed; keys and cache come along', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'zenith-update-'));
  try {
    const data = installed(root);
    const pack = makePack(root, {
      'main.js': 'new',
      'package-lock.json': LOCK,
    });
    const manifest = manifestFor(pack);
    const { fetchImpl, asked } = serve(manifest, pack);
    const result = await checkForUpdate({
      data,
      appVersion: '1.2',
      manifestUrl: MANIFEST_URL,
      publicKeyPem: PUBLIC,
      fetchImpl,
    });
    assert.deepEqual(result, { state: 'ready', version: '1.2.1' });
    assert.deepEqual(asked, [MANIFEST_URL, manifest.url]);
    assert.equal(
      readFileSync(path.join(data, 'app.new', 'main.js'), 'utf8'),
      'new',
    );
    assert.equal(
      readFileSync(
        path.join(data, 'app.new', 'node_modules', 'vite', 'index.js'),
        'utf8',
      ),
      'vite',
      'the packages are reused',
    );
    assert.equal(
      readFileSync(path.join(data, 'app', 'main.js'), 'utf8'),
      'old',
      'nothing changes before the next start',
    );

    // Asked again: already ready, nothing downloaded twice.
    const again = serve(manifest, pack);
    assert.equal(
      (
        await checkForUpdate({
          data,
          appVersion: '1.2',
          manifestUrl: MANIFEST_URL,
          publicKeyPem: PUBLIC,
          fetchImpl: again.fetchImpl,
        })
      ).state,
      'ready',
    );
    assert.deepEqual(again.asked, [MANIFEST_URL]);

    assert.deepEqual(applyUpdate(data), {
      state: 'applied',
      from: '1.2.0',
      to: '1.2.1',
    });
    assert.equal(
      readFileSync(path.join(data, 'app', 'main.js'), 'utf8'),
      'new',
    );
    assert.equal(
      readFileSync(path.join(data, 'app', '.env'), 'utf8'),
      'KEY=secret',
    );
    assert.equal(
      readFileSync(path.join(data, 'app', '.gev-cache', 'tiles'), 'utf8'),
      'cache',
    );
    assert.ok(
      existsSync(path.join(data, 'app.old', 'main.js')),
      'the old code stays until the new one starts',
    );
    confirmUpdate(data);
    assert.ok(!existsSync(path.join(data, 'app.old')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('if the new code does not start, the old code and the keys go back', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'zenith-update-'));
  try {
    const data = installed(root);
    const pack = makePack(root, {
      'main.js': 'broken',
      'package-lock.json': LOCK,
    });
    const manifest = manifestFor(pack);
    await checkForUpdate({
      data,
      appVersion: '1.2',
      manifestUrl: MANIFEST_URL,
      publicKeyPem: PUBLIC,
      fetchImpl: serve(manifest, pack).fetchImpl,
    });
    applyUpdate(data);
    assert.deepEqual(rollBack(data), {
      state: 'rolled-back',
      version: '1.2.0',
    });
    assert.equal(
      readFileSync(path.join(data, 'app', 'main.js'), 'utf8'),
      'old',
    );
    assert.equal(
      readFileSync(path.join(data, 'app', '.env'), 'utf8'),
      'KEY=secret',
    );
    assert.ok(!existsSync(path.join(data, 'app.old')));
    // The version that would not start is not downloaded again.
    const again = serve(manifest, pack);
    const skipped = await checkForUpdate({
      data,
      appVersion: '1.2',
      manifestUrl: MANIFEST_URL,
      publicKeyPem: PUBLIC,
      fetchImpl: again.fetchImpl,
    });
    assert.equal(skipped.state, 'none');
    assert.deepEqual(again.asked, [MANIFEST_URL]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a pack with one byte changed, an older version, or a wrong signature changes nothing', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'zenith-update-'));
  try {
    const data = installed(root);
    const pack = makePack(root, {
      'main.js': 'new',
      'package-lock.json': LOCK,
    });
    const tampered = Buffer.from(pack);
    tampered[40] ^= 1;
    const manifest = manifestFor(pack);
    const run = (fetchImpl, appVersion = '1.2') =>
      checkForUpdate({
        data,
        appVersion,
        manifestUrl: MANIFEST_URL,
        publicKeyPem: PUBLIC,
        fetchImpl,
      });

    assert.equal(
      (await run(serve(manifest, tampered).fetchImpl)).state,
      'error',
    );
    assert.equal(
      (
        await run(
          serve(manifestFor(pack, { version: '1.2.0' }), pack).fetchImpl,
        )
      ).state,
      'none',
    );
    assert.equal(
      (
        await run(
          serve(manifestFor(pack, { version: '1.1.9' }), pack).fetchImpl,
        )
      ).state,
      'none',
    );
    assert.equal(
      (await run(serve(manifestFor(pack, { key: other }), pack).fetchImpl))
        .state,
      'error',
    );
    assert.equal(
      (
        await run(
          serve(manifestFor(pack, { minAppVersion: '2.0' }), pack).fetchImpl,
        )
      ).state,
      'new-app',
    );
    assert.ok(!existsSync(path.join(data, 'app.new')), 'nothing was got ready');
    assert.equal(
      readFileSync(path.join(data, 'app', 'main.js'), 'utf8'),
      'old',
    );
    assert.equal(
      (await run(async () => new Response('nope', { status: 500 }))).state,
      'none',
      'no answer is not an error',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('new packages are installed only when package-lock.json changed', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'zenith-update-'));
  try {
    const data = installed(root);
    const lock = '{"lockfileVersion":3,"new":true}';
    const pack = makePack(root, {
      'main.js': 'new',
      'package-lock.json': lock,
    });
    const manifest = manifestFor(pack, { lockHash: sha(lock) });
    const run = (npmCi) =>
      checkForUpdate({
        data,
        appVersion: '1.2',
        manifestUrl: MANIFEST_URL,
        publicKeyPem: PUBLIC,
        fetchImpl: serve(manifest, pack).fetchImpl,
        npmCi,
      });
    assert.equal((await run(null)).state, 'error');
    const installedIn = [];
    assert.equal(
      (
        await run(async (folder) => {
          installedIn.push(path.basename(folder));
          mkdirSync(path.join(folder, 'node_modules'));
        })
      ).state,
      'ready',
    );
    assert.deepEqual(installedIn, ['Zenith']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('first open puts the code that came inside the app in place; the private keys only once', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'zenith-update-'));
  try {
    const bundle = path.join(root, 'bundle', 'zenith');
    mkdirSync(bundle, { recursive: true });
    writeFileSync(path.join(bundle, 'main.js'), 'bundled');
    const data = path.join(root, 'data');
    assert.equal(
      installFromBundle({ data, bundleCode: bundle, bundleVersion: '1.2' })
        .state,
      'applied',
    );
    assert.equal(
      readFileSync(path.join(data, 'app', 'main.js'), 'utf8'),
      'bundled',
    );
    assert.equal(
      installFromBundle({ data, bundleCode: bundle, bundleVersion: '1.2' })
        .state,
      'none',
    );

    const keysFile = path.join(root, 'keys.env');
    writeFileSync(keysFile, 'KEY=mine');
    assert.equal(placePrivateKeys({ data, keysFile }).state, 'placed');
    assert.equal(statSync(path.join(data, 'app', '.env')).mode & 0o777, 0o600);
    writeFileSync(keysFile, 'KEY=other');
    assert.equal(
      placePrivateKeys({ data, keysFile }).state,
      'none',
      'keys already there are never replaced',
    );
    assert.equal(
      readFileSync(path.join(data, 'app', '.env'), 'utf8'),
      'KEY=mine',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
