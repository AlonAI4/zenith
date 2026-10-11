import assert from 'node:assert/strict';
import test from 'node:test';

import { tooltipFor } from './buttonTooltips.js';

function button({
  id = '',
  classes = [],
  aria = '',
  text = '',
  dataset = {},
} = {}) {
  return {
    id,
    dataset,
    textContent: text,
    classList: { contains: (name) => classes.includes(name) },
    getAttribute: (name) => (name === 'aria-label' ? aria : null),
  };
}

test('a known id wins over the aria-label', () => {
  assert.equal(
    tooltipFor(button({ id: 'radio-enable-btn', aria: 'Enable Radio' })),
    'Turn the radio layer on or off',
  );
});

test('a layer row names the action, not its current state', () => {
  assert.equal(
    tooltipFor(
      button({ classes: ['data-toggle-btn'], aria: 'Satellites: OFF' }),
    ),
    'Turn Satellites on or off',
  );
});

test('id-less buttons are told apart by group and label', () => {
  assert.equal(
    tooltipFor(button({ classes: ['location-pill'], text: ' London ' })),
    'Fly to London',
  );
  assert.equal(
    tooltipFor(button({ classes: ['scene-shot-btn'], text: 'DEL' })),
    'Delete this shot',
  );
});

test('an unknown button falls back to its aria-label, else nothing', () => {
  assert.equal(
    tooltipFor(button({ aria: 'Stop radio playback' })),
    'Stop radio playback',
  );
  assert.equal(tooltipFor(button({ text: 'MYSTERY' })), '');
});
