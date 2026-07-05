'use strict';

/**
 * Self-healing runtime build (#2002).
 *
 * The GSD runtime CLI (gsd-tools.cjs) require()s ~150 compiled modules from
 * ./lib/*.cjs. Per ADR-457 ("build-at-publish") those are build artifacts:
 * compiled from src/*.cts by `npm run build:lib` (tsc -p tsconfig.build.json),
 * gitignored, and shipped prebuilt in the npm tarball via the prepack /
 * prepublishOnly lifecycle scripts.
 *
 * The Claude Code plugin-marketplace channel does NOT go through `npm publish`
 * or bin/install.js. Claude Code materializes the git tag tree into its plugin
 * cache and at most runs `npm install --ignore-scripts`, so neither `prepare`
 * nor `build:lib` ever fires. The compiled ./lib/*.cjs therefore never exist on
 * that path and every CLI command dies at module load with
 * `Cannot find module './lib/cli-exit.cjs'`.
 *
 * This module heals that: before gsd-tools.cjs require()s ./lib, if the compiled
 * output is absent it invokes tsc once — lock-guarded so the many parallel
 * gsd-tools shell-outs a workflow performs do not race the build — then lets the
 * requires proceed. On the npm path the artifacts already exist, so the common
 * case is a single fs.existsSync check and a no-op.
 *
 * Deliberately depends on nothing under ./lib (that tree is precisely what may
 * be missing) — only on Node built-ins.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// The first module gsd-tools.cjs require()s, and a gitignored build artifact
// (so it is absent on a raw git-tag checkout even though ~11 other bin/lib/*.cjs
// are git-tracked). tsconfig.build.json sets noEmitOnError:true, so tsc is
// all-or-nothing: if this file exists, the whole tree was emitted.
const SENTINEL = 'cli-exit.cjs';

/** Directory holding the compiled ./lib/*.cjs, relative to this file. */
function defaultLibDir() {
  return path.join(__dirname, 'lib');
}

/**
 * Package root (holds tsconfig.build.json + node_modules). This file lives at
 * <root>/gsd-core/bin/ensure-runtime-build.cjs, so the root is two levels up —
 * true for both the dev repo layout and the marketplace plugin-cache checkout
 * (…/<version>/gsd-core/bin/ensure-runtime-build.cjs).
 */
function defaultPackageRoot() {
  return path.resolve(__dirname, '..', '..');
}

/**
 * Resolve the tsc entry SCRIPT (not the .bin/tsc shim). We run it as
 * `node <tsc.js>` so behaviour is identical on POSIX and Windows and does not
 * depend on a shell or on the .cmd shim. Returns null when TypeScript is not
 * installed under packageRoot.
 */
function resolveTscScript(packageRoot) {
  try {
    return require.resolve('typescript/bin/tsc', { paths: [packageRoot] });
  } catch {
    return null;
  }
}

function isBuilt(libDir) {
  return fs.existsSync(path.join(libDir, SENTINEL));
}

/** Synchronous sleep with no dependencies, portable across platforms. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
}

/**
 * Raised when the runtime library is missing and cannot be auto-built. The
 * message is user-facing and actionable; callers print `.message` (not a stack).
 */
class RuntimeBuildError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RuntimeBuildError';
    this.code = 'GSD_RUNTIME_BUILD_FAILED';
  }
}

/**
 * Ensure the compiled ./lib/*.cjs exist, building them once if absent.
 *
 * Idempotent and safe to call concurrently from many processes. When another
 * process holds the build lock, this one waits for the build to finish rather
 * than launching a competing tsc.
 *
 * @param {object} [opts]
 * @param {string} [opts.libDir]        Override the compiled-output directory.
 * @param {string} [opts.packageRoot]   Override the tsconfig/node_modules root.
 * @param {string|null} [opts.tscScript] Override tsc resolution (null = "absent").
 * @param {function} [opts.spawn]       Override spawnSync (for tests).
 * @param {function} [opts.log]         Override the progress logger.
 * @param {number} [opts.waitTimeoutMs] Max wait for a peer build (default 120s).
 * @param {number} [opts.pollMs]        Poll interval while waiting (default 100ms).
 * @param {function} [opts.onPoll]      Test hook invoked before each wait-poll.
 * @returns {{built: true, healed: boolean, waited?: boolean}}
 * @throws {RuntimeBuildError} when the library is absent and cannot be built.
 */
function ensureRuntimeBuild(opts = {}) {
  const libDir = opts.libDir || defaultLibDir();
  const packageRoot = opts.packageRoot || defaultPackageRoot();
  const spawn = opts.spawn || spawnSync;
  const log = opts.log || ((m) => process.stderr.write(m + '\n'));
  const waitTimeoutMs = opts.waitTimeoutMs != null ? opts.waitTimeoutMs : 120000;
  const pollMs = opts.pollMs != null ? opts.pollMs : 100;

  // Fast path: already built (the npm-registry install and every subsequent run).
  if (isBuilt(libDir)) return { built: true, healed: false };

  const tsconfig = path.join(packageRoot, 'tsconfig.build.json');
  if (!fs.existsSync(tsconfig)) {
    throw new RuntimeBuildError(
      'GSD runtime library is not built and cannot be auto-built: ' +
        `${tsconfig} not found. Run \`npm run build:lib\` in the gsd-core package.`,
    );
  }

  const tscScript =
    opts.tscScript !== undefined ? opts.tscScript : resolveTscScript(packageRoot);
  if (!tscScript) {
    throw new RuntimeBuildError(
      `GSD runtime library is not built (missing ${path.join(libDir, SENTINEL)}) ` +
        'and TypeScript is unavailable to build it. Run ' +
        `\`npm install && npm run build:lib\` in the gsd-core package (${packageRoot}).`,
    );
  }

  // libDir may not exist yet on a totally fresh tree; create it so the lock and
  // tsc output have a home.
  fs.mkdirSync(libDir, { recursive: true });
  const lockDir = path.join(libDir, '.build.lock');

  let haveLock = acquireLock(lockDir);
  if (!haveLock) {
    // A peer process is building. Wait for the sentinel rather than racing tsc.
    const deadline = Date.now() + waitTimeoutMs;
    while (!isBuilt(libDir)) {
      if (typeof opts.onPoll === 'function') opts.onPoll();
      if (isBuilt(libDir)) break;
      if (Date.now() > deadline) break; // peer wedged/crashed — take over below
      sleepSync(pollMs);
    }
    if (isBuilt(libDir)) return { built: true, healed: true, waited: true };
    // Peer never finished; try to take over the (stale) lock.
    haveLock = acquireLock(lockDir);
    if (!haveLock && !isBuilt(libDir)) {
      throw new RuntimeBuildError(
        `GSD runtime build did not complete within ${waitTimeoutMs}ms and the ` +
          `build lock (${lockDir}) is held by another process. Remove it and run ` +
          '`npm run build:lib` if this persists.',
      );
    }
    if (isBuilt(libDir)) return { built: true, healed: true, waited: true };
  }

  try {
    log('gsd: runtime library not built — compiling once (tsc -p tsconfig.build.json)…');
    // Heal only runs when the build is genuinely absent/broken, so force a full
    // emit: a stale incremental cache from a partial build would make tsc report
    // success without re-emitting the (still-missing) sentinel.
    forceFullEmit(packageRoot, tsconfig);
    const res = spawn(process.execPath, [tscScript, '-p', tsconfig], {
      cwd: packageRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    if (!res || res.status !== 0) {
      const detail = ((res && (res.stderr || res.stdout)) || '').toString().trim();
      throw new RuntimeBuildError(
        `GSD runtime build failed (tsc exit ${res ? res.status : 'unknown'}). ` +
          `Run \`npm run build:lib\` in ${packageRoot} to see the error.` +
          (detail ? `\n${detail}` : ''),
      );
    }
  } finally {
    releaseLock(lockDir);
  }

  if (!isBuilt(libDir)) {
    throw new RuntimeBuildError(
      `GSD runtime build ran but ${path.join(libDir, SENTINEL)} is still missing. ` +
        `Run \`npm run build:lib\` in ${packageRoot}.`,
    );
  }
  return { built: true, healed: true };
}

/**
 * Delete tsc's incremental build cache so the heal re-emits every module. The
 * cache path defaults to tsconfig.build.tsbuildinfo (per tsconfig.build.json)
 * but is read from the config when overridden. Best-effort: a missing or
 * unreadable config just falls back to the default and a missing cache is fine.
 */
function forceFullEmit(packageRoot, tsconfigPath) {
  let rel = 'tsconfig.build.tsbuildinfo';
  try {
    const cfg = JSON.parse(fs.readFileSync(tsconfigPath, 'utf8'));
    if (cfg && cfg.compilerOptions && cfg.compilerOptions.tsBuildInfoFile) {
      rel = cfg.compilerOptions.tsBuildInfoFile;
    }
  } catch {
    /* unreadable/JSONC config — use the default cache path */
  }
  try {
    fs.rmSync(path.resolve(packageRoot, rel), { force: true });
  } catch {
    /* best effort */
  }
}

/** Atomically acquire the build lock. Returns true on success. */
function acquireLock(lockDir) {
  try {
    fs.mkdirSync(lockDir); // atomic — throws EEXIST if a peer holds it
    return true;
  } catch (e) {
    if (e && e.code === 'EEXIST') return false;
    throw e;
  }
}

/** Best-effort lock release. */
function releaseLock(lockDir) {
  try {
    fs.rmSync(lockDir, { recursive: true, force: true });
  } catch {
    /* best effort — a leftover lock is recovered by the wait-then-takeover path */
  }
}

module.exports = {
  ensureRuntimeBuild,
  resolveTscScript,
  isBuilt,
  RuntimeBuildError,
  SENTINEL,
};
