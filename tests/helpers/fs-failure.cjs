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
  if (!Object.prototype.hasOwnProperty.call(fs, method) || typeof fs[method] !== 'function') {
    // A misspelled method would inject nothing and the test would pass without exercising a failure.
    throw new TypeError(`withFsFailure: fs.${String(method)} is not a function`);
  }
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

/**
 * Run a decision-coverage gate in-process (`routeCheckCommand`) with `fs.statSync` throwing `code`
 * for the phase directory alone, and return the gate's parsed JSON. `phaseDirOrAlias` is the path
 * the caller hands the gate; it may be a symlink or junction to the real directory. Mocked paths are
 * compared canonically (`canonicalizePath`), so the failure fires whichever spelling the gate stats:
 * the gate realpaths the directory before it stats (#5798), and on macOS `/var` and `/tmp` resolve
 * to `/private/...`. Every other path falls through to the real `statSync`, and stdout (fd 1) is
 * captured instead of printed. Both mocks are restored in `finally`.
 *
 * The failure is injected, never produced by removing permission bits: root bypasses them and
 * Windows ignores them. `cwd` and `contextPath` are the gate's working directory and CONTEXT.md path.
 */
function runGateWithStatFailure(t, phaseDirOrAlias, subcommand, code, { cwd, contextPath }) {
  // Lazy: most importers of this module need neither, and the router must not load on their behalf.
  const { canonicalizePath } = require('../helpers.cjs');
  const { routeCheckCommand } = require('../../gsd-core/bin/lib/check-command-router.cjs');

  const realStatSync = fs.statSync;
  const resolvedPhaseDir = canonicalizePath(phaseDirOrAlias);
  t.mock.method(fs, 'statSync', (p, ...rest) => {
    if (typeof p === 'string') {
      let resolvedPath;
      try {
        resolvedPath = canonicalizePath(p);
      } catch {
        return realStatSync.call(fs, p, ...rest);
      }
      if (resolvedPath !== resolvedPhaseDir) return realStatSync.call(fs, p, ...rest);
      throw Object.assign(new Error(`${code}: injected stat failure, stat '${p}'`), { code });
    }
    return realStatSync.call(fs, p, ...rest);
  });
  let captured = '';
  const realWriteSync = fs.writeSync;
  t.mock.method(fs, 'writeSync', (fd, ...args) => {
    if (fd === 1) {
      const buf = args[0];
      captured += Buffer.isBuffer(buf) ? buf.toString('utf-8') : String(buf);
      return Buffer.isBuffer(buf) ? buf.length : Buffer.byteLength(String(buf));
    }
    return realWriteSync.call(fs, fd, ...args);
  });
  try {
    routeCheckCommand({ args: ['check', subcommand, phaseDirOrAlias, contextPath], cwd, raw: false });
  } finally {
    t.mock.restoreAll();
  }
  return JSON.parse(captured || '{}');
}

module.exports = { withFsFailure, writeReadFailurePreload, writeMethodFailurePreload, runGateWithStatFailure };
