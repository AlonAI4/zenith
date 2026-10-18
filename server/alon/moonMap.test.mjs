import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createMoonMap, MAP_2K, MAP_8K, moonMapHandler } from './moonMap.js';

const answer = (text) => new Response(text, { status: 200 });

test('the 8k map is downloaded once, turned into a JPEG, and kept', async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'moon-'));
  try {
    const asked = [];
    const getMap = createMoonMap({
      cacheDir,
      fetchImpl: async (url) => {
        asked.push(url);
        return answer('TIFF');
      },
      convert: async (from, to) =>
        writeFile(to, `JPEG of ${await readFile(from, 'utf8')}`),
    });
    // Two asks at once share one download.
    const [first, second] = await Promise.all([getMap(), getMap()]);
    assert.equal(first.size, '8k');
    assert.equal(first.file, second.file);
    assert.equal(await readFile(first.file, 'utf8'), 'JPEG of TIFF');
    await getMap();
    assert.deepEqual(asked, [MAP_8K], 'downloaded once');
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test('without a way to convert the TIFF, the 2k JPEG is used', async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'moon-'));
  try {
    const asked = [];
    const getMap = createMoonMap({
      cacheDir,
      fetchImpl: async (url) => {
        asked.push(url);
        return answer(url === MAP_2K ? 'SMALL JPEG' : 'TIFF');
      },
      convert: async () => {
        throw new Error('no sips here');
      },
    });
    const map = await getMap();
    assert.equal(map.size, '2k');
    assert.equal(await readFile(map.file, 'utf8'), 'SMALL JPEG');
    assert.deepEqual(asked, [MAP_8K, MAP_2K]);
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

/** A request and a response good enough for the handler. */
function exchange(headers = {}) {
  const sent = { headers: {} };
  const response = {
    statusCode: 0,
    setHeader: (name, value) => (sent.headers[name.toLowerCase()] = value),
    end: (body) => (sent.body = body),
  };
  const request = {
    method: 'GET',
    headers: { host: 'localhost:4173', ...headers },
    socket: {},
  };
  return {
    request,
    response,
    sent,
    done: () => ({ ...sent, status: response.statusCode }),
  };
}

test('the route serves the map to Zenith, and refuses another website', async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'moon-'));
  try {
    const file = path.join(cacheDir, 'map.jpg');
    await writeFile(file, 'JPEG');
    const handler = moonMapHandler(async () => ({ file, size: '8k' }));
    const ok = exchange({ 'sec-fetch-site': 'same-origin' });
    await handler(ok.request, ok.response, () => {});
    const served = ok.done();
    assert.equal(served.status, 200);
    assert.equal(served.headers['content-type'], 'image/jpeg');
    assert.equal(served.headers['x-moon-map'], '8k');
    assert.equal(String(served.body), 'JPEG');

    const other = exchange({
      origin: 'https://example.com',
      'sec-fetch-site': 'cross-site',
    });
    await handler(other.request, other.response, () => {});
    assert.equal(other.done().status, 403);
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test('NASA out of reach is a 502 with a reason', async () => {
  const handler = moonMapHandler(async () => {
    throw new Error('NASA answered 503');
  });
  const call = exchange({ 'sec-fetch-site': 'same-origin' });
  await handler(call.request, call.response, () => {});
  const result = call.done();
  assert.equal(result.status, 502);
  assert.match(JSON.parse(result.body).error, /NASA answered 503/);
});
