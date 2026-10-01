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

/** A `skip` value for `node:test`: false when every named tool is available, else the reason. */
function skipUnless(...tools) {
  return tools.every(have) ? false : `${tools.join(' and ')} ${tools.length === 1 ? 'is' : 'are'} required`;
}

module.exports = { have, skipUnless };
