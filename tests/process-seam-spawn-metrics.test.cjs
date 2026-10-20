'use strict';

/**
 * #5473: per-spawn stall evidence from the process seam.
 *
 * A Windows CI child that runs to its timeout used to surface as
 * `null !== 0`, with no duration, pid or signal to line up against the
 * job-level spawn-stall watcher. These tests pin the fields and the stall
 * record that make that diagnosable from the test side.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempDir, cleanup } = require('./helpers.cjs');
const seam = require('./helpers/process-seam.cjs');
const { runNode, OUTCOME, toSeamResult, formatSeamResult, assertSeamExit, SPAWN_LOG_ENV, SLOW_SPAWN_ENV } = seam;

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('process-seam spawn metrics (#5473)', () => {
  let tmpDir;
  let logFile;
  let savedLog;
  let savedSlow;

  beforeEach(() => {
    tmpDir = createTempDir('seam-metrics-');
    logFile = path.join(tmpDir, 'spawns.jsonl');
    savedLog = process.env[SPAWN_LOG_ENV];
    savedSlow = process.env[SLOW_SPAWN_ENV];
    process.env[SPAWN_LOG_ENV] = logFile;
    delete process.env[SLOW_SPAWN_ENV];
  });

  afterEach(() => {
    if (savedLog === undefined) delete process.env[SPAWN_LOG_ENV];
    else process.env[SPAWN_LOG_ENV] = savedLog;
    if (savedSlow === undefined) delete process.env[SLOW_SPAWN_ENV];
    else process.env[SLOW_SPAWN_ENV] = savedSlow;
    cleanup(tmpDir);
  });

  const records = () =>
    fs.existsSync(logFile)
      ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : [];

  test('a result carries durationMs, pid and UTC start/end timestamps', () => {
    const r = runNode(['-e', 'process.exitCode = 0']);
    assert.equal(r.outcome, OUTCOME.EXITED, r.summary);
    assert.equal(typeof r.durationMs, 'number');
    assert.ok(r.durationMs >= 0);
    assert.ok(Number.isInteger(r.pid) && r.pid > 0, `pid ${r.pid}`);
    assert.match(r.startedAt, ISO_UTC);
    assert.match(r.endedAt, ISO_UTC);
    assert.ok(Date.parse(r.endedAt) >= Date.parse(r.startedAt));
    assert.equal(Date.parse(r.endedAt) - Date.parse(r.startedAt), r.durationMs);
  });

  test('summary names outcome, timedOut, signal and durationMs', () => {
    const r = runNode(['-e', 'setTimeout(() => {}, 30000)'], { timeoutMs: 300 });
    assert.equal(r.outcome, OUTCOME.TIMED_OUT);
    for (const needle of ['outcome=timed_out', 'timedOut=true', `signal=${r.signal}`, `durationMs=${r.durationMs}`, `pid=${r.pid}`]) {
      assert.ok(r.summary.includes(needle), `${needle} missing from: ${r.summary}`);
    }
    assert.equal(r.summary, formatSeamResult(r));
  });

  test('assertSeamExit reports a timeout as a timeout, not a bare exit-code mismatch', () => {
    const r = runNode(['-e', 'setTimeout(() => {}, 30000)'], { timeoutMs: 300 });
    assert.throws(
      () => assertSeamExit(assert, r, 0),
      (err) => /outcome=timed_out/.test(err.message) && /timedOut=true/.test(err.message) && /durationMs=\d+/.test(err.message),
    );
  });

  test('assertSeamExit passes on the expected exit code', () => {
    const r = runNode(['-e', 'process.exitCode = 3']);
    assert.doesNotThrow(() => assertSeamExit(assert, r, 3));
  });

  test('a timed-out spawn appends a stall record with the lining-up fields', () => {
    const r = runNode(['-e', 'setTimeout(() => {}, 30000)'], { timeoutMs: 300 });
    const [rec, ...rest] = records();
    assert.equal(rest.length, 0);
    assert.equal(rec.type, 'seam:spawn-stall');
    assert.equal(rec.file, path.basename(__filename));
    assert.equal(rec.command, path.basename(process.execPath));
    assert.equal(rec.outcome, 'timed_out');
    assert.equal(rec.timedOut, true);
    assert.equal(rec.pid, r.pid);
    assert.equal(rec.durationMs, r.durationMs);
    assert.equal(rec.startedAt, r.startedAt);
    assert.equal(rec.endedAt, r.endedAt);
    assert.equal(rec.timeoutMs, 300);
    assert.ok(rec.argv.length <= 3);
  });

  test('a fast clean spawn writes no record', () => {
    runNode(['-e', 'process.exitCode = 0']);
    assert.deepEqual(records(), []);
  });

  test('a spawn at or over the slow threshold is recorded even when it exits 0', () => {
    process.env[SLOW_SPAWN_ENV] = '0';
    runNode(['-e', 'process.exitCode = 0']);
    const [rec] = records();
    assert.equal(rec.outcome, 'exited');
    assert.equal(rec.exitCode, 0);
  });

  test('no log file configured: no throw and no file', () => {
    delete process.env[SPAWN_LOG_ENV];
    process.env[SLOW_SPAWN_ENV] = '0';
    const r = runNode(['-e', 'process.exitCode = 0']);
    assert.equal(r.outcome, OUTCOME.EXITED);
    assert.equal(fs.existsSync(logFile), false);
  });

  test('an unwritable log path never changes the spawn result', () => {
    process.env[SPAWN_LOG_ENV] = path.join(tmpDir, 'missing-dir', 'x.jsonl');
    process.env[SLOW_SPAWN_ENV] = '0';
    const r = runNode(['-e', 'process.exitCode = 0']);
    assert.equal(r.outcome, OUTCOME.EXITED);
    assert.equal(r.exitCode, 0);
  });

  test('toSeamResult without timing reports zero duration and null timestamps', () => {
    const r = toSeamResult({ error: undefined, status: 0, signal: null, stdout: '', stderr: '' });
    assert.equal(r.durationMs, 0);
    assert.equal(r.pid, null);
    assert.equal(r.startedAt, null);
    assert.equal(r.endedAt, null);
  });
});
