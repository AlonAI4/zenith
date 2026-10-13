import assert from 'node:assert/strict';
import test from 'node:test';

import { failureMessage, guard, startAddOns } from './addOns.js';

test('an add-on that fails at the start does not stop the ones after it', () => {
  const started = [];
  const errors = [];
  const failed = startAddOns(
    [
      ['First', () => started.push('first')],
      [
        'Broken',
        () => {
          throw new Error('boom');
        },
      ],
      ['Third', () => started.push('third')],
      ['Also broken', () => undefined.nope],
      ['Last', () => started.push('last')],
    ],
    { onError: (name, error) => errors.push([name, error.constructor.name]) },
  );
  assert.deepEqual(started, ['first', 'third', 'last']);
  assert.deepEqual(failed, ['Broken', 'Also broken']);
  assert.deepEqual(errors, [
    ['Broken', 'Error'],
    ['Also broken', 'TypeError'],
  ]);
});

test('an add-on that fails later, in a promise, is reported too', async () => {
  const errors = [];
  const failed = startAddOns(
    [
      ['Loads fine', () => Promise.resolve('ok')],
      ['Data missing', () => Promise.reject(new Error('404'))],
    ],
    { onError: (name, error) => errors.push(`${name}: ${error.message}`) },
  );
  assert.deepEqual(failed, []);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(errors, ['Data missing: 404']);
});

test('a guarded function works normally until it throws', () => {
  const errors = [];
  const add = guard('Adder', (a, b) => a + b, { onError: (name) => errors.push(name) });
  assert.equal(add(2, 3), 5);
  assert.equal(add(4, 4), 8);
  assert.deepEqual(errors, []);
});

test('after it throws it is switched off, and the error is reported once', () => {
  const errors = [];
  let calls = 0;
  const everyFrame = guard(
    'Compass',
    () => {
      calls += 1;
      throw new Error('bad frame');
    },
    { onError: (name, error) => errors.push(`${name}: ${error.message}`) },
  );
  // The map calls this on every frame: none of the calls may throw.
  for (let frame = 0; frame < 100; frame++) assert.equal(everyFrame(), undefined);
  assert.equal(calls, 1);
  assert.deepEqual(errors, ['Compass: bad frame']);
});

test('a guarded function keeps its this and its arguments', () => {
  const counter = {
    total: 0,
    add: guard('Counter', function add(amount) {
      this.total += amount;
      return this.total;
    }),
  };
  assert.equal(counter.add(5), 5);
  assert.equal(counter.add(2), 7);
});

test('the notice names what failed and says the rest is fine', () => {
  assert.equal(failureMessage([]), '');
  assert.equal(
    failureMessage(['Compass']),
    'Compass has a problem and was switched off. The rest of Zenith is working. Reload the page to try again.',
  );
  assert.match(failureMessage(['Compass', 'Scale']), /^Compass and Scale have a problem and were switched off\./);
  assert.match(failureMessage(['A', 'B', 'C']), /^A, B and C have /);
});
