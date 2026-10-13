// Proves the copy made for friends carries none of my API keys.
// Usage: node security-tests/share-zip.mjs [--zip some.zip] [--env some.env]
// With no arguments it builds a fresh zip with alon-share.sh and reads the
// real .env. Key values are compared, never printed.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
};
const work = mkdtempSync(join(tmpdir(), 'zenith-share-'));
const failures = [];
const check = (ok, text) => {
  console.log(`${ok ? '✓' : '✗'} ${text}`);
  if (!ok) failures.push(text);
};

try {
  let zip = arg('--zip');
  if (!zip) {
    zip = join(work, 'Zenith.zip');
    execFileSync('/bin/zsh', [join(root, 'alon-share.sh'), zip], { stdio: 'ignore' });
  }
  const names = execFileSync('unzip', ['-Z1', zip], { maxBuffer: 64e6 })
    .toString()
    .split('\n')
    .filter(Boolean);
  check(names.length > 100, `the zip holds the project (${names.length} entries)`);

  const base = (name) => name.split('/').filter(Boolean).pop() || '';
  const envFiles = names.filter((n) => /^\.env(\..+)?$/.test(base(n)) && base(n) !== '.env.example');
  check(envFiles.length === 0, 'no .env file is inside');
  const junk = names.filter((n) => /(^|\/)(node_modules|\.gev-cache|\.gev-logs|\.playwright-mcp|\.git)\//.test(n));
  check(junk.length === 0, 'no caches, logs, packages or git history are inside');

  const envPath = arg('--env') || join(root, '.env');
  const secrets = readFileSync(envPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')])
    .filter(([key, value]) => /KEY|TOKEN|SECRET|CLIENT_ID/.test(key) && value.length >= 16);
  check(secrets.length > 0, `there are key values to look for (${secrets.length})`);

  const out = join(work, 'unzipped');
  execFileSync('unzip', ['-q', zip, '-d', out]);
  const leaked = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else {
        const data = readFileSync(full);
        for (const [key, value] of secrets) if (data.includes(value)) leaked.add(key);
      }
    }
  };
  walk(out);
  check(leaked.size === 0, `none of my key values appears in any file${leaked.size ? ` (found: ${[...leaked].join(', ')})` : ''}`);

  if (!arg('--zip'))
    check(!existsSync(join(root, '.playwright-mcp')), 'no browser-test logs are left in the project folder');
} finally {
  rmSync(work, { recursive: true, force: true });
}
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll share-zip checks passed.');
