'use strict';

/**
 * #6086 — the leftover-stall helper itself: a stall made the direct child (`exec sleep`) is killed by the
 * bound and leaves nothing; a stall under a shell is orphaned and the helper catches it.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runHook, OUTCOME } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { leftoversOf, assertNoLeftoverStall, killRecordedStalls } = require('./helpers/stall-leftovers.cjs');
const { cleanup } = require('./helpers.cjs');

const POSIX = process.platform !== 'win32';
const skip = !POSIX && 'ps is POSIX-only';

/** A bound much shorter than the stall: the stall is the thing the bound must catch. */
const SHORT_BOUND_MS = PROBE_TIMEOUT_MS / 10;

describe('stall-leftovers (#6086)', () => {
  test('an exec`d stall is the process the bound kills: nothing is left', { skip }, () => {
    const r = runHook('-c', ['exec sleep 31.0871'], { interpreter: 'bash', timeoutMs: SHORT_BOUND_MS });
    assert.equal(r.outcome, OUTCOME.TIMED_OUT);
    assertNoLeftoverStall(assert, 'sleep 31.0871', 'exec stall');
  });

  test('a stall left running after its parent exits is reported by the helper', { skip }, (t) => {
    const marker = 'sleep 31.0872';
    // a backgrounded sleep outlives the shell that started it, exactly the reparented orphan of #6086;
    // the shell prints the sleep's pid so the test ends exactly the process it made
    const r = runHook('-c', [`${marker} & echo $!`], { interpreter: 'bash', timeoutMs: PROBE_TIMEOUT_MS });
    assert.equal(r.outcome, OUTCOME.EXITED);
    const orphan = Number.parseInt(r.stdout.trim(), 10);
    assert.ok(Number.isInteger(orphan) && orphan > 0, `the shell must print the sleep's pid; got ${JSON.stringify(r.stdout)}`);
    t.after(() => {
      try {
        process.kill(orphan, 'SIGTERM');
      } catch {
        // already gone
      }
    });
    assert.deepEqual(leftoversOf(marker), [marker]);
    assert.throws(() => assertNoLeftoverStall(assert, marker, 'orphaned stall'), /outlived the test/);
  });

  test('killRecordedStalls ends a recorded sleep and leaves a recorded non-sleep pid alone', { skip }, (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-6086-'));
    t.after(() => cleanup(dir));
    const pidFile = path.join(dir, 'pids.txt');
    // the hook shape the git-hook test uses: a script that records its own pid, then execs the stall, so the
    // recorded pid IS the sleep's
    const hook = path.join(dir, 'hook.sh');
    fs.writeFileSync(hook, `#!/bin/sh\necho $$ >> '${pidFile}'\nexec sleep 31.0873\n`, { mode: 0o755 });
    // the outer bash is what the bound kills (as git is in the real test); the hook's sleep is orphaned
    const bg = runHook('-c', [`'${hook}' & wait`], { interpreter: 'bash', timeoutMs: SHORT_BOUND_MS });
    assert.equal(bg.outcome, OUTCOME.TIMED_OUT);
    assert.ok(fs.existsSync(pidFile), 'the hook ran far enough to record its pid');
    assert.deepEqual(leftoversOf('sleep 31.0873'), ['sleep 31.0873'], 'the recorded stall is orphaned and alive');
    // this node process is recorded too: it is not a `sleep`, so it must survive the kill
    fs.appendFileSync(pidFile, `${process.pid}\n`);
    killRecordedStalls(pidFile);
    assertNoLeftoverStall(assert, 'sleep 31.0873', 'recorded stall');
    assert.equal(process.kill(process.pid, 0), true, 'a recorded non-sleep pid is never signalled');
  });

  test('where ps is unavailable the helpers report null instead of asserting', { skip: POSIX && 'POSIX has ps' }, () => {
    assert.equal(leftoversOf('sleep 1'), null);
    assert.doesNotThrow(() => assertNoLeftoverStall(assert, 'sleep 1', 'win32'));
  });
});
