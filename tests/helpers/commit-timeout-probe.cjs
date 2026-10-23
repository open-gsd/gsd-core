'use strict';

/**
 * #5231: runs a JS snippet in a child process where the SDK's `git commit` (execGit) always times out,
 * and reports the `timeout` option execGit was handed — so the resolved commit bound is observable
 * without parsing any prose. `callSrc` may use `cmds` (the built commands.cjs); an `ExitError` thrown by
 * `error()` is swallowed after its message reaches stderr; any other error propagates.
 */

const path = require('path');
const { runNode } = require('./process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./timeouts.cjs');

const LIB = path.join(__dirname, '..', '..', 'gsd-core', 'bin', 'lib');
const MARKER = '__COMMIT_TIMEOUT__';

/**
 * @param {string} callSrc
 * @param {{stderr?: string, timeoutShape?: 'posix'|'win32'}} [opts] timeoutShape: SIGTERM+ETIMEDOUT (posix) or ETIMEDOUT only (#3050).
 * @returns {{status: number|null, stdout: string, stderr: string, timeout: number|undefined}}
 */
function runWithTimedOutCommit(callSrc, { stderr = '', timeoutShape = 'posix' } = {}) {
  const script = `
const path = require('path');
const LIB = ${JSON.stringify(LIB)};
const projection = require(path.join(LIB, 'shell-command-projection.cjs'));
const cmds = require(path.join(LIB, 'commands.cjs'));
const real = projection.execGit;
let seenTimeout;
process.on('exit', () => process.stderr.write('\\n${MARKER}' + JSON.stringify(seenTimeout ?? null) + '\\n'));
projection.execGit = (args, opts) => {
  if (args[0] === 'commit') {
    seenTimeout = opts && opts.timeout;
    const e = new Error('spawnSync git ETIMEDOUT');
    e.code = 'ETIMEDOUT';
    return { exitCode: 1, stdout: '', stderr: ${JSON.stringify(stderr)}, signal: ${JSON.stringify(timeoutShape)} === 'posix' ? 'SIGTERM' : null, error: e };
  }
  return real(args, opts);
};
try { ${callSrc} } catch (e) { /* error() throws ExitError after writing its message to stderr */ if (!(e instanceof require(path.join(LIB, 'cli-exit.cjs')).ExitError)) throw e; }
`;
  const run = runNode(['-e', script], { timeoutMs: PROBE_TIMEOUT_MS });
  const m = new RegExp(`^${MARKER}(.*)$`, 'm').exec(run.stderr);
  return {
    status: run.exitCode,
    stdout: run.stdout,
    stderr: run.stderr.replace(new RegExp(`\\n?${MARKER}.*$`, 'm'), ''),
    timeout: m ? JSON.parse(m[1] || 'null') : undefined,
  };
}

module.exports = { runWithTimedOutCommit };
