'use strict';

/**
 * #5231: runs a JS snippet in a child process where the SDK's `git commit` (execGit) always times out,
 * and reports the `timeout` option execGit was handed — so the resolved commit bound is observable
 * without parsing any prose. `callSrc` may use `cmds` (the built commands.cjs); an `ExitError` thrown by
 * `error()` is swallowed after its message reaches stderr; any other error propagates.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { runNode } = require('./process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./timeouts.cjs');

const LIB = path.join(__dirname, '..', '..', 'gsd-core', 'bin', 'lib');

/**
 * @param {string} callSrc
 * @param {{stderr?: string, timeoutShape?: 'posix'|'windows'}} [opts] timeoutShape: SIGTERM+ETIMEDOUT (posix) or ETIMEDOUT only (windows, #3050).
 * @returns {{status: number|null, stdout: string, stderr: string, timeout: number|null|undefined, thrown: string|null|undefined, failure: {reason: string, message: string}|null|undefined}}
 *   timeout/thrown/failure come from a JSON report file the child writes at exit; all are `undefined` only if the child died before exit.
 */
function runWithTimedOutCommit(callSrc, { stderr = '', timeoutShape = 'posix' } = {}) {
  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-commit-probe-'));
  const reportFile = path.join(reportDir, 'report.json');
  const script = `
const fs = require('fs');
const path = require('path');
const LIB = ${JSON.stringify(LIB)};
const io = require(path.join(LIB, 'io.cjs'));
const realError = io.error;
let failure = null;
io.error = (message, reason = io.ERROR_REASON.UNKNOWN, extra) => { failure = { reason, message }; return realError(message, reason, extra); };
const projection = require(path.join(LIB, 'shell-command-projection.cjs'));
const cmds = require(path.join(LIB, 'commands.cjs'));
const real = projection.execGit;
let seenTimeout;
let thrown = null;
process.on('exit', () => fs.writeFileSync(${JSON.stringify(reportFile)}, JSON.stringify({ timeout: seenTimeout ?? null, thrown, failure })));
projection.execGit = (args, opts) => {
  if (args[0] === 'commit') {
    seenTimeout = opts && opts.timeout;
    const e = new Error('spawnSync git ETIMEDOUT');
    e.code = 'ETIMEDOUT';
    return { exitCode: 1, stdout: '', stderr: ${JSON.stringify(stderr)}, signal: ${JSON.stringify(timeoutShape)} === 'posix' ? 'SIGTERM' : null, error: e };
  }
  return real(args, opts);
};
try { ${callSrc} } catch (e) { /* error() throws ExitError after writing its message to stderr */ if (!(e instanceof require(path.join(LIB, 'cli-exit.cjs')).ExitError)) { thrown = e && e.message; throw e; } }
`;
  try {
    const run = runNode(['-e', script], { timeoutMs: PROBE_TIMEOUT_MS });
    let report = {};
    try { report = JSON.parse(fs.readFileSync(reportFile, 'utf8')); } catch { /* child died before exit */ }
    return { status: run.exitCode, stdout: run.stdout, stderr: run.stderr, timeout: report.timeout, thrown: report.thrown, failure: report.failure };
  } finally {
    fs.rmSync(reportDir, { recursive: true, force: true });
  }
}

module.exports = { runWithTimedOutCommit };
