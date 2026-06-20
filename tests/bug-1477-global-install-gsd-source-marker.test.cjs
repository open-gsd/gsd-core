/**
 * Regression test for #1477: `gsd surface` broken on Claude Code global installs.
 *
 * Two bugs:
 *
 * 1. findInstallSourceRoot() never found commands/gsd/ on global Claude installs
 *    because the installer never wrote the .gsd-source marker.
 *    Fix: bin/install.js now writes <runtimeConfigDir>/.gsd-source pointing at
 *    the source commands/gsd/ directory.
 *
 * 2. loadInstallExports() resolved '../../../bin/install.js' from the deployed
 *    gsd-core/bin/lib/ path, which resolves to ~/.claude/bin/install.js —
 *    a path that never exists. The installed copy lives at gsd-core/bin/install.js.
 *    Fix: loadInstallExports() now tries the co-located path first
 *    (gsd-core/bin/install.js) before the repo-root fallback.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const { install } = require('../bin/install.js');
const { findInstallSourceRoot } = require('../gsd-core/bin/lib/runtime-artifact-layout.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function silenceConsole(fn) {
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.log = orig.log;
    console.warn = orig.warn;
    console.error = orig.error;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('bug-1477: Claude global install writes .gsd-source and ships install.js', () => {
  let tmpRoot;
  let claudeDir;
  let savedHome;
  let savedUserProfile;
  let savedExplicitConfigDir;
  let savedExit;

  beforeEach(() => {
    tmpRoot = createTempDir('gsd-1477-');
    claudeDir = path.join(tmpRoot, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });

    // Redirect HOME so install() targets our temp dir.
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    savedExplicitConfigDir = process.env.GSD_EXPLICIT_CONFIG_DIR;
    process.env.HOME = tmpRoot;
    process.env.USERPROFILE = tmpRoot;
    delete process.env.GSD_EXPLICIT_CONFIG_DIR;

    // Prevent install() from killing the test process on error.
    savedExit = process.exit;
    process.exit = (code) => {
      throw new Error(`process.exit(${code}) called during install — unexpected`);
    };

    silenceConsole(() => {
      install(true /* isGlobal */, 'claude');
    });
  });

  afterEach(() => {
    process.exit = savedExit;
    process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    if (savedExplicitConfigDir === undefined) delete process.env.GSD_EXPLICIT_CONFIG_DIR;
    else process.env.GSD_EXPLICIT_CONFIG_DIR = savedExplicitConfigDir;
    try { cleanup(tmpRoot); } catch { /* best-effort */ }
  });

  // ── Failure 1: .gsd-source marker ─────────────────────────────────────────

  test('installer writes .gsd-source to runtimeConfigDir (~/.claude)', () => {
    const markerPath = path.join(claudeDir, '.gsd-source');
    assert.ok(
      fs.existsSync(markerPath),
      `.gsd-source must exist at ${markerPath} after Claude global install`,
    );
  });

  test('.gsd-source contains a valid path to commands/gsd/', () => {
    const markerPath = path.join(claudeDir, '.gsd-source');
    const content = fs.readFileSync(markerPath, 'utf8').trim();
    assert.ok(content.length > 0, '.gsd-source must not be empty');
    assert.ok(
      fs.existsSync(content),
      `.gsd-source content must point to an existing directory: ${content}`,
    );
    // Must point at commands/gsd/ (the source skill directory)
    assert.ok(
      content.endsWith(path.join('commands', 'gsd')) || content.endsWith(`commands${path.sep}gsd`),
      `.gsd-source must end with commands/gsd, got: ${content}`,
    );
  });

  test('findInstallSourceRoot(claudeDir) resolves via .gsd-source without throwing', () => {
    let resolved;
    assert.doesNotThrow(() => {
      resolved = findInstallSourceRoot(claudeDir);
    }, 'findInstallSourceRoot must not throw after global Claude install');
    assert.ok(fs.existsSync(resolved), `findInstallSourceRoot returned non-existent path: ${resolved}`);
  });

  // ── Failure 2: install.js co-located copy ─────────────────────────────────

  test('installer copies bin/install.js to gsd-core/bin/install.js', () => {
    const installJsDest = path.join(claudeDir, 'gsd-core', 'bin', 'install.js');
    assert.ok(
      fs.existsSync(installJsDest),
      `gsd-core/bin/install.js must exist at ${installJsDest} after Claude global install`,
    );
  });

  test('deployed gsd-core/bin/install.js is a valid JS file (has exports)', () => {
    const installJsDest = path.join(claudeDir, 'gsd-core', 'bin', 'install.js');
    const content = fs.readFileSync(installJsDest, 'utf8');
    // install.js must export `install` and `installRuntimeArtifacts`
    assert.ok(
      content.includes('installRuntimeArtifacts') || content.includes('module.exports'),
      'deployed install.js must contain installRuntimeArtifacts or module.exports',
    );
  });

  test('deployed gsd-core/bin/install.js path is co-located so loadInstallExports() resolves it', () => {
    // loadInstallExports() in runtime-artifact-layout.cjs resolves the co-located
    // path first: path.join(__dirname, '..', 'install.js') where __dirname is the
    // deployed gsd-core/bin/lib/. That resolves to gsd-core/bin/install.js.
    // The file must exist and be the canonical gsd-core install.js (same inode/content).
    const coLocatedInstallJs = path.join(claudeDir, 'gsd-core', 'bin', 'install.js');
    const repoInstallJs = path.join(ROOT, 'bin', 'install.js');

    assert.ok(
      fs.existsSync(coLocatedInstallJs),
      `co-located install.js must exist at ${coLocatedInstallJs} for loadInstallExports() to resolve`,
    );

    // File sizes must match — ensures it's a real copy, not a stub.
    const deployedSize = fs.statSync(coLocatedInstallJs).size;
    const sourceSize = fs.statSync(repoInstallJs).size;
    assert.strictEqual(
      deployedSize,
      sourceSize,
      `deployed gsd-core/bin/install.js size (${deployedSize}) must match source bin/install.js (${sourceSize})`,
    );
  });
});
