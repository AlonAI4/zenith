import assert from 'node:assert/strict';
import test from 'node:test';

import {
  agentLine,
  bootLines,
  cleanCodename,
  decrypt,
  reducedMotion,
  scrambleFrames,
} from './classified.js';

test('scrambled text settles into the real text, keeping its spaces and punctuation', () => {
  let n = 0;
  const random = () => (n += 0.37) % 1;
  const frames = scrambleFrames('10 Downing Street, London', 12, random);
  assert.equal(frames.length, 12);
  assert.equal(frames.at(-1), '10 Downing Street, London');
  assert.notEqual(frames[0], frames.at(-1));
  for (const frame of frames) {
    assert.equal(frame.length, '10 Downing Street, London'.length);
    assert.equal(frame[2], ' ');
    assert.equal(frame[17], ',');
  }
  assert.deepEqual(scrambleFrames('', 3), ['', '', '']);
});

function fakeElement() {
  const span = () => ({
    textContent: '',
    className: '',
    hidden: null,
    setAttribute(name, value) {
      if (name === 'aria-hidden') this.hidden = value;
    },
  });
  const element = {
    ownerDocument: { createElement: span },
    children: [],
    own: '',
    get textContent() {
      return this.children.length
        ? this.children.map((c) => c.textContent).join('')
        : this.own;
    },
    set textContent(value) {
      this.own = value;
      this.children = [];
    },
    replaceChildren(...children) {
      this.children = children;
    },
  };
  return element;
}

test('decrypting ends on the real text, screen readers only ever get the real text, and reduced motion shows it at once', () => {
  const element = fakeElement();
  const timers = [];
  const win = {
    matchMedia: () => ({ matches: false }),
    setInterval: (fn) => timers.push(fn) && timers.length,
    clearInterval: () => {},
  };
  decrypt(element, 'Buckingham Palace', { win });
  const [shown, heard] = element.children;
  assert.equal(
    shown.hidden,
    'true',
    'the scrambled letters are hidden from screen readers',
  );
  assert.notEqual(shown.textContent, 'Buckingham Palace');
  assert.equal(heard.textContent, 'Buckingham Palace');
  for (let i = 0; i < 40; i++) timers[0]();
  assert.equal(element.textContent, 'Buckingham Palace');

  const still = fakeElement();
  decrypt(still, 'Buckingham Palace', {
    win: { ...win, matchMedia: () => ({ matches: true }) },
  });
  assert.equal(still.textContent, 'Buckingham Palace');
  assert.equal(still.children.length, 0);
  assert.equal(reducedMotion({ matchMedia: () => ({ matches: true }) }), true);
  assert.equal(reducedMotion({}), false);
});

test('the agent line shows the codename and the time in UTC', () => {
  const at = new Date(Date.UTC(2026, 9, 17, 21, 4, 9));
  assert.equal(agentLine('falcon', at), 'AGENT FALCON · 21:04:09Z');
  assert.equal(agentLine('', at), 'AGENT UNASSIGNED · 21:04:09Z');
  assert.match(bootLines('Falcon').join('\n'), /AGENT FALCON/);
});

test('a codename keeps only letters, digits, spaces and dashes', () => {
  assert.equal(cleanCodename('  Night <b>Owl</b>!! '), 'Night bOwlb');
  assert.equal(cleanCodename('A'.repeat(40)).length, 16);
  assert.equal(cleanCodename(null), '');
});
