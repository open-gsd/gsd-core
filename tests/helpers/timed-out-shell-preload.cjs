'use strict';

/**
 * Preload fixture for #5482 (G19b): every `sh -c <command>` that goes through shell-command-projection's
 * `execTool` returns the result a spawnSync timeout produces, without running the command. Other programs
 * run as before. The gate evaluator reads `exports.execTool` at call time, so replacing it here reaches
 * the CLI child process.
 *
 * Loaded via `node --require <this file> ...`. One-shot subprocess: no restore.
 */

const projection = require('../../gsd-core/bin/lib/shell-command-projection.cjs');

const realExecTool = projection.execTool;

projection.execTool = function execToolTimingOutShell(program, args, opts) {
  if (program === 'sh' && Array.isArray(args) && args[0] === '-c') {
    return { exitCode: null, stdout: '', stderr: '', signal: 'SIGTERM', error: null, timedOut: true };
  }
  return realExecTool(program, args, opts);
};
