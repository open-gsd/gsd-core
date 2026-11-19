'use strict';

/**
 * Real-shell oracle for the gate placeholder tests: run `command` in the shell and return what it printed as an
 * array of lines (the last is "" after a final newline). The command text travels in an environment variable and
 * the shell runs it with `eval` at its own top level. Two platform hazards follow: argv text is re-quoted by the
 * Windows spawn (backslashes), and a pipeline runs its commands in subshells, where the macOS system bash 3.2 does
 * not fire an EXIT trap. Neither applies to an env value and a plain `eval`.
 */

const { runHook } = require('./process-seam.cjs');
const { throwIfFailed } = require('./git-fixture.cjs');
const { PROBE_TIMEOUT_MS } = require('./timeouts.cjs');

const COMMAND_ENV = 'GSD_ORACLE_COMMAND';

/** The seam result of running `text` as shell code. The one owner of the env route: every real-shell row goes through it. */
function runShellText(text, { interpreter, env, cwd }) {
  return runHook('-c', [`eval "$${COMMAND_ENV}"`], {
    interpreter, env: { ...env, [COMMAND_ENV]: text }, cwd, input: '', timeoutMs: PROBE_TIMEOUT_MS,
  });
}

/**
 * The lines `command` printed to stdout. The `:` that ends the group keeps a comment-only command valid and masks a
 * runtime non-zero exit of its last command. A parse error (an unterminated here-document swallows the group's `}`),
 * an `exit`, a timeout or a kill throws `oracle shell failed`.
 */
function oracleLines(command, options) {
  const result = runShellText(`{ ${command}\n:\n}`, options);
  throwIfFailed(result, 'oracle shell');
  return result.stdout.split('\n');
}

module.exports = { oracleLines, runShellText };
