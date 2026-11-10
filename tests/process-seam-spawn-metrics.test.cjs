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
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');
const seam = require('./helpers/process-seam.cjs');
const { runNode, OUTCOME, toSeamResult, formatSeamResult, assertSeamExit, SPAWN_LOG_ENV, SLOW_SPAWN_ENV, NEAR_MISS_BOUND_FRACTION, recordSpawnIfNoteworthy } = seam;

// A bound short enough to kill a sleeper quickly, long enough that the child has started.
// Distinct from the shared probe timeouts: this suite WANTS the kill.
const SEAM_KILL_TIMEOUT_MS = 300;
// A threshold no healthy-or-stalled runner reaches, so only the explicit cases below record.
const NEVER_SLOW_MS = '600000';
// Fields a stall record shares with the seam result it describes.
const SHARED_FIELDS = ['outcome', 'timedOut', 'signal', 'exitCode', 'code', 'pid', 'durationMs', 'startedAt', 'endedAt'];
const pick = (obj) => Object.fromEntries(SHARED_FIELDS.map((k) => [k, obj[k]]));

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
    process.env[SLOW_SPAWN_ENV] = NEVER_SLOW_MS;
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
      ? splitLines(fs.readFileSync(logFile, 'utf8')).filter(Boolean).map((l) => JSON.parse(l))
      : [];

  test('a result carries durationMs, pid and UTC start/end timestamps', () => {
    const r = runNode(['-e', 'process.exitCode = 0']);
    assert.equal(r.outcome, OUTCOME.EXITED, r.summary);
    assert.match(r.summary, /durationMs=\d+ /);
    assert.ok(Number.isInteger(r.pid) && r.pid > 0, `pid ${r.pid}`);
    assert.match(r.startedAt, ISO_UTC);
    assert.match(r.endedAt, ISO_UTC);
    assert.ok(Date.parse(r.endedAt) >= Date.parse(r.startedAt));
  });

  test('summary names outcome, timedOut, signal and durationMs', () => {
    const r = runNode(['-e', 'setTimeout(() => {}, 30000)'], { timeoutMs: SEAM_KILL_TIMEOUT_MS });
    assert.equal(r.outcome, OUTCOME.TIMED_OUT);
    for (const needle of ['outcome=timed_out', 'timedOut=true', `signal=${r.signal}`, 'durationMs=', `pid=${r.pid}`]) {
      assert.ok(r.summary.includes(needle), `${needle} missing from: ${r.summary}`);
    }
    assert.equal(r.summary, formatSeamResult(r));
  });

  test('assertSeamExit reports a timeout as a timeout, not a bare exit-code mismatch', () => {
    const r = runNode(['-e', 'setTimeout(() => {}, 30000)'], { timeoutMs: SEAM_KILL_TIMEOUT_MS });
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
    const r = runNode(['-e', 'setTimeout(() => {}, 30000)'], { timeoutMs: SEAM_KILL_TIMEOUT_MS });
    const [rec, ...rest] = records();
    assert.equal(rest.length, 0);
    assert.equal(rec.type, 'seam:spawn-stall');
    assert.equal(rec.file, path.basename(__filename));
    assert.equal(rec.command, path.basename(process.execPath));
    assert.equal(rec.outcome, 'timed_out');
    assert.equal(rec.timedOut, true);
    assert.deepEqual(pick(rec), pick(r));
    assert.equal(rec.timeoutMs, SEAM_KILL_TIMEOUT_MS);
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
    assert.equal(rec.type, 'seam:spawn-stall');
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

  test('a malformed threshold falls back to the default instead of recording everything', () => {
    process.env[SLOW_SPAWN_ENV] = ' ';
    runNode(['-e', 'process.exitCode = 0']);
    assert.deepEqual(records(), []);
  });

  describe('near-miss records (#4689)', () => {
    // A synthetic bound; durations are injected through toSeamResult's timing, so no wall clock is read.
    const BOUND_MS = 1000;
    const HALF_MS = BOUND_MS * NEAR_MISS_BOUND_FRACTION;
    const exited = (durationMs) =>
      toSeamResult(
        { error: undefined, status: 0, signal: null, stdout: '', stderr: '', pid: 4242 },
        { startedAtMs: 0, endedAtMs: durationMs, durationMs },
      );

    test('the near-miss fraction is a fraction of the bound', () => {
      assert.ok(NEAR_MISS_BOUND_FRACTION > 0 && NEAR_MISS_BOUND_FRACTION < 1);
    });

    test('just under half the bound writes no record', () => {
      recordSpawnIfNoteworthy('node', ['-e', 'x'], BOUND_MS, exited(HALF_MS - 1));
      assert.deepEqual(records(), []);
    });

    test('exactly half the bound is recorded as a near-miss', () => {
      recordSpawnIfNoteworthy('node', ['-e', 'x'], BOUND_MS, exited(HALF_MS));
      const [rec, ...rest] = records();
      assert.equal(rest.length, 0);
      assert.equal(rec.nearMiss, true);
      assert.equal(rec.boundFraction, 0.5);
    });

    test('just over half the bound is recorded as a near-miss', () => {
      recordSpawnIfNoteworthy('node', ['-e', 'x'], BOUND_MS, exited(HALF_MS + 1));
      const [rec] = records();
      assert.equal(rec.nearMiss, true);
      assert.equal(rec.boundFraction, 0.501);
    });

    test('boundFraction is floored to three decimals', () => {
      recordSpawnIfNoteworthy('node', [], 3000, exited(2000));
      const [rec] = records();
      assert.equal(rec.boundFraction, 0.666);
    });

    // At the 80000ms CLI-class bound, nearMiss must agree with boundFraction: the
    // value that reads 0.5 is never reported as not a near-miss.
    for (const [durationMs, fraction, near] of [
      [39999, 0.499, false],
      [40000, 0.5, true],
      [40001, 0.5, true],
    ]) {
      test(`bound 80000 with duration ${durationMs} gives boundFraction ${fraction} and nearMiss ${near}`, () => {
        process.env[SLOW_SPAWN_ENV] = '0';
        recordSpawnIfNoteworthy('node', [], 80000, exited(durationMs));
        const [rec] = records();
        assert.equal(rec.boundFraction, fraction);
        assert.equal(rec.nearMiss, near);
        assert.equal(rec.nearMiss, rec.boundFraction >= NEAR_MISS_BOUND_FRACTION);
      });
    }

    test('a slow spawn under half its bound is recorded with nearMiss false', () => {
      process.env[SLOW_SPAWN_ENV] = '0';
      recordSpawnIfNoteworthy('node', [], BOUND_MS, exited(HALF_MS - 1));
      const [rec] = records();
      assert.equal(rec.nearMiss, false);
      assert.equal(rec.boundFraction, 0.499);
    });

    test('a record keeps the existing stall fields alongside the new ones', () => {
      recordSpawnIfNoteworthy('node', ['-e', 'x'], BOUND_MS, exited(HALF_MS));
      const [rec] = records();
      assert.equal(rec.type, 'seam:spawn-stall');
      assert.equal(rec.timeoutMs, BOUND_MS);
      assert.equal(rec.pid, 4242);
      assert.equal(rec.outcome, 'exited');
      assert.deepEqual(rec.argv, ['-e', 'x']);
    });
  });

  test('a stdin-reading child with no input gets EOF and exits promptly (#4689)', () => {
    const r = runNode([
      '-e',
      "process.stdin.resume();process.stdin.on('end',()=>{console.log('eof');process.exit(0)})",
    ]);
    assert.equal(r.outcome, OUTCOME.EXITED, r.summary);
    assert.equal(r.exitCode, 0, r.summary);
    assert.equal(r.stdout.trim(), 'eof');
  });

  test('toSeamResult without timing reports null timestamps and a summary', () => {
    const r = toSeamResult({ error: undefined, status: 0, signal: null, stdout: '', stderr: '' });
    assert.match(r.summary, /durationMs=0 /);
    assert.equal(r.pid, null);
    assert.equal(r.startedAt, null);
    assert.equal(r.endedAt, null);
  });
});
