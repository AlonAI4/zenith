/**
 * Which build of Zenith this is, and what changed in it, in plain words.
 *
 * This is the one place it is written down. The help card in the app reads
 * it, and so does the download page when it is built (alon-site-build.sh).
 * For a new build: raise the number, set the date, and rewrite the list for
 * people who use the app, not for programmers.
 */
export const ZENITH_VERSION = Object.freeze({
  number: '1.0',
  date: '13 October 2026',
  changes: Object.freeze([
    "Live earthquakes: the last day's earthquakes around the world, sized by strength.",
    'Fly-through: tick two or more saved places and the view travels between them.',
    'The measure tool now has undo, the area of a closed shape, and a chart of the heights along your path.',
    'The map pin gives an address anywhere in the world, with the house number where the map data has one, plus sunrise and sunset.',
    'Train stations for the whole UK, Germany, Italy, the Netherlands and eleven big city areas in the USA.',
    'Day and night has a time slider, sharper city lights and a clear line where night begins.',
    'Saved places remember the map, the look and the layers that were on.',
    'Video mode lets you pick the speed and the direction.',
    'Your switches and saved places can be saved to a file and loaded in another browser.',
  ]),
});

/** "Zenith 1.0 · 13 October 2026" */
export function versionLine(version = ZENITH_VERSION) {
  return `Zenith ${version.number} · ${version.date}`;
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

/** The list of changes as HTML list items, for the download page. */
export function changesAsHtml(changes = ZENITH_VERSION.changes) {
  return changes
    .map(
      (line) =>
        `<li>${String(line).replace(/[&<>"]/g, (c) => HTML_ESCAPES[c])}</li>`,
    )
    .join('\n        ');
}
