'use strict';

/**
 * #6086 — stall stand-ins must not outlive the test that planted them.
 *
 * A `spawnSync` `timeout` signals ONE pid: the direct child. A fixture that plants `sleep N` as the stall its
 * timeout must catch therefore has to make the `sleep` that child (`exec sleep N`); written as a plain
 * `sleep N` under a shell, the bound kills the shell and the `sleep` is reparented and runs out its full
 * duration after the test has passed. These helpers let a test prove it left nothing behind: give each stall a
 * duration no other fixture uses (`sleep 5.0861`), then assert no live process still carries that command line.
 *
 * The live process table is read from `/proc` where it exists (Linux: the bench's Docker image ships no `ps`) and
 * from `ps -A -o args=` elsewhere (macOS). On win32 there is neither, so the helpers report `null` and the
 * assertion is skipped there: the process-tree behaviour it guards is the POSIX one. On POSIX a process table
 * that cannot be read THROWS: a guard that silently passes when it cannot look would prove nothing.
 */

const fs = require('node:fs');
const { runHook, OUTCOME } = require('./process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./timeouts.cjs');
const { splitLines } = require('../../gsd-core/bin/lib/text-lines.cjs');

const PROC_ROOT = '/proc';

/** Command lines of every live process from /proc (Linux), or null when this host has no /proc. */
function procArgs() {
  if (!fs.existsSync(`${PROC_ROOT}/self/cmdline`)) return null;
  const out = [];
  for (const name of fs.readdirSync(PROC_ROOT)) {
    if (!/^\d+$/.test(name)) continue;
    try {
      // argv is NUL-separated; a process that exits mid-scan simply throws and is skipped
      out.push(fs.readFileSync(`${PROC_ROOT}/${name}/cmdline`, 'utf8').split(String.fromCharCode(0)).join(' ').trim());
    } catch {
      // gone
    }
  }
  return out;
}

/** Command lines of every live process; null on win32; throws on POSIX when the table cannot be read. */
function liveProcessArgs() {
  if (process.platform === 'win32') return null;
  const viaProc = procArgs();
  if (viaProc !== null) return viaProc;
  const r = runHook('-A', ['-o', 'args='], { interpreter: 'ps', timeoutMs: PROBE_TIMEOUT_MS });
  if (r.outcome !== OUTCOME.EXITED || r.exitCode !== 0) {
    throw new Error(`stall-leftovers: \`ps -A -o args=\` could not be read (${r.summary}); the leftover check cannot run`);
  }
  return splitLines(r.stdout);
}

/** Live processes whose command line contains `marker`, or null where they cannot be listed. */
function leftoversOf(marker) {
  const lines = liveProcessArgs();
  return lines === null ? null : lines.filter((line) => line.includes(marker));
}

/**
 * Assert no live process still runs the stall `marker` (e.g. `sleep 5.0861`). Re-lists a bounded number of
 * times (each listing is itself a process spawn) so a process that was signalled a moment ago is given the
 * chance to finish exiting; a stall that was reparented and left running for seconds still fails.
 */
function assertNoLeftoverStall(assert, marker, label) {
  const attempts = 10;
  let left = leftoversOf(marker);
  if (left === null) return;
  for (let i = 1; left.length > 0 && i < attempts; i += 1) {
    left = leftoversOf(marker);
  }
  assert.deepEqual(left, [], `${label}: the stall outlived the test — the timeout must kill the stall itself (exec it)`);
}

/** The command name of a live pid (`sleep`), or '' when it is gone or cannot be read. */
function commOf(pid) {
  if (process.platform === 'win32') return '';
  if (fs.existsSync(`${PROC_ROOT}/self/comm`)) {
    try {
      return fs.readFileSync(`${PROC_ROOT}/${pid}/comm`, 'utf8').trim();
    } catch {
      return '';
    }
  }
  const r = runHook('-o', ['comm=', '-p', String(pid)], { interpreter: 'ps', timeoutMs: PROBE_TIMEOUT_MS });
  return r.outcome === OUTCOME.EXITED && r.exitCode === 0 ? r.stdout.trim() : '';
}

/** `{ pid, args }` for every live process; null on win32; throws on POSIX when the table cannot be read. */
function liveProcessEntries() {
  if (process.platform === 'win32') return null;
  if (fs.existsSync(`${PROC_ROOT}/self/cmdline`)) {
    const out = [];
    for (const name of fs.readdirSync(PROC_ROOT)) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const args = fs.readFileSync(`${PROC_ROOT}/${name}/cmdline`, 'utf8').split(String.fromCharCode(0)).join(' ').trim();
        out.push({ pid: Number.parseInt(name, 10), args });
      } catch {
        // gone
      }
    }
    return out;
  }
  const r = runHook('-A', ['-o', 'pid=,args='], { interpreter: 'ps', timeoutMs: PROBE_TIMEOUT_MS });
  if (r.outcome !== OUTCOME.EXITED || r.exitCode !== 0) {
    throw new Error(`stall-leftovers: \`ps -A -o pid=,args=\` could not be read (${r.summary}); the stall cleanup cannot run`);
  }
  const out = [];
  for (const line of splitLines(r.stdout)) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m) out.push({ pid: Number.parseInt(m[1], 10), args: m[2].trim() });
  }
  return out;
}

function terminate(pid) {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // already gone
  }
}

/** Let a just-started process reach its `exec` between two process-table reads: a child `sleep`, no timer API. */
function settle(seconds) {
  runHook(String(seconds), [], { interpreter: 'sleep', timeoutMs: PROBE_TIMEOUT_MS });
}

/**
 * Terminate each pid a stall wrote into `pidFile` (one per line) that is still a `sleep`. The `comm` check
 * guards against pid reuse: a recorded pid that has exited and been handed to an unrelated process is left alone.
 *
 * With `marker` (the stall's unique command line, e.g. `sleep 12.0864`) it then also ends every live `sleep`
 * whose command line is exactly that marker, until three consecutive reads find none. The hook records its pid
 * when git starts it, which can be after the bound fired and the call returned, on a loaded host: that stall
 * is not in the file yet when it is read above, and would otherwise run out its full duration as a leftover.
 */
function killRecordedStalls(pidFile, marker) {
  if (fs.existsSync(pidFile)) {
    for (const line of splitLines(fs.readFileSync(pidFile, 'utf8'))) {
      const pid = Number.parseInt(line, 10);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      if (/(^|\/)sleep$/.test(commOf(pid))) terminate(pid);
    }
  }
  if (marker === undefined) return;
  const rounds = 20;
  const quietRounds = 3;
  let quiet = 0;
  for (let i = 0; i < rounds && quiet < quietRounds; i += 1) {
    const entries = liveProcessEntries();
    if (entries === null) return;
    const found = entries.filter((e) => e.args === marker && /(^|\/)sleep$/.test(commOf(e.pid)));
    for (const e of found) terminate(e.pid);
    quiet = found.length === 0 ? quiet + 1 : 0;
    settle(0.05);
  }
}

module.exports = { liveProcessArgs, leftoversOf, assertNoLeftoverStall, killRecordedStalls };
