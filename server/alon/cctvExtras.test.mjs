import assert from 'node:assert/strict';
import test from 'node:test';

import {
  caltransCamera,
  cctvExtrasHandler,
  createCctvExtras,
  historyFrameUrl,
  historySource,
  parseDrivebcHistory,
  parseFintrafficHistory,
} from './cctvExtras.js';

const NOW = Date.UTC(2026, 9, 16, 18, 0, 0);
const CAM = 'https://cwwp2.dot.ca.gov/data/d7/cctv/image/i110196avenue26offramp/i110196avenue26offramp.jpg';

test('only the networks that keep older pictures get a history, and not the Bay Area', () => {
  assert.equal(historySource('fi-c0150301'), 'fintraffic');
  assert.equal(historySource('drivebc-537'), 'drivebc');
  for (const district of ['3', '7', '11']) assert.equal(historySource(`ca-d${district}-tv102`), 'caltrans');
  for (const id of ['ca-d4-tv102', 'tfl-00001.01251', 'fi-c01503011', 'drivebc-0', 'drivebc-12345678', '', null]) {
    assert.equal(historySource(id), null, String(id));
  }
});

test("Finland's history keeps this camera's own view only, oldest first", () => {
  const answer = {
    presets: [
      {
        history: [
          { lastModified: '2026-10-16T17:38:00Z', imageUrl: 'https://weathercam.digitraffic.fi/C0150301.jpg?versionId=newerVersion1' },
          { lastModified: '2026-10-16T14:38:00Z', imageUrl: 'https://weathercam.digitraffic.fi/C0150301.jpg?versionId=olderVersion1' },
          { lastModified: '2026-10-16T14:38:00Z', imageUrl: 'https://weathercam.digitraffic.fi/C0150302.jpg?versionId=otherView001' },
          { lastModified: 'not a time', imageUrl: 'https://weathercam.digitraffic.fi/C0150301.jpg?versionId=noTimeHere1' },
          { lastModified: '2026-10-16T15:00:00Z', imageUrl: 'https://evil.example/C0150301.jpg?versionId=fromElsewhere' },
          { lastModified: '2026-10-16T15:10:00Z', imageUrl: 'https://weathercam.digitraffic.fi/C0150301.jpg?versionId=../../x' },
        ],
      },
    ],
  };
  const frames = parseFintrafficHistory(answer, 'fi-c0150301');
  assert.deepEqual(
    frames.map((frame) => frame.key),
    ['olderVersion1', 'newerVersion1'],
  );
  assert.equal(frames[0].time, Date.parse('2026-10-16T14:38:00Z'));
  assert.deepEqual(parseFintrafficHistory(null, 'fi-c0150301'), []);
});

test("BC's list is read as UTC, and pictures about to be deleted are left out", () => {
  const frames = parseDrivebcHistory(
    ['20261016150000', '20261015181500', '20261015175500', 'junk', '20261016190000', 42],
    NOW,
  );
  assert.deepEqual(
    frames.map((frame) => frame.key),
    ['20261015181500', '20261016150000'],
  );
  assert.equal(frames[1].time, Date.UTC(2026, 9, 16, 15, 0, 0));
});

test('Caltrans picture addresses are read only from its own server and districts', () => {
  assert.deepEqual(caltransCamera(CAM), { district: '7', cam: 'i110196avenue26offramp' });
  for (const url of [
    'https://cwwp2.dot.ca.gov/data/d4/cctv/image/tv102/tv102.jpg',
    'https://evil.example/data/d7/cctv/image/a/a.jpg',
    'https://cwwp2.dot.ca.gov/data/d7/cctv/image/a/b.jpg',
    '',
  ]) {
    assert.equal(caltransCamera(url), null, url);
  }
});

test('an older picture address is built only from a key the camera can have', () => {
  assert.equal(
    historyFrameUrl('fi-c0150301', 'abcDEF123_.-x'),
    'https://weathercam.digitraffic.fi/C0150301.jpg?versionId=abcDEF123_.-x',
  );
  assert.equal(
    historyFrameUrl('drivebc-537', '20261016150000'),
    'https://www.drivebc.ca/images/replaytheday/537/20261016150000.jpg',
  );
  assert.equal(
    historyFrameUrl('ca-d7-x1', '12', caltransCamera(CAM)),
    'https://cwwp2.dot.ca.gov/data/d7/cctv/image/i110196avenue26offramp/previous/i110196avenue26offramp-12.jpg',
  );
  for (const [id, key] of [
    ['fi-c0150301', '../../etc/passwd'],
    ['fi-c0150301', 'a/b'],
    ['fi-c0150301', 'short'],
    ['drivebc-537', '2026101615'],
    ['drivebc-537', '20261016150000.jpg?x'],
    ['ca-d7-x1', '13'],
    ['ca-d7-x1', '0'],
    ['tfl-00001.01251', '1'],
  ]) {
    assert.equal(historyFrameUrl(id, key, caltransCamera(CAM)), null, `${id} ${key}`);
  }
  assert.equal(historyFrameUrl('ca-d7-x1', '3', null), null, 'no Caltrans address without the camera');
});

test('Finland is asked with its user header; Caltrans times come from each picture, bad ones dropped', async () => {
  const asked = [];
  const fetchImpl = async (url, init = {}) => {
    asked.push({ url, init });
    if (url.includes('digitraffic')) {
      return new Response(
        JSON.stringify({
          presets: [{ history: [{ lastModified: '2026-10-16T17:00:00Z', imageUrl: 'https://weathercam.digitraffic.fi/C0150301.jpg?versionId=version00001' }] }],
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    }
    const slot = Number(/-(\d+)\.jpg$/.exec(url)[1]);
    const times = {
      1: new Date(NOW - 15 * 60_000).toUTCString(),
      2: 'Thu, 01 Jan 1970 00:00:00 GMT',
      3: new Date(NOW + 3600_000).toUTCString(),
    };
    return new Response(null, { status: 200, headers: { 'last-modified': times[slot] ?? '' } });
  };
  const extras = createCctvExtras({
    fetchImpl,
    now: () => NOW,
    cameras: async () => [{ id: 'ca-d7-x1', url: CAM }],
  });

  assert.deepEqual(await extras.history('fi-c0150301'), [{ time: Date.parse('2026-10-16T17:00:00Z'), key: 'version00001' }]);
  assert.equal(asked[0].url, 'https://tie.digitraffic.fi/api/weathercam/v1/stations/C0150301/history');
  assert.equal(asked[0].init.headers['Digitraffic-User'], 'gods-eye-view');

  const caltrans = await extras.history('ca-d7-x1');
  assert.deepEqual(caltrans, [{ key: '1', time: Date.parse(new Date(NOW - 15 * 60_000).toUTCString()) }]);
  assert.ok(asked.filter((one) => one.init.method === 'HEAD').length === 12);

  // A second ask within the minute is answered from memory.
  const before = asked.length;
  await extras.history('fi-c0150301');
  assert.equal(asked.length, before);

  // A camera without history asks nobody.
  assert.deepEqual(await extras.history('tfl-00001.01251'), []);
  assert.equal(await extras.historyFrame('fi-c0150301', '../x'), null);
  assert.equal(asked.length, before);
});

function fakeRequest(path, headers = {}) {
  return { method: 'GET', url: path, headers: { host: 'localhost:4173', 'sec-fetch-site': 'same-origin', ...headers }, socket: {} };
}
function fakeResponse() {
  const res = { status: 0, headers: {}, body: null };
  res.writeHead = (status, headers) => Object.assign(res, { status, headers });
  res.setHeader = (name, value) => (res.headers[name] = value);
  res.end = (body) => (res.body = body);
  return res;
}

test('the route answers this page only, and refuses other websites', async () => {
  const handler = cctvExtrasHandler({
    history: async (id) => (id === 'fi-c0150301' ? [{ time: 1, key: 'version00001' }] : []),
    historyFrame: async () => null,
  });
  const ok = fakeResponse();
  await handler(fakeRequest('/history/fi-c0150301'), ok);
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(ok.body), { frames: [{ time: 1, key: 'version00001' }] });

  const elsewhere = fakeResponse();
  await handler(fakeRequest('/history/fi-c0150301', { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }), elsewhere);
  assert.equal(elsewhere.statusCode ?? elsewhere.status, 403);

  const missing = fakeResponse();
  await handler(fakeRequest('/history/fi-c0150301/frame?key=nope'), missing);
  assert.equal(missing.status, 404);

  const unknown = fakeResponse();
  await handler(fakeRequest('/somewhere'), unknown);
  assert.equal(unknown.status, 404);
});

test("the server starts these routes, from one line in the original's plugin list", async () => {
  // The original project's updater merges with "theirs wins", which could drop
  // that line without a word; this test is what notices.
  const { localProviderPlugins } = await import('../providers/local.js');
  const names = localProviderPlugins().map((plugin) => plugin.name);
  assert.ok(names.includes('alon-cctv-extras'));
  assert.equal(names.at(-1), 'gev-key-setup', 'the key panel stays last');
  const plugin = localProviderPlugins().find((one) => one.name === 'alon-cctv-extras');
  assert.equal(typeof plugin.configureServer, 'function');
  assert.equal(typeof plugin.configurePreviewServer, 'function');
  // A hook that returns a function would be run again by Vite later.
  assert.equal(plugin.configureServer({ middlewares: { use() {} } }), undefined);
});

test('a malformed address is answered 400 instead of stopping the server', async () => {
  const handler = cctvExtrasHandler({ history: async () => [], historyFrame: async () => null });
  const res = fakeResponse();
  await handler(fakeRequest('/history/%E0'), res);
  assert.equal(res.status, 400);
});

test('a Caltrans slot that has moved on to a newer picture is refused, and lists never follow redirects', async () => {
  const asked = [];
  const listed = NOW - 60 * 60_000;
  const fetchImpl = async (url, init = {}) => {
    asked.push(init);
    return new Response(init.method === 'HEAD' ? null : Buffer.from([0xff, 0xd8, 0xff]), {
      headers: { 'last-modified': new Date(listed + 16 * 60_000).toUTCString(), 'content-type': 'image/jpeg' },
    });
  };
  const extras = createCctvExtras({ fetchImpl, now: () => NOW, cameras: async () => [{ id: 'ca-d7-x1', url: CAM }] });
  assert.equal(await extras.historyFrame('ca-d7-x1', '4', listed), null, 'the picture in the slot is not the one listed');
  assert.ok(asked.every((init) => init.redirect === 'error'));
  const matching = await extras.historyFrame('ca-d7-x1', '4', listed + 16 * 60_000);
  assert.ok(matching?.ok && matching.moves, 'the listed picture is fetched, and marked as one that moves');
  await extras.history('ca-d7-x1');
  assert.ok(asked.filter((init) => init.method === 'HEAD').every((init) => init.redirect === 'error'));
});
