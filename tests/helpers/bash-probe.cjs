'use strict';

/**
 * Tool-availability probe for tests that extract a documented bash block and run it (#5170).
 *
 * A test that executes a workflow's or agent's shell snippet needs `bash` (and sometimes `curl`,
 * `jq`, `node`) on PATH. `have(cmd)` answers that without a mocked environment, so the suite can
 * `skip` with a reason instead of failing on a host that lacks the tool.
 *
 * A skip must not be silent (#6677): the gsd-test tester image has no `curl` or `jq`, and a skipped
 * `describe` registers none of its children, so a skip left no trace in the verdict. `skipUnless`
 * now announces each skip as a named skipped test, and fails the file at load, like CI does, when
 * `GSD_REQUIRE_BASH_TOOLS` is set (docs/how-to/make-a-missing-test-tool-fail.md).
 */

const { spawnSync } = require('node:child_process');
const { PROBE_TIMEOUT_MS } = require('./timeouts.cjs');

/**
 * The switches under which a missing tool is a failure, never a skip: a skipped suite there would
 * report green having executed nothing. CI is first: it is the one named when both are set.
 */
const REQUIRE_ENV_KEYS = ['CI', 'GSD_REQUIRE_BASH_TOOLS'];

/** True when `cmd` resolves on PATH under bash. `cmd` is an argument to the probe, never part of its shell text. */
function have(cmd) {
  const r = spawnSync('bash', ['-c', 'command -v -- "$1"', 'bash', cmd], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
  return !r.error && r.status === 0;
}

/** Register the skip as a named skipped test, so it shows in the run summary and the reporter events. */
function announceSkip(reason) {
  const { test } = require('node:test');
  test(`bash-block behavior tests skipped on this host: ${reason}`, {
    skip: `${reason}; set GSD_REQUIRE_BASH_TOOLS=1 to fail instead of skipping`,
  }, () => {});
}

/**
 * A `skipUnless` over the given host: `have` answers whether a tool is there, `env` is read at each
 * call (not captured), and `announce` records a skip. The default instance below is the one tests use.
 */
function createSkipUnless({ have: haveTool = have, env = process.env, announce = announceSkip } = {}) {
  return function skipUnless(...tools) {
    if (tools.every(haveTool)) return false;
    const reason = `${tools.join(' and ')} ${tools.length === 1 ? 'is' : 'are'} required`;
    const key = REQUIRE_ENV_KEYS.find((name) => env[name]);
    if (key) throw new Error(`${reason} under ${key}: a bash-block behavior test must run, not skip`);
    announce(reason);
    return reason;
  };
}

/**
 * A `skip` value for `node:test`: false when every named tool is available, else the reason. Under
 * CI or GSD_REQUIRE_BASH_TOOLS a missing tool throws, which fails the test file at load.
 */
const skipUnless = createSkipUnless();

module.exports = { have, skipUnless, createSkipUnless, REQUIRE_ENV_KEYS };
