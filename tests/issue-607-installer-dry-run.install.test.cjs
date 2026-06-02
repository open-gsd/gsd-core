// allow-test-rule: integration-test-input
// Test-created temp dirs are the only filesystem reads here — not repo source files.
// This is an integration test that seeds fixture files in OS temp dirs and
// asserts that the installer correctly handles --dry-run and the
// cleanupLegacyGsdCc exported helper.

/**
 * #607 — --dry-run flag and cleanupLegacyGsdCc wiring.
 *
 * Covers:
 *   1. Spawning `node bin/install.js --claude --global --dry-run` with an
 *      isolated HOME that contains a seeded legacy artifact. Asserts exit 0,
 *      stdout names the artifact and contains "dry" (case-insensitive), and
 *      no files are mutated (artifact still present; no .claude install).
 *      Also asserts the per-package cache path appears AT MOST ONCE (no
 *      double-print regression).
 *   2. Spawning `node bin/install.js --claude --dry-run --uninstall` asserts
 *      the "does not preview --uninstall" warning prints and exits 0 without
 *      uninstalling anything.
 *   3. Direct unit call to the exported cleanupLegacyGsdCc helper:
 *      - dryRun:true → plan lists the artifact, removes nothing.
 *      - dryRun:false → seeded leftover removed, dev-preferences.md preserved.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');
const os     = require('node:os');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const INSTALL_BIN = path.join(REPO_ROOT, 'bin', 'install.js');
const { cleanup } = require('./helpers.cjs');

// ─── helpers ─────────────────────────────────────────────────────────────────

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

// The assembled signal string used as file content to trigger
// content-references-old-package detection.
const LEGACY_PKG_SIGNAL = 'gsd-core' + '-cc';

// ─── Suite 1: spawn --dry-run, assert no mutations ───────────────────────────

describe('#607 --dry-run flag: spawned installer exits 0 and mutates nothing', () => {
  let tmpHome;

  beforeEach(() => {
    tmpHome = mkTmp('gsd-607-dryhome-');
  });

  afterEach(() => {
    cleanup(tmpHome);
  });

  test('exits 0; stdout names artifact and contains "dry"; no install; artifact preserved; no double-print', () => {
    // Seed a legacy artifact: a .cjs hook file under HOME/.gemini/hooks/ whose
    // content contains the old package name (content-signal, not orphan-by-name).
    // This exercises the content-references-old-package reason exclusively.
    const legacyHook = path.join(tmpHome, '.gemini', 'hooks', 'gsd-old-update-worker.cjs');
    writeFile(legacyHook, `// installed via ${LEGACY_PKG_SIGNAL}\nconsole.log("old worker");`);

    // Seed the legacy shared cache file
    const legacyCache = path.join(tmpHome, '.cache', 'gsd', 'gsd-update-check.json');
    writeFile(legacyCache, JSON.stringify({ legacy: true }));

    // Spawn the installer with --dry-run
    const result = spawnSync(
      process.execPath,
      [INSTALL_BIN, '--claude', '--global', '--dry-run'],
      {
        env: {
          ...process.env,
          HOME: tmpHome,
          USERPROFILE: tmpHome,
          // Redirect Claude config dir into isolated tmp home
          CLAUDE_CONFIG_DIR: path.join(tmpHome, '.claude'),
          // Suppress slow stale-SDK npm check
          GSD_SKIP_STALE_SDK_CHECK: '1',
          // Do NOT set GSD_TEST_MODE — we want the main() block to run
          GSD_TEST_MODE: undefined,
        },
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: 30_000,
      }
    );

    // Exit code must be 0
    assert.equal(
      result.status,
      0,
      `Expected exit 0 but got ${result.status}.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
    );

    const stdout = result.stdout + result.stderr;

    // stdout must contain the word "dry" (case-insensitive)
    assert.match(
      stdout,
      /dry/i,
      `Expected stdout to contain "dry". Got:\n${stdout}`
    );

    // stdout must mention the seeded legacy artifact path
    assert.ok(
      stdout.includes(legacyHook),
      `Expected stdout to mention ${legacyHook}.\nGot:\n${stdout}`
    );

    // The seeded artifact must STILL EXIST (no mutations)
    assert.ok(
      fs.existsSync(legacyHook),
      `Legacy hook must still exist after --dry-run: ${legacyHook}`
    );

    // The legacy cache must STILL EXIST
    assert.ok(
      fs.existsSync(legacyCache),
      `Legacy cache must still exist after --dry-run: ${legacyCache}`
    );

    // No actual install happened — .claude/gsd-core must not exist
    const installDir = path.join(tmpHome, '.claude', 'gsd-core');
    assert.equal(
      fs.existsSync(installDir),
      false,
      `No install should happen during --dry-run; found: ${installDir}`
    );

    // Regression: the per-package cache path must appear AT MOST ONCE
    // (guard against the duplicate-print bug where it was printed both inside
    // cleanupLegacyGsdCc and again in the outer --dry-run block).
    const updateCacheFileName = require(
      path.join(REPO_ROOT, 'gsd-core', 'bin', 'lib', 'package-identity.cjs')
    ).updateCacheFileName;
    const perPkgCacheFile = path.join(tmpHome, '.cache', 'gsd', updateCacheFileName);
    const occurrences = stdout.split(perPkgCacheFile).length - 1;
    assert.ok(
      occurrences <= 1,
      `Per-package cache path must appear at most once in stdout; found ${occurrences} times.\nstdout:\n${stdout}`
    );
  });

  test('--uninstall --dry-run prints "does not preview --uninstall" warning and exits 0', () => {
    const result = spawnSync(
      process.execPath,
      [INSTALL_BIN, '--claude', '--uninstall', '--dry-run'],
      {
        env: {
          ...process.env,
          HOME: tmpHome,
          USERPROFILE: tmpHome,
          CLAUDE_CONFIG_DIR: path.join(tmpHome, '.claude'),
          GSD_SKIP_STALE_SDK_CHECK: '1',
          GSD_TEST_MODE: undefined,
        },
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: 30_000,
      }
    );

    assert.equal(
      result.status,
      0,
      `Expected exit 0 but got ${result.status}.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
    );

    const stdout = result.stdout + result.stderr;

    // Must print the warning about --uninstall not being previewed
    assert.ok(
      stdout.includes('does not preview --uninstall'),
      `Expected "does not preview --uninstall" warning.\nGot:\n${stdout}`
    );

    // No uninstall occurred — .claude/gsd-core must not have been removed
    // (it never existed, but we confirm the installer didn't blow up)
    assert.equal(
      result.status,
      0,
      'Process must exit 0'
    );
  });
});

// ─── Suite 2: direct helper unit tests ───────────────────────────────────────

describe('#607 cleanupLegacyGsdCc: exported helper unit tests', () => {
  // GSD_TEST_MODE is already set at the top so requiring install.js is safe.
  const { cleanupLegacyGsdCc } = require(INSTALL_BIN);

  let tmpRoot;
  let homeDir;

  beforeEach(() => {
    tmpRoot = mkTmp('gsd-607-unit-');
    homeDir = path.join(tmpRoot, 'home');
    fs.mkdirSync(homeDir, { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpRoot);
  });

  test('dryRun:true — plan lists seeded artifact; nothing removed', () => {
    // Seed a content-signal code file under homeDir/.gemini/hooks/
    const legacyHook = path.join(homeDir, '.gemini', 'hooks', 'gsd-old-update-worker.cjs');
    writeFile(legacyHook, `// installed via ${LEGACY_PKG_SIGNAL}\nconsole.log("old worker");`);

    const logMessages = [];
    const mockLogger = { log: (msg) => logMessages.push(msg) };

    const { plan, result } = cleanupLegacyGsdCc({
      homeDir,
      dryRun: true,
      logger: mockLogger,
    });

    // Plan must include the seeded artifact
    const planEntry = plan.find((p) => p.path === legacyHook);
    assert.ok(planEntry, `Plan must list seeded artifact: ${legacyHook}\nActual plan: ${JSON.stringify(plan)}`);

    // dryRun result must flag it as skipped, not removed
    assert.equal(result.dryRun, true);
    assert.equal(result.removed.length, 0, 'dryRun must remove nothing');

    // The artifact must still exist
    assert.ok(
      fs.existsSync(legacyHook),
      `Artifact must survive dry-run: ${legacyHook}`
    );

    // Logger should have been called at least once
    assert.ok(logMessages.length > 0, 'Logger should have been called');
  });

  test('dryRun:false — seeded leftover removed; dev-preferences.md preserved', () => {
    // Seed a content-signal code file
    const legacyHook = path.join(homeDir, '.gemini', 'hooks', 'gsd-old-update-worker.cjs');
    writeFile(legacyHook, `// installed via ${LEGACY_PKG_SIGNAL}\nconsole.log("old worker");`);

    // Seed a dev-preferences.md that must NOT be removed
    const devPrefs = path.join(homeDir, '.gemini', 'gsd-core', 'dev-preferences.md');
    writeFile(devPrefs, '# My prefs\n\nSome user content — must not be touched.');

    const { plan, result } = cleanupLegacyGsdCc({
      homeDir,
      dryRun: false,
    });

    // The legacy hook must be in the plan
    const planEntry = plan.find((p) => p.path === legacyHook);
    assert.ok(planEntry, `Legacy hook must appear in plan: ${legacyHook}\nActual plan: ${JSON.stringify(plan)}`);

    // The legacy hook must have been removed
    assert.equal(
      fs.existsSync(legacyHook),
      false,
      `Legacy hook must be removed: ${legacyHook}`
    );

    // The removed list must include the legacy hook
    assert.ok(
      result.removed.includes(legacyHook),
      `removed[] must include legacy hook\nActual removed: ${JSON.stringify(result.removed)}`
    );

    // dev-preferences.md must NOT be in the plan and must still exist
    const devPrefsInPlan = plan.find((p) => p.path === devPrefs);
    assert.equal(devPrefsInPlan, undefined, 'dev-preferences.md must never appear in plan');
    assert.ok(
      fs.existsSync(devPrefs),
      `dev-preferences.md must be preserved: ${devPrefs}`
    );
  });

  test('dryRun:true — returns plan and result without error (no files present)', () => {
    // homeDir exists but no legacy artifacts seeded
    const { plan, result } = cleanupLegacyGsdCc({
      homeDir,
      dryRun: true,
    });

    assert.ok(Array.isArray(plan), 'plan must be an array');
    assert.equal(result.dryRun, true);
    assert.equal(result.removed.length, 0, 'nothing to remove');
  });
});
