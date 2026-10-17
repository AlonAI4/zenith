/**
 * Which build of Zenith this is, and what changed in it, in plain words.
 *
 * This is the one place it is written down. The help card in the app reads
 * it, and so does the download page when it is built (alon-site-build.sh).
 * For a new build: raise the number, set the date, and rewrite the list for
 * people who use the app, not for programmers.
 */
export const ZENITH_VERSION = Object.freeze({
  number: '1.3',
  date: '17 October 2026',
  changes: Object.freeze([
    'Right-click a house, building or park: it lights up, with a target box of its address, size, floors and British grid reference.',
    'Search a street address, such as 10 Downing Street, and the view goes straight down over that house.',
    'The classified look (TS switch): decrypting text, REDACTED lines, a TRACKING lock-on, FLIR readouts and your codename.',
    'SAVE CASE FILE keeps a picture of a target box, with a TOP SECRET stamp, in My photos.',
    'Free voice control with no OpenAI key: hold V and say "go to Paris" or "CCTV on". Your Mac turns the words into text.',
    'This version needs the new app, once: download it again, and it updates itself after that.',
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
