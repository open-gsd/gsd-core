'use strict';

/**
 * Real-shell oracle for the gate placeholder tests: run `command` in the shell and return what it printed as an
 * array of lines. The child encodes its own stdout as JSON, so a test asserts on typed values (CONTRIBUTING.md,
 * "Raw Text Matching on Test Outputs"), never on a regex over the raw stream.
 */

const { runHook } = require('./process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./timeouts.cjs');

const NODE_ENV = 'GSD_ORACLE_NODE';
const ENCODE = 'let s="";process.stdin.on("data",(d)=>{s+=d}).on("end",()=>process.stdout.write(JSON.stringify(s.split("\\n"))))';

/** The lines `command` printed to stdout (the last is "" after a final newline). */
function oracleLines(command, { interpreter, env }) {
  const { stdout } = runHook('-c', [`{ ${command}\n} | "$${NODE_ENV}" -e '${ENCODE}'`], {
    interpreter, env: { ...env, [NODE_ENV]: process.execPath }, input: '', timeoutMs: PROBE_TIMEOUT_MS,
  });
  return JSON.parse(stdout);
}

module.exports = { oracleLines };
