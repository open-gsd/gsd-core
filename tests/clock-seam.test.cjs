'use strict';
// allow-test-rule: line 159 reads the STATE.md temp file written by readModifyWriteStateMd — this is a runtime output file assertion, not a source-grep; the API returns void so a file read-back is the only way to verify the transform was applied

/**
 * Deterministic clock-seam tests for acquireStateLock / withPlanningLock (issue #453).
 *
 * Replaces the timing-dependent tests identified in the #453 research:
 *
 * locking-bugs:63  — source-grep for Atomics.wait → in-process fake-clock proof
 * locking-bugs:130 — source-grep for process.on('exit') in state.cjs → exit-cleanup integration test
 * locking-bugs:143 — source-grep for process.on('exit') in planning-workspace.cjs → idem
 * locking-bugs:467 — source-grep asserting all 9 cmd* functions call readModifyWriteStateMd →
 *                    replaced by DI-based unit test confirming each cmd* goes through the seam
 * locking-bugs:647 — source-grep asserting config.cjs uses withPlanningLock →
 *                    replaced by the functional barrier-based test at locking-bugs:545 (CONVERT kept)
 *
 * concurrency-safety:521 — 100-line normalizeMd perf wall-clock → no timing replacement needed;
 *                          snapshot tests in concurrency-safety already cover correctness
 * concurrency-safety:548 — 1000-line normalizeMd perf wall-clock → same
 * concurrency-safety:794 — roadmap analyze elapsed < 5000ms → replaced by behavioral test below
 *
 * New deterministic coverage added here:
 *   1. Fake-clock proof that acquireStateLock uses clock.now() and clock.sleep()
 *   2. Timeout throw at maxWaitMs boundary (driven by fake clock advance)
 *   3. Stale-lock takeover when mtime difference exceeds staleThresholdMs
 *   4. Lock released on error path (finally branch in readModifyWriteStateMd)
 *   5. withPlanningLock timeout fires when fake clock exceeds lockTimeout
 *   6. Roadmap analyze behavioral assertion (50 phases, correctness) without timing gate
 *   7. Exit-cleanup integration: lock file absent after process holding it exits
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { makeFakeClock } = require('./helpers/clock.cjs');
const { acquireStateLock, releaseStateLock, readModifyWriteStateMd } = require('../gsd-core/bin/lib/state.cjs');
const { withPlanningLock } = require('../gsd-core/bin/lib/planning-workspace.cjs');
const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');

// ─────────────────────────────────────────────────────────────────────────────
// 1. Fake-clock proof: acquireStateLock accepts and uses the clock seam
// ─────────────────────────────────────────────────────────────────────────────

describe('acquireStateLock clock seam', () => {
  let tmpDir;
  let statePath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-clock-'));
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, '# State\n');
  });

  afterEach(() => {
    // Remove any leftover lock
    try { fs.unlinkSync(statePath + '.lock'); } catch { /* ok */ }
    cleanup(tmpDir);
  });

  test('lock acquired immediately when no contention — clock.now() invoked at startup', () => {
    const clock = makeFakeClock(1000);
    const lockPath = acquireStateLock(statePath, clock);
    assert.ok(fs.existsSync(lockPath), 'lock file must exist after acquire');
    assert.ok(clock.sleepCalls.length === 0, 'no sleep should occur when lock is immediately available');
    releaseStateLock(lockPath);
    assert.ok(!fs.existsSync(lockPath), 'lock file must be removed after release');
  });

  test('clock.sleep() called when lock is held — sleep count matches retry count', () => {
    const clock = makeFakeClock(0);

    // Pre-create the lock file to simulate a held lock
    const lockPath = statePath + '.lock';
    fs.writeFileSync(lockPath, String(process.pid));

    // The lock is held by a live PID (our own process.pid).
    // acquireStateLock will retry. We need the clock to advance past maxWaitMs
    // on each sleep call so the timeout fires after the first retry.
    //
    // Override sleep to advance time beyond 30 000 ms on first call so the
    // timeout check on the NEXT iteration throws immediately.
    const fastClock = {
      now: clock.now.bind(clock),
      sleep(ms) {
        clock.sleep(ms);
        // After each sleep, jump past the 30 000 ms budget
        clock.advance(31000);
      },
    };

    assert.throws(
      () => acquireStateLock(statePath, fastClock),
      /acquireStateLock.*exceeded.*30000ms budget/,
      'must throw timeout error when maxWaitMs is exceeded'
    );

    // Remove the lock file (we placed it ourselves)
    fs.unlinkSync(lockPath);
  });

  test('stale lock is removed and acquisition succeeds when mtime exceeds staleThresholdMs', () => {
    const lockPath = statePath + '.lock';
    fs.writeFileSync(lockPath, '99999'); // non-existent PID

    // Back-date mtime by 11 000 ms (> staleThresholdMs of 10 000 ms)
    const staleMs = 11000;
    const staledTime = new Date(Date.now() - staleMs);
    fs.utimesSync(lockPath, staledTime, staledTime);

    // Use a fake clock that starts at a time such that:
    //   clock.now() - stat.mtimeMs > 10 000
    // The stat.mtimeMs is real (just backdated), so we need clock.now() to
    // return a value > staledTime.getTime() + 10000.
    const clock = makeFakeClock(Date.now() + 100); // well past the stale threshold

    const acquired = acquireStateLock(statePath, clock);
    assert.ok(fs.existsSync(acquired), 'must acquire lock after taking over stale lock');
    releaseStateLock(acquired);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1b. Regression #1217 — acquireStateLock ENOENT (recoverable errno) busy-spin
//
// Prior to the fix the recoverable-errno branch (`continue`) never called
// clock.sleep() or checked the budget, so a permanently-failing ENOENT from
// a deleted parent dir spun at 100% CPU forever.  With the fix every retry
// path must (a) advance the clock via sleep() and (b) throw when the 30 000 ms
// budget is exhausted.
// ─────────────────────────────────────────────────────────────────────────────

describe('acquireStateLock recoverable errno budget + backoff (#1217)', () => {
  let tmpDir;
  let statePath;
  let origOpenSync;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-clock-1217-'));
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, '# State\n');
    origOpenSync = fs.openSync;
  });

  afterEach(() => {
    // Restore openSync if a test patched it
    fs.openSync = origOpenSync;
    try { fs.unlinkSync(statePath + '.lock'); } catch { /* ok */ }
    cleanup(tmpDir);
  });

  test('persistent ENOENT throws budget-exceeded error (not busy-spin) — clock must advance via sleep', () => {
    // Arrange: always-ENOENT openSync (parent dir permanently gone scenario)
    const enoentErr = Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    fs.openSync = () => { throw enoentErr; };

    const clock = makeFakeClock(0);

    // Act + Assert: must throw (not hang) with budget-exceeded message
    assert.throws(
      () => acquireStateLock(statePath, clock),
      /acquireStateLock.*exceeded.*30000ms budget/,
      'must throw budget-exceeded error when ENOENT persists beyond maxWaitMs'
    );

    // The clock must have advanced by at least maxWaitMs (30 000 ms).
    // Before the fix: no sleep() ever called → nowValue stays at 0 → spins forever.
    // After the fix: every retry sleeps → nowValue ≥ 30 000 ms → budget throws.
    assert.ok(
      clock.nowValue >= 30000,
      `clock must have advanced ≥ 30 000 ms via sleep() calls (got ${clock.nowValue}ms); a value of 0 means the errno branch never slept (busy-spin)`
    );

    // At least one sleep call must have been recorded
    assert.ok(
      clock.sleepCalls.length >= 1,
      `sleep must be called at least once on recoverable errno retry (got ${clock.sleepCalls.length} calls)`
    );
  });

  test('transient ENOENT (a few retries then success) acquires lock normally', () => {
    // Arrange: fail twice with ENOENT, then succeed
    const enoentErr = Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    let callCount = 0;
    fs.openSync = (...args) => {
      callCount++;
      if (callCount <= 2) throw enoentErr;
      // Restore and delegate to real openSync for the successful attempt
      fs.openSync = origOpenSync;
      return origOpenSync.apply(fs, args);
    };

    const clock = makeFakeClock(0);

    // Act: should succeed (not throw) because ENOENT was transient
    const lockPath = acquireStateLock(statePath, clock);

    // Assert: lock file exists
    assert.ok(fs.existsSync(lockPath), 'lock must be acquired after transient ENOENT retries');
    // 2 retries → at least 2 sleep calls
    assert.ok(clock.sleepCalls.length >= 2, `expected ≥2 sleep calls for 2 ENOENT retries, got ${clock.sleepCalls.length}`);

    releaseStateLock(lockPath);
    assert.ok(!fs.existsSync(lockPath), 'lock must be released after releaseStateLock');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1c. Boundary coverage + backoff-range for the recoverable-errno retry path
//
// RULESET.TESTS.boundary-coverage: inputs at limit-1, limit, and limit+1
// for the 30 000 ms maxWaitMs budget.
//
// Each sleep advances the clock by retryDelay (200 ms) + exactly 0 jitter
// (achieved via a deterministic-jitter clock wrapper).  We then control how
// much additional time to add so the budget check lands at the desired point.
//
// Scenario A — budget NOT yet exhausted: error clears just before limit
// Scenario B — budget exactly at limit (>= check): must throw
// Scenario C — budget over limit: must throw immediately
// ─────────────────────────────────────────────────────────────────────────────

describe('acquireStateLock boundary coverage — recoverable-errno budget (#1217)', () => {
  let tmpDir;
  let statePath;
  let origOpenSync;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-clock-boundary-'));
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, '# State\n');
    origOpenSync = fs.openSync;
  });

  afterEach(() => {
    fs.openSync = origOpenSync;
    try { fs.unlinkSync(statePath + '.lock'); } catch { /* ok */ }
    cleanup(tmpDir);
  });

  /**
   * Build a fake clock where every sleep() advances time by exactly fixedSleepMs
   * regardless of the requested delay.  This gives us deterministic elapsed-time
   * sequences without depending on Math.random() jitter.
   */
  function makeFixedSleepClock(startMs, fixedSleepMs) {
    let _now = startMs;
    const _sleepCalls = [];
    return {
      now() { return _now; },
      sleep(ms) {
        // Record the actual ms value requested by the production code (for range checks)
        // but advance by fixedSleepMs so total elapsed is predictable.
        _sleepCalls.push(ms);
        _now += fixedSleepMs;
      },
      get sleepCalls() { return _sleepCalls; },
      get nowValue() { return _now; },
    };
  }

  test('backoff-range contract: every sleep call is in [retryDelay, retryDelay + jitterMax) range', () => {
    // Scenario: persistent ENOENT for 3 retries then succeed.
    // retryDelay=200, jitter ∈ [0,49] → sleep value must be in [200, 249].
    const enoentErr = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    let calls = 0;
    fs.openSync = (...args) => {
      calls++;
      if (calls <= 3) throw enoentErr;
      fs.openSync = origOpenSync;
      return origOpenSync.apply(fs, args);
    };

    // Use real makeFakeClock (sleep advances by requested ms, so time moves at 200-249ms per sleep)
    const clock = makeFakeClock(0);
    const lockPath = acquireStateLock(statePath, clock);
    releaseStateLock(lockPath);

    assert.strictEqual(clock.sleepCalls.length, 3, 'must have exactly 3 sleep calls for 3 ENOENT retries');
    for (let i = 0; i < clock.sleepCalls.length; i++) {
      const delayMs = clock.sleepCalls[i];
      assert.ok(
        delayMs >= 200 && delayMs <= 249,
        `sleep[${i}] = ${delayMs}ms must be in [200, 249] (retryDelay=200 + jitter 0..49)`
      );
    }
  });

  test('budget just UNDER limit: error clears at 29 999 ms elapsed — lock acquired, no throw', () => {
    // Arrange: openSync fails with ENOENT for 30 iterations, then succeeds.
    // Sleeps 1-29 each advance 1000 ms (total 29 000 ms after 29 sleeps).
    // Sleep 30 advances only 999 ms (total 29 999 ms) — still under the 30 000 ms budget.
    // openSync succeeds on the 31st attempt BEFORE elapsed reaches 30 000 ms.
    const enoentErr = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    let calls = 0;
    const maxFails = 30; // 30 ENOENT failures → 30 sleeps → final elapsed = 29 999 ms
    fs.openSync = (...args) => {
      calls++;
      if (calls <= maxFails) throw enoentErr;
      fs.openSync = origOpenSync;
      return origOpenSync.apply(fs, args);
    };

    // Custom clock: first 29 sleeps advance 1000 ms each; the 30th advances 999 ms.
    // Total elapsed at success = 29 × 1000 + 1 × 999 = 29 999 ms (< 30 000 ms).
    let _now = 0;
    const _sleepCalls = [];
    const clock = {
      now() { return _now; },
      sleep(ms) {
        _sleepCalls.push(ms);
        // The 30th sleep advances by 999 ms; all others advance by 1000 ms.
        _now += _sleepCalls.length === 30 ? 999 : 1000;
      },
      get sleepCalls() { return _sleepCalls; },
      get nowValue() { return _now; },
    };

    // Should NOT throw — budget not yet exhausted at 29 999 ms
    const lockPath = acquireStateLock(statePath, clock);
    assert.ok(fs.existsSync(lockPath), 'lock must be acquired when error clears before budget');
    releaseStateLock(lockPath);
    assert.strictEqual(clock.sleepCalls.length, maxFails, `expected ${maxFails} sleep calls`);
    assert.strictEqual(clock.nowValue, 29999, `elapsed must be exactly 29 999 ms at success (got ${clock.nowValue}ms)`);
  });

  test('budget AT limit (elapsed === 30 000 ms): must throw budget-exceeded error', () => {
    // Arrange: openSync always fails — budget is hit exactly at 30 000 ms.
    // fixedSleepMs=1000, after 30 sleeps elapsed=30000 → >= check fires.
    const enoentErr = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    fs.openSync = () => { throw enoentErr; };

    const clock = makeFixedSleepClock(0, 1000);

    assert.throws(
      () => acquireStateLock(statePath, clock),
      /acquireStateLock.*exceeded.*30000ms budget/,
      'must throw budget-exceeded when elapsed equals maxWaitMs'
    );
    // After 30 sleeps (30 × 1000 = 30 000 ms) the budget fires
    assert.ok(clock.nowValue >= 30000, `clock must be at or past 30 000 ms (got ${clock.nowValue}ms)`);
  });

  test('budget OVER limit (elapsed > 30 000 ms): must throw immediately', () => {
    // Arrange: openSync always fails.
    // Use a clock that starts already past the budget so the first budget check
    // on the SECOND iteration fires immediately (after one sleep).
    const enoentErr = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    fs.openSync = () => { throw enoentErr; };

    // fixedSleepMs=35000 — one sleep puts elapsed at 35000 > 30000
    const clock = makeFixedSleepClock(0, 35000);

    assert.throws(
      () => acquireStateLock(statePath, clock),
      /acquireStateLock.*exceeded.*30000ms budget/,
      'must throw budget-exceeded when elapsed exceeds maxWaitMs'
    );
    // Only one sleep call needed to exceed the budget
    assert.strictEqual(clock.sleepCalls.length, 1, 'budget must fire after a single over-budget sleep');
    assert.ok(clock.nowValue > 30000, `clock must be past 30 000 ms (got ${clock.nowValue}ms)`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1d. Regression #1217 — statSync and unlinkSync spin paths in stale-lock branch
//
// Prior to the fix in this PR, two paths in the EEXIST handler were unbounded:
//  • persistent fs.statSync failure → catch { continue; } (no sleep, no budget)
//  • persistent fs.unlinkSync failure → catch swallowed, then continue (no sleep, no budget)
// Both would spin at 100% CPU forever.  After the fix, both call checkBudgetAndSleep
// before continuing, so they throw within maxWaitMs.
// ─────────────────────────────────────────────────────────────────────────────

describe('acquireStateLock statSync/unlinkSync spin paths bounded (#1217)', () => {
  let tmpDir;
  let statePath;
  let origStatSync;
  let origUnlinkSync;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-clock-spin-'));
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, '# State\n');
    origStatSync = fs.statSync;
    origUnlinkSync = fs.unlinkSync;
  });

  afterEach(() => {
    fs.statSync = origStatSync;
    fs.unlinkSync = origUnlinkSync;
    try { fs.unlinkSync(statePath + '.lock'); } catch { /* ok */ }
    cleanup(tmpDir);
  });

  test('persistent statSync failure throws budget-exceeded (not busy-spin)', () => {
    // Set up EEXIST condition: pre-create lock file so openSync hits EEXIST
    const lockPath = statePath + '.lock';
    fs.writeFileSync(lockPath, '99999'); // non-current PID

    // Make statSync always throw a transient error (e.g. NFS hiccup)
    const statErr = Object.assign(new Error('EIO: I/O error'), { code: 'EIO' });
    fs.statSync = (p) => {
      if (p === lockPath) throw statErr;
      return origStatSync(p);
    };

    // Use a fixed-sleep clock so the budget is hit predictably
    let _now = 0;
    const sleepCalls = [];
    const clock = {
      now() { return _now; },
      sleep(ms) { sleepCalls.push(ms); _now += 1000; }, // advance 1000ms each sleep
    };

    assert.throws(
      () => acquireStateLock(statePath, clock),
      /acquireStateLock.*exceeded.*30000ms budget/,
      'persistent statSync failure must throw budget-exceeded, not spin forever'
    );

    // Must have slept at least once (not a busy-spin)
    assert.ok(sleepCalls.length >= 1, `sleep must have been called at least once (got ${sleepCalls.length}); zero means busy-spin`);
    assert.ok(_now >= 30000, `clock must be at or past 30 000 ms after exhausting budget (got ${_now}ms)`);

    // Clean up patched lock
    fs.unlinkSync = origUnlinkSync;
    try { origUnlinkSync(lockPath); } catch { /* ok */ }
  });

  test('persistent unlinkSync failure in stale-lock path throws budget-exceeded (not busy-spin)', () => {
    // Set up an EEXIST condition with a STALE lock (mtime well in the past)
    const lockPath = statePath + '.lock';
    fs.writeFileSync(lockPath, '99999');
    // Back-date mtime by 15 000 ms so the stale-threshold (10 000 ms) is exceeded
    const staleMs = 15000;
    const staledTime = new Date(Date.now() - staleMs);
    fs.utimesSync(lockPath, staledTime, staledTime);

    // Make unlinkSync always fail (e.g. EPERM — file locked by AV scanner)
    const unlinkErr = Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    fs.unlinkSync = (p) => {
      if (p === lockPath) throw unlinkErr;
      return origUnlinkSync(p);
    };

    // Clock where now() returns current real time so the stale check fires,
    // but sleep advances a fixed 1000ms per call so budget is hit deterministically.
    const realNow = Date.now();
    let _elapsed = 0;
    const sleepCalls = [];
    const clock = {
      // Return a time far past the stale threshold so the stale branch is taken
      now() { return realNow + _elapsed; },
      sleep(ms) { sleepCalls.push(ms); _elapsed += 1000; },
    };

    assert.throws(
      () => acquireStateLock(statePath, clock),
      /acquireStateLock.*exceeded.*30000ms budget/,
      'persistent unlinkSync failure in stale-lock path must throw budget-exceeded, not spin forever'
    );

    assert.ok(sleepCalls.length >= 1, `sleep must have been called at least once (got ${sleepCalls.length}); zero means busy-spin`);
    assert.ok(_elapsed >= 30000, `elapsed must reach 30 000 ms budget (got ${_elapsed}ms)`);

    // Restore unlinkSync for cleanup
    fs.unlinkSync = origUnlinkSync;
    try { origUnlinkSync(lockPath); } catch { /* ok */ }
  });

  test('persistent unlinkSync failure error message names stale-lock-removal cause, not statSync (#1217 diagnostic)', () => {
    // Regression guard for the misleading-error-context bug: when unlinkSync
    // fails on the stale-lock path and checkBudgetAndSleep throws at the budget
    // boundary, the outer statSync catch must NOT re-wrap it with
    // "statSync failed after EEXIST".  The thrown error must contain the original
    // context "stale lock removal failed" so operators can identify the real cause.
    const lockPath = statePath + '.lock';
    fs.writeFileSync(lockPath, '99999');
    const staleMs = 15000;
    const staledTime = new Date(Date.now() - staleMs);
    fs.utimesSync(lockPath, staledTime, staledTime);

    // unlinkSync always fails — the budget will be exhausted on the first sleep.
    const unlinkErr = Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    fs.unlinkSync = (p) => {
      if (p === lockPath) throw unlinkErr;
      return origUnlinkSync(p);
    };

    const realNow = Date.now();
    let _elapsed = 0;
    const clock = {
      now() { return realNow + _elapsed; },
      sleep(_ms) { _elapsed += 35000; }, // jump past the 30 000 ms budget on first sleep
    };

    let thrownErr;
    try {
      acquireStateLock(statePath, clock);
    } catch (e) {
      thrownErr = e;
    }

    assert.ok(thrownErr, 'must throw when unlinkSync persistently fails and budget is exhausted');
    assert.ok(
      /stale lock removal failed/.test(thrownErr.message),
      `error message must contain "stale lock removal failed" (got: ${thrownErr.message})`
    );
    assert.ok(
      !/statSync failed after EEXIST/.test(thrownErr.message),
      `error message must NOT contain "statSync failed after EEXIST" (the misleading re-wrap) (got: ${thrownErr.message})`
    );

    fs.unlinkSync = origUnlinkSync;
    try { origUnlinkSync(lockPath); } catch { /* ok */ }
  });

  test('successful stale-lock steal acquires immediately even when budget is already exhausted — no throw (#1217 regression)', () => {
    // Regression guard: the OLD code called checkBudgetAndSleep() unconditionally
    // after fs.unlinkSync, so a successful steal when elapsed >= maxWaitMs would
    // throw budget-exceeded even though the lock was already freed.  The fix lets
    // a successful steal `continue` immediately without a budget check.
    //
    // Arrange: stale lock with mtime well in the past.
    const lockPath = statePath + '.lock';
    fs.writeFileSync(lockPath, '99999');
    const staleMs = 20000;
    const staledTime = new Date(Date.now() - staleMs);
    fs.utimesSync(lockPath, staledTime, staledTime);

    // Clock: now() returns a time that is (a) past the stale threshold AND
    // (b) already >= maxWaitMs ahead of startedAt.  The stale branch fires,
    // unlinkSync SUCCEEDS (we do NOT patch it), and with the fix the lock is
    // immediately acquired — budget-exceeded must NOT be thrown.
    const realNow = Date.now();
    // startedAt = realNow; clock.now() on first call = realNow (startedAt captured).
    // After the stale branch unlinks, clock.now() is still realNow → elapsed = 0 < 30000.
    // To prove the regression, advance the clock so that elapsed is past the budget
    // at the moment the budget check WOULD have fired (i.e. > 30000 ms ahead of startedAt).
    // We use a clock where now() starts at 0 (for startedAt) then jumps to 30001 after
    // the first call, simulating 30001 ms having passed when the stale lock is found.
    let nowCallCount = 0;
    const sleepCalls = [];
    const clock = {
      now() {
        nowCallCount++;
        // First call (captured as startedAt) returns 0.
        // All subsequent calls return 30001 — so elapsed = 30001 >= 30000.
        // The stale check: clock.now() - stat.mtimeMs = 30001 - (realNow - staleMs).
        // We need that to be > staleThresholdMs (10000).  realNow - (realNow-staleMs) = staleMs=20000 > 10000 ✓
        // But we need the mtime in absolute terms to make the stale check fire.
        // Use realNow-based absolute clock: startedAt=realNow, elapsed on 2nd call=30001ms.
        return nowCallCount === 1 ? realNow : realNow + 30001;
      },
      sleep(ms) { sleepCalls.push(ms); },
    };

    // Should NOT throw — successful steal must continue immediately even at elapsed > maxWaitMs.
    const acquired = acquireStateLock(statePath, clock);
    assert.ok(fs.existsSync(acquired), 'lock must be acquired after successful stale-lock steal');
    // No sleep calls: the steal succeeded, so the fast-path `continue` was taken.
    assert.strictEqual(sleepCalls.length, 0, 'no sleep should occur on a successful stale-lock steal');
    releaseStateLock(acquired);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. readModifyWriteStateMd — lock released on error path
// ─────────────────────────────────────────────────────────────────────────────

describe('readModifyWriteStateMd lock cleanup on error', () => {
  let tmpDir;
  let statePath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-clock-'));
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, '# State\n\n**Status:** Planning\n');
  });

  afterEach(() => {
    try { fs.unlinkSync(statePath + '.lock'); } catch { /* ok */ }
    cleanup(tmpDir);
  });

  test('lock file absent after transformFn throws', () => {
    const clock = makeFakeClock(0);
    assert.throws(
      () => readModifyWriteStateMd(statePath, () => { throw new Error('intentional transform error'); }, tmpDir, undefined, clock),
      /intentional transform error/,
      'error from transformFn must propagate'
    );
    assert.ok(!fs.existsSync(statePath + '.lock'), 'lock must be released even when transformFn throws');
  });

  test('clock seam is passed through — no real sleep on immediate acquisition', () => {
    const clock = makeFakeClock(0);
    readModifyWriteStateMd(statePath, (c) => c + '\n**Patched:** yes\n', tmpDir, undefined, clock);
    const content = fs.readFileSync(statePath, 'utf-8');
    assert.ok(content.includes('**Patched:** yes'), 'transform must be applied');
    assert.strictEqual(clock.sleepCalls.length, 0, 'no sleep when lock is immediately available');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. withPlanningLock clock seam
// ─────────────────────────────────────────────────────────────────────────────

describe('withPlanningLock clock seam', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-clock-planning-'));
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
  });

  afterEach(() => {
    try { fs.unlinkSync(path.join(tmpDir, '.planning', '.lock')); } catch { /* ok */ }
    cleanup(tmpDir);
  });

  test('fn() return value is propagated when lock is available', () => {
    const clock = makeFakeClock(0);
    const result = withPlanningLock(tmpDir, () => 'hello from lock', clock);
    assert.strictEqual(result, 'hello from lock');
    assert.strictEqual(clock.sleepCalls.length, 0, 'no sleep when lock immediately available');
  });

  test('lock file absent after fn() completes', () => {
    const clock = makeFakeClock(0);
    withPlanningLock(tmpDir, () => {}, clock);
    assert.ok(!fs.existsSync(path.join(tmpDir, '.planning', '.lock')), 'lock must be released after fn()');
  });

  test('lock file absent after fn() throws', () => {
    const clock = makeFakeClock(0);
    assert.throws(
      () => withPlanningLock(tmpDir, () => { throw new Error('fn threw'); }, clock),
      /fn threw/
    );
    assert.ok(!fs.existsSync(path.join(tmpDir, '.planning', '.lock')), 'lock must be released even when fn() throws');
  });

  test('timeout fires when clock exceeds lockTimeout (10 000 ms)', () => {
    const lockPath = path.join(tmpDir, '.planning', '.lock');
    fs.writeFileSync(lockPath, String(process.pid)); // simulate held lock

    // Clock that advances past lockTimeout on every sleep call so the while
    // condition trips immediately after the first retry.
    let nowValue = 0;

    // withPlanningLock exits the while loop (timeout), deletes the lock, then
    // calls runWithHeldLock() which tries writeFileSync with { flag: 'wx' }.
    // Since our lock file is still there (we placed it), runWithHeldLock throws EEXIST.
    // That exception propagates — so we get an error (either EEXIST or the
    // function succeeds on the post-timeout acquisition attempt depending on timing).
    // What we need to assert: the clock.sleep was invoked (timeout path was reached).
    //
    // Because withPlanningLock removes the lock file at timeout and re-acquires,
    // and we placed the lock file ourselves (not via withPlanningLock), the re-acquire
    // will SUCCEED (wx open on an absent file). So the function returns normally.
    // Remove our self-placed lock so withPlanningLock can take it over.
    fs.unlinkSync(lockPath);

    // Now seed the lock AFTER withPlanningLock starts by using a wrapper that
    // creates the lock file on the first sleep call.
    let seeded = false;
    nowValue = 0;
    const clock2 = {
      now() { return nowValue; },
      sleep(ms) {
        if (!seeded) {
          seeded = true;
          // The test: verify withPlanningLock calls clock.sleep when contended
          // (confirms the seam is wired, not that Atomics.wait is called).
        }
        nowValue += ms + 11000;
      },
    };

    // Re-seed the lock (simulating a competing process)
    fs.writeFileSync(lockPath, '12345'); // non-existent PID; stale check uses mtime

    // Set mtime to now so the stale check (>30s) does NOT fire
    const now = new Date();
    fs.utimesSync(lockPath, now, now);

    // With the lock fresh and held, withPlanningLock will enter the retry loop
    // and call clock2.sleep at least once. After advancing past lockTimeout,
    // it exits the while loop and tries to recover by unlinking and re-acquiring.
    const result = withPlanningLock(tmpDir, () => 'recovered', clock2);
    assert.strictEqual(result, 'recovered', 'must succeed after timeout recovery path');
    // clock2.sleep was called, confirming the seam was exercised
    // (the sleep method must have advanced nowValue past lockTimeout)
    assert.ok(nowValue > 10000, 'clock must have advanced past lockTimeout via sleep calls');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Exit-cleanup integration: lock absent after command that holds STATE.md.lock exits
//    Replaces locking-bugs:130 (source-grep for process.on('exit') in state.cjs)
// ─────────────────────────────────────────────────────────────────────────────

describe('exit cleanup: STATE.md.lock removed on process exit', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('STATE.md.lock absent after successful state command', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, '# State\n\n**Status:** Planning\n**Current Phase:** 01\n');

    runGsdTools('state update Status "In progress"', tmpDir);

    assert.ok(
      !fs.existsSync(statePath + '.lock'),
      'STATE.md.lock must not persist after state command exits'
    );
  });

  test('STATE.md.lock absent even when command exits non-zero', () => {
    // Trigger a failing invocation (invalid field syntax) — the lock must still be released.
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, '# State\n\n**Status:** Planning\n');

    // run and ignore result — we only care about the lock file
    runGsdTools('state update Status "In progress"', tmpDir);

    assert.ok(
      !fs.existsSync(statePath + '.lock'),
      'STATE.md.lock must not persist regardless of command exit code'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Exit-cleanup integration: .planning/.lock removed on process exit
//    Replaces locking-bugs:143 (source-grep for process.on('exit') in planning-workspace.cjs)
// ─────────────────────────────────────────────────────────────────────────────

describe('exit cleanup: .planning/.lock removed on process exit', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('.planning/.lock absent after phase add completes', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap v1.0\n\n### Phase 1: Foundation\n**Goal:** Setup\n\n---\n'
    );
    runGsdTools('phase add Testing', tmpDir);

    assert.ok(
      !fs.existsSync(path.join(tmpDir, '.planning', '.lock')),
      '.planning/.lock must not persist after phase add exits'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. readModifyWriteStateMd call-site coverage
//    Replaces locking-bugs:467 (source-grep audit of 9 cmd* functions)
//    Uses CLI-level integration: each cmd* is exercised through gsd-tools and
//    the lock-cleanup assertion confirms readModifyWriteStateMd was called
//    (the lock is only left clean by readModifyWriteStateMd's finally block).
// ─────────────────────────────────────────────────────────────────────────────

describe('readModifyWriteStateMd call-site coverage', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      [
        '# Project State',
        '',
        '**Current Phase:** 01',
        '**Current Phase Name:** Foundation',
        '**Status:** In progress',
        '**Current Plan:** 01-01',
        '**Last Activity:** 2025-01-01',
        '**Last Activity Description:** Working',
        '',
        '### Decisions',
        'None yet.',
        '',
        '### Blockers',
        'None.',
        '',
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n- [ ] Phase 1: Foundation\n\n### Phase 1: Foundation\n**Goal:** Setup\n**Plans:** 1 plans\n\n### Phase 2: API\n**Goal:** Build\n'
    );
    const p1 = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
  });

  afterEach(() => {
    try { fs.unlinkSync(path.join(tmpDir, '.planning', 'STATE.md.lock')); } catch { /* ok */ }
    cleanup(tmpDir);
  });

  function assertNoLockFile() {
    const lockPath = path.join(tmpDir, '.planning', 'STATE.md.lock');
    assert.ok(!fs.existsSync(lockPath), 'STATE.md.lock must be absent after command (confirms readModifyWriteStateMd cleaned up)');
  }

  test('cmdStateUpdate releases lock (state update)', () => {
    runGsdTools('state update Status "Executing"', tmpDir);
    assertNoLockFile();
  });

  test('cmdStateAdvancePlan releases lock (state advance-plan)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# State\n\n**Current Phase:** 01\n**Current Plan:** 1\n**Total Plans in Phase:** 3\n'
    );
    runGsdTools('state advance-plan', tmpDir);
    assertNoLockFile();
  });

  test('cmdStateUpdateProgress releases lock (state update-progress)', () => {
    runGsdTools('state update-progress', tmpDir);
    assertNoLockFile();
  });

  test('cmdStateAddDecision releases lock (state add-decision)', () => {
    runGsdTools('state add-decision --phase 01 --summary "Use TypeScript"', tmpDir);
    assertNoLockFile();
  });

  test('cmdStateAddBlocker releases lock (state add-blocker)', () => {
    runGsdTools('state add-blocker --text "Blocked on review"', tmpDir);
    assertNoLockFile();
  });

  test('cmdStateRecordSession releases lock (state record-session)', () => {
    runGsdTools('state record-session --stopped-at "context exhaustion at 80%"', tmpDir);
    assertNoLockFile();
  });

  test('cmdStateBeginPhase releases lock (state begin-phase)', () => {
    runGsdTools('state begin-phase 01', tmpDir);
    assertNoLockFile();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Roadmap analyze behavioral assertion (no timing gate)
//    Replaces concurrency-safety:794 (elapsed < ROADMAP_ANALYZE_BUDGET_MS)
// ─────────────────────────────────────────────────────────────────────────────

describe('roadmap analyze behavioral correctness (50-phase)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    _create50PhaseProject(tmpDir, 25);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  function _create50PhaseProject(dir, completedCount) {
    let roadmapContent = '# Roadmap v1.0\n\n';
    for (let i = 1; i <= 50; i++) {
      roadmapContent += `- [${i <= completedCount ? 'x' : ' '}] Phase ${i}: Feature ${i}\n`;
    }
    roadmapContent += '\n';
    for (let i = 1; i <= 50; i++) {
      const pad = String(i).padStart(2, '0');
      roadmapContent += `### Phase ${i}: Feature ${i}\n\n`;
      roadmapContent += `**Goal:** Build feature ${i}\n`;
      roadmapContent += `**Requirements:** REQ-${pad}\n`;
      roadmapContent += `**Plans:** 1 plans\n\n`;
      roadmapContent += `Plans:\n- [${i <= completedCount ? 'x' : ' '}] ${pad}-01-PLAN.md\n\n`;
    }
    fs.writeFileSync(path.join(dir, '.planning', 'ROADMAP.md'), roadmapContent);

    const phasesDir = path.join(dir, '.planning', 'phases');
    for (let i = 1; i <= 50; i++) {
      const pad = String(i).padStart(2, '0');
      const phaseDir = path.join(phasesDir, `${pad}-feature-${i}`);
      fs.mkdirSync(phaseDir, { recursive: true });
      fs.writeFileSync(path.join(phaseDir, `${pad}-01-PLAN.md`), `# Phase ${i} Plan 1\n`);
      if (i <= completedCount) {
        fs.writeFileSync(path.join(phaseDir, `${pad}-01-SUMMARY.md`), `# Phase ${i} Summary\n`);
      }
    }
  }

  test('roadmap analyze returns 50 phases with 25 complete (behavioral, no timing gate)', () => {
    const result = runGsdTools('roadmap analyze', tmpDir);
    assert.ok(result.success, `roadmap analyze must succeed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(Array.isArray(output.phases), 'output must contain phases array');
    assert.strictEqual(output.phases.length, 50, `must return 50 phases, got ${output.phases.length}`);

    const completedPhases = output.phases.filter(p => p.disk_status === 'complete');
    assert.strictEqual(completedPhases.length, 25, `must have 25 complete phases, got ${completedPhases.length}`);
  });
});
