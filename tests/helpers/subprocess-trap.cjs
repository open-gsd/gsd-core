'use strict';

/**
 * subprocess-trap — run a SYNCHRONOUS function while every `child_process`
 * entry point throws, and report which entry points the function tried to call.
 *
 * Purpose: prove the code under test spawns nothing, on every OS, without
 * real subprocesses. The proof is platform-independent, so it lives in a
 * shared helper that any test can reuse instead of re-implementing the trap.
 *
 * Sync-only: the trap is restored when `fn` returns, so an async callback
 * would run its spawns after restoration and be silently missed. A thenable
 * return value therefore throws a TypeError.
 *
 * @param {() => unknown} fn
 * @returns {{ attempted: string[], result: unknown }}
 */
function trapChildProcess(fn) {
  const childProcess = require('node:child_process');
  const names = ['spawnSync', 'execFileSync', 'execSync', 'spawn', 'exec', 'execFile'];
  const originals = {};
  const attempted = [];
  for (const name of names) {
    originals[name] = childProcess[name];
    childProcess[name] = () => {
      attempted.push(name);
      throw new Error(`child_process.${name} must not be called`);
    };
  }
  let result;
  try {
    result = fn();
    if (result !== null && result !== undefined && typeof result.then === 'function') {
      throw new TypeError('trapChildProcess is sync-only: the callback returned a thenable');
    }
  } finally {
    for (const name of names) childProcess[name] = originals[name];
  }
  return { attempted, result };
}

module.exports = { trapChildProcess };
