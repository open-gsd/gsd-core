/**
 * Regression test for bug #941
 *
 * `managed-hooks-registry.cjs` is shipped alongside gsd-check-update-worker.js
 * in hooks/dist/ (it is listed in HOOKS_TO_COPY in scripts/build-hooks.js).
 * However, the manifest-writing loop in bin/install.js gated on
 *   file.startsWith('gsd-') && (file.endsWith('.js') || file.endsWith('.sh'))
 * — which `managed-hooks-registry.cjs` fails on both predicates (wrong prefix,
 * .cjs extension).  The result: after every install, `detect-custom-files`
 * found the installed file in the hooks/ dir but had no manifest entry for it
 * and reported a perpetual false-positive "Found 1 custom file(s)" warning on
 * every `/gsd-update`.
 *
 * Fix: drive the manifest hooks loop from HOOKS_TO_COPY (the canonical build
 * set), so the manifest set is structurally identical to what was installed.
 *
 * Closes: #941
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const INSTALL_SCRIPT = path.join(__dirname, '..', 'bin', 'install.js');
const BUILD_SCRIPT = path.join(__dirname, '..', 'scripts', 'build-hooks.js');
const TOOLS_PATH = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');
const MANIFEST_NAME = 'gsd-file-manifest.json';

const { HOOKS_TO_COPY } = require('../scripts/build-hooks.js');

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
  // eslint-disable-next-line local/no-raw-rmsync-in-tests -- local cleanup helper, swallows ENOENT
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/**
 * Run the installer targeting a temp directory as the claude global config dir.
 * Returns the path to configDir.
 */
function runInstaller(configDir) {
  // Clear GSD_TEST_MODE so the installer's main() block actually runs.
  // The test file sets GSD_TEST_MODE=1 (top of file) to suppress in-process
  // import side effects, but when install.js is spawned as a subprocess it
  // must not skip the main() gate or the install is a no-op.
  const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir };
  delete env.GSD_TEST_MODE;
  execFileSync(process.execPath, [INSTALL_SCRIPT, '--claude', '--global', '--yes'], {
    encoding: 'utf-8',
    stdio: 'pipe',
    env,
  });
  return configDir;
}

/**
 * Run detect-custom-files and return parsed JSON output.
 */
function detectCustomFiles(configDir) {
  const result = execFileSync(process.execPath, [TOOLS_PATH, 'detect-custom-files', '--config-dir', configDir], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, GSD_SESSION_KEY: '' },
  });
  return JSON.parse(result.trim());
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('bug #941 — managed-hooks-registry.cjs recorded in file manifest', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-bug-941-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('managed-hooks-registry.cjs appears in gsd-file-manifest.json after install', () => {
    runInstaller(tmpDir);

    const manifestPath = path.join(tmpDir, MANIFEST_NAME);
    assert.ok(
      fs.existsSync(manifestPath),
      `${MANIFEST_NAME} must exist after install (not found at ${manifestPath})`,
    );

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    assert.ok(
      typeof manifest.files === 'object' && manifest.files !== null,
      'manifest must have a files map',
    );

    // The key must use forward slashes (cross-platform manifest format)
    const key = 'hooks/managed-hooks-registry.cjs';
    assert.ok(
      Object.prototype.hasOwnProperty.call(manifest.files, key),
      [
        `manifest.files must contain '${key}' — managed-hooks-registry.cjs is`,
        'shipped to users but was not recorded in the manifest, causing',
        `detect-custom-files to flag it as a perpetual false-positive custom file.`,
        `Actual manifest hook keys: ${Object.keys(manifest.files).filter(k => k.startsWith('hooks/')).join(', ')}`,
      ].join(' '),
    );
  });

  test('gsd-file-manifest.json covers the full HOOKS_TO_COPY set (forward-proof)', () => {
    runInstaller(tmpDir);

    const manifestPath = path.join(tmpDir, MANIFEST_NAME);
    assert.ok(fs.existsSync(manifestPath), `${MANIFEST_NAME} must exist after install`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const hooksDir = path.join(tmpDir, 'hooks');

    // Every hook in HOOKS_TO_COPY that was actually installed must have a
    // manifest entry. This assertion is forward-proof: adding any new hook to
    // HOOKS_TO_COPY without updating the manifest loop will fail this test.
    for (const hook of HOOKS_TO_COPY) {
      const installed = path.join(hooksDir, hook);
      if (!fs.existsSync(installed)) {
        // Skip hooks that weren't installed (e.g. .sh hooks on non-unix skip
        // chmod but still install — only skip if truly absent).
        continue;
      }
      const key = `hooks/${hook}`;
      assert.ok(
        Object.prototype.hasOwnProperty.call(manifest.files, key),
        [
          `manifest.files must contain '${key}'.`,
          `HOOKS_TO_COPY lists '${hook}' and it was installed, but the manifest`,
          `loop in writeManifest() did not record it.`,
          `Actual manifest hook keys: ${Object.keys(manifest.files).filter(k => k.startsWith('hooks/')).join(', ')}`,
        ].join(' '),
      );
    }
  });

  test('detect-custom-files reports zero custom files after a clean install (no false positives)', () => {
    runInstaller(tmpDir);

    let detected;
    try {
      detected = detectCustomFiles(tmpDir);
    } catch (err) {
      assert.fail(
        `detect-custom-files failed: ${err.message}\nstderr: ${err.stderr || '(none)'}`,
      );
    }

    assert.ok(
      detected.manifest_found,
      'detect-custom-files must find the manifest after install',
    );

    const hookCustomFiles = (detected.custom_files || []).filter(f => f.startsWith('hooks/'));
    assert.strictEqual(
      hookCustomFiles.length,
      0,
      [
        `detect-custom-files must report 0 custom hook files after a clean install, but got ${hookCustomFiles.length}:`,
        JSON.stringify(hookCustomFiles, null, 2),
        'This is the perpetual false-positive bug #941 — hooks in HOOKS_TO_COPY that',
        'were not recorded in the manifest appear as custom files.',
      ].join('\n'),
    );
  });

  test('manifest hook keys use forward slashes (cross-platform compatibility)', () => {
    runInstaller(tmpDir);

    const manifest = JSON.parse(fs.readFileSync(path.join(tmpDir, MANIFEST_NAME), 'utf-8'));
    const hookKeys = Object.keys(manifest.files).filter(k => k.startsWith('hooks/'));

    assert.ok(hookKeys.length > 0, 'manifest must contain at least one hooks/ entry');

    for (const key of hookKeys) {
      assert.ok(
        !key.includes('\\'),
        `manifest key '${key}' must use forward slashes, not backslashes`,
      );
    }
  });
});
