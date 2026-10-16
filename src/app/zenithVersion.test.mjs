import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { changesAsHtml, versionLine, ZENITH_VERSION } from './zenithVersion.js';

test('the build has a number, a date and a short list written for people', () => {
  // Updates to the Mac app may add a third number, such as 1.2.1.
  assert.match(ZENITH_VERSION.number, /^\d+\.\d+(\.\d+)?$/);
  assert.match(ZENITH_VERSION.date, /^\d{1,2} [A-Z][a-z]+ 20\d\d$/);
  assert.ok(ZENITH_VERSION.changes.length >= 1 && ZENITH_VERSION.changes.length <= 10);
  for (const line of ZENITH_VERSION.changes) {
    assert.ok(line.length >= 20 && line.length <= 150, line);
    assert.match(line, /^[A-Z].*\.$/, line);
    // Words for programmers, file names and code have no place in it.
    assert.doesNotMatch(line, /`|\.js\b|\.mjs\b|refactor|commit|shader|API|localStorage|\bbug\b/i, line);
  }
  assert.equal(versionLine(), `Zenith ${ZENITH_VERSION.number} · ${ZENITH_VERSION.date}`);
});

test('the list is made safe before it goes into the download page', () => {
  assert.equal(
    changesAsHtml(['Tom & "Jerry" <script>alert(1)</script>.']),
    '<li>Tom &amp; &quot;Jerry&quot; &lt;script&gt;alert(1)&lt;/script&gt;.</li>',
  );
  assert.equal(changesAsHtml().split('<li>').length - 1, ZENITH_VERSION.changes.length);
});

test('the download page has a place for the version and for the list, filled when it is built', () => {
  const page = readFileSync(new URL('../../alon-site/index.html', import.meta.url), 'utf8');
  assert.equal(page.split('__WHATS_NEW__').length - 1, 1);
  assert.ok(page.split('__VERSION__').length - 1 >= 2);
  const build = readFileSync(new URL('../../alon-site-build.sh', import.meta.url), 'utf8');
  assert.match(build, /zenithVersion\.js/);
  assert.match(build, /__WHATS_NEW__/);
  assert.match(build, /__VERSION__/);
});
