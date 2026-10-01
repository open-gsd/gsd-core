'use strict';

/**
 * Tool-availability probe for tests that extract a documented bash block and run it (#5170).
 *
 * A test that executes a workflow's or agent's shell snippet needs `bash` (and sometimes `curl`,
 * `jq`, `node`) on PATH. `have(cmd)` answers that without a mocked environment, so the suite can
 * `skip` with a reason instead of failing on a host that lacks the tool.
 */

const { spawnSync } = require('node:child_process');
const { PROBE_TIMEOUT_MS } = require('./timeouts.cjs');

/** True when `cmd` resolves on PATH under bash. */
function have(cmd) {
  const r = spawnSync('bash', ['-c', `command -v ${cmd}`], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
  return !r.error && r.status === 0;
}

/**
 * A `skip` value for `node:test`: false when every named tool is available, else the reason.
 * Under CI (`process.env.CI`) a missing tool is a failure, never a skip: a skipped suite there would
 * report green having executed nothing. The throw fails the test file at load.
 */
function skipUnless(...tools) {
  if (tools.every(have)) return false;
  const reason = `${tools.join(' and ')} ${tools.length === 1 ? 'is' : 'are'} required`;
  if (process.env.CI) throw new Error(`${reason} under CI: a bash-block behavior test must run, not skip`);
  return reason;
}

module.exports = { have, skipUnless };
