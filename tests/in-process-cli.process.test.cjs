'use strict';

/**
 * #6332 (ADR-6315 item 14): the one in-process-CLI case that needs a fresh
 * process whose stdout and stderr are files.
 *
 * process.stdout and process.stderr are created lazily. When one is a file,
 * its stream takes fs.writeSync as it is at that moment, so a stream created
 * while runInProcess has fs.writeSync swapped would keep the stand-in for the
 * rest of the process and lose everything written afterwards. A pipe does not
 * show it, and in-process every other test has already touched both streams.
 * So this test starts a child whose only job is to start a grandchild with
 * both streams pointed at files; the grandchild calls runInProcess before it
 * touches either stream and then writes to both.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createTempDir, cleanup } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS, HOOK_FANOUT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const LIB = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'in-process-cli.cjs');

const GRANDCHILD = [
  `const { runInProcess } = require(${JSON.stringify(LIB)});`,
  'runInProcess(() => { require("node:fs").writeSync(1, "captured"); }).then((result) => {',
  '  process.stdout.write(JSON.stringify({ stream: "stdout", captured: result.stdout }));',
  '  process.stderr.write(JSON.stringify({ stream: "stderr" }));',
  '});',
].join('\n');

// Runs the grandchild with fd 1 and fd 2 opened on files in argv[1], then
// reports its exit status and what the two files hold. The grandchild is
// bounded by argv[2] milliseconds, so a hang ends there and leaves no process
// behind when the outer bound is reached.
const CHILD = [
  'const fs = require("node:fs");',
  'const path = require("node:path");',
  'const { spawnSync } = require("node:child_process");',
  'const dir = process.argv[1];',
  'const out = fs.openSync(path.join(dir, "out.txt"), "w");',
  'const err = fs.openSync(path.join(dir, "err.txt"), "w");',
  `const run = spawnSync(process.execPath, ["-e", ${JSON.stringify(GRANDCHILD)}], {`,
  '  stdio: ["ignore", out, err], timeout: Number(process.argv[2]),',
  '});',
  'fs.closeSync(out);',
  'fs.closeSync(err);',
  'process.stdout.write(JSON.stringify({',
  '  status: run.status,',
  '  out: fs.readFileSync(path.join(dir, "out.txt"), "utf8"),',
  '  err: fs.readFileSync(path.join(dir, "err.txt"), "utf8"),',
  '}));',
].join('\n');

test('output written after a first in-process call reaches file-backed streams (#6332)', (t) => {
  const dir = createTempDir('gsd-in-process-streams-');
  t.after(() => cleanup(dir));

  const child = runNode(['-e', CHILD, dir, String(PROBE_TIMEOUT_MS)], { timeoutMs: HOOK_FANOUT_TIMEOUT_MS });

  assert.equal(child.exitCode, 0, child.summary);
  const report = JSON.parse(child.stdout);
  assert.equal(report.status, 0);
  assert.deepEqual(JSON.parse(report.out), { stream: 'stdout', captured: 'captured' });
  assert.deepEqual(JSON.parse(report.err), { stream: 'stderr' });
});
