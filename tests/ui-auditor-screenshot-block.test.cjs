'use strict';
// Reads agents/gsd-ui-auditor.md (prose) and EXECUTES its static screenshot bash
// fence; no source module is read, so there is no allow-test-rule site.

/**
 * #4176 (Phase 8 of epic #5056): the static <screenshot_approach> fence.
 *
 * Three defects, each pinned by running the fence under bash against a real
 * local http server and a stub `npx` on PATH:
 *   1. A redirecting (or auth-gated) dev server was misread as no server.
 *   2. "Screenshots captured" printed although every capture failed.
 *   3. The documented 3000 -> 5173 -> 8080 fallback was never attempted.
 * Capture success is judged from the files actually written (non-empty), and
 * a failure is reported as NOT captured, never as success.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const fc = require('fast-check');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');
const { cleanup } = require('./helpers.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { skipUnless } = require('./helpers/bash-probe.cjs');

const AUDITOR_FILES = ['gsd-ui-auditor.md', 'gsd-ui-auditor.compact.md'];
const FENCE = '`'.repeat(3);

const SKIP = skipUnless('bash', 'curl');

/** First bash fence inside <screenshot_approach> (the static capture block). */
function staticFence(file) {
  const lines = splitLines(fs.readFileSync(path.join(__dirname, '..', 'agents', file), 'utf8'));
  const out = [];
  let inSection = false;
  let inFence = false;
  for (const line of lines) {
    if (!inSection) { if (line.includes('<screenshot_approach>')) inSection = true; continue; }
    if (!inFence) { if (line.trim() === `${FENCE}bash`) inFence = true; continue; }
    if (line.trim() === FENCE) break;
    out.push(line);
  }
  assert.ok(out.length > 0, `${file}: <screenshot_approach> must open with a bash fence`);
  return out;
}

// STUB_MODE: ok | fail (exit 1, nothing written) | empty (exit 0, zero-byte file) |
// failmobile (everything but mobile.png succeeds)
const STUB_NPX = `#!/bin/sh
# argv: playwright screenshot <url> <file> --viewport-size=W,H ...
printf '%s\\n' "$3" >> "$STUB_LOG"
file="$4"
case "$STUB_MODE" in
  fail) exit 1 ;;
  empty) : > "$file"; exit 0 ;;
  failmobile) case "$file" in *mobile.png) exit 1 ;; esac ;;
esac
printf 'PNG' > "$file"
exit 0
`;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function serve(handler) {
  return new Promise((resolve, reject) => {
    const s = http.createServer(handler);
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

function closeServer(s) {
  return new Promise((resolve) => { s.close(() => resolve()); s.closeAllConnections?.(); });
}

/** Run the fence; async so the in-process http server can answer curl. */
async function runFence(t, file, { ports = [], rawPorts, mode = 'ok' }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-shot-block-'));
  t.after(() => cleanup(tmp));
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'npx'), STUB_NPX, { mode: 0o755 });
  const log = path.join(tmp, 'npx.log');
  fs.writeFileSync(log, '');
  const script = [
    '#!/bin/bash',
    'PADDED_PHASE=08',
    ...staticFence(file),
    'printf "DEV_URL=%s\\n" "$DEV_URL"',
    'printf "SCREENSHOT_DIR=%s\\n" "$SCREENSHOT_DIR"',
    '',
  ].join('\n');
  const scriptPath = path.join(tmp, 'fence.sh');
  fs.writeFileSync(scriptPath, script);
  const child = spawn('bash', [scriptPath], {
    cwd: tmp,
    env: {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      HOME: tmp,
      TMPDIR: tmp,
      TEMP: tmp,
      TMP: tmp,
      STUB_LOG: log,
      STUB_MODE: mode,
      DEV_PORTS: rawPorts === undefined ? ports.join(' ') : rawPorts,
    },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const killer = setTimeout(() => child.kill('SIGKILL'), PROBE_TIMEOUT_MS);
  const status = await new Promise((resolve) => child.on('close', resolve));
  clearTimeout(killer);
  const calls = fs.readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean);
  const field = (name) => (stdout.match(new RegExp(`^${name}=(.*)$`, 'm')) || [])[1];
  return {
    tmp, status, stdout, stderr, calls,
    devUrl: field('DEV_URL'),
    shotDir: field('SCREENSHOT_DIR'),
  };
}

for (const file of AUDITOR_FILES) {
  describe(`${file} screenshot block (bash, local http server, stub npx)`, { skip: SKIP }, () => {
    test('followsARedirectingDevServerInsteadOfReadingItAsNoServer', async (t) => {
      const srv = await serve((req, res) => {
        if (req.url === '/') { res.writeHead(307, { Location: '/en' }); res.end(); return; }
        res.writeHead(200); res.end('ok');
      });
      t.after(() => closeServer(srv));
      const port = srv.address().port;
      const out = await runFence(t, file, { ports: [port] });
      assert.equal(out.status, 0, out.stderr);
      assert.equal(out.devUrl, `http://localhost:${port}`);
      assert.match(out.stdout, /Screenshots captured \(3\/3\)/);
      assert.equal(out.calls.length, 3);
      assert.ok(out.calls.every((c) => c === `http://localhost:${port}`));
    });

    test('anAuthGatedServerIsStillAServer', async (t) => {
      const srv = await serve((req, res) => { res.writeHead(401); res.end(); });
      t.after(() => closeServer(srv));
      const out = await runFence(t, file, { ports: [srv.address().port] });
      assert.match(out.stdout, /Screenshots captured \(3\/3\)/);
    });

    test('aFiveHundredIsNotAServer', async (t) => {
      const srv = await serve((req, res) => { res.writeHead(500); res.end(); });
      t.after(() => closeServer(srv));
      const out = await runFence(t, file, { ports: [srv.address().port] });
      assert.equal(out.devUrl, '');
      assert.match(out.stdout, /No dev server on localhost:3000, 5173 or 8080/);
      assert.deepEqual(out.calls, []);
    });

    test('fallsBackToTheNextPortWhenTheFirstIsClosed', async (t) => {
      const closed = await freePort();
      const srv = await serve((req, res) => { res.writeHead(200); res.end('ok'); });
      t.after(() => closeServer(srv));
      const second = srv.address().port;
      const out = await runFence(t, file, { ports: [closed, second] });
      assert.equal(out.devUrl, `http://localhost:${second}`);
      assert.match(out.stdout, /Screenshots captured \(3\/3\)/);
      assert.ok(out.calls.every((c) => c === `http://localhost:${second}`));
    });

    test('noServerOnAnyPortIsCodeOnlyAndRunsNoCapture', async (t) => {
      const a = await freePort();
      const b = await freePort();
      const out = await runFence(t, file, { ports: [a, b] });
      assert.equal(out.status, 0, out.stderr);
      assert.equal(out.devUrl, '');
      assert.equal(out.shotDir, '', 'no capture directory is named when nothing was reached');
      assert.match(out.stdout, /No dev server on localhost:3000, 5173 or 8080/);
      assert.deepEqual(out.calls, []);
    });

    test('everyCaptureFailingIsReportedNotCapturedNeverAsSuccess', async (t) => {
      const srv = await serve((req, res) => { res.writeHead(200); res.end('ok'); });
      t.after(() => closeServer(srv));
      const out = await runFence(t, file, { ports: [srv.address().port], mode: 'fail' });
      assert.equal(out.status, 0, out.stderr);
      assert.match(out.stdout, /Screenshots NOT captured/);
      assert.ok(!/Screenshots captured/.test(out.stdout), 'must never claim success');
      assert.equal(out.calls.length, 3, 'all three viewports are attempted');
    });

    test('successIsJudgedFromTheFilesWrittenNotFromTheExitStatus', async (t) => {
      const srv = await serve((req, res) => { res.writeHead(200); res.end('ok'); });
      t.after(() => closeServer(srv));
      // The tool exits 0 but leaves zero-byte files: that is not a capture.
      const out = await runFence(t, file, { ports: [srv.address().port], mode: 'empty' });
      assert.match(out.stdout, /Screenshots NOT captured/);
      assert.ok(!/Screenshots captured/.test(out.stdout));
      assert.deepEqual(fs.readdirSync(path.join(out.tmp, out.shotDir)), [],
        'failed captures leave no stray empty files');
    });

    test('aGlobCharacterInDevPortsIsNeverExpandedIntoPorts', async (t) => {
      // Unquoted, `*` would expand to the files in the working directory and each would be probed as a port.
      const out = await runFence(t, file, { rawPorts: '*' });
      assert.equal(out.status, 0, out.stderr);
      assert.equal(out.devUrl, '');
      assert.match(out.stdout, /No dev server on localhost:3000, 5173 or 8080/);
    });

    test('aPathOrUrlFragmentInDevPortsNeverReachesTheProbedUrl', async (t) => {
      const srv = await serve((req, res) => { res.writeHead(200); res.end('ok'); });
      t.after(() => closeServer(srv));
      const port = srv.address().port;
      const out = await runFence(t, file, { rawPorts: `${port}/admin?x=1  ` });
      assert.equal(out.devUrl, `http://localhost:${port}`);
      assert.ok(out.calls.every((c) => c === `http://localhost:${port}`));
    });

    test('aPartialCaptureIsReportedAsPartialWithTheCount', async (t) => {
      const srv = await serve((req, res) => { res.writeHead(200); res.end('ok'); });
      t.after(() => closeServer(srv));
      const out = await runFence(t, file, { ports: [srv.address().port], mode: 'failmobile' });
      assert.match(out.stdout, /Screenshot FAILED: mobile/);
      assert.match(out.stdout, /Screenshots PARTIAL \(2\/3\)/);
      assert.ok(!/Screenshots captured/.test(out.stdout));
      assert.deepEqual(fs.readdirSync(path.join(out.tmp, out.shotDir)).sort(), ['desktop.png', 'tablet.png']);
    });
  });
}

// DEV_PORTS is an operator-supplied space-separated list. The probe loop must iterate exactly the digit runs
// of it — never a glob expansion of the working directory, never a path or URL fragment. The property runs
// the documented `for PORT in ...` line itself, in a directory that holds files a glob would expand to.
for (const file of AUDITOR_FILES) {
  describe(`${file} DEV_PORTS expansion (property, seeded)`, { skip: SKIP }, () => {
    const loopHead = () => staticFence(file).find((line) => line.trim().startsWith('for PORT in'));

    function iterated(t, devPorts) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-shot-ports-'));
      t.after(() => cleanup(dir));
      for (const name of ['a', 'b', 'port-x']) fs.writeFileSync(path.join(dir, name), '');
      const script = `${loopHead()}\n  printf '%s\\n' "$PORT"\ndone\n`;
      const r = spawnSync('bash', ['-c', script], {
        cwd: dir, encoding: 'utf8', timeout: PROBE_TIMEOUT_MS,
        env: { PATH: process.env.PATH, HOME: dir, TMPDIR: dir, TEMP: dir, TMP: dir, DEV_PORTS: devPorts },
      });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.split('\n').filter(Boolean);
    }

    test('the loop head is found in the fence (the property is not vacuous)', () => {
      assert.ok(loopHead(), `${file}: the documented fence must carry a "for PORT in" line`);
    });

    test('iterates exactly the digit runs of DEV_PORTS, in order; unset or empty falls back to the documented list', (t) => {
      const alphabet = [...'0123456789  *?[]/;$"\'\\ab-.\t'];
      fc.assert(
        fc.property(fc.string({ unit: fc.constantFrom(...alphabet), maxLength: 14 }), (devPorts) => {
          const expected = devPorts === '' ? ['3000', '5173', '8080'] : (devPorts.match(/\d+/g) ?? []);
          return JSON.stringify(iterated(t, devPorts)) === JSON.stringify(expected);
        }),
        { seed: 5170, numRuns: 25 },
      );
    });

    test('a glob character is never expanded into the working directory\'s files (control: the literal alphabet of the fixture)', (t) => {
      assert.deepEqual(iterated(t, '*'), []);
      assert.deepEqual(iterated(t, '*a* 3000 [ab]'), ['3000']);
    });
  });
}
