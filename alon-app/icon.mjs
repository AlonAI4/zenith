// Draws the Zenith logo (public/alon/zenith-logo.svg) as a 1024 px PNG for the
// Mac app's icon. Usage: node alon-app/icon.mjs <out.png> [size] [drawing.svg]
// (the browser tab icon: ... public/alon/zenith-favicon.png 64 alon-app/favicon.svg)
import { readFileSync } from 'node:fs';

import { launchBrowser } from '../alon-browser.mjs';

const [out, sizeArg = '1024', drawing] = process.argv.slice(2);
if (!out)
  throw new Error(
    'usage: node alon-app/icon.mjs <out.png> [size] [drawing.svg]',
  );
const size = Number(sizeArg);
const svg = readFileSync(
  drawing ?? new URL('../public/alon/zenith-logo.svg', import.meta.url),
);
const browser = await launchBrowser();
try {
  const page = await browser.newPage();
  await page.setViewport({ width: size, height: size });
  await page.setContent(
    `<html><body style="margin:0;background:transparent"><img width="${size}" height="${size}" src="data:image/svg+xml;base64,${svg.toString('base64')}"></body></html>`,
  );
  await page.waitForFunction(() => document.querySelector('img').complete);
  await page.screenshot({
    path: out,
    omitBackground: true,
    clip: { x: 0, y: 0, width: size, height: size },
  });
} finally {
  await browser.close();
}
