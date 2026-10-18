/**
 * No emojis on screen. Every emoji the page shows is swapped for a drawn line
 * icon of the same meaning, in the toolbar's style (24-unit grid, a 1.8 stroke
 * in the text's own colour). Emojis look different on every computer and look
 * out of place next to the line icons, so Zenith draws its own.
 *
 * Most emojis come from the original app's files (layer icons, the Visual
 * Presets buttons, the Location line, the key setup dots), and lists drawn
 * later bring new ones, so this watches the page for new text instead of
 * editing those files. The emoji itself stays in the page, visually hidden:
 * screen readers still read it, and the original's code that reads the text
 * back finds what it wrote. Text drawn on the map canvas cannot hold an icon;
 * those few strings were changed where they are made.
 */

const STROKE =
  'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';

/** name -> the inside of a 24x24 SVG. */
export const ICONS = Object.freeze({
  car: '<path d="M3 16.5v-4.3l2.1-5A1.6 1.6 0 0 1 6.6 6h10.8a1.6 1.6 0 0 1 1.5 1.2l2.1 5v4.3H19M5 16.5H3M3 12.2h18M9.2 16.5h5.6"/><circle cx="7.1" cy="16.6" r="2"/><circle cx="16.9" cy="16.6" r="2"/>',
  rocket:
    '<path d="M12 2.5c3 2.2 4.5 5.5 4.5 9.5v4.5h-9V12c0-4 1.5-7.3 4.5-9.5zM7.5 13.2 5 15.8v3.4l2.5-1.6M16.5 13.2l2.5 2.6v3.4l-2.5-1.6M10.5 19.5 12 22l1.5-2.5"/><circle cx="12" cy="9.5" r="1.6"/>',
  walk: '<circle cx="13.2" cy="4.2" r="1.8"/><path d="M12.6 7.6 10.8 13l3 2.6 1 5.4M10.8 13l-2.4 7.6M12.3 9.2l3.3 2.6 2.6-.4M12.3 9.2 9 10.6l-1.6 3"/>',
  bike: '<circle cx="5.8" cy="16" r="3.6"/><circle cx="18.2" cy="16" r="3.6"/><path d="M5.8 16 9.6 8.6h5.6M9.6 8.6l3.1 7.4H5.8M18.2 16l-3.3-9.4h-2.6"/>',
  compass:
    '<circle cx="12" cy="12" r="9"/><path d="m15.6 8.4-2.1 5.1-5.1 2.1 2.1-5.1z"/>',
  plane:
    '<path d="M10.5 9.2V4.4a1.5 1.5 0 0 1 3 0v4.8l7.5 4.6v1.9l-7.5-2.3v4.7l2 1.5v1.6l-3.5-1-3.5 1v-1.6l2-1.5v-4.7L3 15.7v-1.9z"/>',
  antenna:
    '<path d="M4.5 9.2a10.3 10.3 0 0 0 10.3 10.3zM9.7 14.3l4.2-4.2M16.4 6.2a3.6 3.6 0 0 1 1.4 1.4M18.4 3.2a7.2 7.2 0 0 1 2.4 2.4M9 19.6 7.6 22h6.8"/><circle cx="14.5" cy="9.5" r="1"/>',
  video:
    '<rect x="2.5" y="6.5" width="12.5" height="11" rx="2"/><path d="m15 10.5 6.5-3.6v10.2L15 13.5"/>',
  wind: '<path d="M3 8.5h10.2a2.6 2.6 0 1 0-2.6-2.6M3 12.5h15.3a2.9 2.9 0 1 1-2.9 2.9M3 16.5h7.5"/>',
  camera:
    '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  satellite:
    '<g transform="rotate(-40 12 12)"><rect x="9.6" y="8.6" width="4.8" height="6.8" rx="1"/><path d="M2.5 10h5.6v4H2.5zM15.9 10h5.6v4h-5.6zM8.1 12h1.5M14.4 12h1.5M12 15.4v2.8"/></g><path d="M16 19.5a4 4 0 0 0 3.4-3.4"/>',
  medal:
    '<path d="M8 2.5h8l-2.6 7.1M8 2.5l2.6 7.1"/><circle cx="12" cy="15.3" r="5.6"/><circle cx="12" cy="15.3" r="2.2"/>',
  bus: '<rect x="5" y="3" width="14" height="15" rx="2.5"/><path d="M5 7.2h14M5 11.6h14M7.6 18v2.6M16.4 18v2.6M8 14.8h.1M16 14.8h.1"/>',
  tram: '<rect x="6" y="5.5" width="12" height="12.5" rx="2.5"/><path d="M9 2.5h6M12 2.5v3M6 11h12M8.3 18 6.3 21.5M15.7 18l2 3.5M9 14.6h.1M15 14.6h.1"/>',
  underground:
    '<path d="M3 21.5V12a9 9 0 0 1 18 0v9.5"/><rect x="8" y="9" width="8" height="9" rx="2.2"/><path d="M8 13h8M9.6 18l-1.2 3M14.4 18l1.2 3"/>',
  train:
    '<rect x="6" y="3" width="12" height="14" rx="2"/><path d="M6 9.5h12M12 3v6.5M8.6 17l-1.8 4M15.4 17l1.8 4M9 13.4h.1M15 13.4h.1"/>',
  ferry:
    '<path d="m3 14.5 2 5h14l2-5zM7 14.5v-4h10v4M10 10.5V7.5h4v3M2.5 22c1.6 0 1.6-.9 3.2-.9s1.6.9 3.2.9 1.6-.9 3.2-.9 1.6.9 3.2.9 1.6-.9 3.2-.9 1.6.9 3.2.9"/>',
  'bus-stop':
    '<rect x="6.5" y="2.5" width="11" height="7" rx="1.6"/><path d="M12 9.5v11.5M9 21h6M9.5 6h5"/>',
  flame:
    '<path d="M12 21.5c-3.9 0-6.5-2.7-6.5-6.3 0-3.6 2.9-5.7 3.6-9.7 2.7 1.7 3.6 4 3.6 6 1.4-.5 2.1-1.8 2.3-3.2 2 1.7 3.5 4.2 3.5 6.9 0 3.6-2.6 6.3-6.5 6.3z"/>',
  cloud:
    '<path d="M7.2 18.5h9.9a4 4 0 0 0 .5-8 5.6 5.6 0 0 0-10.7 1.1 3.5 3.5 0 0 0 .3 6.9z"/>',
  volcano:
    '<path d="m2.5 20.5 6-9h7l6 9zM8.5 11.5 10 13h4l1.5-1.5M10.5 7.5c0-1.6 1.1-2.1 2.1-2.1s1.9-.6 1.9-2M14 8c.9-.6 2.2-.4 2.8-1.6"/>',
  wave: '<path d="M2 15.5c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2M2 19.5c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2M5 11.5c0-4.2 3-7.5 7-7.5 2.5 0 4.2 1.6 4.2 3.6S14.6 11 13 11"/>',
  pin: '<path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  warning: '<path d="M12 3.5 21.5 20h-19zM12 10v4.5M12 17.4v.1"/>',
  moon: '<path d="M20 14.6A8.5 8.5 0 1 1 9.4 4a7 7 0 0 0 10.6 10.6z"/>',
  thermometer:
    '<path d="M10 14.8V5a2 2 0 1 1 4 0v9.8a4 4 0 1 1-4 0zM12 9v7.5"/>',
  star: '<path d="M12 3c.6 4.6 3.4 7.4 9 9-5.6 1.6-8.4 4.4-9 9-.6-4.6-3.4-7.4-9-9 5.6-1.6 8.4-4.4 9-9z"/>',
  snowflake:
    '<path d="M12 2.5v19M3.8 7.2l16.4 9.6M3.8 16.8l16.4-9.6M9.6 3.9 12 6.1l2.4-2.2M9.6 20.1l2.4-2.2 2.4 2.2M3.6 10.4l3.1 1-.7 3.1M20.4 13.6l-3.1-1 .7-3.1M6 9.5l.7-3.1M18 14.5l-.7 3.1"/>',
  ufo: '<path d="M2.5 14c0-2.2 4.3-4 9.5-4s9.5 1.8 9.5 4-4.3 4-9.5 4-9.5-1.8-9.5-4zM7.5 10.7a4.5 4.5 0 0 1 9 0M7 19.8l-1 1.7M12 18.6v3M17 19.8l1 1.7"/>',
  link: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.2 1.2M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.3 15.3 5.7 5.7"/>',
  sparkles:
    '<path d="M10 3.5c.5 3.6 2.6 5.7 6.5 6.5-3.9.8-6 2.9-6.5 6.5-.5-3.6-2.6-5.7-6.5-6.5 3.9-.8 6-2.9 6.5-6.5zM18 14.5c.2 1.5 1 2.3 2.5 2.5-1.5.2-2.3 1-2.5 2.5-.2-1.5-1-2.3-2.5-2.5 1.5-.2 2.3-1 2.5-2.5zM18 3v3.4M16.3 4.7h3.4"/>',
  'red-dot': '<circle cx="12" cy="12" r="6" fill="#ff4d4f" stroke="none"/>',
  'yellow-dot': '<circle cx="12" cy="12" r="6" fill="#ffc83d" stroke="none"/>',
  // Any emoji not in the list below: a plain ring, never the emoji.
  other: '<circle cx="12" cy="12" r="5"/>',
});

/** Each emoji (without its variation selector) and the icon drawn for it. */
export const EMOJI_ICONS = Object.freeze({
  '🚗': 'car',
  '🚀': 'rocket',
  '🚶': 'walk',
  '🚲': 'bike',
  '🧭': 'compass',
  '✈': 'plane',
  '📡': 'antenna',
  '📹': 'video',
  '🌬': 'wind',
  '📷': 'camera',
  '🛰': 'satellite',
  '🎖': 'medal',
  '🚌': 'bus',
  '🚊': 'tram',
  '🚇': 'underground',
  '🚆': 'train',
  '⛴': 'ferry',
  '🚏': 'bus-stop',
  '🔥': 'flame',
  '☁': 'cloud',
  '🌋': 'volcano',
  '🌊': 'wave',
  '📍': 'pin',
  '⚠': 'warning',
  '🌙': 'moon',
  '🌡': 'thermometer',
  '✦': 'star',
  '❄': 'snowflake',
  '🛸': 'ufo',
  '🔗': 'link',
  '🔎': 'search',
  '🔍': 'search',
  '✨': 'sparkles',
  '🔴': 'red-dot',
  '🟡': 'yellow-dot',
});

/**
 * What counts as an emoji: every emoji sequence (with skin tones, families,
 * flags and keycaps as one), anything else in the emoji block, which a Mac
 * draws in colour, and the listed text symbols that sit among them as icons
 * (cloud, star, snowflake, warning) unless they are asked to be drawn as text
 * (U+FE0E).
 */
export const EMOJI = new RegExp(
  `\\p{RGI_Emoji}|(?:${Object.keys(EMOJI_ICONS).join('|')})(?!\\uFE0E)\\uFE0F?|(?=[\\u{1F000}-\\u{1FAFF}])\\p{Extended_Pictographic}\\uFE0F?`,
  'gv',
);
/** A quick first look: every emoji and listed symbol has one of these. */
const QUICK = /[⌀-⯿\u{1F000}-\u{1FAFF}️⃣]/u;

/** The name of the icon drawn for one emoji, or for the first of a sequence. */
export function iconFor(emoji) {
  const plain = emoji.replace(/[︎️]/g, '');
  return (
    EMOJI_ICONS[plain] ??
    EMOJI_ICONS[String.fromCodePoint(plain.codePointAt(0))] ??
    'other'
  );
}

/**
 * A text split into plain runs and emojis, in order; null when it has none.
 * @returns {Array<{ text: string } | { emoji: string, icon: string }> | null}
 */
export function emojiParts(text) {
  if (!text || !QUICK.test(text)) return null;
  const parts = [];
  let last = 0;
  for (const match of text.matchAll(EMOJI)) {
    if (match.index > last) parts.push({ text: text.slice(last, match.index) });
    parts.push({ emoji: match[0], icon: iconFor(match[0]) });
    last = match.index + match[0].length;
  }
  if (last === 0) return null;
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

/** The SVG for an icon name, hidden from screen readers. */
export function iconMarkup(name) {
  return `<svg viewBox="0 0 24 24" ${STROKE} aria-hidden="true" focusable="false">${ICONS[name] ?? ICONS.other}</svg>`;
}

const STYLE = `
.zenith-glyph { display: inline-block; width: 1.05em; height: 1.05em; vertical-align: -0.16em; line-height: 1; }
.zenith-glyph svg { display: block; width: 100%; height: 100%; overflow: visible; }
.zenith-glyph-text {
  display: inline-block; width: 1px; height: 1px; margin: -1px; padding: 0; border: 0;
  overflow: hidden; clip-path: inset(50%); white-space: nowrap;
}
`;

/** Where text is code, typed by the person, or not drawn as text at all. */
const SKIP = 'script, style, textarea, svg, option, title, [contenteditable]';

/**
 * @param {Document} [doc]
 * @returns {() => void} Stops watching. Icons already drawn stay.
 */
export function installDrawnIcons(doc = document) {
  const win = doc.defaultView ?? globalThis;
  const style = doc.createElement('style');
  style.id = 'zenith-glyph-style';
  style.textContent = STYLE;
  doc.head.appendChild(style);

  // Each split text node: the nodes put in after it, its whole text before
  // the split and what it was left holding.
  const drawn = new WeakMap();
  // The plain text nodes put in after a split node, and the node they follow.
  const ownerOf = new WeakMap();
  // Text nodes already drawn in this batch of changes: a second pass would
  // find only the plain text left and drop the icons.
  const done = new Set();

  const glyph = (emoji, icon) => {
    const holder = doc.createElement('span');
    holder.className = 'zenith-glyph';
    holder.dataset.glyph = icon;
    holder.innerHTML = iconMarkup(icon);
    const said = doc.createElement('span');
    said.className = 'zenith-glyph-text';
    said.textContent = emoji;
    holder.appendChild(said);
    return holder;
  };

  /** Takes out what was put in after a split node, except `keep`. */
  const undo = (node, keep = null) => {
    for (const item of drawn.get(node)?.nodes ?? []) {
      ownerOf.delete(item);
      if (item !== keep) item.remove();
    }
    drawn.delete(node);
  };

  const redraw = (node) => {
    if (done.has(node)) return;
    done.add(node);
    undo(node);
    const parent = node.parentNode;
    if (!parent || parent.closest?.(`${SKIP}, .zenith-glyph`)) return;
    const parts = emojiParts(node.data);
    if (!parts) return;
    // The text node keeps the first plain run, so code holding it still
    // holds the start of what it wrote; the rest follows it.
    const [first, ...rest] = parts;
    const after = [];
    if (first.text === undefined) after.push(glyph(first.emoji, first.icon));
    for (const part of rest) {
      if (part.text === undefined) after.push(glyph(part.emoji, part.icon));
      else {
        const text = doc.createTextNode(part.text);
        ownerOf.set(text, node);
        after.push(text);
      }
    }
    const full = node.data;
    node.data = first.text ?? '';
    const next = node.nextSibling;
    for (const item of after) parent.insertBefore(item, next);
    drawn.set(node, { nodes: after, full, left: node.data });
  };

  const changed = (node) => {
    const owner = ownerOf.get(node);
    if (owner) {
      // The page rewrote the last piece of a split text as if it were all
      // of it: that piece is now the whole text.
      undo(owner, node);
      owner.data = '';
    }
    if (QUICK.test(node.data) || drawn.has(node)) redraw(node);
  };

  const removed = (node) => {
    const was = drawn.get(node);
    if (!was) return;
    // Taken out or moved: its icons go with it, and its text is whole again,
    // to be drawn afresh wherever it is put back.
    undo(node);
    if (node.data === was.left) node.data = was.full;
  };

  const scan = (root) => {
    if (root.nodeType === 3) {
      if (!drawn.has(root) && !ownerOf.has(root)) redraw(root);
      return;
    }
    if (root.nodeType !== 1 && root.nodeType !== 11) return;
    if (root.closest?.(`${SKIP}, .zenith-glyph`)) return;
    const walker = doc.createTreeWalker(root, 4);
    const found = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      // Already split and only moved with its element: its icons came too.
      if (!drawn.has(node) && !ownerOf.has(node) && QUICK.test(node.data))
        found.push(node);
    }
    found.forEach(redraw);
  };

  const observer = new win.MutationObserver((records) => {
    done.clear();
    for (const record of records) {
      if (record.type === 'characterData') changed(record.target);
      else {
        for (const node of record.removedNodes) {
          if (node.nodeType === 3) removed(node);
        }
        for (const node of record.addedNodes) {
          if (node.isConnected) scan(node);
        }
      }
    }
    // What this callback changed itself is not news.
    observer.takeRecords();
    done.clear();
  });
  scan(doc.body);
  done.clear();
  observer.observe(doc.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  return () => {
    observer.disconnect();
    style.remove();
  };
}
