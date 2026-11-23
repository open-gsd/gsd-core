'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { cleanup, createTempDir } = require('./helpers.cjs');
const { runNode, OUTCOME } = require('./helpers/process-seam.cjs');

// ─────────────────────────────────────────────────────────────────────────────
// #5327: capability-lock probed THIS process's start-time at module load. Every
// config read loads the module (config-loader → loadRegistry → capability-consent
// → capability-lock), so every gsd-tools invocation paid one probe — a PowerShell
// launch on Windows (~200 ms), a `ps` on macOS — even when it never took a lock.
//
// The start-time is only ever read by lockFileBody, so the contract pinned here:
//   - loading the module, and a whole config-reading CLI call, probe ZERO times;
//   - the first lock acquire probes ONCE, before the exclusive create, and later
//     acquires reuse that value;
//   - a FAILED probe is not cached: the next acquire retries, at most two probes
//     in all, so a host whose probe never succeeds stays bounded;
//   - the lock body still carries this process's start-time (the pid-reuse
//     discriminator the steal path compares against is unchanged).
//
// Each case runs in a fresh subprocess, because module-load behavior can only be
// observed on a cold require. The preload counts only probes naming the child's
// own pid, on whichever platform seam applies (/proc read, `ps`, PowerShell).
// ─────────────────────────────────────────────────────────────────────────────

const PRELOAD = path.join(__dirname, 'helpers', 'count-self-start-time-probes-preload.cjs');
const LOCK_LIB = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'capability-lock.cjs');
const GSD_TOOLS = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');
const PROBE_LINE = /^GSD_SELF_START_TIME_PROBES=(\d+)$/m;
const LOADED_LINE = /^GSD_CAPABILITY_LOCK_LOADED=(true|false)$/m;

function sandbox(t) {
  const dir = createTempDir('gsd-caplock-self-probe-');
  t.after(() => cleanup(dir));
  return dir;
}

function sandboxEnv(home) {
  return { ...process.env, HOME: home, USERPROFILE: home, GSD_HOME: path.join(home, '.gsd') };
}

describe('#5327 regression: capability-lock probes its own start-time lazily', () => {
  // The issue's literal repro (runtime-identity) plus a direct config read.
  for (const argv of [['runtime-identity', '--raw'], ['query', 'config-get', 'model_profile']]) {
    test(`gsd-tools ${argv.join(' ')} loads capability-lock but never probes its own start-time`, (t) => {
      const home = sandbox(t);
      fs.mkdirSync(path.join(home, '.planning'));
      fs.writeFileSync(path.join(home, '.planning', 'config.json'), JSON.stringify({ model_profile: 'quality' }));
      const res = runNode(['--require', PRELOAD, GSD_TOOLS, ...argv], { cwd: home, env: sandboxEnv(home) });
      assert.equal(res.outcome, OUTCOME.EXITED, res.stderr);
      assert.equal(res.exitCode, 0, res.stderr);

      // Without this, a future startup change that stops loading the module would pass vacuously.
      assert.match(res.stderr, LOADED_LINE);
      assert.equal(LOADED_LINE.exec(res.stderr)[1], 'true', 'the command must load capability-lock for the zero count to mean anything');

      const m = PROBE_LINE.exec(res.stderr);
      assert.ok(m, `preload did not report a probe count:\n${res.stderr}`);
      assert.equal(Number(m[1]), 0, 'loading capability-lock through a config read must not probe this process\'s start-time');
    });
  }

  // Three acquire/release cycles in one cold child; reports the probe count and lock body after each.
  function runThreeLockWrites(dir, extraEnv = {}) {
    const script = `
      const probes = globalThis.__gsdSelfStartTimeProbes;
      const fs = require('fs');
      const lock = require(${JSON.stringify(LOCK_LIB)});
      const lockPath = require('path').join(${JSON.stringify(dir)}, '.lock');
      const afterLoad = probes();
      const writes = [];
      for (let i = 0; i < 3; i++) {
        const handle = lock.acquireLock(lockPath);
        if (!handle) throw new Error('acquireLock ' + i + ' returned null');
        writes.push({ probes: probes(), body: JSON.parse(fs.readFileSync(lockPath, 'utf8')) });
        lock.releaseLock(handle);
      }
      const events = globalThis.__gsdSelfStartTimeEvents();
      const results = globalThis.__gsdSelfStartTimeResults();
      const direct = lock.getProcessStartTime(process.pid);
      process.stdout.write(JSON.stringify({ afterLoad, writes, events, results, direct }));
    `;
    const res = runNode(['--require', PRELOAD, '-e', script], { cwd: dir, env: { ...sandboxEnv(dir), ...extraEnv } });
    assert.equal(res.outcome, OUTCOME.EXITED, res.stderr);
    assert.equal(res.exitCode, 0, res.stderr);
    return JSON.parse(res.stdout);
  }

  test('module load probes zero times; the first lock acquire probes once and later acquires reuse it', (t) => {
    const r = runThreeLockWrites(sandbox(t));

    assert.equal(r.afterLoad, 0, 'requiring capability-lock must not probe this process\'s start-time');
    // Between the O_EXCL create and the body write a racing acquirer sees an empty lockfile, so the
    // (possibly slow) first probe must run before the create, not inside that window.
    assert.deepEqual(r.events.slice(0, 2), ['probe', 'open-wx'], 'the self probe runs before the first exclusive lockfile create');

    // A real probe can fail on a loaded host (a PowerShell launch past its 5 s timeout on a busy
    // Windows runner). That path is pinned deterministically by the forced-failure cases below.
    if (r.results[0] !== true) {
      t.skip('the real self probe failed on this host; the forced-failure cases pin that path');
      return;
    }
    assert.deepEqual(r.writes.map((w) => w.probes), [1, 1, 1], 'the first lock acquire probes once; later acquires reuse the cached start-time');
    assert.deepEqual(r.events, ['probe', 'open-wx', 'open-wx', 'open-wx']);

    // The steal path compares a holder's recorded startTime against a fresh probe of
    // that pid, so the body must still carry the value a direct probe returns.
    const body = r.writes[0].body;
    assert.equal(body.pid, Number(body.token.split('-')[0]));
    assert.equal(typeof body.startTime, 'string', 'a successful probe\'s start-time reaches the lock body');
    assert.ok(r.writes.every((w) => w.body.startTime === body.startTime), 'later acquires record the cached value');
    // The reference probe is a fresh real probe too, and can fail on its own.
    if (r.direct === null) {
      t.skip('the reference probe failed on this host; the recorded value is checked above');
      return;
    }
    assert.equal(body.startTime, r.direct, 'the lock body records this process\'s own start-time');
  });

  test('a failed first probe is not cached: the next acquire probes again and records the start-time', (t) => {
    const r = runThreeLockWrites(sandbox(t), { GSD_TEST_FAIL_SELF_PROBES: '1' });

    assert.equal(r.writes[0].body.startTime, null, 'the write after a failed probe records no start-time');
    assert.deepEqual(r.writes.map((w) => w.probes), [1, 2, 2], 'the failure is retried once, then the success is reused');
    if (r.results[1] !== true) {
      t.skip('the real retry probe failed on this host as well');
      return;
    }
    assert.equal(typeof r.writes[1].body.startTime, 'string', 'the retried probe\'s start-time reaches the lock body');
    assert.equal(r.writes[2].body.startTime, r.writes[1].body.startTime, 'the retried success is reused');
    if (r.direct === null) {
      t.skip('the reference probe failed on this host; the recorded value is checked above');
      return;
    }
    assert.equal(r.writes[1].body.startTime, r.direct);
  });

  test('a probe that never succeeds stops after two attempts instead of costing one per acquire', (t) => {
    const r = runThreeLockWrites(sandbox(t), { GSD_TEST_FAIL_SELF_PROBES: '2' });

    assert.deepEqual(r.writes.map((w) => w.probes), [1, 2, 2], 'no third probe after two failures');
    assert.deepEqual(r.writes.map((w) => w.body.startTime), [null, null, null]);
  });
});
