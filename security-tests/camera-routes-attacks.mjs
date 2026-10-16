// Attacks on the camera routes (/api/alon/cctv/*) and on what the server
// hands out, against a real Vite server started here on a random port.
// Usage: node security-tests/camera-routes-attacks.mjs
// It never uses port 4173, never reads .env and never sends anything out:
// every request goes to 127.0.0.1, and no route that would call a camera
// network is asked.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'zenith-camera-attacks-')));
const photos = path.join(root, 'photo-store');
mkdirSync(photos, { recursive: true });
// Set before the plugins are made: the photo store reads it once.
process.env.ZENITH_PHOTOS_DIR = photos;

const { createServer } = await import('vite');
const { localProviderPlugins } = await import('../server/providers/local.js');
const { apiNotFoundPlugin } = await import('../server/standalone/api-not-found.js');
const { createBrowserViteConfig } = await import('../build/vite.js');
const { hostCheckPlugin } = await import('../build/allowedHosts.js');

const failures = [];
const check = (ok, text) => {
  console.log(`${ok ? '✓' : '✗'} ${text}`);
  if (!ok) failures.push(text);
};

/** One raw HTTP request, so Host and every other header are exactly as written. */
function ask(port, { method = 'GET', path: target, headers = {}, body }) {
  return new Promise((resolve) => {
    const req = request(
      { host: '127.0.0.1', port, method, path: target, headers: { host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', (error) => resolve({ status: 0, error: error.code || error.message, text: '' }));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

// The real settings the app's server uses (Host check first, fs.deny, headers),
// on a test folder instead of the project, the way previewServing.test.mjs does.
const real = createBrowserViteConfig({});
check(real.plugins[0]?.name === 'host-check', "the app's Vite settings put the Host check first");

writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>Zenith</title>');
// The server hands out files under the project folder, so Alon's private copy
// must never be built there: alon-release.sh builds in ~/Library/Caches.
const release = readFileSync('alon-release.sh', 'utf8');
check(/RELEASES="\$HOME\/Library\/Caches\/Zenith-release"/.test(release) && /REL="\$RELEASES\/\$VERSION"/.test(release), 'releases, and the private copy with the keys, are built outside the project');
check(/rm -rf "\$REL\/work\/Zenith-private\.app"/.test(release), "the private app's working copy with the keys is deleted after packing");
const leftovers = execFileSync('/usr/bin/find', ['.', '-path', './node_modules', '-prune', '-o', '(', '-name', 'alon-private.env', '-o', '-name', 'Zenith-Alon-private.zip', ')', '-print']).toString().trim();
check(leftovers === '', `no private keys file or private zip inside the project${leftovers ? `: ${leftovers}` : ''}`);
for (const [file, body] of [['.env', 'FAKE_TEST_KEY=not-a-real-key-123456']]) {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), body);
}
// A photo that is really in the list, a file beside the folder, and a list entry that tries to climb out.
const goodPhoto = '1700000000000-0a1b2c3d.jpg';
writeFileSync(path.join(photos, goodPhoto), 'jpeg-bytes');
writeFileSync(path.join(root, 'secret.txt'), 'outside the photos folder');
writeFileSync(path.join(photos, '1700000000001-ffffffff.jpg'), 'not in the list');
writeFileSync(
  path.join(photos, 'photos.json'),
  JSON.stringify([
    { file: goodPhoto, cameraId: 'x', time: 1700000000000, bytes: 10 },
    { file: '../secret.txt', cameraId: 'x', time: 1, bytes: 1 },
  ]),
);

const server = await createServer({
  root,
  configFile: false,
  envFile: false,
  publicDir: false,
  logLevel: 'silent',
  plugins: [hostCheckPlugin(), ...localProviderPlugins(), apiNotFoundPlugin()],
  server: { ...real.server, host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
});

try {
  await server.listen();
  const port = server.httpServer.address().port;
  check(port !== 4173, `the test server is on its own port (${port}), not 4173`);
  const self = `http://127.0.0.1:${port}`;
  const sameOrigin = { origin: self, 'sec-fetch-site': 'same-origin' };
  const json = { 'content-type': 'application/json' };
  const API = '/api/alon/cctv';

  // Control: the app itself gets in, so the refusals below mean something.
  let r = await ask(port, { path: `${API}/photos`, headers: sameOrigin });
  check(r.status === 200 && r.text.includes(goodPhoto), 'control: the app itself can list its photos');
  check(!r.text.includes('secret.txt'), 'a list entry that climbs out of the folder is dropped from the list');

  // Cross-site POST and DELETE, in every shape a browser can send them.
  const crossSite = [
    ['a modern browser (foreign Origin + Sec-Fetch-Site: cross-site)', { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }],
    ['an older browser (foreign Origin only)', { origin: 'https://evil.example' }],
    ['a sandboxed frame (Origin: null)', { origin: 'null' }],
    ['another page on this Mac (http://localhost:5173, same-site)', { origin: 'http://localhost:5173', 'sec-fetch-site': 'same-site' }],
    ['a form with no Origin but Sec-Fetch-Site: cross-site', { 'sec-fetch-site': 'cross-site' }],
    ['a request through a proxy (X-Forwarded-For)', { 'x-forwarded-for': '203.0.113.9' }],
  ];
  for (const [label, headers] of crossSite) {
    r = await ask(port, { method: 'POST', path: `${API}/photos`, headers: { ...headers, ...json }, body: '{"cameraId":"fi-c1234567"}' });
    check(r.status === 403, `cross-site POST /photos refused: ${label} (${r.status})`);
    r = await ask(port, { method: 'DELETE', path: `${API}/photos/${goodPhoto}`, headers });
    check(r.status === 403, `cross-site DELETE refused: ${label} (${r.status})`);
  }
  check(existsSync(path.join(photos, goodPhoto)), 'the photo is still there after every cross-site DELETE');
  r = await ask(port, { path: `${API}/photos/${goodPhoto}`, headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } });
  check(r.status === 403, `a cross-site page cannot read a photo (${r.status})`);

  // DNS rebinding: evil.example now points at 127.0.0.1, so the browser
  // sends Host: evil.example and an Origin that matches it.
  for (const target of [`${API}/photos`, '/', '/index.html']) {
    r = await ask(port, { path: target, headers: { host: `evil.example:${port}`, origin: `http://evil.example:${port}`, 'sec-fetch-site': 'same-origin' } });
    check(r.status === 403, `a forged Host (DNS rebinding) is refused on ${target} (${r.status})`);
  }
  r = await ask(port, { method: 'POST', path: `${API}/photos`, headers: { host: `evil.example:${port}`, origin: `http://evil.example:${port}`, ...json }, body: '{"cameraId":"x"}' });
  check(r.status === 403, `a rebinding POST is refused (${r.status})`);
  r = await ask(port, { path: `${API}/photos`, headers: { host: `localhost.evil.example:${port}` } });
  check(r.status === 403, `Host localhost.evil.example is refused (${r.status})`);

  // Path tricks in camera ids and photo names (same-origin, so only the checks stop them).
  for (const name of ['..%2F..%2Fsecret.txt', '..%2Fsecret.txt', '%2E%2E%2Fsecret.txt', 'photos.json', '..', '%00', '1700000000000-0a1b2c3d.jpg%2F..%2F..%2Fsecret.txt', '1700000000001-ffffffff.jpg']) {
    r = await ask(port, { path: `${API}/photos/${name}`, headers: sameOrigin });
    check(r.status === 404 && !r.text.includes('outside the photos folder') && !r.text.includes('not in the list'), `photo name "${name}" reads nothing (${r.status})`);
    r = await ask(port, { method: 'DELETE', path: `${API}/photos/${name}`, headers: sameOrigin });
    check(r.status === 404, `photo name "${name}" deletes nothing (${r.status})`);
  }
  check(existsSync(path.join(root, 'secret.txt')) && existsSync(path.join(photos, '1700000000001-ffffffff.jpg')) && existsSync(path.join(photos, 'photos.json')),
    'no file outside the list was deleted');
  for (const id of ['../../etc/passwd', '..%2F..%2Fx', 'a/b', 'x\u0000y', 'x'.repeat(121), 'https://evil.example/x.jpg']) {
    r = await ask(port, { method: 'POST', path: `${API}/photos`, headers: { ...sameOrigin, ...json }, body: JSON.stringify({ cameraId: id }) });
    check(r.status === 403, `camera id ${JSON.stringify(id.slice(0, 30))} is refused (${r.status})`);
  }
  for (const target of [`${API}/history/..%2F..%2Fetc`, `${API}/history/fi-c1234567%2F..%2F..%2Fx/frame?key=aaaaaaaa`, `${API}/history/fi-c12%3F/frame?key=..%2F..%2F..%2Fx`]) {
    r = await ask(port, { path: target, headers: sameOrigin });
    check(r.status === 200 ? r.text === '{"frames":[]}' : r.status === 404, `history path trick answers nothing (${target.slice(API.length)} → ${r.status})`);
  }
  r = await ask(port, { path: `${API}/history/%E0%A4%A`, headers: sameOrigin });
  check(r.status === 400, `a broken %-escape is refused, not a crash (${r.status})`);
  const { historyFrameUrl } = await import('../server/alon/cctvExtras.js');
  const frameUrls = [
    historyFrameUrl('fi-c1234567', '../../../x/../../y'),
    historyFrameUrl('fi-c1234567', 'aaaaaaaa@evil.example'),
    historyFrameUrl('drivebc-12', '20240101000000/../../x'),
    historyFrameUrl('ca-d3-x', '13', { district: '3', cam: 'x' }),
    historyFrameUrl('fi-c1234567\nhttps://evil.example', 'aaaaaaaa'),
  ];
  check(frameUrls.every((url) => url === null), 'older-picture keys with path or host tricks build no address');

  // Oversized and malformed bodies.
  r = await ask(port, { method: 'POST', path: `${API}/photos`, headers: { ...sameOrigin, ...json }, body: JSON.stringify({ cameraId: 'x', pad: 'a'.repeat(5 * 1024 * 1024) }) });
  check(r.status === 400 || r.status === 0, `a 5 MB body is refused (${r.status || r.error})`);
  r = await ask(port, { method: 'POST', path: `${API}/photos`, headers: { ...sameOrigin, 'content-type': 'text/plain' }, body: '{"cameraId":"x"}' });
  check(r.status === 400, `a text/plain (form-style) body is refused (${r.status})`);
  r = await ask(port, { method: 'POST', path: `${API}/photos`, headers: { ...sameOrigin, ...json }, body: '{"cameraId":{"length":1}}' });
  check(r.status === 400, `a camera id that is not text is refused (${r.status})`);
  r = await ask(port, { path: `${API}/photos`, headers: sameOrigin });
  check(r.status === 200, 'the server still answers after the oversized body');

  // Files the server must never hand out, even to a page on another localhost port
  // (Vite lets localhost origins read its answers).
  for (const [file, label] of [
    ['.env', 'the .env file'],
  ]) {
    r = await ask(port, { path: `/${file}`, headers: { origin: 'http://localhost:5173' } });
    const cors = r.headers?.['access-control-allow-origin'] ? ', readable by that page: CORS allows it' : '';
    check(!(r.status === 200 && r.text.includes(file.endsWith('.zip') ? 'PK-fake' : 'FAKE_TEST_KEY')), `the server does not hand out ${label} (${r.status}${r.status === 200 ? cors : ''})`);
  }
} finally {
  await server.close();
  rmSync(root, { recursive: true, force: true });
}

console.log(failures.length ? `\n${failures.length} check(s) failed.` : '\nAll camera-route attacks were stopped.');
process.exit(failures.length ? 1 : 0);
