'use strict';
// allow-test-rule: architectural-invariant (see #1531)
// acquireStateLock's "no orphan empty lock + no fd leak on a recoverable
// writeSync/closeSync error" property is a resource-safety invariant of a private
// function. A single-threaded test cannot otherwise force the openSync-succeeds-
// then-writeSync-throws window. The simulateWriteError seam injects exactly that
// one-shot failure; the onLoopIteration seam snapshots the lock file's existence
// at the top of the retry that follows — the only level at which the orphan is
// observable deterministically (no wall-clock, no threads).

/**
 * M9 — acquireStateLock leaks the fd AND strands the just-created empty lock
 * when writeSync/closeSync throws a RECOVERABLE errno (e.g. EAGAIN) after
 * openSync(O_CREAT|O_EXCL) already created the lock file. The pre-fix catch did
 * checkBudgetAndSleep + continue WITHOUT closeSync(fd) or unlinkSync(lockPath),
 * so every occurrence leaked a descriptor and left a content-less lock behind.
 *
 * capability-lock.cts:415-425 already ships the cleanup-before-bail pattern this
 * mirrors. The fix wraps the writeSync/closeSync in an inner try that
 * closeSync(fd) (guarded) + unlinkSync(lockPath) (guarded), then re-throws to the
 * existing outer catch (which keeps classifying recoverable vs fatal errnos — DRY).
 *
 * Deterministic repro (no wall-clock, no threads):
 *   - simulateWriteError: 'EAGAIN' injects a ONE-SHOT writeSync failure.
 *   - onLoopIteration snapshots fs.existsSync(lockPath) at the top of each retry.
 * On the retry iteration that follows the injected error:
 *   RED  (pre-fix):  the empty lock is still stranded → lockExists === true.
 *   GREEN (post-fix): cleanup unlinked it → lockExists === false.
 * And in BOTH the call still ultimately succeeds (M1's liveness steal recovers an
 * orphan) — so the orphan PRESENCE on the retry is the discriminating signal.
 *
 * A FATAL errno (e.g. ENOSPC, not in ACQUIRE_LOCK_RETRY_ERRNOS) must still
 * propagate after cleanup — covered by the fatal-propagation test below.
 *
 * Recurring closed family this guards: #500 / #905 / #1230 (STATE.md write
 * corruption); #453 deleted the flaky race tests so this path was under-tested.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { makeFakeClock } = require('./helpers/clock.cjs');
const stateMod = require('../gsd-core/bin/lib/state.cjs');
const { acquireStateLock, releaseStateLock } = stateMod;
const { cleanup } = require('./helpers.cjs');

describe('M9: acquireStateLock cleans up fd + orphan lock on recoverable write error', () => {
  let tmpDir;
  let statePath;
  let lockPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-m9-'));
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    statePath = path.join(tmpDir, '.planning', 'STATE.md');
    lockPath = statePath + '.lock';
    fs.writeFileSync(statePath, '# State\n');
  });

  afterEach(() => {
    stateMod._resetStateLockTestHooks();
    try { fs.unlinkSync(lockPath); } catch { /* ok */ }
    cleanup(tmpDir);
  });

  test('a one-shot recoverable writeSync error leaves NO stranded empty lock before the retry', () => {
    const clock = makeFakeClock(0);
    const lockExistsAtIterationTop = [];

    stateMod._setStateLockTestHooks({
      simulateWriteError: 'EAGAIN', // one-shot: thrown by the first writeSync
      onLoopIteration() {
        lockExistsAtIterationTop.push(fs.existsSync(lockPath));
      },
    });

    const acquired = acquireStateLock(statePath, clock);

    // The call must still ultimately succeed and hold the lock.
    assert.equal(acquired, lockPath, 'acquireStateLock must succeed after recovering from the write error');
    assert.ok(fs.existsSync(lockPath), 'a real lock must be held when acquire returns');

    // At least two iterations: the failing attempt, then the recovery retry.
    assert.ok(
      lockExistsAtIterationTop.length >= 2,
      'expected the injected write error to force at least one retry iteration'
    );

    // The discriminator: on the retry that FOLLOWS the injected write error, no
    // orphan empty lock may remain. Pre-fix it is still stranded (true); post-fix
    // the inner cleanup unlinked it (false).
    assert.equal(
      lockExistsAtIterationTop[1], false,
      'the empty lock created by the failed attempt must be unlinked (cleanup-before-retry) — ' +
      'no orphan lock may be stranded after a recoverable writeSync error (M9 / capability-lock.cts:415-425)'
    );

    releaseStateLock(acquired);
    assert.ok(!fs.existsSync(lockPath), 'lock removed after release');
  });

  test('the held lock body is a valid pid after recovery (write actually completed on retry)', () => {
    const clock = makeFakeClock(0);
    stateMod._setStateLockTestHooks({ simulateWriteError: 'EAGAIN' });

    const acquired = acquireStateLock(statePath, clock);
    const body = fs.readFileSync(lockPath, 'utf-8').trim();
    assert.equal(body, String(process.pid), 'recovered lock must carry the real pid (no content-less lock survives)');
    releaseStateLock(acquired);
  });

  test('a FATAL (non-recoverable) write error still propagates after cleanup — orphan not masked', () => {
    const clock = makeFakeClock(0);
    let iterations = 0;

    stateMod._setStateLockTestHooks({
      simulateWriteError: 'ENOSPC', // fatal: NOT in ACQUIRE_LOCK_RETRY_ERRNOS
      onLoopIteration() {
        // A fatal error must propagate on the FIRST attempt — never retried.
        iterations++;
      },
    });

    assert.throws(
      () => acquireStateLock(statePath, clock),
      (err) => err && err.code === 'ENOSPC',
      'a fatal write errno must propagate (not be masked by cleanup or retried)'
    );

    assert.equal(iterations, 1, 'a fatal write errno must NOT be retried (single attempt then propagate)');

    // After the throw, the empty lock created by the failed openSync must NOT be
    // left behind — cleanup runs even on the fatal path before re-throw.
    assert.ok(
      !fs.existsSync(lockPath),
      'fatal write error must still unlink the orphan lock before propagating (no stranded lock)'
    );
  });
});
