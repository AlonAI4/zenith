import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { cctvExtrasHandler } from './cctvExtras.js';
import { createPhotoStore, photoFileName, photoPermission } from './cctvPhotos.js';

const CAMERAS = [
  { id: 'tfl-00001.01251', pack: 'tfl', name: 'Tower Bridge', city: 'London', lat: 51.5, lon: -0.07, url: 'https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/00001.01251.jpg', feedType: 'image' },
  { id: 'txdot-1', pack: 'txdot', name: 'I-35', city: 'Austin', url: 'https://its.txdot.gov/x.jpg', feedType: 'image' },
  { id: 'vegvesen-9', pack: 'vegvesen', name: 'E6', city: 'Oslo', url: 'https://kamera.vegvesen.no/x.m3u8', feedType: 'hls' },
];
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);

function setUp({ limits, picture = JPEG, type = 'image/jpeg' } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'zenith-photos-'));
  let clock = Date.UTC(2026, 9, 16, 12, 0, 0);
  const fetched = [];
  const store = createPhotoStore({
    dir,
    listCameras: async () => CAMERAS,
    now: () => (clock += 1000),
    limits,
    fetchImpl: async (url) => {
      fetched.push(url);
      return new Response(picture, { headers: { 'content-type': type } });
    },
  });
  return { dir, store, fetched, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('only cameras whose network allows copies, and only pictures, not video', () => {
  assert.deepEqual(photoPermission(CAMERAS[0]), { allowed: true, why: '' });
  assert.match(photoPermission(CAMERAS[1]).why, /terms do not say copies may be saved/);
  assert.match(photoPermission(CAMERAS[2]).why, /not video/);
  assert.match(photoPermission(null).why, /not in the list/);
});

test('a photo is fetched from the camera itself, saved under its own name, and listed newest first', async () => {
  const { dir, store, fetched, done } = setUp();
  try {
    const first = await store.take('tfl-00001.01251');
    const second = await store.take('tfl-00001.01251');
    assert.equal(first.status, 200);
    assert.deepEqual(fetched, [CAMERAS[0].url, CAMERAS[0].url]);
    assert.ok(photoFileName(first.photo.file), first.photo.file);
    assert.equal(first.photo.name, 'Tower Bridge');
    assert.equal(first.photo.network, 'Transport for London (Open Government Licence)');
    assert.deepEqual(readFileSync(path.join(dir, first.photo.file)), JPEG);
    const { photos, full } = await store.list();
    assert.deepEqual(
      photos.map((photo) => photo.file),
      [second.photo.file, first.photo.file],
    );
    assert.equal(full, false);
    assert.deepEqual((await store.read(first.photo.file)).body, JPEG);
  } finally {
    done();
  }
});

test('refused: other networks, video, unknown ids and ids with path tricks; nothing is fetched', async () => {
  const { dir, store, fetched, done } = setUp();
  try {
    for (const id of ['txdot-1', 'vegvesen-9', 'nope', '../../etc/passwd', 'a/b', '']) {
      const answer = await store.take(id);
      assert.equal(answer.status, 403, id);
    }
    assert.deepEqual(fetched, []);
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    done();
  }
});

test('a picture that is too big or not a picture is not saved', async () => {
  const big = setUp({ limits: { count: 10, bytes: 1_000_000, picture: 5 }, picture: JPEG });
  const text = setUp({ type: 'text/html', picture: Buffer.from('<html>') });
  try {
    assert.equal((await big.store.take('tfl-00001.01251')).status, 502);
    assert.equal((await text.store.take('tfl-00001.01251')).status, 502);
    assert.deepEqual((await big.store.list()).photos, []);
  } finally {
    big.done();
    text.done();
  }
});

test('a full folder says so instead of deleting anything', async () => {
  const { store, done } = setUp({ limits: { count: 2, bytes: 1_000_000, picture: 1000 } });
  try {
    assert.equal((await store.take('tfl-00001.01251')).status, 200);
    assert.equal((await store.take('tfl-00001.01251')).status, 200);
    const third = await store.take('tfl-00001.01251');
    assert.equal(third.status, 507);
    assert.match(third.error, /full/);
    const { photos, full } = await store.list();
    assert.equal(photos.length, 2);
    assert.equal(full, true);
  } finally {
    done();
  }
});

test('two quick presses are both kept', async () => {
  const { store, done } = setUp();
  try {
    await Promise.all([store.take('tfl-00001.01251'), store.take('tfl-00001.01251'), store.take('tfl-00001.01251')]);
    assert.equal((await store.list()).photos.length, 3);
  } finally {
    done();
  }
});

test('delete removes the photo and its file; names outside the list are refused', async () => {
  const { dir, store, done } = setUp();
  try {
    const { photo } = await store.take('tfl-00001.01251');
    for (const name of ['../photos.json', 'photos.json', `${photo.file}/..`, '1792184863000-zzzzzzzz.jpg']) {
      assert.equal(await store.remove(name), false, name);
      assert.equal(await store.read(name), null, name);
    }
    assert.equal(await store.remove(photo.file), true);
    assert.deepEqual((await store.list()).photos, []);
    assert.ok(!readdirSync(dir).includes(photo.file));
  } finally {
    done();
  }
});

function request(method, url, { headers = {}, body = '' } = {}) {
  const req = (async function* () {
    if (body) yield Buffer.from(body);
  })();
  return Object.assign(req, {
    method,
    url,
    headers: { host: 'localhost:4173', 'sec-fetch-site': 'same-origin', ...headers },
    socket: {},
  });
}
function response() {
  const res = { status: 0, headers: {}, body: null };
  res.writeHead = (status, headers) => Object.assign(res, { status, headers });
  res.setHeader = (name, value) => (res.headers[name] = value);
  res.end = (body) => (res.body = body);
  return res;
}

test('the photo route takes only a camera id in JSON, and refuses other websites', async () => {
  const { store, done } = setUp();
  const handler = cctvExtrasHandler({ photos: store, history: async () => [], historyFrame: async () => null });
  try {
    const json = { 'content-type': 'application/json' };
    const plain = response();
    await handler(request('POST', '/photos', { body: 'cameraId=tfl-00001.01251', headers: { 'content-type': 'text/plain' } }), plain);
    assert.equal(plain.status, 400);

    const elsewhere = response();
    await handler(
      request('POST', '/photos', {
        body: JSON.stringify({ cameraId: 'tfl-00001.01251' }),
        headers: { ...json, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
      }),
      elsewhere,
    );
    assert.equal(elsewhere.statusCode ?? elsewhere.status, 403);
    assert.deepEqual((await store.list()).photos, [], 'another website took no photo');

    const taken = response();
    await handler(request('POST', '/photos', { body: JSON.stringify({ cameraId: 'tfl-00001.01251' }), headers: json }), taken);
    assert.equal(taken.status, 200);
    const { file } = JSON.parse(taken.body).photo;

    const shown = response();
    await handler(request('GET', `/photos/${file}`), shown);
    assert.equal(shown.status, 200);
    assert.equal(shown.headers['Content-Type'], 'image/jpeg');

    const tricked = response();
    await handler(request('GET', '/photos/..%2Fphotos.json'), tricked);
    assert.equal(tricked.status, 404);

    const gone = response();
    await handler(request('DELETE', `/photos/${file}`), gone);
    assert.equal(gone.status, 200);

    const check = response();
    await handler(request('GET', '/photo-check/txdot-1'), check);
    assert.equal(JSON.parse(check.body).allowed, false);
  } finally {
    done();
  }
});
