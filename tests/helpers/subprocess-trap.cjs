'use strict';

/**
 * subprocess-trap — run a function while every `child_process` entry point
 * throws, and report which entry points the function tried to call.
 *
 * Lives in a helper (not inline in the test) so a test that only needs to
 * PROVE "this code spawns nothing" does not carry a raw `child_process`
 * reference of its own: that reference is a real-OS signal to the platform
 * conformance classifier, and the proof itself is platform-independent.
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
  } finally {
    for (const name of names) childProcess[name] = originals[name];
  }
  return { attempted, result };
}

module.exports = { trapChildProcess };
