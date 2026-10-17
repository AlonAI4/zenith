/**
 * Which build of Zenith this is, and what changed in it, in plain words.
 *
 * This is the one place it is written down. The help card in the app reads
 * it, and so does the download page when it is built (alon-site-build.sh).
 * For a new build: raise the number, set the date, and rewrite the list for
 * people who use the app, not for programmers.
 */
export const ZENITH_VERSION = Object.freeze({
  number: '1.2',
  date: '16 October 2026',
  changes: Object.freeze([
    'Zenith now comes as a Mac app: drag it into Applications, and it updates itself when a new version is out.',
    'Cameras in Finland, British Columbia and parts of California can show their older pictures, up to a day back.',
    "Take a photo of a camera whenever you want: it stays on your Mac, in My photos and in that camera's times.",
    'Escape now closes every panel, the keyboard reaches everything, and screen readers hear what changes.',
    'From the original project: fifty new pieces of work, such as the real map coming back by itself after a fallback.',
    'Zenith MC, the Minecraft mod, now has its own download page.',
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
