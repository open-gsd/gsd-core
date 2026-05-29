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
 * Strategy: two Worker threads run in parallel.
 *   Worker A (lock holder): writes the lock file with the current process pid,
 *     sleeps 400ms via Atomics.wait, then removes the lock.
 *   Worker B (writer): installs a counting SharedArrayBuffer stub, then calls
 *     withPlanningLock — which retries until A releases.
 *     Reports sabCount via postMessage.
 *
 * Using Worker threads (not child processes) avoids the node --test subprocess-
 * detection hang that occurs with spawn() inside a test runner worker context.
 *
 * Total test wall-time: ~400-600ms.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Worker } = require('worker_threads');

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const PLANNING_WORKSPACE_CJS_PATH = path.join(
  __dirname, '..', 'get-shit-done', 'bin', 'lib', 'planning-workspace.cjs'
);

// Worker A: holds the planning lock file for holdMs, then removes it.
// workerData: { lockPath, holdMs }
const HOLDER_WORKER_CODE = `
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
// Write pid to lock file so withPlanningLock sees a live pid and retries.
const lockContent = JSON.stringify({ pid: process.pid, cwd: '/tmp', acquired: new Date().toISOString() });
fs.writeFileSync(workerData.lockPath, lockContent);
parentPort.postMessage({ pid: process.pid });
// Synchronous sleep — blocks this worker thread for holdMs ms.
const buf = new Int32Array(new SharedArrayBuffer(4));
Atomics.wait(buf, 0, 0, workerData.holdMs);
// Release the lock.
try { fs.unlinkSync(workerData.lockPath); } catch { /* already gone */ }
parentPort.postMessage({ done: true });
`;

// Worker B: stubs global.SharedArrayBuffer with a counting call-through wrapper,
// then calls withPlanningLock, and reports sabCount.
// workerData: { planningWorkspaceCjsPath, cwd }
const WRITER_WORKER_CODE = `
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const RealSAB = global.SharedArrayBuffer;
let sabCount = 0;
// Stub: increments sabCount, calls through so Atomics.wait gets a real SAB-backed buffer.
function StubSAB(...args) {
  sabCount++;
  return new RealSAB(...args);
}
StubSAB.prototype = RealSAB.prototype;
global.SharedArrayBuffer = StubSAB;

// Lock-attempt counter: stubs fs.writeFileSync to count atomic-create attempts
// (planning-workspace.cjs's withPlanningLock uses fs.writeFileSync(..., { flag: 'wx' })
// to atomically create the lock file). Each call with flag:'wx' is one retry-
// loop iteration. >=2 attempts proves the SUT entered the retry path — without
// this witness, a no-retry success would yield sabCount === 1 from BOTH pre-fix
// and post-fix code (the SAB is allocated unconditionally post-fix, and exactly
// once for the single successful write pre-fix), giving a false-pass against
// the bug. The 1000ms holdMs + 100ms SUT retry delay guarantees >=9 attempts
// even on the slowest CI runners.
const realWriteFileSync = fs.writeFileSync.bind(fs);
let lockAttempts = 0;
fs.writeFileSync = function(filePath, data, options) {
  if (typeof filePath === 'string' && filePath.endsWith('.lock') &&
      options && typeof options === 'object' && options.flag === 'wx') {
    lockAttempts++;
  }
  return realWriteFileSync(filePath, data, options);
};

// Delete cache entry to ensure a fresh require picks up the stubbed constructor.
// (The inline "new SharedArrayBuffer(4)" in withPlanningLock reads the global at
// call time, so even a cached require would use our stub — but deleting avoids
// any module-level SAB allocations from a prior require contaminating sabCount.)
delete require.cache[workerData.planningWorkspaceCjsPath];
const { withPlanningLock } = require(workerData.planningWorkspaceCjsPath);

let callErr = null;
try {
  withPlanningLock(workerData.cwd, () => {});
} catch (e) {
  callErr = (e && e.message) ? e.message : String(e);
}
parentPort.postMessage({ sabCount, lockAttempts, callErr });
`;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-407-'));
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  return dir;
}

function removeTempDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
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
  });

  test(
    'sabCount === 1 after a call that undergoes >= 1 retry (post-fix assertion)',
    { timeout: 8000 },
    async () => {
      // ── Worker A: hold the lock for 1000ms ─────────────────────────────────
      // planning-workspace.cjs retry delay = 100ms; 1000ms hold guarantees >=9
      // retries even on the slowest CI worker (~200ms spawn + 9 retry intervals
      // ~900ms ≈ hold duration). The lockAttempts assertion below proves the
      // retry path was exercised end-to-end.
      const holdMs = 1000;
      let holderWorker;
      let resolveLockWritten;
      const lockWritten = new Promise((resolve) => { resolveLockWritten = resolve; });
      const holderDone = new Promise((resolve, reject) => {
        holderWorker = new Worker(HOLDER_WORKER_CODE, {
          eval: true,
          workerData: { lockPath, holdMs },
        });
        holderWorker.on('message', (msg) => {
          if (msg.pid !== undefined) resolveLockWritten();
          if (msg.done) resolve();
        });
        holderWorker.on('error', (err) => {
          resolveLockWritten(); // unblock so the assert below fires immediately
          reject(err);
        });
        holderWorker.on('exit', (code) => {
          resolveLockWritten(); // unblock if Worker A exits before posting
          if (code !== 0) reject(new Error('Holder worker exit code: ' + code));
        });
      });
      // Suppress unhandled-rejection warnings on holderDone — we always observe
      // it later via `await holderDone`, which re-throws the original error.
      holderDone.catch(() => {});

      // Deterministic synchronization: await Worker A's {pid} message, which
      // it posts AFTER fs.writeFileSync returns (single-thread source order
      // within the worker). By the time the parent receives this message,
      // the lock file exists on disk and is visible across threads (workers
      // share the same OS file table). The MessagePort buffers messages
      // posted before the listener attaches, so there is no listener-race.
      // Ref: https://nodejs.org/api/worker_threads.html#event-message_1
      // The 5000ms safety timeout catches a hung holder; nominal latency <50ms.
      let lockWrittenTimer;
      const lockWrittenTimeout = new Promise((_, reject) => {
        lockWrittenTimer = setTimeout(
          () => reject(new Error('Holder worker did not post pid within 5000ms')),
          5000
        );
      });
      try {
        await Promise.race([lockWritten, lockWrittenTimeout]);
      } finally {
        clearTimeout(lockWrittenTimer);
      }
      assert.ok(fs.existsSync(lockPath), 'Worker A must have written the lock file');

      // ── Worker B: call withPlanningLock, measure SAB allocations ───────────
      const writeResult = await new Promise((resolve, reject) => {
        const writer = new Worker(WRITER_WORKER_CODE, {
          eval: true,
          workerData: {
            planningWorkspaceCjsPath: PLANNING_WORKSPACE_CJS_PATH,
            cwd: tmpDir,
          },
        });
        writer.on('message', resolve);
        writer.on('error', reject);
        writer.on('exit', (code) => {
          if (code !== 0) reject(new Error('Writer worker exit code: ' + code));
        });
      });

      // Wait for Worker A to finish releasing
      await holderDone;

      // ── Assertions ─────────────────────────────────────────────────────────
      assert.ok(
        writeResult.callErr === null,
        'withPlanningLock must succeed once the lock is released — error: ' + writeResult.callErr
      );

      assert.ok(
        writeResult.sabCount >= 1,
        'at least one SharedArrayBuffer must be allocated (the sleep buffer must exist)'
      );

      // PROOF OF RETRY-PATH COVERAGE (Contract 4 of test-rigor):
      //   The sabCount === 1 invariant below only discriminates pre-fix from
      //   post-fix when the SUT actually entered the retry loop. Without this
      //   witness, a no-retry success path yields sabCount === 1 under BOTH
      //   pre-fix and post-fix code (one SAB for the single successful write).
      //   lockAttempts counts atomic-create attempts (fs.writeFileSync with
      //   { flag: 'wx' }); >=2 means at least one failed-then-retried.
      assert.ok(
        writeResult.lockAttempts >= 2,
        'SUT must have entered the retry path (>=1 failed lock attempt before success). ' +
          'Got lockAttempts: ' + writeResult.lockAttempts + '. The 1000ms holdMs + 100ms ' +
          'SUT retry delay guarantees >=2 attempts on any CI runner.'
      );

      // THE KEY INVARIANT:
      //   POST-FIX: sabCount === 1  (buffer allocated once, before the retry loop)
      //   PRE-FIX:  sabCount === lockAttempts (new buffer on EVERY iteration)
      // Combined with lockAttempts >= 2 above, sabCount === 1 strictly proves
      // the buffer is hoisted (post-fix). Pre-fix code would observe sabCount
      // equal to the iteration count, never 1.
      assert.strictEqual(
        writeResult.sabCount,
        1,
        'post-fix: exactly one SharedArrayBuffer must be allocated per withPlanningLock call ' +
          '(buffer hoisted before retry loop). Got: ' + writeResult.sabCount +
          ' across ' + writeResult.lockAttempts + ' lock attempts.'
      );
    }
  );
});
