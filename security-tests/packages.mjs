// Re-test for F-003: three packages had known weaknesses below these versions.
// An update from the original project can put an older lock file back ("theirs
// wins on a clash"), so this fails if any of them slips under the fixed version.
import { readFileSync } from 'node:fs';

const FIXED = { sharp: '0.35.5', 'source-map-js': '1.2.2', dompurify: '3.4.16' };
const packages = JSON.parse(readFileSync('package-lock.json', 'utf8')).packages;

const parts = (version) => version.split('.').map((n) => parseInt(n, 10));
const atLeast = (have, want) => {
  const [a, b] = [parts(have), parts(want)];
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
};

let failed = false;
for (const [name, want] of Object.entries(FIXED)) {
  const have = packages[`node_modules/${name}`]?.version;
  const ok = Boolean(have) && atLeast(have, want);
  console.log(`${ok ? '✓' : '✗'} ${name} is ${have ?? 'missing'} (needs ${want} or newer)`);
  if (!ok) failed = true;
}
if (failed) {
  console.error('\nA package is back on a version with a known weakness. Run: npm audit fix');
  process.exit(1);
}
console.log('\nAll package-version checks passed.');
