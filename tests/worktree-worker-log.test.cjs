'use strict';

/**
 * #4624 — `worktree worker-record` / `worker-status` / `worker-complete`: the
 * durable per-worker lifecycle record for the orchestrator-worktree backend.
 *
 * WHY: the dispatch fragment spawned external executors behind a bare shell
 * `wait`. When the orchestrator's turn ended before a worker finished, no
 * launch identity, result location, or terminal outcome was persisted, so a
 * resumed session re-derived everything from manual PID/log discovery and
 * could re-dispatch a recorded plan (#4624). These tests pin the state
 * machine that closes that gap:
 *
 *   record (running) ──▶ status (pidAlive/summaryExists/needsReconciliation)
 *        ▲                          │
 *        │ re-record only after     ▼
 *        └── terminal ─────  worker-complete (idempotent)
 *
 * Determinism: `pidAlive` is injected everywhere (no live-PID probing), the
 * summary file is real fs, and the CLI end-to-end case uses a self-PID or a
 * max-int32 pid (ESRCH on every platform) so no assertion depends on the
 * runner's process table.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createTempDir, cleanup } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const ROOT = path.join(__dirname, '..');
const GSD_TOOLS = path.join(ROOT, 'gsd-core', 'bin', 'gsd-tools.cjs');
const {
  cmdWorktreeWorkerRecord,
  cmdWorktreeWorkerStatus,
  cmdWorktreeWorkerComplete,
} = require('../gsd-core/bin/lib/worktree-safety.cjs');

describe('#4624 worktree worker lifecycle records', () => {
  let dir;
  let wtPath;
  let summaryPath;

  beforeEach(() => {
    dir = createTempDir('rwt-4624');
    wtPath = path.join(dir, 'agent-p3-1700000000');
    summaryPath = path.join(dir, '3-SUMMARY.md');
  });

  afterEach(() => {
    cleanup(dir);
  });

  function run(cmd, args, deps = {}) {
    let exitCode = 0;
    let stdout = '';
    let stderr = '';
    const scoped = {
      write: (s) => { stdout += s; },
      writeErr: (s) => { stderr += s; },
      ...deps,
    };
    // The cmd functions set process.exitCode directly; capture it without
    // leaking into the runner's own exit status.
    const prior = process.exitCode;
    process.exitCode = 0;
    if (cmd === 'record') cmdWorktreeWorkerRecord(dir, args, scoped);
    else if (cmd === 'status') cmdWorktreeWorkerStatus(dir, args, scoped);
    else if (cmd === 'complete') cmdWorktreeWorkerComplete(dir, args, scoped);
    exitCode = process.exitCode || 0;
    process.exitCode = prior;
    return { exitCode, stdout, stderr };
  }

  const dead = () => false;

  test('record persists a running launch record beside the worktree with an absolute summary path', () => {
    const r = run('record', ['--path', wtPath, '--pid', '4242', '--plan', '3',
      '--summary-path', summaryPath, '--log-file', `${wtPath}.worker.log`]);
    assert.equal(r.exitCode, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.record.state, 'running');
    assert.equal(out.record.agentId, 'agent-p3-1700000000');
    assert.equal(out.record.summaryPath, summaryPath, 'summary path must resolve to absolute (resume reads it from any cwd)');
    const onDisk = JSON.parse(require('node:fs').readFileSync(`${wtPath}.worker.json`, 'utf8'));
    assert.equal(onDisk.state, 'running');
    assert.equal(onDisk.pid, 4242);
  });

  test('record refuses a second dispatch while a running record exists (duplicate-dispatch guard)', () => {
    run('record', ['--path', wtPath, '--pid', '4242', '--plan', '3', '--summary-path', summaryPath]);
    const r = run('record', ['--path', wtPath, '--pid', '4242', '--plan', '3', '--summary-path', summaryPath]);
    assert.equal(r.exitCode, 1, 're-dispatching a recorded running worker must fail closed');
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'already_running');
    assert.match(r.stderr, /never re-dispatch a recorded plan/);
  });

  test('record after a terminal record is allowed (fresh lifecycle at the same path)', () => {
    run('record', ['--path', wtPath, '--pid', '4242', '--plan', '3', '--summary-path', summaryPath]);
    run('complete', ['--path', wtPath, '--exit-code', '0']);
    const r = run('record', ['--path', wtPath, '--pid', '4242', '--plan', '3', '--summary-path', summaryPath]);
    assert.equal(r.exitCode, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.record.state, 'running');
  });

  test('status composes the recovery view: dead pid + running record = needsReconciliation', () => {
    run('record', ['--path', wtPath, '--pid', '4242', '--plan', '3', '--summary-path', summaryPath]);
    const r = run('status', ['--path', wtPath], { isPidAlive: dead });
    const out = JSON.parse(r.stdout);
    assert.equal(out.found, true);
    assert.equal(out.workers[0].state, 'running');
    assert.equal(out.workers[0].pidAlive, false);
    assert.equal(out.workers[0].summaryExists, false, 'no SUMMARY written yet — nothing artifact-complete to reconcile');
    assert.equal(out.workers[0].needsReconciliation, true);
  });

  test('status surfaces artifact-completion independently of the process result', () => {
    run('record', ['--path', wtPath, '--pid', '4242', '--plan', '3', '--summary-path', summaryPath]);
    require('node:fs').writeFileSync(summaryPath, '# SUMMARY\n');
    const r = run('status', ['--path', wtPath], { isPidAlive: dead });
    const out = JSON.parse(r.stdout);
    assert.equal(out.workers[0].summaryExists, true, 'the exit-after-artifact-completion shape the issue describes');
    assert.equal(out.workers[0].needsReconciliation, true);
  });

  test('status --root scans every record and flags torn records as reconciliation candidates', () => {
    run('record', ['--path', wtPath, '--pid', '4242', '--plan', '3', '--summary-path', summaryPath]);
    require('node:fs').writeFileSync(path.join(dir, 'torn.worker.json'), '{ truncated');
    const r = run('status', ['--root', dir]);
    const out = JSON.parse(r.stdout);
    assert.equal(out.workers.length, 2);
    const torn = out.workers.find((w) => w.state === 'unreadable');
    assert.ok(torn, 'a torn record must surface, never silently vanish');
    assert.equal(torn.needsReconciliation, true);
  });

  test('status with no record reports found:false (unrecorded worktree)', () => {
    const r = run('status', ['--path', wtPath]);
    const out = JSON.parse(r.stdout);
    assert.equal(out.found, false);
    assert.deepEqual(out.workers, []);
  });

  test('complete is idempotent: a resumed session re-marking a terminal worker still succeeds', () => {
    run('record', ['--path', wtPath, '--pid', '4242', '--plan', '3', '--summary-path', summaryPath]);
    const first = run('complete', ['--path', wtPath, '--exit-code', '1', '--note', 'blocked: missing toolchain']);
    assert.equal(first.exitCode, 0);
    const again = run('complete', ['--path', wtPath, '--exit-code', '1', '--note', 'blocked: missing toolchain']);
    assert.equal(again.exitCode, 0);
    const out = JSON.parse(again.stdout);
    assert.equal(out.alreadyComplete, true);
    const view = JSON.parse(run('status', ['--path', wtPath], { isPidAlive: dead }).stdout);
    assert.equal(view.workers[0].state, 'complete');
    assert.equal(view.workers[0].exitCode, 1);
    assert.equal(view.workers[0].needsReconciliation, false, 'a terminal record never needs reconciliation');
  });

  test('complete without a record fails with no_record (never fabricates state)', () => {
    const r = run('complete', ['--path', wtPath, '--exit-code', '0']);
    assert.equal(r.exitCode, 1);
    assert.equal(JSON.parse(r.stdout).reason, 'no_record');
  });

  test('usage errors: missing/invalid --pid, and status requires exactly one of --path/--root', () => {
    assert.equal(run('record', ['--path', wtPath, '--plan', '3', '--summary-path', summaryPath]).exitCode, 2);
    assert.equal(run('record', ['--path', wtPath, '--pid', 'not-a-pid', '--plan', '3', '--summary-path', summaryPath]).exitCode, 2);
    assert.equal(run('record', ['--path', wtPath, '--pid', '4242', '--plan', '3']).exitCode, 2, '--summary-path is required — an omitted path would make summaryExists vacuously true');
    assert.equal(run('status', ['--path', wtPath, '--root', dir]).exitCode, 2);
    assert.equal(run('status', []).exitCode, 2);
  });

  test('end-to-end through the gsd-tools CLI router: record → status(dead pid) → complete', () => {
    const record = runNode([GSD_TOOLS, 'query', 'worktree', 'worker-record',
      '--path', wtPath, '--pid', String(process.pid), '--plan', '3', '--summary-path', summaryPath],
      { timeoutMs: PROBE_TIMEOUT_MS });
    assert.equal(record.exitCode, 0, `record failed: ${record.stderr}`);

    const deadPid = 2147483646; // max int32 — ESRCH on every platform, never a real pid
    runNode([GSD_TOOLS, 'query', 'worktree', 'worker-record',
      '--path', path.join(dir, 'agent-p4-1700000001'), '--pid', String(deadPid),
      '--plan', '4', '--summary-path', summaryPath], { timeoutMs: PROBE_TIMEOUT_MS });

    const status = runNode([GSD_TOOLS, 'query', 'worktree', 'worker-status', '--root', dir],
      { timeoutMs: PROBE_TIMEOUT_MS });
    assert.equal(status.exitCode, 0);
    const workers = JSON.parse(status.stdout).workers;
    const self = workers.find((w) => w.pid === process.pid);
    const gone = workers.find((w) => w.pid === deadPid);
    assert.equal(self.needsReconciliation, false, 'self pid is alive');
    assert.equal(gone.needsReconciliation, true, 'dead-pid worker needs reconciliation');

    const complete = runNode([GSD_TOOLS, 'query', 'worktree', 'worker-complete',
      '--path', wtPath, '--exit-code', '0'], { timeoutMs: PROBE_TIMEOUT_MS });
    assert.equal(complete.exitCode, 0);
  });
});
