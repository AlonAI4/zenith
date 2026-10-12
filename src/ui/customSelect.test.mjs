import assert from 'node:assert/strict';
import test from 'node:test';

import { menuRows } from './customSelect.js';

const OPTIONS = [
  { label: 'Austin · 5TH ST', value: 'a1', group: 'Austin Transport' },
  { label: 'Austin · 6TH ST', value: 'a2', group: 'Austin Transport' },
  { label: 'London · Strand', value: 'l1', group: 'Transport for London' },
  { label: 'London · Whitehall', value: 'l2', group: 'Transport for London' },
];

test('with no search every option shows under its group heading', () => {
  assert.deepEqual(
    menuRows(OPTIONS, '').rows.map((row) => row.heading || row.label),
    [
      'Austin Transport',
      'Austin · 5TH ST',
      'Austin · 6TH ST',
      'Transport for London',
      'London · Strand',
      'London · Whitehall',
    ],
  );
});

test('a search matches option text or the group name, ignoring case', () => {
  assert.deepEqual(
    menuRows(OPTIONS, 'whiteHALL').rows.map((row) => row.value).filter(Boolean),
    ['l2'],
  );
  assert.equal(menuRows(OPTIONS, 'transport for london').matched, 2);
  assert.equal(menuRows(OPTIONS, 'paris').matched, 0);
});

test('a long list is capped, and says how many really matched', () => {
  const { rows, matched } = menuRows(OPTIONS, '', 3);
  assert.equal(matched, 4);
  assert.equal(rows.filter((row) => row.value).length, 3);
});

test('options without a group get no heading', () => {
  assert.deepEqual(menuRows([{ label: 'Tactical', value: 't' }], '').rows, [
    { label: 'Tactical', value: 't' },
  ]);
});
