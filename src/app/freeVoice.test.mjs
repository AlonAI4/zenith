import assert from 'node:assert/strict';
import test from 'node:test';

import { matchCommand, onOff, switchNames } from './freeVoice.js';

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
