import assert from 'node:assert/strict';
import test from 'node:test';

import { fakeDocument } from './fakeDom.mjs';
import {
  installFreeVoice,
  matchCommand,
  onOff,
  switchNames,
} from './freeVoice.js';

const layers = new Map([
  ['flights', 'flights'],
  ['planes', 'flights'],
  ['ships', 'ships'],
  ['satellites', 'satellites'],
]);
const names = { layers, switches: switchNames() };
const said = (text) => matchCommand(text, names);

test('go to a place', () => {
  assert.deepEqual(said('Go to Paris'), { do: 'go', place: 'paris' });
  assert.deepEqual(said('fly to 10 Downing Street, London.'), {
    do: 'go',
    place: '10 downing street london',
  });
  assert.deepEqual(said('take me to Tokyo'), { do: 'go', place: 'tokyo' });
});

test('zoom in and out', () => {
  assert.deepEqual(said('Zoom in'), { do: 'zoom', in: true });
  assert.deepEqual(said('zoom out more'), { do: 'zoom', in: false });
});

test('CCTV on and off', () => {
  assert.deepEqual(said('CCTV on'), { do: 'cctv', on: true });
  assert.deepEqual(said('turn off the cameras'), { do: 'cctv', on: false });
});

test('take photo', () => {
  assert.deepEqual(said('Take photo'), { do: 'photo' });
  assert.deepEqual(said('take a picture'), { do: 'photo' });
});

test('FLIR on and off', () => {
  assert.deepEqual(said('FLIR on'), { do: 'flir', on: true });
  assert.deepEqual(said('thermal off'), { do: 'flir', on: false });
});

test('classified on and off', () => {
  assert.deepEqual(said('classified on'), { do: 'classified', on: true });
  assert.deepEqual(said('switch off classified'), {
    do: 'classified',
    on: false,
  });
});

test('watch zones on and off', () => {
  assert.deepEqual(said('watch zones on'), { do: 'watching', on: true });
  assert.deepEqual(said('turn off watch zones'), { do: 'watching', on: false });
});

test('space view, go to the Moon and back to Earth', () => {
  assert.deepEqual(said('space view'), {
    do: 'switch',
    id: 'space-view-toggle',
    on: true,
  });
  // The Moon is a search, which space view catches.
  assert.deepEqual(said('go to the Moon'), { do: 'go', place: 'the moon' });
  assert.deepEqual(said('back to Earth'), { do: 'earth' });
  assert.deepEqual(said('go back to the Earth'), { do: 'earth' });
});

test("Zenith's switches and the map's layers, by name", () => {
  assert.deepEqual(said('earthquakes on'), {
    do: 'switch',
    id: 'earthquakes-toggle',
    on: true,
  });
  assert.deepEqual(said('turn off place names'), {
    do: 'switch',
    id: 'map-labels-toggle',
    on: false,
  });
  assert.deepEqual(said('show planes'), {
    do: 'layer',
    id: 'flights',
    on: true,
  });
  assert.deepEqual(said('ships layer off'), {
    do: 'layer',
    id: 'ships',
    on: false,
  });
});

test('anything else is not understood', () => {
  assert.equal(said('make me a sandwich'), null);
  assert.equal(said('unicorns on'), null);
  assert.equal(said(''), null);
  assert.equal(onOff('hello there'), null);
});

test('panels are not switches you can say', () => {
  const switches = switchNames();
  assert.ok(switches.has('map pin'));
  assert.ok(!switches.has('help'));
});

/** The add-on on a fake page, with or without an OpenAI key set. */
async function micPage(openaiSet) {
  const doc = fakeDocument();
  const win = doc.defaultView;
  win.setTimeout = () => 0;
  const heard = { started: 0, stopped: 0 };
  win.SpeechRecognition = class {
    start() {
      heard.started++;
    }
    stop() {
      heard.stopped++;
    }
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ keys: [{ id: 'openai', set: openaiSet }] }),
  });
  let stop;
  try {
    stop = installFreeVoice({ viewer: {} }, {}, doc);
    await new Promise((done) => setImmediate(done));
  } finally {
    globalThis.fetch = realFetch;
  }
  const button = doc.createElement('button');
  button.id = 'gev-voice-button';
  doc.body.appendChild(button);
  // The fake page does not pass events up: hand the page the click itself.
  const click = () => {
    const event = new Event('click', { cancelable: true });
    Object.defineProperty(event, 'target', { value: button });
    doc.dispatchEvent(event);
    return event;
  };
  return { heard, click, stop };
}

test('with no OpenAI key the mic button starts and stops the free voice, not the paid one', async () => {
  const { heard, click, stop } = await micPage(false);
  try {
    assert.ok(click().defaultPrevented, 'the paid voice never saw the click');
    assert.equal(heard.started, 1);
    click();
    assert.equal(heard.stopped, 1);
  } finally {
    stop();
  }
});

test('with an OpenAI key the mic button is left to the paid voice', async () => {
  const { heard, click, stop } = await micPage(true);
  try {
    assert.ok(!click().defaultPrevented);
    assert.equal(heard.started, 0);
  } finally {
    stop();
  }
});
