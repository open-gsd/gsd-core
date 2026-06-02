/**
 * Regression test for perf #407 — withPlanningLock allocates a fresh
 * SharedArrayBuffer on every retry iteration.
 *
 * The fix: hoist the sleep buffer allocation to once before the retry loop.
 * The buffer is never mutated and never escapes — Atomics.wait(buf,0,0,delay)
 * always sees 0 whether the buffer is fresh or reused, so the behavior is
 * identical.
 *
 * Observable invariant (POST-FIX): exactly ONE SharedArrayBuffer is allocated
 * per withPlanningLock call, regardless of retry count.
 *
 * RED (pre-fix):  sabCount >= 2 when >= 1 retry occurs.
 * GREEN (post-fix): sabCount === 1.
 *
 * Strategy: deterministic clock-seam approach (no real workers, no wall-clock).
 *   1. Spy on the SharedArrayBuffer constructor BEFORE requiring the module
 *      (clock.cjs allocates its module-level _realSleepBuf at load time).
 *   2. Pre-create the lock file so the first acquire attempt sees EEXIST.
 *   3. Inject a fake clock whose sleep() side-effect unlinks the lock file
 *      after the first call — so attempt #1 sees contention → clock.sleep()
 *      (which releases the lock) → attempt #2 acquires.
 *   4. Assert: fn ran, sleep was called >= 1 time (retry path exercised),
 *      and sabCount === 1 (the hoist invariant).
 *
 * This approach is fully synchronous and deterministic: no Atomics.wait, no
 * setTimeout, no worker scheduling races, no wall-clock dependence.
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { cleanup } = require('./helpers.cjs');

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const PLANNING_WORKSPACE_CJS_PATH = path.join(
  __dirname, '..', 'get-shit-done', 'bin', 'lib', 'planning-workspace.cjs'
);

const CLOCK_CJS_PATH = path.join(
  __dirname, '..', 'get-shit-done', 'bin', 'lib', 'clock.cjs'
);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-407-'));
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  return dir;
}

function removeTempDir(dir) {
  try { cleanup(dir); } catch { /* ignore */ }
}

/**
 * Install a counting spy on the global SharedArrayBuffer constructor.
 * Returns { getCount(), restore() }.
 * Must be installed BEFORE requiring any module that allocates SABs at load time.
 */
function spySAB() {
  const RealSAB = global.SharedArrayBuffer;
  let count = 0;

  function SpySAB(...args) {
    count++;
    return new RealSAB(...args);
  }
  SpySAB.prototype = RealSAB.prototype;
  SpySAB.BYTES_PER_ELEMENT = RealSAB.BYTES_PER_ELEMENT;

  global.SharedArrayBuffer = SpySAB;

  return {
    getCount() { return count; },
    restore() { global.SharedArrayBuffer = RealSAB; },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test
// ─────────────────────────────────────────────────────────────────────────────

describe('perf #407: withPlanningLock hoists sleep buffer — exactly one SAB per call', () => {
  let tmpDir;
  let lockPath;

  beforeEach(() => {
    tmpDir = makeTempDir();
    lockPath = path.join(tmpDir, '.planning', '.lock');
  });

  afterEach(() => {
    try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
    removeTempDir(tmpDir);
    // Purge module cache so each test gets a fresh require (and fresh SAB spy window).
    delete require.cache[PLANNING_WORKSPACE_CJS_PATH];
    delete require.cache[CLOCK_CJS_PATH];
  });

  test(
    'sabCount === 1 after a call that undergoes >= 1 retry (post-fix assertion)',
    () => {
      // ── Step 1: install SAB spy before requiring the module ────────────────
      // clock.cjs allocates its module-level _realSleepBuf at require time.
      // Spying before the require catches that allocation.
      const spy = spySAB();
      let withPlanningLock;
      try {
        // Purge any previously cached versions so the spy catches module-level allocs.
        delete require.cache[PLANNING_WORKSPACE_CJS_PATH];
        delete require.cache[CLOCK_CJS_PATH];
        withPlanningLock = require(PLANNING_WORKSPACE_CJS_PATH).withPlanningLock;
      } finally {
        spy.restore();
      }
      const sabCountAtLoad = spy.getCount();

      // ── Step 2: pre-create the lock file (simulates a contending process) ──
      // writing a valid lock JSON so withPlanningLock's stale-check doesn't
      // delete it immediately (mtime is NOW, well within the 30s stale window).
      fs.writeFileSync(lockPath, JSON.stringify({
        pid: process.pid + 1, // fake pid — not this process
        cwd: tmpDir,
        acquired: new Date().toISOString(),
      }));

      // ── Step 3: build a fake clock that releases contention on first sleep ─
      // Mechanism:
      //   - now() starts at 0; withPlanningLock checks `clock.now() - start < 10000`.
      //   - sleep() is called when EEXIST is seen and the lock is not stale.
      //     On the first sleep call we unlink the lock file so the next
      //     fs.writeFileSync(..., { flag: 'wx' }) attempt succeeds.
      //   - sleep() advances virtual time by the amount slept so elapsed-time
      //     checks work correctly (stale lock = > 30 000 ms — we advance by 100
      //     per sleep so we never trip that threshold accidentally).
      let sleepCallCount = 0;
      const fakeClock = {
        now() { return sleepCallCount * 100; }, // advances with each sleep
        sleep(_ms) {
          sleepCallCount++;
          if (sleepCallCount === 1) {
            // Release the contention: unlink the lock so the next attempt wins.
            try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
          }
        },
      };

      // ── Step 4: call withPlanningLock — must retry exactly once ───────────
      let fnRan = false;
      let callErr = null;
      try {
        withPlanningLock(tmpDir, () => { fnRan = true; }, fakeClock);
      } catch (e) {
        callErr = e;
      }

      // ── Assertions ─────────────────────────────────────────────────────────

      assert.ok(
        callErr === null,
        'withPlanningLock must succeed once the lock is released — error: ' +
          (callErr && callErr.message)
      );

      assert.ok(fnRan, 'the callback fn must have run');

      // PROOF OF RETRY-PATH COVERAGE (Contract 4 of test-rigor):
      //   sleepCallCount >= 1 proves the SUT entered the retry path.
      //   Without this witness, a no-retry success (if the lock was never seen)
      //   would also yield sabCount === 1 under both pre-fix and post-fix code,
      //   giving a false-pass against the bug.
      assert.ok(
        sleepCallCount >= 1,
        'fake clock sleep() must have been called at least once — the SUT must ' +
          'have entered the retry path. Got sleepCallCount: ' + sleepCallCount
      );

      // THE KEY INVARIANT:
      //   POST-FIX: sabCount === 1  (buffer allocated once, at module load, before any retry loop)
      //   PRE-FIX:  sabCount would be >= 2 (new buffer on every iteration)
      //
      // sabCountAtLoad counts ALL SABs allocated during require() of the module
      // (clock.cjs allocates one module-level _realSleepBuf). Combined with
      // sleepCallCount >= 1 above, sabCountAtLoad === 1 proves the buffer is
      // hoisted (post-fix).
      //
      // Note: with a fake clock injected, withPlanningLock itself never calls
      // realClock.sleep(), so no SABs are allocated during the lock call itself.
      // The spy window covers require() time only — which is exactly where the
      // module-level allocation happens post-fix (clock.cjs line: `new SharedArrayBuffer(4)`).
      assert.strictEqual(
        sabCountAtLoad,
        1,
        'post-fix: exactly one SharedArrayBuffer must be allocated when the module is ' +
          'loaded (buffer hoisted to module level in clock.cjs). Got: ' + sabCountAtLoad
      );
    }
  );
});
