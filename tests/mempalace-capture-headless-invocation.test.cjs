'use strict';

// #4700 / #6266: the shipped headless capture snippet, run under bash with a stubbed `mempalace`: a locked palace
// never drops the capture silently, and a capture never starts the daemon. #4700 queued the headless mine with
// --daemon --background; on MemPalace 3.12 that flag AUTO-STARTS a daemon which holds the palace writer lock for its
// whole life and blocks every MCP write tool (#6266). The daemon route is now used only when a daemon is already
// running; otherwise a plain mine is retried with bounded backoff and a final failure is reported.
//
// The text of the same surfaces (no --room, staging instructions, the rooms: YAML, the fragment, .gitignore) is the
// text contract scripts/static-checks/text-contracts/mempalace-capture-headless-invocation.cjs; this file keeps the
// cases whose subject is the behaviour of the snippet when it runs.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');
const { runHook, assertSeamExit } = require('./helpers/process-seam.cjs');
const { cleanup } = require('./helpers.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const ROOT = path.resolve(__dirname, '..');

describe('#4700 / #6266 — headless mine: daemon only when running, bounded retry otherwise', () => {
  const SURFACES = [
    'commands/gsd/mempalace-capture.md',
    'skills/gsd-mempalace-capture/SKILL.md',
  ];

  // The shipped snippet: from the #6266 comment to the `fi` that closes the daemon guard, one list-indent removed.
  function snippetOf(rel) {
    const lines = splitLines(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    const from = lines.findIndex((l) => l.includes('#6266: use the daemon route only when'));
    assert.ok(from !== -1, `${rel}: the #6266 daemon-route comment must be present`);
    const to = lines.findIndex((l, i) => i > from && /^\s*fi\s*$/.test(l));
    assert.ok(to !== -1, `${rel}: the daemon guard must be closed by fi`);
    return lines.slice(from, to + 1).map((l) => l.replace(/^ {3}/, '')).join('\n').replaceAll('<wing>', 'w');
  }

  // `mempalace` is a stub that logs every call: `daemon status` answers DAEMON_RC, and `mine` exits MINE_RC
  // (1 = a held lock) for its first MINE_FAILS calls. `sleep` logs its delay so the backoff is visible.
  function runCapture(rel, { daemonRc, mineFails, mineRc = 1 }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-6266-'));
    const log = path.join(dir, 'calls.log');
    const script = [
      'STAGE=/stage',
      'sleep() { printf "sleep %s\\n" "$1" >> "$CALL_LOG"; }',
      'mempalace() { printf "%s\\n" "$*" >> "$CALL_LOG"; case "$1" in',
      '  daemon) return "$DAEMON_RC";;',
      '  mine) if [ "$(grep -c "^mine " "$CALL_LOG")" -gt "$MINE_FAILS" ]; then return 0; else return "$MINE_RC"; fi;;',
      'esac; }',
      snippetOf(rel),
    ].join('\n');
    try {
      const res = runHook('-c', [script], {
        interpreter: 'bash',
        env: { ...process.env, CALL_LOG: log, DAEMON_RC: String(daemonRc), MINE_FAILS: String(mineFails), MINE_RC: String(mineRc) },
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      const calls = fs.existsSync(log) ? splitLines(fs.readFileSync(log, 'utf8')).filter(Boolean) : [];
      return { res, calls, mines: calls.filter((c) => c.startsWith('mine ')), sleeps: calls.filter((c) => c.startsWith('sleep ')) };
    } finally {
      cleanup(dir);
    }
  }

  for (const rel of SURFACES) {
    test(`${rel}: a running daemon is used (--daemon --background) and nothing else is mined`, () => {
      const { res, calls, mines } = runCapture(rel, { daemonRc: 0, mineFails: 0 });
      assertSeamExit(assert, res, 0, 'the snippet must run to completion');
      assert.deepEqual(calls, ['daemon status', 'mine /stage --wing w --daemon --background']);
      assert.equal(mines.length, 1);
    });

    test(`${rel}: with no daemon running a plain mine runs and the daemon is never started`, () => {
      const { res, calls, mines } = runCapture(rel, { daemonRc: 1, mineFails: 0 });
      assertSeamExit(assert, res, 0, 'the snippet must run to completion');
      assert.deepEqual(mines, ['mine /stage --wing w --direct'], 'a plain mine would follow a prefer/require policy and start the daemon');
      assert.ok(!calls.some((c) => c.includes('--daemon') || c.startsWith('daemon start')), 'no daemon may be started');
      assert.doesNotMatch(res.stdout, /skipped/);
    });

    test(`${rel}: a held lock is retried at limit-1, limit and limit+1 failures, then reported, never silent`, () => {
      // Three attempts: two failures still file the capture, three or more are reported.
      const recovered = runCapture(rel, { daemonRc: 1, mineFails: 2 });
      assert.equal(recovered.mines.length, 3, 'limit-1 failures: the third attempt files it');
      assert.doesNotMatch(recovered.res.stdout, /skipped/);
      for (const fails of [3, 4]) {
        const lost = runCapture(rel, { daemonRc: 1, mineFails: fails });
        assertSeamExit(assert, lost.res, 0, 'a skipped capture never fails the step (onError: skip)');
        assert.equal(lost.mines.length, 3, `${fails} failures: still exactly three attempts`);
        assert.match(lost.res.stdout, /MemPalace capture skipped — palace locked/);
        assert.ok(!lost.calls.some((c) => c.includes('--daemon')), 'the daemon is not started as a fallback');
        assert.deepEqual(lost.sleeps, ['sleep 1', 'sleep 2'], 'no sleep after the final failure');
      }
    });

    test(`${rel}: a failure that is not a held lock is reported as that, at once, without retries`, () => {
      for (const mineRc of [2, 127]) {
        const { res, mines, sleeps } = runCapture(rel, { daemonRc: 1, mineFails: 9, mineRc });
        assertSeamExit(assert, res, 0, 'a skipped capture never fails the step (onError: skip)');
        assert.equal(mines.length, 1, `exit ${mineRc}: not retried`);
        assert.equal(sleeps.length, 0);
        assert.match(res.stdout, new RegExp(`MemPalace capture skipped — mine failed \\(exit ${mineRc}\\)`));
        assert.doesNotMatch(res.stdout, /palace locked/);
      }
    });

    test(`${rel}: a CLI without the daemon subcommand (probe exit 2) gets a plain mine, retried like any other`, () => {
      const { res, mines } = runCapture(rel, { daemonRc: 2, mineFails: 1 });
      assertSeamExit(assert, res, 0, 'the snippet must run to completion');
      assert.deepEqual(mines, ['mine /stage --wing w', 'mine /stage --wing w']);
    });
  }
});
