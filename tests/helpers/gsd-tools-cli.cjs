'use strict';

/**
 * Run the real `gsd-tools.cjs` CLI in a child process and report its exit status (#5170).
 *
 * The gate tests assert on the process exit code, so they cannot use an in-process call. Unlike
 * `runGsdTools` (tests/helpers.cjs), which reports `success`/`error` for the many callers that only
 * care about 0 versus not-0, this returns the numeric `exitCode` for every status, with `stdout` and
 * `stderr` trimmed — a verdict-driven verb exits 0, 1, 66 or 69 and each is a distinct answer.
 */

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { TEST_ENV_BASE } = require('../helpers.cjs');
const { LOOP_HOOK_POINT_CLI_TIMEOUT_MS } = require('./timeouts.cjs');

const TOOLS_PATH = path.join(__dirname, '..', '..', 'gsd-core', 'bin', 'gsd-tools.cjs');

/**
 * `runTools(args, cwd, { preload })`: `args` is the argv after `gsd-tools.cjs`; `preload` is an optional
 * `--require` module (a fault-injection preload) loaded before the CLI starts.
 */
function runTools(args, cwd, { preload } = {}) {
  const argv = [...(preload === undefined ? [] : ['--require', preload]), TOOLS_PATH, ...args];
  try {
    const stdout = execFileSync(process.execPath, argv, {
      cwd,
      encoding: 'utf-8',
      env: { ...process.env, ...TEST_ENV_BASE },
      timeout: LOOP_HOOK_POINT_CLI_TIMEOUT_MS,
    });
    return { exitCode: 0, stdout: stdout.trim(), stderr: '' };
  } catch (err) {
    return {
      exitCode: err.status ?? 1,
      stdout: err.stdout?.toString().trim() ?? '',
      stderr: err.stderr?.toString().trim() ?? err.message,
    };
  }
}

module.exports = { runTools, TOOLS_PATH };
