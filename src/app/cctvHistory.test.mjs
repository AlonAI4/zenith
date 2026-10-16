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

function setUp({ answer = { frames: every(10, 24 * 60 - 10) } } = {}) {
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
  const remove = installCctvHistory({ _cctvControls: { cctv } }, doc, {
    now: () => NOW,
    fetchJson: async (url) => {
      asked.push(url);
      return answer;
    },
  });
  const tell = async (state) => {
    listener?.(state);
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { doc, wrap, asked, remove, tell, listening: () => Boolean(listener) };
}

test('choosing a time lays the older picture over the live one, and Escape goes back to Live', async () => {
  const { doc, wrap, asked, remove, tell } = setUp();
  try {
    const box = doc.getElementById('cctv-history');
    assert.ok(box.hidden, 'nothing shows before a camera is chosen');
    assert.ok(wrap.parentNode.children.indexOf(box) === wrap.parentNode.children.indexOf(wrap) + 1, 'the control sits right under the picture');

    await tell({ enabled: true, activeCameraId: 'fi-c0150301', activeCamera: { isVideo: false } });
    assert.deepEqual(asked, ['/api/alon/cctv/history/fi-c0150301']);
    assert.ok(!box.hidden);
    const buttons = box.querySelectorAll('button');
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
    const row = box.querySelector('.ch-row');
    row.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { key: 'ArrowRight' }));
    assert.equal(box.querySelectorAll('button').find((b) => b.textContent === '6 h').getAttribute('aria-checked'), 'true');

    const escape = Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' });
    doc.defaultView.dispatchEvent(escape);
    assert.ok(view.hidden, 'Escape went back to the live picture');
    assert.equal(box.querySelectorAll('button')[0].getAttribute('aria-checked'), 'true');
  } finally {
    remove();
  }
});

test('a picture that will not load says so, and switching camera goes back to Live', async () => {
  const { doc, remove, tell } = setUp();
  try {
    await tell({ enabled: true, activeCameraId: 'drivebc-537', activeCamera: {} });
    const box = doc.getElementById('cctv-history');
    box.querySelectorAll('button')[1].click();
    const picture = doc.getElementById('cctv-history-view').querySelector('img');
    picture.onerror();
    assert.equal(doc.getElementById('cctv-history-time').textContent, 'No picture from then');
    assert.ok(doc.getElementById('cctv-history-view').hidden);

    await tell({ enabled: true, activeCameraId: 'fi-c0150301', activeCamera: {} });
    assert.equal(box.querySelectorAll('button')[0].getAttribute('aria-checked'), 'true');
    assert.equal(doc.getElementById('cctv-history-time').textContent, '');
  } finally {
    remove();
  }
});

test('cameras without history, video cameras and CCTV off show nothing; remove takes it all away', async () => {
  const { doc, asked, remove, tell, listening } = setUp({ answer: { frames: [] } });
  await tell({ enabled: true, activeCameraId: 'tfl-00001.01251', activeCamera: {} });
  assert.ok(doc.getElementById('cctv-history').hidden);
  await tell({ enabled: true, activeCameraId: 'vegvesen-1', activeCamera: { isVideo: true } });
  assert.equal(asked.length, 1, 'a video camera is not asked about');
  await tell({ enabled: false, activeCameraId: 'fi-c0150301', activeCamera: {} });
  assert.ok(doc.getElementById('cctv-history').hidden);
  remove();
  assert.equal(doc.getElementById('cctv-history'), null);
  assert.equal(doc.getElementById('cctv-history-view'), null);
  assert.ok(!listening());
});
