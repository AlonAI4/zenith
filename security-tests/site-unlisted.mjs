// Re-test: the download page stays unlisted. Search engines must be told not
// to list it (header and tag), and the big ones must be allowed to read it,
// because a search engine blocked by robots.txt never sees "do not list".
import { readFileSync } from 'node:fs';

const read = (name) => readFileSync(`alon-site/${name}`, 'utf8');
const checks = [];
const check = (ok, what) => checks.push([Boolean(ok), what]);

const headers = read('_headers');
const everyPath = headers.split(/\n(?=\S)/).find((block) => block.startsWith('/*'));
check(
  /X-Robots-Tag:.*\bnoindex\b/i.test(everyPath ?? ''),
  'every path is served with an X-Robots-Tag header that says noindex',
);

for (const page of ['index.html', '404.html']) {
  const tag = /<meta\s+name="robots"\s+content="([^"]*)"/i.exec(read(page));
  check(tag && /\bnoindex\b/.test(tag[1]), `${page} has a robots tag that says noindex`);
}
check(!/rel="canonical"|property="og:/i.test(read('index.html')), 'the page sets no sharing or canonical tags');

// robots.txt: split into groups of "User-agent" lines followed by their rules.
const groups = [];
let current = null;
for (const raw of read('robots.txt').split('\n')) {
  const line = raw.replace(/#.*/, '').trim();
  const [key, ...rest] = line.split(':');
  const value = rest.join(':').trim();
  if (/^user-agent$/i.test(key)) {
    if (!current || current.rules.length > 0) groups.push((current = { agents: [], rules: [] }));
    current.agents.push(value.toLowerCase());
  } else if (current && /^(allow|disallow)$/i.test(key)) {
    current.rules.push(`${key.toLowerCase()}:${value}`);
  }
}
const rulesFor = (agent) =>
  (groups.find((group) => group.agents.includes(agent)) ?? groups.find((group) => group.agents.includes('*')))
    ?.rules ?? [];
for (const engine of ['googlebot', 'bingbot']) {
  check(!rulesFor(engine).includes('disallow:/'), `${engine} may read the page, so it sees noindex`);
}
check(rulesFor('some-other-crawler').includes('disallow:/'), 'every other crawler is told to keep out');

let failed = false;
for (const [ok, what] of checks) {
  console.log(`${ok ? '✓' : '✗'} ${what}`);
  if (!ok) failed = true;
}
if (failed) process.exit(1);
console.log('\nAll unlisted-page checks passed.');
