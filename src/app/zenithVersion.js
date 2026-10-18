/**
 * Which build of Zenith this is, and what changed in it, in plain words.
 *
 * This is the one place it is written down. The help card in the app reads
 * it, and so does the download page when it is built (alon-site-build.sh).
 * For a new build: raise the number, set the date, and rewrite the list for
 * people who use the app, not for programmers.
 */
export const ZENITH_VERSION = Object.freeze({
  number: '1.3.3',
  date: '18 October 2026',
  changes: Object.freeze([
    'A shorter top bar: the map overlays live in one LAYERS menu, with a number for how many are on.',
    'Every switch has a key, shown in its tooltip and the help card: P map pin, M measure, A layers and more.',
    'The tilt and north buttons are gone from the bar: the compass does both (drag its arc, click its N).',
    'Single-letter keys can be switched off in the help card, and they never fire while you type.',
  ]),
});

/** "Zenith 1.1 · 13 October 2026" */
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
