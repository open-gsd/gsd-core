'use strict';

/**
 * Platform-sensitive tests split out of tests/tdd-mode.test.cjs (#5276).
 *
 * scripts/gen-platform-conformance-tier.cjs selects whole files for the real-OS
 * (Windows/macOS) conformance tier. The test below carries the platform signal,
 * so it lives here; tests/tdd-mode.test.cjs stays signal-free and runs on Linux
 * only. Linux lanes run both files. Add a new platform-sensitive test HERE, not
 * in the base file — the generator fails if a split base regains a platform
 * signal.
 *
 * Moved tests and why each needs a real OS:
 * - "HOME-only seed leaks via USERPROFILE on win32" — seeds the project config
 *   with a HOME-only env while a poisoned ambient home is reachable through both
 *   home variables; on Windows os.homedir() resolves USERPROFILE, so the leak
 *   only happens there (win32-darwin-literal, process-platform)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, createTempDir, cleanup, homeSandboxEnv, withIsolatedProcessState } = require('./helpers.cjs');

// ─── helpers ──────────────────────────────────────────────────────────────────

function readConfig(tmpDir) {
  const configPath = path.join(tmpDir, '.planning', 'config.json');
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

// ─── #5276 canary: HOME-only seed still leaks on win32 ──────────────────────
// The negative control for the sandboxed-seed canary in tests/tdd-mode.test.cjs:
// while USERPROFILE still points at a poisoned ambient home, a HOME-only sandbox
// is ignored on Windows (os.homedir() prefers USERPROFILE) and the global
// default leaks into the project config — the defect #5276 is about.

describe('#5276 homeSandboxEnv canary for tdd_mode defaults', () => {
  test('HOME-only seed leaks via USERPROFILE on win32', { skip: process.platform !== 'win32' }, (t) => {
    const ambientHome = createTempDir('gsd-5276-ambient-home-');
    t.after(() => cleanup(ambientHome));
    fs.mkdirSync(path.join(ambientHome, '.gsd'));
    fs.writeFileSync(
      path.join(ambientHome, '.gsd', 'defaults.json'),
      JSON.stringify({ workflow: { tdd_mode: true } }),
    );

    const homeOnlyDir = createTempProject();
    t.after(() => cleanup(homeOnlyDir));
    const homeOnly = withIsolatedProcessState(() => {
      Object.assign(process.env, homeSandboxEnv(ambientHome));
      return runGsdTools('config-ensure-section', homeOnlyDir, { HOME: homeOnlyDir }); // #5276 HOME-only control: the leak this PR fixes
    });
    assert.ok(homeOnly.success, `HOME-only seed failed: ${homeOnly.error}`);
    assert.strictEqual(
      readConfig(homeOnlyDir).workflow?.tdd_mode,
      true,
      'HOME-only seed must leak via USERPROFILE on win32',
    );
  });
});
