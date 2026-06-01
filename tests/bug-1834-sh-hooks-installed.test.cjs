/**
 * Regression tests for bug #1834
 *
 * The installer must copy all three .sh hook files to the target hooks/
 * directory during installation. In v1.32.0, only .js hooks were deployed
 * because the install loop did not handle non-.js files from hooks/dist/.
 *
 * This test runs the actual installer (not a simulation) and verifies that
 * gsd-session-state.sh, gsd-validate-commit.sh, and gsd-phase-boundary.sh
 * are present and executable in the target hooks directory.
 *
 * Distinct from:
 *   #1656 — .sh files missing from build-hooks.js HOOKS_TO_COPY
 *   #1817 — settings.json registration ran even when .sh files were absent
 */

'use strict';

const { describe, test, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const INSTALL_SCRIPT = path.join(__dirname, '..', 'bin', 'install.js');
const BUILD_SCRIPT = path.join(__dirname, '..', 'scripts', 'build-hooks.js');
const isWindows = process.platform === 'win32';

const SH_HOOKS = [
  'gsd-session-state.sh',
  'gsd-validate-commit.sh',
  'gsd-phase-boundary.sh',
];

// ─── Ensure hooks/dist/ is populated before any install test ────────────────

before(() => {
  execFileSync(process.execPath, [BUILD_SCRIPT], {
    encoding: 'utf-8',
    stdio: 'pipe',
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/**
 * Run the installer targeting a temp directory.
 * Uses CLAUDE_CONFIG_DIR to redirect the global install target.
 * Returns the path to the installed hooks directory.
 */
function runInstaller(configDir) {
  // --no-sdk: this test covers hook deployment only; skip SDK build to avoid
  // flakiness and keep the test fast (SDK install path has dedicated coverage
  // in install-smoke.yml).
  execFileSync(process.execPath, [INSTALL_SCRIPT, '--claude', '--global', '--yes', '--no-sdk'], {
    encoding: 'utf-8',
    stdio: 'pipe',
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: configDir,
    },
  });
  return path.join(configDir, 'hooks');
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. End-to-end install: .sh hooks are deployed
// ─────────────────────────────────────────────────────────────────────────────

describe('#1834: installer deploys .sh hooks alongside .js hooks', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-install-1834-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('gsd-session-state.sh is present after install', () => {
    const hooksDir = runInstaller(tmpDir);
    const target = path.join(hooksDir, 'gsd-session-state.sh');
    assert.ok(
      fs.existsSync(target),
      'gsd-session-state.sh must be installed to hooks/ — missing file causes SessionStart hook errors'
    );
  });

  test('gsd-validate-commit.sh is present after install', () => {
    const hooksDir = runInstaller(tmpDir);
    const target = path.join(hooksDir, 'gsd-validate-commit.sh');
    assert.ok(
      fs.existsSync(target),
      'gsd-validate-commit.sh must be installed to hooks/ — missing file causes PreToolUse hook errors'
    );
  });

  test('gsd-phase-boundary.sh is present after install', () => {
    const hooksDir = runInstaller(tmpDir);
    const target = path.join(hooksDir, 'gsd-phase-boundary.sh');
    assert.ok(
      fs.existsSync(target),
      'gsd-phase-boundary.sh must be installed to hooks/ — missing file causes PostToolUse hook errors'
    );
  });

  test('all three .sh hooks are present after a single install', () => {
    const hooksDir = runInstaller(tmpDir);
    for (const hook of SH_HOOKS) {
      assert.ok(
        fs.existsSync(path.join(hooksDir, hook)),
        `${hook} must be present in hooks/ after install`
      );
    }
  });

  test('.sh hooks are executable after install', {
    skip: isWindows ? 'Windows does not support POSIX file permissions' : false,
  }, () => {
    const hooksDir = runInstaller(tmpDir);
    for (const hook of SH_HOOKS) {
      const stat = fs.statSync(path.join(hooksDir, hook));
      assert.ok(
        (stat.mode & 0o111) !== 0,
        `${hook} must be executable (chmod +x) after install — missing +x causes hook invocation failures`
      );
    }
  });
});
