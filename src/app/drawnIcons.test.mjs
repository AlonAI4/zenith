import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EMOJI_ICONS,
  ICONS,
  emojiParts,
  iconFor,
  iconMarkup,
  installDrawnIcons,
} from './drawnIcons.js';

test('every emoji the original app shows has its own drawn icon', () => {
  const shown =
    '🚗🚀🚶🚲🧭✈️✈📡📹🌬📷🛰️🛰🎖️🚌🚊🚇🚆⛴️🚏🔥☁🌋🌊📍⚠️⚠🌙🌡️✦❄🛸🔗🔎🔍✨🔴🟡';
  const parts = emojiParts(shown);
  assert.ok(parts.every((part) => part.emoji && part.icon !== 'other'));
  for (const icon of Object.values(EMOJI_ICONS)) assert.ok(ICONS[icon], icon);
});

test('text is split into plain runs and emojis, variation selector kept', () => {
  assert.deepEqual(emojiParts('📍 London'), [
    { emoji: '📍', icon: 'pin' },
    { text: ' London' },
  ]);
  assert.deepEqual(emojiParts('Live ✈️ flights'), [
    { text: 'Live ' },
    { emoji: '✈️', icon: 'plane' },
    { text: ' flights' },
  ]);
});

test('a sequence is one emoji, and the emoji block counts even without a colour flag', () => {
  for (const text of ['👨‍👩‍👧', '👍🏽', '🇬🇧', '1️⃣', 'ℹ️', '🗺']) {
    assert.deepEqual(emojiParts(text), [{ emoji: text, icon: 'other' }]);
  }
  assert.deepEqual(emojiParts('🚶‍♂️'), [{ emoji: '🚶‍♂️', icon: 'walk' }]);
});

test('arrows and shapes that draw as plain text are left alone', () => {
  assert.equal(emojiParts('▶ PLAY'), null);
  assert.equal(emojiParts('OPEN ORIGINAL ↗'), null);
  assert.equal(emojiParts('◉ ϟ ◭ ⌖ ▣ ≋ ▰ ◐ ▦'), null);
  assert.equal(emojiParts('❄︎'), null);
  assert.equal(emojiParts('Plain words'), null);
  assert.equal(emojiParts(''), null);
});

test('an emoji not in the list still becomes a drawn mark, never itself', () => {
  assert.equal(iconFor('🦄'), 'other');
  assert.deepEqual(emojiParts('🦄'), [{ emoji: '🦄', icon: 'other' }]);
});

test('icons are line drawings in the text colour, hidden from screen readers', () => {
  for (const name of Object.keys(ICONS)) {
    const svg = iconMarkup(name);
    assert.match(svg, /^<svg viewBox="0 0 24 24" [^>]*aria-hidden="true"/);
    assert.match(svg, /stroke="currentColor"/);
    assert.equal(emojiParts(svg), null, name);
  }
  assert.equal(iconMarkup('nope'), iconMarkup('other'));
});

/** Just enough of a page for the add-on: text nodes, spans and one observer. */
function tinyPage() {
  let observed = null;
  class Node {
    constructor(doc) {
      this.ownerDocument = doc;
      this.parentNode = null;
      this.childNodes = [];
    }
    get nextSibling() {
      const list = this.parentNode?.childNodes ?? [];
      return list[list.indexOf(this) + 1] ?? null;
    }
    get isConnected() {
      return this.parentNode ? this.parentNode.isConnected : this === page.body;
    }
    remove() {
      if (!this.parentNode) return;
      const list = this.parentNode.childNodes;
      list.splice(list.indexOf(this), 1);
      this.parentNode = null;
      observed?.queue.push({
        type: 'childList',
        addedNodes: [],
        removedNodes: [this],
      });
    }
  }
  class Text extends Node {
    constructor(doc, data) {
      super(doc);
      this.nodeType = 3;
      this._data = data;
    }
    get data() {
      return this._data;
    }
    set data(value) {
      this._data = value;
      observed?.queue.push({ type: 'characterData', target: this });
    }
    get textContent() {
      return this._data;
    }
  }
  class Element extends Node {
    constructor(doc, tag) {
      super(doc);
      this.nodeType = 1;
      this.tagName = tag.toUpperCase();
      this.className = '';
      this.dataset = {};
    }
    insertBefore(node, next) {
      node.remove();
      const index = next ? this.childNodes.indexOf(next) : -1;
      if (index < 0) this.childNodes.push(node);
      else this.childNodes.splice(index, 0, node);
      node.parentNode = this;
      observed?.queue.push({
        type: 'childList',
        addedNodes: [node],
        removedNodes: [],
      });
      return node;
    }
    appendChild(node) {
      return this.insertBefore(node, null);
    }
    set innerHTML(markup) {
      this.markup = markup;
    }
    get textContent() {
      return this.childNodes.map((node) => node.textContent ?? '').join('');
    }
    set textContent(value) {
      for (const node of [...this.childNodes]) node.remove();
      this.appendChild(new Text(page, value));
    }
    closest(selector) {
      const classes = selector
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.startsWith('.'))
        .map((part) => part.slice(1));
      for (let at = this; at; at = at.parentNode) {
        if (classes.includes(at.className)) return at;
      }
      return null;
    }
  }
  const page = {
    createElement: (tag) => new Element(page, tag),
    createTextNode: (data) => new Text(page, data),
    createTreeWalker(root) {
      const found = [];
      const walk = (node) => {
        if (node.nodeType === 3) found.push(node);
        node.childNodes.forEach(walk);
      };
      walk(root);
      return { nextNode: () => found.shift() ?? null };
    },
    defaultView: {
      MutationObserver: class {
        constructor(callback) {
          this.queue = [];
          this.callback = callback;
          observed = this;
        }
        observe() {}
        disconnect() {
          observed = null;
        }
        takeRecords() {
          return this.queue.splice(0);
        }
      },
    },
    flush() {
      const records = observed.takeRecords();
      if (records.length) observed.callback(records);
    },
  };
  page.head = page.createElement('head');
  page.body = page.createElement('body');
  return page;
}

test('the page shows a drawn icon and keeps the emoji only for screen readers', () => {
  const page = tinyPage();
  const line = page.createElement('div');
  line.textContent = '📍 London';
  page.body.appendChild(line);
  const stop = installDrawnIcons(page);
  try {
    const [text, glyph, rest] = line.childNodes;
    assert.equal(text.data, '');
    assert.equal(glyph.className, 'zenith-glyph');
    assert.equal(glyph.dataset.glyph, 'pin');
    assert.match(glyph.markup, /aria-hidden="true"/);
    assert.equal(glyph.childNodes[0].className, 'zenith-glyph-text');
    assert.equal(rest.data, ' London');
    // The original's code that reads its text back still finds what it wrote.
    assert.equal(line.textContent, '📍 London');
  } finally {
    stop();
  }
});

test('text that changes later is redrawn without leaving old icons behind', () => {
  const page = tinyPage();
  const stop = installDrawnIcons(page);
  try {
    const line = page.createElement('div');
    page.body.appendChild(line);
    line.textContent = '🚀 Launches';
    page.flush();
    const text = line.childNodes[0];
    assert.equal(line.childNodes.length, 3);
    // The original updates its own text node in place.
    text.data = '🚌 Bus 17';
    page.flush();
    assert.equal(line.textContent, '🚌 Bus 17');
    const glyphs = line.childNodes.filter(
      (n) => n.className === 'zenith-glyph',
    );
    assert.equal(glyphs.length, 1);
    assert.equal(glyphs[0].dataset.glyph, 'bus');
    text.data = 'Location: --';
    page.flush();
    assert.equal(line.childNodes.length, 1);
    assert.equal(line.textContent, 'Location: --');
  } finally {
    stop();
  }
});

test('a split text moved by the page keeps its icon', () => {
  const page = tinyPage();
  const stop = installDrawnIcons(page);
  try {
    const from = page.createElement('div');
    const to = page.createElement('div');
    page.body.appendChild(from);
    page.body.appendChild(to);
    from.textContent = '▶ 🚀 Go';
    page.flush();
    // The text node alone is moved; its icon is drawn again where it lands.
    to.appendChild(from.childNodes[0]);
    page.flush();
    assert.equal(from.textContent, '');
    assert.equal(to.textContent, '▶ 🚀 Go');
    assert.equal(to.childNodes.filter((n) => n.dataset?.glyph).length, 1);
    // A whole element moved takes its icons with it.
    page.body.appendChild(to);
    page.flush();
    assert.equal(to.textContent, '▶ 🚀 Go');
  } finally {
    stop();
  }
});

test('a page that rewrites the last piece of a split text gets just that text', () => {
  const page = tinyPage();
  const stop = installDrawnIcons(page);
  try {
    const head = page.createElement('div');
    page.body.appendChild(head);
    head.textContent = 'Live 🚀 rockets';
    page.flush();
    const last = head.childNodes[head.childNodes.length - 1];
    last.data = 'Buses 🚌';
    page.flush();
    assert.equal(head.textContent, 'Buses 🚌');
    const glyphs = head.childNodes.filter((n) => n.dataset?.glyph);
    assert.deepEqual(
      glyphs.map((n) => n.dataset.glyph),
      ['bus'],
    );
  } finally {
    stop();
  }
});

test('a split text taken out by the page takes its icon with it', () => {
  const page = tinyPage();
  const stop = installDrawnIcons(page);
  try {
    const line = page.createElement('div');
    page.body.appendChild(line);
    line.textContent = '📍 London';
    page.flush();
    const text = line.childNodes[0];
    text.remove();
    page.flush();
    assert.equal(line.childNodes.length, 0);
    assert.equal(text.data, '📍 London');
  } finally {
    stop();
  }
});
