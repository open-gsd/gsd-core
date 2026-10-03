'use strict';

/**
 * Shared probe for tests/git-optional-locks-parity.test.cjs (#5048).
 *
 * The guard this supports is about an ENV BLOCK that a real spawn receives, so
 * the probe intercepts `node:child_process` and records what the production
 * code actually hands the OS. Nothing here inspects source text: the observable
 * is the options object a real seam passes to spawnSync/execFileSync.
 *
 * Why interception rather than `child_process` dependency injection: the seams
 * under test (src/shell-command-projection.cts, src/smart-entry.cts,
 * src/pristine-baseline.cts, hooks/gsd-statusline.js) all import
 * `node:child_process` directly and take no seam parameter for it. Patching the
 * resolved module object intercepts all of them without touching production
 * code, and — unlike a regex over the source — it cannot be fooled by a comment
 * that mentions the variable.
 *
 * The patch is installed on the *module object*, not on a copy of a function, so
 * it is seen by every call site that reads the property at CALL time. That is a
 * narrower claim than it first looks, and the limit is worth stating: a module
 * that captured the function by destructuring `const { execFileSync } = require(
 * 'node:child_process')` at ITS OWN require() time holds the original binding
 * and would NOT be intercepted. It works for the seams here because the tsc
 * CommonJS emit compiles `import { execFileSync } from 'node:child_process'` to
 * `const node_child_process_1 = require('node:child_process')` and reads
 * `node_child_process_1.execFileSync` at each call. If a seam ever switches to
 * a real destructure, the probe goes quiet rather than red — which is why
 * every probe below asserts it captured at least one git spawn.
 */

const childProcess = require('node:child_process');

/** Field-for-field stand-in for a successful sync spawn. */
function okResult(stdout = '') {
  return { status: 0, stdout, stderr: '', error: undefined };
}

/**
 * The value each callee actually RETURNS, which is not uniform and is the whole
 * reason a fake must be callee-aware:
 *   - execFileSync / execSync honour `encoding` and return the stdout STRING.
 *   - spawnSync returns a result OBJECT even with `encoding` set.
 * Getting this wrong makes the fake throw inside production code (e.g.
 * smart-entry's `readGitSignals` does `run(args).trim()`, which is a TypeError
 * on an object) — and a probe whose fake throws is worse than no probe, because
 * the throw can be swallowed into a false pass.
 */
function fakeReturn(callee, opts, stdout) {
  const encoding = opts && opts.encoding;
  if (callee === 'spawnSync') return okResult(stdout);
  if (encoding === null || encoding === undefined) return Buffer.from(stdout);
  if (Buffer.isEncoding(encoding) || typeof encoding === 'string') return stdout;
  return okResult(stdout);
}

/**
 * Record every spawn's argv + env, and return a fake that answers ok.
 *
 * @param {(rec:{file:string,argv:string[],env:object}) => void} [onSpawn]
 * @returns {() => {calls: Array<{file:string,argv:string[],env:object}>}}
 */
function recordSpawns(onSpawn, stdoutFor) {
  const calls = [];
  const record = (callee) => (file, args, opts) => {
    const argv = Array.isArray(args) ? args.map(String) : [String(args)];
    const env = (opts && opts.env) || {};
    calls.push({ file, argv, env });
    if (onSpawn) onSpawn({ file: String(file), argv, env });
    return fakeReturn(callee, opts, stdoutFor ? stdoutFor(argv, file) : '');
  };

  const originals = {
    execFileSync: childProcess.execFileSync,
    spawnSync: childProcess.spawnSync,
    execSync: childProcess.execSync,
    exec: childProcess.exec,
  };

  childProcess.execFileSync = record('execFileSync');
  childProcess.spawnSync = record('spawnSync');
  childProcess.execSync = record('execSync');
  childProcess.exec = record('exec');

  return () => {
    childProcess.execFileSync = originals.execFileSync;
    childProcess.spawnSync = originals.spawnSync;
    childProcess.execSync = originals.execSync;
    childProcess.exec = originals.exec;
    return calls;
  };
}

/** git global options that consume the following token as their value. */
const VALUE_TAKING = /^(-C|-c|--git-dir|--work-tree|--namespace|--exec-path|--config-env)$/;

/**
 * The subcommand from an argv ALREADY EXCLUDING the executable
 * (`['status','--porcelain']`, `['-C','/repo','status']`). Leading global
 * options and the values they consume are skipped; `null` when no subcommand is
 * statically readable, which the classifier treats as the conservative side of
 * the doubt.
 */
function gitSubcommand(argv) {
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith('-')) return tok;
    if (VALUE_TAKING.test(tok)) i++;
  }
  return null;
}

module.exports = { recordSpawns, gitSubcommand, okResult, fakeReturn };