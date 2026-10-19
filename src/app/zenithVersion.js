/**
 * Which build of Zenith this is, and what changed in it, in plain words.
 *
 * This is the one place it is written down. The help card in the app reads
 * it, and so does the download page when it is built (alon-site-build.sh).
 * For a new build: raise the number, set the date, and rewrite the list for
 * people who use the app, not for programmers.
 */
export const ZENITH_VERSION = Object.freeze({
  number: '1.5.5',
  date: '19 October 2026',
  changes: Object.freeze([
    'The whole target box now takes your highlight colour, its OVERHEAD button too, and the browser tab shows the new Zenith icon.',
    'Pick your own highlight colour in the controls card, fly to the Moon with one button from anywhere on Earth, and Zenith has a new app icon.',
    'The target box finds stadiums, the Pentagon and many houses that said NO MATCH, and names each kind of building in plain words.',
    'The target box lights the building you picked from the ground to its real top, so you can see exactly which one it is.',
    'Every emoji is gone: icons across the app are drawn lines that stay sharp at any size.',
    'Map labels like STARSHIP are bigger and clearer, on a dark plate with a drawn icon and a ringed dot on the spot itself.',
    'Labels and camera names no longer pile on top of each other, and a camera name cut short shows in full when you point at it.',
    'The camera you choose gets cyan corners instead of the green box, and the area it can see is lit up on the map.',
    "The chosen camera's full name now shows in the camera panel, above its details.",
    'Selecting the whole page no longer turns it blue, and the voice mic no longer shows an error when there is no key.',
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
