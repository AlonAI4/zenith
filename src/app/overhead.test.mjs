import assert from 'node:assert/strict';
import test from 'node:test';
import { twoline2satrec } from 'satellite.js';

import { findNextSatellitePass, lookAnglesAt } from '../data/satellitePass.js';
import { fakeDocument } from './fakeDom.mjs';
import {
  announceSpot,
  compassPoint,
  installOverhead,
  isOverheadNow,
  needsRecount,
  OVERHEAD_MIN_ELEV_DEG,
  OVERHEAD_SATELLITES,
  passLine,
  RECOUNT_MS,
  untilText,
} from './overhead.js';

const MIN = 60_000;
const pass = (riseInMin, now = 0) => ({
  status: 'ok',
  pass: {
    riseMs: now + riseInMin * MIN,
    setMs: now + (riseInMin + 6) * MIN,
    maxElevDeg: 63.4,
    maxElevMs: now + (riseInMin + 3) * MIN,
    riseAzDeg: 228,
  },
});

test('a pass reads as name, countdown, peak and where it rises', () => {
  assert.equal(
    passLine('ISS', pass(14), 0),
    'ISS · in 14 min · up to 63° · from the SW',
  );
});

test('the countdown goes from hours to minutes to seconds', () => {
  assert.equal(untilText(3 * 3_600_000 + 5 * MIN), 'in 3 h 05 min');
  assert.equal(untilText(59 * MIN + 59_000), 'in 59 min');
  assert.equal(untilText(60_000), 'in 1 min');
  assert.equal(untilText(59_999), 'in 59 s');
  assert.equal(untilText(-5), 'in 0 s');
  // One pass, a minute later, counts one minute less.
  assert.equal(
    passLine('ISS', pass(14), MIN),
    'ISS · in 13 min · up to 63° · from the SW',
  );
});

test('OVERHEAD NOW from rising to setting, not before or after', () => {
  const { pass: p } = pass(10);
  assert.equal(isOverheadNow(p, p.riseMs - 1), false);
  assert.equal(isOverheadNow(p, p.riseMs), true);
  assert.equal(isOverheadNow(p, p.setMs - 1), true);
  assert.equal(isOverheadNow(p, p.setMs), false);
  assert.match(
    passLine('Hubble', pass(10), p.riseMs + MIN),
    /^Hubble · OVERHEAD NOW · up to 63°/,
  );
});

test('a pass already under way when it was worked out says when it sets, not where it rose', () => {
  const joined = { ...pass(-2), joined: true };
  assert.equal(
    passLine('ISS', joined, 0),
    'ISS · OVERHEAD NOW · sets in 4 min',
  );
});

test('rising and setting are where the satellite crosses 10° above the horizon', () => {
  // A published ISS orbit and a place it passes over (Austin, 20 September 2008).
  const satrec = twoline2satrec(
    '1 25544U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927',
    '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537',
  );
  const at = { latDeg: 30.2672, lonDeg: -97.7431 };
  const found = findNextSatellitePass({
    satrec,
    ...at,
    fromMs: Date.UTC(2008, 8, 20, 12, 30),
    minElevDeg: OVERHEAD_MIN_ELEV_DEG,
  });
  assert.ok(found, 'a pass was found');
  const height = (ms) => lookAnglesAt(satrec, ms, at.latDeg, at.lonDeg).elevDeg;
  assert.ok(
    Math.abs(height(found.riseMs) - 10) < 0.2,
    `rises at ${height(found.riseMs)}°`,
  );
  assert.ok(height(found.riseMs - 20_000) < 10, 'below 10° before it rises');
  assert.ok(height(found.riseMs + 20_000) > 10, 'above 10° after it rises');
  assert.ok(isOverheadNow(found, found.maxElevMs));
  assert.ok(!isOverheadNow(found, found.setMs + 1000));
});

test('no pass, and a satellite missing from the catalogue, say so', () => {
  assert.equal(
    passLine('Hubble', { status: 'none' }, 0),
    'Hubble · no pass above 10° in the next 24 h',
  );
  assert.equal(
    passLine('Tiangong', { status: 'no-tle' }, 0),
    'Tiangong · not in the loaded satellites',
  );
});

test('compass points', () => {
  assert.equal(compassPoint(0), 'N');
  assert.equal(compassPoint(359), 'N');
  assert.equal(compassPoint(-90), 'W');
  assert.equal(compassPoint(135), 'SE');
});

test('passes are worked out again once a minute, or when one shown has ended', () => {
  const state = { results: [pass(30)], loaded: true, at: 0 };
  assert.equal(needsRecount(state, RECOUNT_MS - 1), false);
  assert.equal(needsRecount(state, RECOUNT_MS), true);
  const ending = { results: [pass(-5)], loaded: true, at: 0 };
  assert.equal(needsRecount(ending, 30_000), false);
  assert.equal(needsRecount(ending, MIN + 1), true);
  // Before the catalogue loads: tried again every 2 seconds.
  assert.equal(
    needsRecount({ results: [], loaded: false, at: 0 }, 1999),
    false,
  );
  assert.equal(needsRecount({ results: [], loaded: false, at: 0 }, 2000), true);
});

/** The add-on in a fake page with a made-up satellites layer. */
function inFakePage({ loaded = true, enabled = loaded } = {}) {
  const doc = fakeDocument();
  const win = doc.defaultView;
  win.setInterval = (fn, ms) => setInterval(fn, ms);
  win.clearInterval = (handle) => clearInterval(handle);
  const asked = [];
  const switched = [];
  const module = {
    getNextSatellitePass(id, options) {
      asked.push({ id, ...options });
      return loaded ? pass(14, options.fromMs) : { status: 'no-tle' };
    },
  };
  const dataManager = {
    layers: new Map([['satellites', { module }]]),
    isEnabled: () => enabled,
    setEnabled: (...args) => switched.push(args),
  };
  const remove = installOverhead({ dataManager }, doc);
  const box = doc.createElement('div');
  doc.body.appendChild(box);
  const open = (spot) =>
    announceSpot(win, 'target', spot, (section) => box.appendChild(section));
  return { doc, box, asked, switched, open, remove };
}

test('a box opening on a spot shows the three satellites, worked out once', () => {
  const page = inFakePage();
  try {
    page.open({ lat: 51.5, lon: -0.12 });
    const section = page.box.querySelector('.zenith-overhead');
    assert.ok(section, 'the section is in the box');
    assert.match(section.textContent, /^OVERHEAD/);
    for (const { name } of OVERHEAD_SATELLITES)
      assert.match(section.textContent, new RegExp(`${name} · in 14 min`));
    assert.deepEqual(
      page.asked.map(({ id }) => id),
      OVERHEAD_SATELLITES.map(({ id }) => id),
    );
    assert.equal(page.asked[0].latDeg, 51.5);
    assert.equal(page.asked[0].minElevDeg, 10);
    // Closing takes the section away.
    page.open(null);
    assert.equal(page.box.querySelector('.zenith-overhead'), null);
  } finally {
    page.remove();
  }
});

test('without the catalogue, one line and a button that switches the layer on', () => {
  const page = inFakePage({ loaded: false });
  try {
    page.open({ lat: 51.5, lon: -0.12 });
    const section = page.box.querySelector('.zenith-overhead');
    assert.match(section.textContent, /Switch on the Satellites layer/);
    const button = section.querySelector('button');
    assert.ok(button, 'there is a switch-on button');
    button.dispatchEvent(new Event('click'));
    assert.deepEqual(page.switched[0].slice(0, 2), ['satellites', true]);
  } finally {
    page.remove();
  }
});
