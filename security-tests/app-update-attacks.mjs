// Attacks on the Mac app's self-updater (server/alon/appUpdate.mjs) and its
// launcher (alon-app/launcher.sh), in throwaway folders with a test key pair.
// Usage: node security-tests/app-update-attacks.mjs
// It never reads the real signing key or .env, never touches
// ~/Library/Application Support/Zenith and never downloads anything.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { allowedAddress, checkForUpdate, checkManifest, signManifest } from '../server/alon/appUpdate.mjs';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const check = (ok, text) => {
  console.log(`${ok ? '✓' : '✗'} ${text}`);
  if (!ok) failures.push(text);
};
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const pem = (key, type) => key.export({ type, format: 'pem' });
const author = generateKeyPairSync('ed25519');
const PUBLIC = pem(author.publicKey, 'spki');
const PRIVATE = pem(author.privateKey, 'pkcs8');
const STRANGER = pem(generateKeyPairSync('ed25519').privateKey, 'pkcs8');
const LOCK = '{"lockfileVersion":3}';
const URL_PACK = 'https://github.com/AlonAI4/zenith/releases/download/v9.0/Zenith-code-9.0.zip';
const URL_MANIFEST = 'https://github.com/AlonAI4/zenith/releases/latest/download/update.json';
const top = realpathSync(mkdtempSync(path.join(tmpdir(), 'zenith-update-attacks-')));

/** A zip written by hand, so names, links and the "made by" system can lie. */
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, local = name, body = '', link = false, madeBy = 3 } of files) {
    const nameBytes = Buffer.from(name);
    const localBytes = Buffer.from(local);
    const data = Buffer.from(body);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(10, 4);
    head.writeUInt32LE(data.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(localBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((madeBy << 8) | 20, 4);
    central.writeUInt16LE(10, 6);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(((link ? 0o120777 : 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(head, localBytes, data);
    centrals.push(central, nameBytes);
    offset += 30 + localBytes.length + data.length;
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

/** A good pack, made with ditto the way alon-release.sh makes it. */
function goodPack(dir) {
  const code = path.join(dir, 'src', 'Zenith');
  mkdirSync(code, { recursive: true });
  writeFileSync(path.join(code, 'package-lock.json'), LOCK);
  writeFileSync(path.join(code, 'index.html'), '<title>Zenith</title>');
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', code, path.join(dir, 'pack.zip')]);
  return readFileSync(path.join(dir, 'pack.zip'));
}

function manifestFor(pack, fields = {}, key = PRIVATE) {
  const manifest = { version: '9.0', url: URL_PACK, sha256: sha(pack), size: pack.length, lockHash: sha(LOCK), minAppVersion: '1.2', ...fields };
  return { ...manifest, signature: signManifest(manifest, key) };
}

let caseNumber = 0;
/** A fresh installed copy (version 1.2.0 with keys), plus a folder next to it nothing may write to. */
function installed(version = '1.2.0') {
  const root = path.join(top, `case-${++caseNumber}`);
  const data = path.join(root, 'data');
  const app = path.join(data, 'app');
  mkdirSync(path.join(app, 'node_modules', 'vite'), { recursive: true });
  mkdirSync(path.join(root, 'outside'), { recursive: true });
  writeFileSync(path.join(app, '.zenith-version'), version);
  writeFileSync(path.join(app, 'package-lock.json'), LOCK);
  writeFileSync(path.join(app, '.env'), 'FAKE_TEST_KEY=not-real');
  return { root, data, app };
}

/** Run one update check against a fake GitHub, and say what changed. */
async function attempt({ manifest, pack, version, manifestUrl = URL_MANIFEST, served = {} }) {
  const place = installed(version);
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(String(url));
    if (String(url) === manifestUrl) return new Response(typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
    if (served[url]) return new Response(served[url]);
    if (manifest && String(url) === manifest.url) return new Response(pack);
    return new Response('missing', { status: 404 });
  };
  const result = await checkForUpdate({ data: place.data, appVersion: '1.2', manifestUrl, publicKeyPem: PUBLIC, fetchImpl });
  const untouched =
    readFileSync(path.join(place.app, '.zenith-version'), 'utf8') === (version ?? '1.2.0') &&
    existsSync(path.join(place.app, '.env')) &&
    readdirSync(path.join(place.root, 'outside')).length === 0 &&
    readdirSync(place.root).sort().join() === 'data,outside';
  return { result, asked, ready: existsSync(path.join(place.data, 'app.new')), untouched, place };
}

const work = path.join(top, 'pack');
mkdirSync(work);
const pack = goodPack(work);

// Control: a real, signed, newer update is accepted, so the refusals below mean something.
let run = await attempt({ manifest: manifestFor(pack), pack });
check(run.result.state === 'ready' && run.ready, `control: a correctly signed newer update is accepted (${run.result.state})`);

const refused = (label, run, { fetched = null } = {}) => {
  const fetchedOk = fetched === null || run.asked.length === fetched;
  check(run.result.state !== 'ready' && !run.ready && run.untouched && fetchedOk,
    `${label}: refused, installed copy untouched (${run.result.state}${run.result.message ? `: ${run.result.message.split('\n')[0].slice(0, 90)}` : ''})`);
};

// Tampering.
const tampered = Buffer.from(pack);
tampered[tampered.length - 30] ^= 0xff;
refused('a tampered pack (one byte changed)', await attempt({ manifest: manifestFor(pack), pack: tampered }));
refused('a pack with extra bytes on the end', await attempt({ manifest: manifestFor(pack), pack: Buffer.concat([pack, Buffer.alloc(10)]) }));
const signed = manifestFor(pack);
for (const [field, value] of [['version', '99.0'], ['url', 'https://evil.example/pack.zip'], ['sha256', sha(Buffer.from('evil'))], ['size', pack.length + 1], ['lockHash', sha('evil')], ['minAppVersion', '0.1']]) {
  refused(`a signed description with ${field} changed afterwards`, await attempt({ manifest: { ...signed, [field]: value }, pack }));
}
refused('a description signed with another key', await attempt({ manifest: manifestFor(pack, {}, STRANGER), pack }));
refused('a description with no signature', await attempt({ manifest: { ...signed, signature: undefined }, pack }));
refused('the signature of an old update stuck on new fields', await attempt({ manifest: { ...manifestFor(pack, { version: '9.1' }), signature: manifestFor(pack, { version: '1.1' }).signature }, pack }));
refused('a description that is not JSON', await attempt({ manifest: 'not json', pack }));
refused('size given as text', await attempt({ manifest: manifestFor(pack, { size: String(pack.length) }), pack }));

// Downgrade and replay of real, correctly signed old descriptions.
refused('replay of an older signed update (1.1 onto 1.2.0)', await attempt({ manifest: manifestFor(pack, { version: '1.1' }), pack }), { fetched: 1 });
refused('replay of the same version (1.2.0 onto 1.2.0)', await attempt({ manifest: manifestFor(pack, { version: '1.2.0' }), pack }), { fetched: 1 });
refused('replay of "1.2" onto 1.2.0 (same number, other spelling)', await attempt({ manifest: manifestFor(pack, { version: '1.2' }), pack }), { fetched: 1 });
{
  const place = installed();
  writeFileSync(path.join(place.data, 'failed-version'), '9.0');
  const result = await checkForUpdate({ data: place.data, appVersion: '1.2', manifestUrl: URL_MANIFEST, publicKeyPem: PUBLIC, fetchImpl: async () => new Response(JSON.stringify(manifestFor(pack))) });
  check(result.state === 'none' && !existsSync(path.join(place.data, 'app.new')), 'a version that already failed to start is not tried again');
}

// Addresses.
for (const url of ['http://evil.example/update.json', 'file:///etc/passwd', 'http://localhost.evil.example/u.json', 'http://127.0.0.1.nip.io/u.json', 'http://0.0.0.0/u.json', 'ftp://evil.example/u.json', 'javascript:alert(1)', '']) {
  check(!allowedAddress(url), `update address ${JSON.stringify(url)} is not allowed`);
  refused(`an update description at ${JSON.stringify(url)}`, await attempt({ manifest: manifestFor(pack), pack, manifestUrl: url }), { fetched: 0 });
}
for (const url of ['http://evil.example/pack.zip', 'file:///Users/alon/pack.zip']) {
  check(!checkManifest(manifestFor(pack, { url }), PUBLIC).ok, `even a signed description cannot point the pack at ${url}`);
}
// ZENITH_UPDATE_URL pointed at a server on this Mac: it still needs the author's signature.
refused('a loopback update server (ZENITH_UPDATE_URL) with a stranger-signed description',
  await attempt({ manifestUrl: 'http://127.0.0.1:9/update.json', manifest: manifestFor(pack, {}, STRANGER), pack }));

// Bad packs, each correctly signed (as if the signing key or the build were attacked):
// the path and link checks must still stop them.
const lockEntry = { name: 'Zenith/package-lock.json', body: LOCK };
const badPacks = [
  ['a ../ path', [lockEntry, { name: 'Zenith/../../outside/evil.txt', body: 'x' }]],
  ['a path outside Zenith/', [lockEntry, { name: 'outside/evil.txt', body: 'x' }]],
  ['an absolute path', [lockEntry, { name: '/tmp/zenith-evil.txt', body: 'x' }]],
  ['a backslash path', [lockEntry, { name: 'Zenith\\..\\..\\evil.txt', body: 'x' }]],
  ['a symlink (Unix zip)', [lockEntry, { name: 'Zenith/link', body: '/etc', link: true }]],
  ['a symlink marked as made on macOS', [lockEntry, { name: 'Zenith/link', body: '/etc', link: true, madeBy: 19 }]],
  ['a symlink then a file written through it', [lockEntry, { name: 'Zenith/d', body: '../../../outside', link: true, madeBy: 19 }, { name: 'Zenith/d/evil.txt', body: 'x' }]],
  ['an empty pack', []],
];
for (const [label, files] of badPacks) {
  const zip = makeZip(files);
  const run = await attempt({ manifest: manifestFor(zip), pack: zip });
  refused(`a signed pack with ${label}`, run);
}
// ditto unpacks by the name in each file's own (local) header, which the
// check above does not read. These must still land nowhere but the update folder.
for (const [label, local] of [['../', '../../../outside/evil.txt'], ['absolute', '/tmp/zenith-evil-abs.txt']]) {
  const zip = makeZip([lockEntry, { name: 'Zenith/ok.txt', local, body: 'x' }]);
  const run = await attempt({ manifest: manifestFor(zip), pack: zip });
  const extra = run.ready ? readdirSync(path.join(run.place.data, 'app.new')).filter((name) => !['package-lock.json', 'ok.txt', '.zenith-version', 'node_modules'].includes(name)) : [];
  check(run.untouched && extra.length === 0, `a signed pack whose local header name is ${label} writes nothing outside the update (${run.result.state})`);
}
check(!existsSync('/tmp/zenith-evil.txt') && !existsSync('/tmp/zenith-evil-abs.txt'), 'nothing was written to /tmp by any bad pack');

// The launcher: Stop must only stop Zenith's own server, never another program
// whose number happens to be in a stale server.pid (after a crash or restart).
{
  const home = path.join(top, 'home');
  const resources = path.join(top, 'Zenith.app', 'Contents', 'Resources');
  mkdirSync(path.join(resources, 'node'), { recursive: true });
  copyFileSync(path.join(repo, 'alon-app', 'launcher.sh'), path.join(resources, 'launcher.sh'));
  writeFileSync(path.join(resources, 'version.txt'), '1.2');
  writeFileSync(path.join(resources, 'node', 'version.txt'), 'v0-test');
  const data = path.join(home, 'Library', 'Application Support', 'Zenith');
  mkdirSync(data, { recursive: true });
  const victim = spawn('/bin/sleep', ['60'], { stdio: 'ignore' });
  writeFileSync(path.join(data, 'server.pid'), String(victim.pid));
  spawnSync('/bin/zsh', [path.join(resources, 'launcher.sh'), 'stop'], { env: { PATH: process.env.PATH, HOME: home }, stdio: 'ignore', timeout: 30_000 });
  // A killed child stays a zombie until Node reaps it, so wait for its exit event.
  const ended = await new Promise((resolve) => {
    if (victim.exitCode !== null || victim.signalCode !== null) return resolve(true);
    victim.once('exit', () => resolve(true));
    setTimeout(() => resolve(false), 1500);
  });
  check(!ended, 'launcher.sh stop leaves alone a program that is not Zenith (stale server.pid)');
  victim.kill();
  const launcher = readFileSync(path.join(repo, 'alon-app', 'launcher.sh'), 'utf8');
  check(/--host 127\.0\.0\.1/.test(launcher) && !/--host 0\.0\.0\.0/.test(launcher), 'the launcher binds the server to 127.0.0.1 only');
  check(!/ZENITH_UPDATE_URL=/.test(launcher.replace(/^#.*$/gm, '')), 'the launcher never sets ZENITH_UPDATE_URL itself');
}

// The private keys file: only in Alon's own copy, never in git or a public file.
{
  const tracked = execFileSync('git', ['-C', repo, 'ls-files'], { maxBuffer: 64e6 }).toString().split('\n');
  check(!tracked.some((name) => /(^|\/)(alon-private\.env|\.env)$/.test(name) || /private\.zip$/.test(name)), 'no .env, alon-private.env or private zip is in git');
  check(!tracked.some((name) => /update-signing-key/.test(name)), 'the update signing key is not in git');
  const ignored = spawnSync('git', ['-C', repo, 'check-ignore', '-q', '.gev-cache/release/x/out/Zenith-Alon-private.zip']).status === 0;
  check(ignored, 'release output (with the private zip) is ignored by git');
  const release = path.join(repo, '.gev-cache', 'release');
  for (const version of existsSync(release) ? readdirSync(release) : []) {
    const out = path.join(release, version, 'out');
    for (const file of existsSync(out) ? readdirSync(out) : []) {
      if (!file.endsWith('.zip') || file.includes('private')) continue;
      const names = execFileSync('zipinfo', ['-1', path.join(out, file)], { maxBuffer: 64e6 }).toString().split('\n');
      check(!names.some((name) => /(^|\/)(\.env|alon-private\.env)$/.test(name)), `public ${version}/${file} holds no .env or alon-private.env`);
    }
  }
  const publicPem = readFileSync(path.join(repo, 'alon-app', 'update-public-key.pem'), 'utf8');
  check(/BEGIN PUBLIC KEY/.test(publicPem) && !/PRIVATE/.test(publicPem), 'the key built into the app is a public key only');
}

rmSync(top, { recursive: true, force: true });
console.log(failures.length ? `\n${failures.length} check(s) failed.` : '\nAll update and launcher attacks were stopped.');
process.exit(failures.length ? 1 : 0);
