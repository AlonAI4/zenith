import assert from 'node:assert/strict';
import test from 'node:test';

import {
  agoWords,
  installCctvHistory,
  pickSteps,
  pictureWords,
  STEPS,
} from './cctvHistory.js';
import { fakeDocument } from './fakeDom.mjs';

const NOW = Date.UTC(2026, 9, 16, 18, 0, 0);
const MIN = 60_000;
const every = (minutes, spanMinutes) =>
  Array.from({ length: Math.floor(spanMinutes / minutes) }, (_, i) => ({
    time: NOW - (i + 1) * minutes * MIN,
    key: `k${i + 1}`,
  }));

test('a camera with a full day of pictures gets every step back', () => {
  const steps = pickSteps(every(10, 24 * 60 - 10), NOW);
  assert.deepEqual(
    steps.map((step) => step.label),
    STEPS.map((step) => step.label),
  );
  for (const step of steps) {
    assert.ok(Math.abs(NOW - step.ms - step.frame.time) <= 40 * MIN, step.label);
  }
});

test('a camera that keeps three hours gets steps up to 3 h and no further', () => {
  // Caltrans: twelve pictures about 16 minutes apart.
  const steps = pickSteps(every(16, 12 * 16), NOW);
  assert.deepEqual(
    steps.map((step) => step.label),
    ['15 min', '30 min', '1 h', '2 h', '3 h'],
  );
});

test('no two steps show the same picture, and no pictures means no steps', () => {
  const steps = pickSteps([{ time: NOW - 20 * MIN, key: 'only' }], NOW);
  assert.equal(steps.length, 1);
  assert.deepEqual(pickSteps([], NOW), []);
});

test('the time of a picture reads plainly', () => {
  assert.equal(agoWords(MIN), 'just now');
  assert.equal(agoWords(12 * MIN), '12 min ago');
  assert.equal(agoWords(80 * MIN), '1 h 20 min ago');
  assert.equal(agoWords(3 * 60 * MIN + 2 * MIN), '3 h ago');
  assert.equal(agoWords(23 * 60 * MIN + 40 * MIN), '23 h ago');
  assert.equal(
    pictureWords(NOW - 3 * 60 * MIN, NOW, 'UTC'),
    'Picture from 15:00, 3 h ago',
  );
});

function setUp({
  frames = every(10, 24 * 60 - 10),
  allowed = true,
  photos = [],
  takeError = null,
} = {}) {
  const doc = fakeDocument();
  const wrap = doc.createElement('div');
  wrap.id = 'cctv-frame-wrap';
  const badge = doc.createElement('div');
  badge.id = 'cctv-source-badge';
  doc.body.append(wrap, badge);
  let listener = null;
  const cctv = {
    subscribe: (fn) => {
      listener = fn;
      return () => (listener = null);
    },
  };
  const asked = [];
  const store = [...photos];
  const remove = installCctvHistory({ _cctvControls: { cctv } }, doc, {
    now: () => NOW,
    fetchJson: async (url, init = {}) => {
      asked.push(init.method ? `${init.method} ${url}` : url);
      if (url.startsWith('/api/alon/cctv/history/')) return { frames };
      if (url.startsWith('/api/alon/cctv/photo-check/')) {
        return { allowed, why: allowed ? '' : "Photos are off for this camera: its network's terms do not say copies may be saved." };
      }
      if (url === '/api/alon/cctv/photos' && init.method === 'POST') {
        if (takeError) throw Object.assign(new Error(takeError), { said: takeError });
        const { cameraId } = JSON.parse(init.body);
        const photo = { file: `${NOW - 5 * MIN}-0000000${store.length}.jpg`, cameraId, name: 'Tower Bridge', place: 'London', network: 'TfL', time: NOW - 5 * MIN };
        store.push(photo);
        return { photo };
      }
      if (url === '/api/alon/cctv/photos') return { photos: [...store].sort((a, b) => b.time - a.time), full: false };
      if (init.method === 'DELETE') {
        const file = decodeURIComponent(url.split('/').pop());
        store.splice(store.findIndex((photo) => photo.file === file), 1);
        return { deleted: file };
      }
      throw new Error(`unexpected ${url}`);
    },
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
  const tell = async (state) => {
    listener?.(state);
    await settle();
  };
  const key = (target, name) =>
    target.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { key: name }));
  return { doc, wrap, asked, store, remove, tell, settle, key, listening: () => Boolean(listener) };
}

const FINLAND = { enabled: true, activeCameraId: 'fi-c0150301', activeCamera: { isVideo: false } };
const LONDON = { enabled: true, activeCameraId: 'tfl-00001.01251', activeCamera: { isVideo: false } };

test('choosing a time lays the older picture over the live one, and Escape goes back to Live', async () => {
  const { doc, wrap, asked, remove, tell, key } = setUp();
  try {
    const box = doc.getElementById('cctv-history');
    assert.ok(box.hidden, 'nothing shows before a camera is chosen');
    assert.ok(wrap.parentNode.children.indexOf(box) === wrap.parentNode.children.indexOf(wrap) + 1, 'the control sits right under the picture');

    await tell(FINLAND);
    assert.deepEqual(asked, [
      '/api/alon/cctv/history/fi-c0150301',
      '/api/alon/cctv/photo-check/fi-c0150301',
      '/api/alon/cctv/photos',
    ]);
    assert.ok(!box.hidden);
    const buttons = box.querySelector('.ch-row').querySelectorAll('button');
    assert.deepEqual(
      buttons.map((button) => button.textContent),
      ['Live', ...STEPS.map((step) => step.label)],
    );
    assert.equal(buttons[0].getAttribute('aria-checked'), 'true');
    assert.equal(buttons[0].tabIndex, 0);

    const threeHours = buttons.find((button) => button.textContent === '3 h');
    threeHours.click();
    const view = doc.getElementById('cctv-history-view');
    const picture = view.querySelector('img');
    assert.match(picture.src, /^\/api\/alon\/cctv\/history\/fi-c0150301\/frame\?key=k\d+$/);
    assert.ok(view.hidden, 'the older picture shows only once it has loaded');
    picture.onload();
    assert.ok(!view.hidden);
    assert.match(doc.getElementById('cctv-history-time').textContent, /^Picture from \d\d:\d\d, 3 h ago$/);
    assert.equal(threeHours.getAttribute('aria-checked'), 'true');
    assert.equal(doc.getElementById('cctv-history-time').getAttribute('role'), 'status');

    // Arrow keys move between the times.
    key(box.querySelector('.ch-row'), 'ArrowRight');
    assert.equal(box.querySelector('.ch-row').querySelectorAll('button').find((b) => b.textContent === '6 h').getAttribute('aria-checked'), 'true');

    key(doc.defaultView, 'Escape');
    assert.ok(view.hidden, 'Escape went back to the live picture');
    assert.equal(box.querySelector('.ch-row').querySelectorAll('button')[0].getAttribute('aria-checked'), 'true');
  } finally {
    remove();
  }
});

test('a picture that will not load says so, and switching camera goes back to Live', async () => {
  const { doc, remove, tell } = setUp();
  try {
    await tell({ enabled: true, activeCameraId: 'drivebc-537', activeCamera: {} });
    const box = doc.getElementById('cctv-history');
    box.querySelector('.ch-row').querySelectorAll('button')[1].click();
    const picture = doc.getElementById('cctv-history-view').querySelector('img');
    picture.onerror();
    assert.equal(doc.getElementById('cctv-history-time').textContent, 'No picture from then');
    assert.ok(doc.getElementById('cctv-history-view').hidden);

    await tell(FINLAND);
    assert.equal(box.querySelector('.ch-row').querySelectorAll('button')[0].getAttribute('aria-checked'), 'true');
    assert.equal(doc.getElementById('cctv-history-time').textContent, '');
  } finally {
    remove();
  }
});

test('Take photo saves the picture, and the photo joins the camera’s times', async () => {
  const { doc, asked, remove, tell, settle } = setUp({ frames: [] });
  try {
    await tell(LONDON);
    const row = doc.getElementById('cctv-history').querySelector('.ch-row');
    assert.ok(row.hidden, 'no times before there is anything to look back on');
    const take = doc.getElementById('cctv-photo-take');
    assert.ok(!take.disabled);
    take.click();
    await settle();
    assert.ok(asked.includes('POST /api/alon/cctv/photos'));
    assert.match(doc.getElementById('cctv-history-time').textContent, /Photo saved on this computer/);
    // The clock is the viewer's own time, whatever zone the test runs in.
    const clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(NOW - 5 * MIN);
    const labels = row.querySelectorAll('button').map((button) => button.textContent);
    assert.deepEqual(labels, ['Live', `Photo ${clock}`]);
    row.querySelectorAll('button')[1].click();
    const picture = doc.getElementById('cctv-history-view').querySelector('img');
    assert.match(picture.src, /^\/api\/alon\/cctv\/photos\/\d+-0+\.jpg$/);
    picture.onload();
    assert.equal(doc.getElementById('cctv-history-time').textContent, `Your photo from ${clock}, 5 min ago`);
  } finally {
    remove();
  }
});

test('on a camera whose network does not allow copies, Take photo is off and says why', async () => {
  const { doc, remove, tell } = setUp({ allowed: false });
  try {
    await tell({ enabled: true, activeCameraId: 'txdot-1', activeCamera: {} });
    const take = doc.getElementById('cctv-photo-take');
    assert.ok(take.disabled);
    assert.match(doc.getElementById('cctv-photo-note').textContent, /terms do not say copies may be saved/);
  } finally {
    remove();
  }
});

test('a refused photo shows the reason the server gave', async () => {
  const { doc, remove, tell, settle } = setUp({ takeError: 'The photos folder is full. Delete some photos to take more.' });
  try {
    await tell(LONDON);
    doc.getElementById('cctv-photo-take').click();
    await settle();
    assert.equal(doc.getElementById('cctv-history-time').textContent, 'The photos folder is full. Delete some photos to take more.');
  } finally {
    remove();
  }
});

test('My photos lists every photo newest first; a photo opens large; Delete asks first', async () => {
  const older = { file: '1792171200000-00000001.jpg', cameraId: 'tfl-a', name: 'Old one', place: 'London', network: 'TfL', time: NOW - 2 * 60 * MIN };
  const newer = { file: '1792178400000-00000002.jpg', cameraId: 'tfl-b', name: 'New one', place: 'London', network: 'TfL', time: NOW - 60 * MIN };
  const { doc, asked, remove, tell, settle, key } = setUp({ photos: [older, newer] });
  try {
    await tell(LONDON);
    const opener = doc.getElementById('cctv-photos-open');
    opener.click();
    await settle();
    const panel = doc.getElementById('my-photos');
    assert.ok(!panel.hidden);
    assert.match(panel.textContent, /never uploaded/);
    const items = panel.querySelectorAll('li');
    assert.deepEqual(
      items.map((item) => item.querySelector('.mp-name').textContent),
      ['New one', 'Old one'],
    );
    items[1].querySelector('button').click();
    const big = panel.querySelector('.mp-big');
    assert.ok(!big.hidden);
    assert.match(big.querySelector('img').src, /\/api\/alon\/cctv\/photos\/1792171200000-00000001\.jpg$/);

    // Escape goes from the large photo back to the list first.
    key(doc.defaultView, 'Escape');
    assert.ok(big.hidden && !panel.hidden);

    items[1].querySelector('button').click();
    big.querySelector('.mp-danger').click();
    const confirm = big.querySelectorAll('.mp-row')[1];
    assert.ok(!confirm.hidden, 'Delete asks first');
    assert.ok(!asked.some((one) => one.startsWith('DELETE')), 'nothing is deleted before the answer');
    confirm.querySelector('.mp-danger').click();
    await settle();
    assert.ok(asked.includes('DELETE /api/alon/cctv/photos/1792171200000-00000001.jpg'));
    assert.deepEqual(
      panel.querySelectorAll('li').map((item) => item.querySelector('.mp-name').textContent),
      ['New one'],
    );
    assert.equal(panel.querySelector('.mp-said').textContent, 'Photo deleted.');

    key(doc.defaultView, 'Escape');
    assert.ok(panel.hidden, 'Escape closed the panel');
  } finally {
    remove();
  }
});

test('video cameras and CCTV off show nothing; remove takes it all away', async () => {
  const { doc, asked, remove, tell, listening } = setUp({ frames: [] });
  await tell({ enabled: true, activeCameraId: 'vegvesen-1', activeCamera: { isVideo: true } });
  assert.ok(doc.getElementById('cctv-history').hidden);
  assert.equal(asked.length, 0, 'a video camera is not asked about');
  await tell({ enabled: false, activeCameraId: 'fi-c0150301', activeCamera: {} });
  assert.ok(doc.getElementById('cctv-history').hidden);
  remove();
  for (const id of ['cctv-history', 'cctv-history-view', 'my-photos']) assert.equal(doc.getElementById(id), null, id);
  assert.ok(!listening());
});
