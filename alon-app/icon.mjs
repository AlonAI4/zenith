// Draws the Zenith logo (public/alon/zenith-logo.svg) as a 1024 px PNG for the
// Mac app's icon. Usage: node alon-app/icon.mjs <out.png>
import { readFileSync } from 'node:fs';

import { launchBrowser } from '../alon-browser.mjs';

const out = process.argv[2];
if (!out) throw new Error('usage: node alon-app/icon.mjs <out.png>');
const svg = readFileSync(new URL('../public/alon/zenith-logo.svg', import.meta.url));
const browser = await launchBrowser();
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1024, height: 1024 });
  await page.setContent(
    `<html><body style="margin:0;background:transparent"><img width="1024" height="1024" src="data:image/svg+xml;base64,${svg.toString('base64')}"></body></html>`,
  );
  await page.waitForFunction(() => document.querySelector('img').complete);
  await page.screenshot({ path: out, omitBackground: true, clip: { x: 0, y: 0, width: 1024, height: 1024 } });
} finally {
  await browser.close();
}
