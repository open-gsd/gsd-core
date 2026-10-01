'use strict';

/**
 * Deterministic filesystem failure injection for gate tests (#5170).
 *
 * A gate that reads a file has a third answer besides "found" and "none": the read FAILED
 * (EACCES, EIO, EISDIR ...). These tests need that failure on demand, on every platform. They
 * never `chmod`: mode bits do not bind a root process (root Docker, CI), so a chmod-based test
 * passes without exercising the failure at all. A method is monkeypatched instead and always
 * restored in `finally`.
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * Run `body` with `fs[method]` throwing an error carrying `code` for any path `match` accepts, and
 * restore the original in `finally` (also when `body` throws). `match` is an exact path string or a
 * predicate over the path string. Returns `body`'s result.
 */
function withFsFailure(method, match, code, body) {
  const accepts = typeof match === 'function' ? match : (candidate) => candidate === match;
  const original = fs[method];
  fs[method] = function patched(target, ...rest) {
    const key = typeof target === 'string' ? target : String(target);
    if (accepts(key)) {
      throw Object.assign(new Error(`${code}: injected failure on ${key}`), { code });
    }
    return original.call(this, target, ...rest);
  };
  try {
    return body();
  } finally {
    fs[method] = original;
  }
}

/**
 * Write a `--require` preload that makes `fs.readFileSync` throw `code` for any path ending in
 * `suffix`, for a CLI child process (the failure cannot be patched in-process there). Returns the
 * preload's path, written under `dir`.
 */
function writeReadFailurePreload(dir, suffix, code = 'EACCES') {
  return writeMethodFailurePreload(dir, 'readFileSync', suffix, code, 'fail-read-preload.cjs');
}

/**
 * The general form of {@link writeReadFailurePreload}: a `--require` preload that makes
 * `fs[method]` throw `code` for any path (string) ending in `suffix`, for a CLI child process.
 * `readdirSync` on a nested `plans/` directory is the case the plan-scan gates need.
 */
function writeMethodFailurePreload(dir, method, suffix, code = 'EACCES', fileName = `fail-${method}-preload.cjs`) {
  const failure = method === 'readFileSync' ? 'simulated read failure' : 'simulated failure';
  const preload = path.join(dir, fileName);
  fs.writeFileSync(
    preload,
    [
      "const fs = require('node:fs');",
      `const real = fs[${JSON.stringify(method)}];`,
      `fs[${JSON.stringify(method)}] = function (p, ...rest) {`,
      `  if (typeof p === 'string' && p.endsWith(${JSON.stringify(suffix)})) {`,
      `    const err = new Error(${JSON.stringify(`${code}: ${failure}`)});`,
      `    err.code = ${JSON.stringify(code)};`,
      '    throw err;',
      '  }',
      '  return real.call(fs, p, ...rest);',
      '};',
      '',
    ].join('\n'),
  );
  return preload;
}

module.exports = { withFsFailure, writeReadFailurePreload, writeMethodFailurePreload };
