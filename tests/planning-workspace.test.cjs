const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { cleanup } = require('./helpers.cjs');
const { makeFakeClock } = require('./helpers/clock.cjs');

const planningWorkspaceDirect = require('../gsd-core/bin/lib/planning-workspace.cjs');

const {
  createPlanningWorkspace,
  createMemoryPointerAdapter,
  planningDir,
  planningPaths,
  withPlanningLock,
  getActiveWorkstream,
  setActiveWorkstream,
} = planningWorkspaceDirect;

describe('planning-workspace: planningDir/planningPaths parity', () => {
  const cwd = '/fake/repo';
  let savedProject;
  let savedWorkstream;

  beforeEach(() => {
    savedProject = process.env.GSD_PROJECT;
    savedWorkstream = process.env.GSD_WORKSTREAM;
    delete process.env.GSD_PROJECT;
    delete process.env.GSD_WORKSTREAM;
  });

  afterEach(() => {
    if (savedProject !== undefined) process.env.GSD_PROJECT = savedProject;
    else delete process.env.GSD_PROJECT;
    if (savedWorkstream !== undefined) process.env.GSD_WORKSTREAM = savedWorkstream;
    else delete process.env.GSD_WORKSTREAM;
  });

  test('matches expected path resolution', () => {
    assert.strictEqual(planningDir(cwd, null, null), path.join(cwd, '.planning'));
    assert.strictEqual(planningDir(cwd, 'feature-x', null), path.join(cwd, '.planning', 'workstreams', 'feature-x'));
    assert.strictEqual(planningDir(cwd, 'feature-x', 'my-app'), path.join(cwd, '.planning', 'my-app', 'workstreams', 'feature-x'));

    const paths = planningPaths(cwd, 'feature-x');
    assert.strictEqual(paths.planning, path.join(cwd, '.planning', 'workstreams', 'feature-x'));
    assert.strictEqual(paths.state, path.join(cwd, '.planning', 'workstreams', 'feature-x', 'STATE.md'));
    assert.strictEqual(paths.config, path.join(cwd, '.planning', 'workstreams', 'feature-x', 'config.json'));
  });

  test('rejects traversal and path separators', () => {
    assert.throws(() => planningDir(cwd, null, '../../etc'), /invalid path characters/);
    assert.throws(() => planningDir(cwd, 'foo/bar', null), /invalid path characters/);
    assert.throws(() => planningDir(cwd, 'foo\\bar', null), /invalid path characters/);
  });
});

describe('planning-workspace: session adapter precedence', () => {
  let savedSession;

  beforeEach(() => {
    savedSession = process.env.GSD_SESSION_KEY;
  });

  afterEach(() => {
    if (savedSession !== undefined) process.env.GSD_SESSION_KEY = savedSession;
    else delete process.env.GSD_SESSION_KEY;
  });

  test('uses session adapter over shared adapter when session key exists', () => {
    process.env.GSD_SESSION_KEY = 'session-123';

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-planning-precedence-'));
    try {
      fs.mkdirSync(path.join(tmpDir, '.planning', 'workstreams', 'session-ws'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, '.planning', 'workstreams', 'shared-ws'), { recursive: true });

      const session = createMemoryPointerAdapter('session-ws');
      const shared = createMemoryPointerAdapter('shared-ws');
      const workspace = createPlanningWorkspace(tmpDir, {
        activeWorkstreamAdapters: { session, shared },
      });

      assert.strictEqual(workspace.activeWorkstream.get(), 'session-ws');
    } finally {
      cleanup(tmpDir);
    }
  });
});

describe('planning-workspace: self-heal behavior', () => {
  test('clears invalid pointer names and returns null', () => {
    const adapter = createMemoryPointerAdapter('bad/name');
    const workspace = createPlanningWorkspace('/fake/repo', {
      activeWorkstreamAdapter: adapter,
    });

    assert.strictEqual(workspace.activeWorkstream.get(), null);
    assert.strictEqual(adapter.read(), null);
  });

  test('clears stale pointers when workstream directory is gone', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-planning-workspace-'));
    try {
      fs.mkdirSync(path.join(tmpDir, '.planning', 'workstreams'), { recursive: true });
      const adapter = createMemoryPointerAdapter('ghost');
      const workspace = createPlanningWorkspace(tmpDir, {
        activeWorkstreamAdapter: adapter,
      });

      assert.strictEqual(workspace.activeWorkstream.get(), null);
      assert.strictEqual(adapter.read(), null);
    } finally {
      cleanup(tmpDir);
    }
  });
});

describe('planning-workspace: lock seam', () => {
  test('exports withPlanningLock and acquires/release lock', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-planning-lock-'));
    try {
      const result = withPlanningLock(tmpDir, () => 'ok');
      assert.strictEqual(result, 'ok');
      assert.ok(!fs.existsSync(path.join(tmpDir, '.planning', '.lock')));
    } finally {
      cleanup(tmpDir);
    }
  });

  test('does not retry errors thrown by locked work', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-planning-lock-work-error-'));
    let attempts = 0;
    try {
      assert.throws(() => {
        withPlanningLock(tmpDir, () => {
          attempts += 1;
          const err = new Error('write failed inside critical section');
          err.code = 'EIO';
          throw err;
        });
      }, /write failed inside critical section/);
      assert.strictEqual(attempts, 1);
      assert.ok(!fs.existsSync(path.join(tmpDir, '.planning', '.lock')));
    } finally {
      cleanup(tmpDir);
    }
  });
});

describe('planning-workspace direct: functions expose matching behavior', () => {
  let savedSession;

  beforeEach(() => {
    savedSession = process.env.GSD_SESSION_KEY;
    delete process.env.GSD_SESSION_KEY;
  });

  afterEach(() => {
    if (savedSession !== undefined) process.env.GSD_SESSION_KEY = savedSession;
    else delete process.env.GSD_SESSION_KEY;
  });

  test('planning-workspace functions work consistently', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-core-compat-'));
    try {
      fs.mkdirSync(path.join(tmpDir, '.planning', 'workstreams', 'alpha'), { recursive: true });

      planningWorkspaceDirect.setActiveWorkstream(tmpDir, 'alpha');
      assert.strictEqual(planningWorkspaceDirect.getActiveWorkstream(tmpDir), 'alpha');
      assert.strictEqual(getActiveWorkstream(tmpDir), 'alpha');

      assert.strictEqual(
        planningWorkspaceDirect.planningDir(tmpDir, 'feature-x', 'my-project'),
        planningDir(tmpDir, 'feature-x', 'my-project')
      );
      assert.deepStrictEqual(
        planningWorkspaceDirect.planningPaths(tmpDir, 'feature-x'),
        planningPaths(tmpDir, 'feature-x')
      );

      setActiveWorkstream(tmpDir, null);
      assert.strictEqual(planningWorkspaceDirect.getActiveWorkstream(tmpDir), null);
    } finally {
      cleanup(tmpDir);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// withPlanningLock PID-liveness staleness + EEXIST safety (audit M1 + M2)
//
// M1: the prior timeout fallback unconditionally unlinked WHATEVER lock existed —
//     even a fresh, live holder's — then re-acquired. A legitimate op taking
//     longer than lockTimeout (10 000 ms) got its lock force-stolen. The fix gates
//     stealing on a real liveness signal (injected via _setLockProbes): a dead
//     holder is stolen promptly inside the polite loop; a LIVE holder is waited on
//     and, on genuine timeout, the waiter throws a clear timeout error rather than
//     corrupting the live holder's critical section.
//
// M2: the timeout-fallback re-acquire (acquireLock with { flag: 'wx' }) sat OUTSIDE
//     any try/catch — if another process re-created the lock between the unlink and
//     the wx write, a raw EEXIST escaped the helper and crashed the command. The
//     fix removes the unconditional force-steal so no raw EEXIST can escape.
// ─────────────────────────────────────────────────────────────────────────────

describe('withPlanningLock PID-liveness staleness + EEXIST safety (audit M1+M2)', () => {
  let tmpDir;
  let lockPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-liveness-planning-'));
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    lockPath = path.join(tmpDir, '.planning', '.lock');
  });

  afterEach(() => {
    planningWorkspaceDirect._resetLockProbes();
    if (typeof planningWorkspaceDirect._resetPlanningLockTestHooks === 'function') {
      planningWorkspaceDirect._resetPlanningLockTestHooks();
    }
    try { fs.unlinkSync(lockPath); } catch { /* ok */ }
    cleanup(tmpDir);
  });

  test('a dead holder recreated by a racer mid-steal is NOT double-stolen (identity re-confirm — PR #1532)', () => {
    const deadPid = 4040;
    const livePid = 5050;
    // Decision-time holder: a DEAD pid → eligible for steal inside the polite loop.
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: deadPid,
      cwd: tmpDir,
      acquired: new Date().toISOString(),
    }));

    planningWorkspaceDirect._setLockProbes({ isPidAlive: (pid) => pid === livePid });

    // Inject a concurrent waiter that, in the gap between our steal-DECISION and our
    // steal, already stole + recreated a FRESH lock owned by a LIVE pid. A correct
    // (identity-re-confirming) acquirer must notice the instance changed and must NOT
    // delete the racer's live replacement.
    let injected = false;
    planningWorkspaceDirect._setPlanningLockTestHooks({
      beforeSteal: () => {
        if (injected) return;
        injected = true;
        try { fs.unlinkSync(lockPath); } catch { /* ok */ }
        fs.writeFileSync(lockPath, JSON.stringify({
          pid: livePid,
          cwd: tmpDir,
          acquired: new Date().toISOString(),
        }));
      },
    });

    let ranCriticalSection = false;
    const clock = makeFakeClock(0);
    // The racer's replacement is held by a LIVE pid → the acquirer must wait on it and
    // budget out, NOT delete it and run the critical section (which a double-steal does).
    assert.throws(
      () => withPlanningLock(tmpDir, () => { ranCriticalSection = true; return 'x'; }, clock),
      (err) => err && err.lockTimeout === true,
      'acquirer must not double-steal the racer\'s live replacement — it must wait + time out'
    );
    assert.strictEqual(ranCriticalSection, false, 'critical section must NOT run — the live replacement was not stolen');
    assert.ok(fs.existsSync(lockPath), 'the racer\'s live replacement lock must survive');
    const body = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
    assert.strictEqual(body.pid, livePid, 'the racer\'s freshly-recreated live lock body must be intact (never deleted by a stale-decision unlink)');
  });

  test('exports _setLockProbes / _resetLockProbes seams', () => {
    assert.ok(typeof planningWorkspaceDirect._setLockProbes === 'function', '_setLockProbes seam must be exported');
    assert.ok(typeof planningWorkspaceDirect._resetLockProbes === 'function', '_resetLockProbes seam must be exported');
  });

  test('live holder held past lockTimeout is NOT force-stolen — waiter throws a clear timeout error', () => {
    const livePid = 5151;
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: livePid,
      cwd: tmpDir,
      acquired: new Date().toISOString(),
    }));

    // Holder pid reads as ALIVE → must never be force-stolen.
    planningWorkspaceDirect._setLockProbes({ isPidAlive: (pid) => pid === livePid });

    let ranCriticalSection = false;
    // Fake clock whose sleep advances past lockTimeout (10 000 ms) so the polite
    // loop budgets out; the live holder must survive and the waiter must throw.
    const clock = makeFakeClock(0);
    assert.throws(
      () => withPlanningLock(tmpDir, () => { ranCriticalSection = true; return 'stolen'; }, clock),
      /lock/i,
      'a live holder must never be force-stolen on timeout — the waiter must throw a clear timeout error'
    );

    assert.strictEqual(ranCriticalSection, false, 'critical section must NOT run against a live holder (no force-steal)');
    assert.ok(fs.existsSync(lockPath), 'live holder lock must still exist (not unlinked)');
    const body = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
    assert.strictEqual(body.pid, livePid, 'live holder lock body must be unchanged');
  });

  test('dead holder is stolen promptly inside the polite loop (no full timeout wait)', () => {
    const deadPid = 888;
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: deadPid,
      cwd: tmpDir,
      acquired: new Date().toISOString(),
    }));

    // Holder pid reads as DEAD → eligible for prompt steal inside the loop.
    planningWorkspaceDirect._setLockProbes({ isPidAlive: () => false });

    const clock = makeFakeClock(0);
    const result = withPlanningLock(tmpDir, () => 'acquired', clock);
    assert.strictEqual(result, 'acquired', 'dead holder lock must be stolen and the critical section must run');
    assert.ok(!fs.existsSync(lockPath), 'lock must be released after the critical section completes');
  });

  test('M2: no raw EEXIST escapes the helper on the timeout path against a live holder', () => {
    const livePid = 6262;
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: livePid,
      cwd: tmpDir,
      acquired: new Date().toISOString(),
    }));

    planningWorkspaceDirect._setLockProbes({ isPidAlive: (pid) => pid === livePid });

    const clock = makeFakeClock(0);
    let caught;
    try {
      withPlanningLock(tmpDir, () => 'x', clock);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, 'helper must surface a failure rather than silently force-stealing a live lock');
    assert.notStrictEqual(caught.code, 'EEXIST', 'a raw EEXIST must never escape the lock helper (M2)');
  });

  test('R4-FIX: false-alive pid-reuse holder aged past the deadman ceiling IS stolen (self-heal)', () => {
    const reusedPid = 7373;
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: reusedPid,
      cwd: tmpDir,
      acquired: new Date().toISOString(),
    }));

    // Probe says the recorded pid is ALIVE — simulating pid-reuse: the original holder
    // crashed but its pid was recycled by an unrelated live process. The .lock body has
    // no startTime, so liveness alone cannot distinguish this from a genuine live holder.
    planningWorkspaceDirect._setLockProbes({ isPidAlive: (pid) => pid === reusedPid });

    // Lock mtime ≈ now (real); seed the fake clock ABOVE the 60 000 ms deadman ceiling so
    // age = clock.now() - mtimeMs ≫ ceiling → the lock must be recovered despite "alive".
    // Without the ceiling, withPlanningLock would throw on every call with no self-heal.
    const clock = makeFakeClock(Date.now() + 120000);
    const result = withPlanningLock(tmpDir, () => 'self-healed', clock);
    assert.strictEqual(result, 'self-healed', 'a false-alive lock past the deadman ceiling must be stolen (no infinite block)');
    assert.ok(!fs.existsSync(lockPath), 'lock must be released after the critical section completes');
  });
});
