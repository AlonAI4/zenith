import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import test from 'node:test';

const site = new URL('../../alon-site/', import.meta.url);
// Zenith's page and the Zenith MC page share one folder of pictures.
const pages = ['index.html', 'mc.html'].map((name) => readFileSync(new URL(name, site), 'utf8'));
const page = pages[0];
const pictures = pages.flatMap((one) =>
  [...one.matchAll(/<img\b[^>]*>/g)].map((tag) => ({ tag: tag[0], page: one })).filter(({ tag }) => /src="shots\//.test(tag)),
);

test('every picture on the download page is there, sized, described and small', () => {
  assert.ok(pictures.length >= 4);
  const used = new Set();
  for (const { tag, page } of pictures) {
    const src = /src="(shots\/[a-z-]+\.webp)"/.exec(tag)?.[1];
    assert.ok(src, tag);
    used.add(src.replace('shots/', ''));
    assert.match(tag, /width="\d+" height="\d+"/, tag);
    assert.match(tag, /alt="[^"]{20,}"/, tag);
    const bytes = statSync(new URL(src, site)).size;
    assert.ok(bytes > 10_000 && bytes < 400_000, `${src} is ${bytes} bytes`);
    // The big version a click opens is the same file, not something else.
    assert.ok(page.includes(`<a href="${src}">`), src);
  }
  assert.deepEqual(readdirSync(new URL('shots/', site)).sort(), [...used].sort());
});

test('the pictures are credited next to them, and only the satellite map is ever photographed', () => {
  const credit = /<p class="credit">([^<]+)<\/p>/.exec(page)?.[1] ?? '';
  for (const who of ['Esri', 'Maxar', 'Cesium', 'NASA', 'U.S. Geological Survey', 'OpenStreetMap']) {
    assert.ok(credit.includes(who), `the picture credit does not name ${who}`);
  }
  const script = readFileSync(new URL('../../alon-site-shots.mjs', import.meta.url), 'utf8');
  assert.match(script, /map=esri-imagery/);
  assert.match(script, /found\.map !== 'esri-imagery'\) throw/);
  assert.match(script, /the satellite credit is not clear on screen/);
  assert.doesNotMatch(script, /map=photoreal|pickMap\(/);
  const build = readFileSync(new URL('../../alon-site-build.sh', import.meta.url), 'utf8');
  assert.match(build, /cp -R alon-site\/shots/);
});

test('the Zenith MC page credits its own pictures, and each page links to the other', () => {
  const [zenith, mc] = pages;
  assert.match(mc, /<p class="credit">Pictures taken in Minecraft with Zenith MC\.<\/p>/);
  assert.doesNotMatch(zenith, /zenith-mc-/, 'no Zenith MC picture is left on the Zenith page');
  assert.match(zenith, /<a href="mc\.html">Zenith MC<\/a>/);
  assert.match(mc, /<a href="\.\/">Zenith, the live 3D globe for Mac<\/a>/);
  for (const one of pages) assert.match(one, /not an official Minecraft product/i);
});
