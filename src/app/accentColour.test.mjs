import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACCENT_KEY,
  accent,
  accentPicker,
  accentRgb,
  DEFAULT_ACCENT,
  installAccent,
  luminance,
  MIN_LUMINANCE,
  onAccent,
  setAccent,
  SWATCHES,
  tidyAccent,
} from './accentColour.js';
import { fakeDocument } from './fakeDom.mjs';

const memory = (entries = {}) => ({
  values: { ...entries },
  getItem(key) {
    return Object.hasOwn(this.values, key) ? this.values[key] : null;
  },
  setItem(key, value) {
    this.values[key] = String(value);
  },
});

/** A fake page whose root keeps the CSS variables it is given. */
const page = () => {
  const doc = fakeDocument();
  const vars = {};
  doc.documentElement.style.setProperty = (name, value) => {
    vars[name] = value;
  };
  return { doc, vars };
};

test('the six ready colours are bright enough, and cyan is the default', () => {
  assert.deepEqual(
    SWATCHES.map((swatch) => swatch.name),
    ['Cyan', 'Green', 'Amber', 'Red', 'Magenta', 'White'],
  );
  for (const { name, hex } of SWATCHES) {
    assert.equal(tidyAccent(hex), hex, name);
    assert.ok(luminance(hex) >= MIN_LUMINANCE, name);
  }
  assert.equal(SWATCHES[0].hex, DEFAULT_ACCENT);
});

test('only a bright #rrggbb colour is taken, in small letters', () => {
  for (const bad of ['red', '#fff', '#000000', '#0a0a0a', '', '<script>alert(1)</script>', '#ffb000;color:red', null, 42])
    assert.equal(tidyAccent(bad), null, String(bad));
  assert.equal(tidyAccent('#FFB000'), '#ffb000');
  assert.equal(luminance('#ffffff'), 1);
  assert.equal(luminance('#000000'), 0);
  assert.equal(accentRgb('#ffb000'), '255, 176, 0');
  assert.equal(accentRgb('#00f6ff'), '0, 246, 255');
});

test('the saved colour starts the page, and a new one is kept and announced', () => {
  const { doc, vars } = page();
  const storage = memory({ [ACCENT_KEY]: '#39ff6a' });
  installAccent(doc, storage);
  assert.equal(accent(), '#39ff6a');
  assert.deepEqual(vars, { '--zenith-accent': '#39ff6a', '--zenith-accent-rgb': '57, 255, 106' });

  const heard = [];
  const stop = onAccent((hex) => heard.push(hex));
  assert.equal(setAccent('#FFB000'), true);
  assert.equal(accent(), '#ffb000');
  assert.equal(storage.values[ACCENT_KEY], '#ffb000');
  assert.equal(vars['--zenith-accent-rgb'], '255, 176, 0');
  // Too dark: refused, and nothing changes.
  assert.equal(setAccent('#0a0a0a'), false);
  assert.equal(accent(), '#ffb000');
  stop();
  setAccent('#ffffff');
  assert.deepEqual(heard, ['#ffb000']);

  // A damaged or dark saved value, or blocked storage, starts cyan.
  installAccent(page().doc, memory({ [ACCENT_KEY]: '#000000' }));
  assert.equal(accent(), DEFAULT_ACCENT);
  installAccent(page().doc, {
    getItem() {
      throw new Error('blocked');
    },
  });
  assert.equal(accent(), DEFAULT_ACCENT);
});

test('one drawing that fails does not stop the others', (t) => {
  t.mock.method(console, 'error', () => {});
  installAccent(page().doc, memory());
  const heard = [];
  const stopBad = onAccent(() => {
    throw new Error('broken drawing');
  });
  const stopGood = onAccent((hex) => heard.push(hex));
  setAccent('#ff3b3b');
  stopBad();
  stopGood();
  assert.deepEqual(heard, ['#ff3b3b']);
});

test('the picker marks the chosen colour, changes it, and refuses a dark one', () => {
  const { doc } = page();
  installAccent(doc, memory());
  const box = accentPicker(doc);
  doc.body.appendChild(box);
  const buttons = box.querySelectorAll('button');
  assert.equal(buttons.length, 6);
  const pressed = () => buttons.filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.getAttribute('aria-label'));
  assert.deepEqual(pressed(), ['Cyan']);
  assert.equal(buttons[2].style.background, '#ffb000');

  buttons[2].click();
  assert.equal(accent(), '#ffb000');
  assert.deepEqual(pressed(), ['Amber']);

  const input = doc.getElementById('zenith-accent-any');
  const any = input.parentNode;
  assert.equal(input.getAttribute('aria-label'), 'Any colour');
  assert.equal(any.dataset.on, 'false');
  input.value = '#123abc';
  input.dispatchEvent(new Event('change'));
  assert.equal(accent(), '#ffb000', 'too dark: kept amber');
  assert.match(box.textContent, /too dark/);
  assert.equal(input.value, '#ffb000');

  input.value = '#80d0ff';
  input.dispatchEvent(new Event('change'));
  assert.equal(accent(), '#80d0ff');
  assert.deepEqual(pressed(), []);
  assert.equal(any.dataset.on, 'true');
  assert.doesNotMatch(box.textContent, /too dark/);
  setAccent(DEFAULT_ACCENT);
});
