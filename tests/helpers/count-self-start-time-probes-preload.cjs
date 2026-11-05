'use strict';

/**
 * Preload fixture for #5327 — count how many times THIS process probes its own
 * start-time through capability-lock's `getProcessStartTime(process.pid)`.
 *
 * The probe has one shape per platform (src/capability-lock.cts):
 *   - linux:  fs.readFileSync(`/proc/<pid>/stat`)
 *   - win32:  spawnSync('powershell', [..., `(Get-Process -Id <pid>).StartTime.Ticks`])
 *   - other:  spawnSync('ps', ['-p', '<pid>', '-o', 'lstart='])
 * Both seams are wrapped here, and only a probe naming OUR OWN pid counts, so a
 * steal-path probe of another holder's pid is never mistaken for the self probe.
 *
 * The running count is exposed as `globalThis.__gsdSelfStartTimeProbes()`, and the
 * ordered probe / exclusive-open events as `globalThis.__gsdSelfStartTimeEvents()`, for
 * `node -e` scripts, and printed on exit as a `GSD_SELF_START_TIME_PROBES=<n>`
 * stderr line for whole-CLI runs, next to `GSD_CAPABILITY_LOCK_LOADED=<bool>`.
 * `globalThis.__gsdSelfStartTimeResults()` reports whether each self probe succeeded, and
 * GSD_TEST_FAIL_SELF_PROBES=<n> forces the first n to fail.
 *
 * Loaded via `node --require <this file> ...`. One-shot subprocess: no restore.
 */

const fs = require('node:fs');
const childProcess = require('node:child_process');

const selfPid = String(process.pid);
let count = 0;
// Ordered record of self probes and exclusive ('wx') opens, so a test can assert the probe
// runs BEFORE the lockfile is created rather than inside the held window.
const events = [];
// Per self probe: did the platform seam yield a usable value? A real probe can fail under load.
const results = [];
// GSD_TEST_FAIL_SELF_PROBES=<n> fails the first n self probes the way a real failure does
// (the /proc read throws; the shell-out comes back as a spawn timeout), so the retry path
// is pinned on every platform rather than only when a CI runner happens to be slow.
let forcedFailures = Number(process.env.GSD_TEST_FAIL_SELF_PROBES) || 0;
function forceFailure() {
  if (forcedFailures <= 0) return false;
  forcedFailures--;
  return true;
}

const realReadFileSync = fs.readFileSync;
fs.readFileSync = function countingReadFileSync(file, ...rest) {
  if (file === `/proc/${selfPid}/stat`) {
    count++; events.push('probe');
    if (forceFailure()) {
      results.push(false);
      throw Object.assign(new Error(`ENOENT: no such file or directory, open '${file}'`), { code: 'ENOENT' });
    }
    try {
      const out = realReadFileSync.call(this, file, ...rest);
      results.push(true);
      return out;
    } catch (err) {
      results.push(false);
      throw err;
    }
  }
  return realReadFileSync.call(this, file, ...rest);
};

const realSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = function countingSpawnSync(cmd, args, ...rest) {
  const argv = Array.isArray(args) ? args : [];
  const isPsSelf = argv.includes('lstart=') && argv.includes(selfPid);
  // includes(), not ===: a powershell .cmd/.bat shim is mediated through cmd.exe, which folds the
  // expression into one `/c` command string.
  const isPowershellSelf = argv.some((a) => typeof a === 'string' && a.includes(`(Get-Process -Id ${selfPid}).StartTime.Ticks`));
  if (!isPsSelf && !isPowershellSelf) return realSpawnSync.call(this, cmd, args, ...rest);
  count++; events.push('probe');
  if (forceFailure()) {
    results.push(false);
    const error = Object.assign(new Error(`spawnSync ${cmd} ETIMEDOUT`), { code: 'ETIMEDOUT' });
    return { pid: 0, output: [null, '', ''], stdout: '', stderr: '', status: null, signal: 'SIGTERM', error };
  }
  const res = realSpawnSync.call(this, cmd, args, ...rest);
  results.push(res.status === 0 && !res.error && String(res.stdout || '').trim() !== '');
  return res;
};

// Any exclusive create, in either spelling: the string flag, or numeric O_CREAT|O_EXCL
// (the form src/state.cts uses), so a flag-spelling change cannot hide the create.
const { O_CREAT, O_EXCL } = fs.constants;
const isExclusiveCreate = (flags) => (typeof flags === 'string'
  ? flags.includes('x')
  : typeof flags === 'number' && (flags & (O_CREAT | O_EXCL)) === (O_CREAT | O_EXCL));

const realOpenSync = fs.openSync;
fs.openSync = function recordingOpenSync(file, flags, ...rest) {
  if (isExclusiveCreate(flags)) events.push('open-wx');
  return realOpenSync.call(this, file, flags, ...rest);
};

globalThis.__gsdSelfStartTimeProbes = () => count;
globalThis.__gsdSelfStartTimeEvents = () => events.slice();
globalThis.__gsdSelfStartTimeResults = () => results.slice();

process.on('exit', () => {
  // Whether capability-lock was loaded at all, so a zero count can never pass vacuously.
  const lockLoaded = Object.keys(require.cache).some((k) => /[\\/]capability-lock\.cjs$/.test(k));
  process.stderr.write(`GSD_SELF_START_TIME_PROBES=${count}\nGSD_CAPABILITY_LOCK_LOADED=${lockLoaded}\n`);
});
