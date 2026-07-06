// allow-test-rule: integration-test-input
// The script under test (scripts/release-tarball-smoke.cjs) is the system
// under test. We exercise it via its exported pure function, not by reading
// source text. The tarball fixture is produced by npm pack in before().

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { cleanup, createTempDir, runNpm, isolatedNpmEnv } = require('./helpers.cjs');
const { SMOKE, runSmoke } = require('../scripts/release-tarball-smoke.cjs');

const smokeMsg = (label, result) =>
  `${label}: code=${result.code} details=${JSON.stringify(result.details)}`;

const PKG_PATH = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf-8'));

describe('release-tarball-smoke', () => {
  // Shared fixture state: pack the tarball once, install it once, reuse for all tests.
  let packDir;
  let installPrefix;
  let tarballPath;
  // fixtureDir for lifecycle / init tests; created once in before(), cleaned in after().
  let fixtureDir;

  before(async () => {
    // Pack once into a temp dir.
    packDir = createTempDir('gsd-smoke-pack-');
    installPrefix = createTempDir('gsd-smoke-prefix-');
    fixtureDir = createTempDir('gsd-smoke-fixture-');

    // npm pack + npm install -g on a large tarball (1499 files, ~10 MB) can take
    // 3–6 minutes on slow Docker hosts (cold disk, constrained CPU). The runNpm
    // default timeout of 180 s is sufficient on fast machines but insufficient on
    // cartographer-class hosts. 600 s (10 min) gives a safe ceiling without
    // masking genuine hangs.
    const SLOW_HOST_TIMEOUT = 600_000;

    const packOutput = runNpm(
      ['pack', '--pack-destination', packDir],
      { cwd: path.join(__dirname, '..'), timeout: SLOW_HOST_TIMEOUT },
    );

    // npm pack prints the filename as the last line of stdout.
    const lines = packOutput.split(/\r?\n/).filter(Boolean);
    const tgzName = lines[lines.length - 1];
    tarballPath = path.join(packDir, tgzName);
    if (!fs.existsSync(tarballPath)) {
      const found = fs.readdirSync(packDir).find((f) => f.endsWith('.tgz'));
      if (!found) throw new Error(`npm pack produced no .tgz in ${packDir}; output: ${packOutput}`);
      tarballPath = path.join(packDir, found);
    }

    // Install once into installPrefix. All tests share this install.
    runNpm(['install', '-g', '--prefix', installPrefix, tarballPath], { timeout: SLOW_HOST_TIMEOUT });
  });

  after(() => {
    cleanup(packDir);
    cleanup(installPrefix);
    cleanup(fixtureDir);
  });

  // ── Test A — happy path ────────────────────────────────────────────────────
  test('A: happy path — installed version matches package.json', () => {
    const result = runSmoke({
      tarballPath,
      installPrefix,
      expectedVersion: pkg.version,
      fixtureDir,
      npmEnv: isolatedNpmEnv(),
    });

    assert.equal(result.code, SMOKE.OK, smokeMsg('A', result));
    assert.equal(result.details.version, pkg.version, smokeMsg('A', result));
  });

  // ── Test B — version mismatch detected ────────────────────────────────────
  test('B: version mismatch detected — returns VERSION_MISMATCH', () => {
    const result = runSmoke({
      tarballPath,
      installPrefix,
      expectedVersion: '99.99.99',
      fixtureDir,
      npmEnv: isolatedNpmEnv(),
    });

    assert.equal(result.code, SMOKE.VERSION_MISMATCH, smokeMsg('B', result));
  });

  // ── Test C — happy lifecycle ───────────────────────────────────────────────
  // Verifies that the installed package has all expected command .md files and
  // that each command resolves a workflow .md file that also exists.
  // Also verifies that `gsd-core --local --claude` (init) succeeds in
  // the fixtureDir and creates the expected .claude/ directories.
  test('C: happy lifecycle — command + workflow files resolve OK', () => {
    const result = runSmoke({
      tarballPath,
      installPrefix,
      expectedVersion: pkg.version,
      fixtureDir,
      lifecycleCommands: ['init', 'discuss-phase', 'plan-phase'],
      npmEnv: isolatedNpmEnv(),
    });

    assert.equal(result.code, SMOKE.OK, smokeMsg('C', result));

    // Each non-init command must be in lifecycleResolved with both paths populated
    const resolved = result.details.lifecycleResolved;
    assert.ok(Array.isArray(resolved));

    for (const entry of resolved) {
      assert.ok(
        typeof entry.commandPath === 'string' && entry.commandPath.length > 0,
        `expected commandPath for ${entry.command}`,
      );
      assert.ok(
        fs.existsSync(entry.commandPath) && fs.statSync(entry.commandPath).isFile(),
        `commandPath must be an existing file: ${entry.commandPath}`,
      );
      assert.ok(
        typeof entry.workflowPath === 'string' && entry.workflowPath.length > 0,
        `expected workflowPath for ${entry.command}`,
      );
      assert.ok(
        fs.existsSync(entry.workflowPath) && fs.statSync(entry.workflowPath).isFile(),
        `workflowPath must be an existing file: ${entry.workflowPath}`,
      );
    }
  });

  // ── Test D — missing command detected ─────────────────────────────────────
  // Passes a nonexistent command name; expects the smoke to detect the missing
  // command .md file and return COMMAND_FILE_MISSING with the right details.
  test('D: missing command detected — returns COMMAND_FILE_MISSING', () => {
    const result = runSmoke({
      tarballPath,
      installPrefix,
      expectedVersion: pkg.version,
      fixtureDir,
      lifecycleCommands: ['init', 'nonexistent-phase-xyz'],
      npmEnv: isolatedNpmEnv(),
    });

    assert.equal(result.code, SMOKE.COMMAND_FILE_MISSING, smokeMsg('D', result));
    assert.equal(result.details.command, 'nonexistent-phase-xyz', smokeMsg('D', result));
    assert.ok(typeof result.details.path === 'string' && result.details.path.length > 0, smokeMsg('D', result));
  });

  // ── Test E — workflow-body checks run (informational) ─────────────────────
  // Asserts that the workflow-body scanning machinery ran (structural assertion).
  // Does NOT assert colonLeakCount is zero — when those issues are fixed, this
  // test continues to pass unchanged.
  test('E: workflow-body checks run — scan counts are present integers', () => {
    const result = runSmoke({
      tarballPath,
      installPrefix,
      expectedVersion: pkg.version,
      fixtureDir,
      lifecycleCommands: [],
      npmEnv: isolatedNpmEnv(),
    });

    // Structural: the scan ran and populated the counters
    assert.ok(
      Number.isInteger(result.details.workflowsScanned) && result.details.workflowsScanned >= 1,
      smokeMsg('E', result),
    );
    assert.ok(
      Number.isInteger(result.details.colonLeakCount),
      smokeMsg('E', result),
    );
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-131-release-tarball-smoke-explicit-home.test.cjs — consolidation epic #1969 (B6 #1975)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-131-release-tarball-smoke-explicit-home (consolidation epic #1969 B6 #1975)", () => {
// allow-test-rule: integration-test-input (see #131)
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
const { isolatedNpmEnv, cleanup } = require('./helpers.cjs');

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
    assert.equal(
      env.npm_config_loglevel,
      'error',
      'isolatedNpmEnv() should suppress npm notice/warn chatter in test gates',
    );
    assert.equal(
      env.npm_config_update_notifier,
      'false',
      'isolatedNpmEnv() should disable npm update-notifier notices in test gates',
    );
    assert.equal(
      env.NO_UPDATE_NOTIFIER,
      '1',
      'isolatedNpmEnv() should disable npm update-notifier notices for npm versions that honor NO_UPDATE_NOTIFIER',
    );
  });
});
  });
}
