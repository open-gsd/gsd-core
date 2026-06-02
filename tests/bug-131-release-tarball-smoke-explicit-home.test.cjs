// allow-test-rule: integration-test-input
// Regression test for #131: runNpm() must not fail when HOME points at an
// unwritable directory. The before() hook in release-tarball-smoke.install.test.cjs
// calls runNpm(['pack', ...]) and runNpm(['install', '-g', ...]) — if those inherit
// an unwritable HOME from the environment (common in constrained Docker hosts),
// the entire hook fails and all 6 subtests are cancelled.
//
// Fix: runNpm() must inject an explicit HOME, npm_config_cache, and
// npm_config_userconfig that point into a temp directory it owns, so that npm
// never reads from or writes to the caller's HOME.
//
// Test 3 (added in the second fix pass) verifies that isolatedNpmEnv() — the
// companion export that lets runSmoke() apply the same isolation — also redirects
// HOME away from the caller's HOME. Without this, subtests A-F of
// release-tarball-smoke.install.test.cjs still fail because runSmoke() calls
// spawnSync('npm', ...) internally and was not covered by the runNpm() fix.

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// The helpers under test.
const { runNpm, isolatedNpmEnv, cleanup } = require('./helpers.cjs');

// Resolve a filesystem path to its canonical (symlink-free) form even if the
// leaf does not exist yet (e.g. ~/.npm before npm has written its cache).
// Walks up to the nearest existing ancestor, resolves that, then re-appends
// the trailing segments. This handles macOS /var → /private/var symlinks for
// paths created under os.tmpdir() where the leaf directory may not exist yet.
function safeRealpath(p) {
  try {
    return fs.realpathSync(p);
  } catch (_) {
    // Leaf does not exist — resolve the nearest existing ancestor then
    // reconstruct the original suffix so the result is still canonical.
    const segments = [];
    let cur = p;
    for (;;) {
      const parent = path.dirname(cur);
      if (parent === cur) {
        // Reached filesystem root — return original path unchanged.
        return p;
      }
      segments.unshift(path.basename(cur));
      cur = parent;
      try {
        return path.join(fs.realpathSync(cur), ...segments);
      } catch (__) {
        // Keep walking up.
      }
    }
  }
}

describe('bug-131: runNpm isolates HOME from the caller environment', () => {
  // ── Test 1 — runNpm works with an unwritable HOME ────────────────────────
  // Spawn a child Node process that sets HOME to a chmod-0500 directory, then
  // invokes runNpm(['--version']). Without the fix, npm tries to read/write
  // HOME/.npmrc and HOME/.npm, fails with EACCES, and runNpm throws.
  // With the fix, runNpm injects its own isolated HOME and npm succeeds.
  test('runNpm succeeds even when process HOME is unwritable', () => {
    // Create an unwritable dir to serve as a poisoned HOME.
    const poisonedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-bug131-poison-'));
    try {
      fs.chmodSync(poisonedHome, 0o500); // r-x only — not writable

      // We exercise the real runNpm() path by running a tiny inline Node script
      // that requires helpers.cjs and calls runNpm(['--version']) with HOME set
      // to the unwritable dir. The script exits 0 on success, non-zero on throw.
      const script = `
        process.env.HOME = ${JSON.stringify(poisonedHome)};
        process.env.USERPROFILE = ${JSON.stringify(poisonedHome)};
        const { runNpm } = require(${JSON.stringify(path.join(__dirname, 'helpers.cjs'))});
        try {
          const out = runNpm(['--version']);
          if (!out || out.trim() === '') process.exit(2); // vacuous success guard
          process.stdout.write(out);
          process.exit(0);
        } catch (e) {
          process.stderr.write(e.message + '\\n');
          process.exit(1);
        }
      `;

      let stdout = '';
      let stderr = '';
      let exitCode = 0;
      try {
        stdout = execFileSync(process.execPath, ['-e', script], {
          encoding: 'utf-8',
          timeout: 30_000,
        });
      } catch (err) {
        stdout = err.stdout || '';
        stderr = err.stderr || '';
        exitCode = err.status ?? 1;
      }

      assert.equal(
        exitCode,
        0,
        `runNpm should succeed with an unwritable HOME but exited ${exitCode}. stderr: ${stderr}`,
      );
      // npm --version returns something like "10.x.y"
      assert.match(
        stdout.trim(),
        /^\d+\.\d+/,
        `expected semver output from npm --version, got: ${stdout}`,
      );
    } finally {
      // Restore write permission before cleanup so the directory can be deleted.
      try { fs.chmodSync(poisonedHome, 0o700); } catch (_) { /* best-effort */ }
      cleanup(poisonedHome);
    }
  });

  // ── Test 2 — runNpm does not leak a caller-supplied HOME into npm ────────
  // Even if the caller exports HOME=/some/real/path, the injected HOME must be
  // a different (temp) path so npm writes never touch the caller's $HOME.
  test('runNpm injects a HOME distinct from process.env.HOME', () => {
    // Capture what HOME runNpm actually passes to npm by asking npm to print
    // the value it sees for the $HOME env var. We do this via `npm config get
    // cache` which reveals the cache path — if it's under process.env.HOME,
    // the fix is absent; if it's under a tmp dir, the fix is present.

    const script = `
      const { runNpm } = require(${JSON.stringify(path.join(__dirname, 'helpers.cjs'))});
      try {
        // npm config get cache prints the effective cache directory.
        const out = runNpm(['config', 'get', 'cache']);
        process.stdout.write(out.trim());
        process.exit(0);
      } catch (e) {
        process.stderr.write(e.message + '\\n');
        process.exit(1);
      }
    `;

    let stdout = '';
    let stderr = '';
    let exitCode = 0;
    try {
      stdout = execFileSync(process.execPath, ['-e', script], {
        encoding: 'utf-8',
        timeout: 30_000,
      });
    } catch (err) {
      stdout = err.stdout || '';
      stderr = err.stderr || '';
      exitCode = err.status ?? 1;
    }

    assert.equal(
      exitCode,
      0,
      `runNpm config get cache failed with exit ${exitCode}. stderr: ${stderr}`,
    );

    const effectiveCacheDir = stdout.trim();

    // The effective npm cache must NOT be inside the calling process's HOME.
    // If it is, the fix was not applied and the Docker regression can still occur.
    const callerHome = os.homedir();
    assert.ok(
      !effectiveCacheDir.startsWith(callerHome),
      `npm cache dir ${effectiveCacheDir} is still under caller HOME ${callerHome} — fix not applied`,
    );

    // It must be somewhere under the system tmp dir, confirming isolation.
    // Use safeRealpath on both sides so that macOS /var→/private/var symlinks
    // do not cause a false mismatch when os.tmpdir() and the resolved cache
    // path differ only in symlink expansion. The cache sub-directory (.npm) may
    // not exist yet; safeRealpath walks up to the nearest existing ancestor.
    const sysTmp = safeRealpath(os.tmpdir());
    const realCacheDir = safeRealpath(effectiveCacheDir);
    assert.ok(
      realCacheDir.startsWith(sysTmp),
      `npm cache dir ${realCacheDir} should be under tmpdir ${sysTmp}`,
    );
  });

  // ── Test 3 — isolatedNpmEnv() redirects HOME away from the caller's HOME ──
  // runSmoke() calls spawnSync('npm', ...) with npmEnv from isolatedNpmEnv().
  // If isolatedNpmEnv() didn't redirect HOME, subtests A-F would still fail on
  // Docker hosts with an unwritable HOME (the original bug #131 root cause,
  // manifesting via the sibling runSmoke() path). (#131)
  test('isolatedNpmEnv() HOME is distinct from the caller HOME and lives under tmpdir', () => {
    const env = isolatedNpmEnv();

    // Must expose a HOME key.
    assert.ok(
      typeof env.HOME === 'string' && env.HOME.length > 0,
      'isolatedNpmEnv() must set HOME',
    );

    // Must not be the caller's HOME.
    const callerHome = os.homedir();
    assert.notEqual(
      env.HOME,
      callerHome,
      `isolatedNpmEnv() HOME must differ from caller HOME ${callerHome}`,
    );

    // Must live under the system tmpdir, confirming it is an isolated temp directory.
    // Use safeRealpath on both sides so that macOS /var→/private/var symlinks
    // do not cause a false mismatch.
    const sysTmp = safeRealpath(os.tmpdir());
    const realHome = safeRealpath(env.HOME);
    assert.ok(
      realHome.startsWith(sysTmp),
      `isolatedNpmEnv() HOME ${realHome} should be under tmpdir ${sysTmp}`,
    );

    // npm_config_cache and npm_config_userconfig must also be set and under the isolated HOME.
    assert.ok(
      typeof env.npm_config_cache === 'string' && env.npm_config_cache.startsWith(env.HOME),
      `npm_config_cache ${env.npm_config_cache} should be under isolated HOME ${env.HOME}`,
    );
    assert.ok(
      typeof env.npm_config_userconfig === 'string' && env.npm_config_userconfig.startsWith(env.HOME),
      `npm_config_userconfig ${env.npm_config_userconfig} should be under isolated HOME ${env.HOME}`,
    );
  });
});
