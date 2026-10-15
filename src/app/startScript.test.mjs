import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// "Start Zenith.command" is the first thing someone who downloads Zenith runs.
const SCRIPT = fileURLToPath(new URL('../../Start Zenith.command', import.meta.url));
const PACKAGE = new URL('../../package.json', import.meta.url);
const hasZsh = existsSync('/bin/zsh');

/** Run the start script against a stand-in server that sends `html`. */
async function runAgainst(html) {
  const server = createServer((request, response) => {
    response.writeHead(404, { 'content-type': 'text/html' });
    response.end(html);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    return await new Promise((resolve) => {
      const child = execFile(
        '/bin/zsh',
        [SCRIPT],
        {
          env: { ...process.env, ZENITH_PORT: String(port), ZENITH_NO_BROWSER: '1' },
          timeout: 15_000,
        },
        (error, stdout) => resolve({ code: error ? error.code : 0, stdout }),
      );
      child.stdin.end();
    });
  } finally {
    server.close();
  }
}

test('another program on the port is not mistaken for Zenith', { skip: !hasZsh }, async () => {
  const { code, stdout } = await runAgainst('<html><head><title>Something else</title></head></html>');
  assert.notEqual(code, 0, stdout);
  assert.doesNotMatch(stdout, /already running/);
  assert.match(stdout, /Another program is already using port/);
});

test('a Zenith that is already running is opened, not started twice', { skip: !hasZsh }, async () => {
  const { code, stdout } = await runAgainst('<html><head><title>Zenith</title></head></html>');
  assert.equal(code, 0, stdout);
  assert.match(stdout, /Zenith is already running/);
});

test('the start script accepts exactly the Node.js versions the project needs', () => {
  const engines = JSON.parse(readFileSync(PACKAGE, 'utf8')).engines.node;
  // If this range changes, change the check in the start script to match.
  assert.equal(engines, '>=24.14.0 <25 || >=26 <27');
  const check = /node -p '([^']+)'/.exec(readFileSync(SCRIPT, 'utf8'))?.[1];
  assert.ok(check, 'the start script checks the version with node -p');
  const accepts = (version) => String(new Function('process', `return ${check}`)({ versions: { node: version } }));
  for (const version of ['24.14.0', '24.15.2', '26.0.0', '26.3.1']) assert.equal(accepts(version), 'true', version);
  for (const version of ['22.12.0', '24.0.0', '24.13.1', '25.1.0', '27.0.0']) assert.equal(accepts(version), 'false', version);
});
