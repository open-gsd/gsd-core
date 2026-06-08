'use strict';

/**
 * Regression tests for issue #844: manifest version sync.
 *
 * Verifies that `scripts/sync-manifest-versions.cjs` correctly stamps the
 * package.json version into every registered runtime-integration manifest,
 * and that all currently-tracked manifests are in sync.
 *
 * Key deliverable: the regression guard (test d) asserts that any committed
 * JSON file with a top-level `version` field matching package.json is
 * registered in VERSIONED_MANIFESTS — forcing explicit opt-in for future
 * manifests.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const helpers = require(path.join(__dirname, 'helpers.cjs'));
const {
  VERSIONED_MANIFESTS,
  syncManifestVersions,
  getPackageVersion,
  stageManifests,
} = require(path.join(ROOT, 'scripts', 'sync-manifest-versions.cjs'));

// ─── A: RED→GREEN repro via temp fixture ─────────────────────────────────────
describe('A: syncManifestVersions — temp fixture', () => {

  let tmpRoot;

  test('setup: create temp fixture with stale manifests', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-844-'));

    // Write tmp package.json
    fs.writeFileSync(
      path.join(tmpRoot, 'package.json'),
      JSON.stringify({ name: 'x', version: '9.9.9-test.0' }, null, 2) + '\n'
    );

    // Copy real manifests into tmp, stamped at OLD version
    for (const rel of VERSIONED_MANIFESTS) {
      const realAbs = path.join(ROOT, rel);
      const manifest = JSON.parse(fs.readFileSync(realAbs, 'utf8'));
      manifest.version = '0.0.0';

      const destAbs = path.join(tmpRoot, rel);
      const destDir = path.dirname(destAbs);
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
      fs.writeFileSync(destAbs, JSON.stringify(manifest, null, 2) + '\n');
    }
  });

  test('pre-sync: at least one manifest has stale version', () => {
    assert.ok(tmpRoot, 'tmpRoot must be set by setup test');
    const pkgVersion = getPackageVersion(tmpRoot);
    let anyStale = false;
    for (const rel of VERSIONED_MANIFESTS) {
      const m = JSON.parse(fs.readFileSync(path.join(tmpRoot, rel), 'utf8'));
      if (m.version !== pkgVersion) { anyStale = true; break; }
    }
    assert.ok(anyStale, 'At least one manifest should be stale before sync (version 0.0.0 != 9.9.9-test.0)');
  });

  test('syncManifestVersions stamps all manifests to package.json version', () => {
    assert.ok(tmpRoot, 'tmpRoot must be set by setup test');
    const changed = syncManifestVersions({ root: tmpRoot });
    assert.ok(changed.length > 0, 'syncManifestVersions should report at least one changed file');

    const pkgVersion = getPackageVersion(tmpRoot);
    assert.equal(pkgVersion, '9.9.9-test.0');

    for (const rel of VERSIONED_MANIFESTS) {
      const abs = path.join(tmpRoot, rel);
      const m = JSON.parse(fs.readFileSync(abs, 'utf8'));
      assert.equal(
        m.version,
        '9.9.9-test.0',
        `${rel} version should be 9.9.9-test.0 after sync`
      );
    }
  });

  test('non-version fields are preserved after sync', () => {
    assert.ok(tmpRoot, 'tmpRoot must be set by setup test');
    // Read from the real manifests to know what non-version fields should exist
    for (const rel of VERSIONED_MANIFESTS) {
      const real = JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
      const tmp = JSON.parse(fs.readFileSync(path.join(tmpRoot, rel), 'utf8'));
      // Check that every non-version key from the real manifest exists in tmp
      for (const key of Object.keys(real)) {
        if (key === 'version') continue;
        assert.ok(
          Object.prototype.hasOwnProperty.call(tmp, key),
          `${rel}: field "${key}" should be preserved after sync`
        );
      }
    }
  });

  test('each synced file ends with a single trailing newline', () => {
    assert.ok(tmpRoot, 'tmpRoot must be set by setup test');
    for (const rel of VERSIONED_MANIFESTS) {
      const raw = fs.readFileSync(path.join(tmpRoot, rel), 'utf8');
      assert.ok(raw.endsWith('\n'), `${rel} must end with a trailing newline`);
      assert.ok(!raw.endsWith('\n\n'), `${rel} must not end with a double newline`);
    }
  });

  test('second syncManifestVersions call is idempotent (returns [])', () => {
    assert.ok(tmpRoot, 'tmpRoot must be set by setup test');
    const changed = syncManifestVersions({ root: tmpRoot });
    assert.deepEqual(changed, [], 'Second sync call should return [] (already in sync)');
  });

  test('cleanup: remove temp fixture', () => {
    if (tmpRoot) {
      helpers.cleanup(tmpRoot);
      tmpRoot = null;
    }
  });
});

// ─── B: Registry-in-sync: real manifests match package.json ──────────────────
describe('B: real manifests match package.json version', () => {

  const pkgVersion = getPackageVersion(ROOT);

  for (const rel of VERSIONED_MANIFESTS) {
    test(`${rel} version === ${pkgVersion}`, () => {
      const abs = path.join(ROOT, rel);
      assert.ok(fs.existsSync(abs), `${rel} must exist at ${abs}`);
      const m = JSON.parse(fs.readFileSync(abs, 'utf8'));
      assert.equal(
        m.version,
        pkgVersion,
        `${rel} version (${m.version}) must match package.json version (${pkgVersion}). ` +
        'Run `node scripts/sync-manifest-versions.cjs` to fix.'
      );
    });
  }
});

// ─── C: Regression guard — all version-bearing JSON files are registered ──────
describe('C: regression guard — version-bearing JSON files must be registered', () => {

  // package.json is the version source; package-lock.json is npm-managed.
  // Both inherently track the version without the sync script.
  const ALLOWED = new Set([...VERSIONED_MANIFESTS, 'package.json', 'package-lock.json']);

  // Semver-ish: matches X.Y.Z with optional pre-release/build metadata.
  const SEMVER = /^\d+\.\d+\.\d+(?:[-+].+)?$/;

  // Paths to exclude from the guard
  const EXCLUDED_PREFIXES = ['tests/', 'node_modules/', '.changeset/', 'docs/'];

  test('every committed JSON with a semver top-level version is registered or explicitly allowed', (t) => {
    // Enumerate committed JSON files via git (no pathspec to avoid recursion quirks;
    // filter to .json in JS instead).
    let lines;
    try {
      const out = execFileSync('git', ['ls-files'], { cwd: ROOT });
      lines = out.toString().split('\n').filter((f) => f.endsWith('.json'));
    } catch (err) {
      t.skip('git unavailable: ' + err.message);
      return;
    }

    for (const rel of lines) {
      if (ALLOWED.has(rel)) continue;
      if (EXCLUDED_PREFIXES.some(prefix => rel.startsWith(prefix))) continue;

      const abs = path.join(ROOT, rel);
      let parsed;
      try {
        parsed = JSON.parse(fs.readFileSync(abs, 'utf8'));
      } catch (_) {
        continue; // skip invalid JSON (shouldn't exist, but be safe)
      }

      if (
        parsed &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        typeof parsed.version === 'string' &&
        SEMVER.test(parsed.version)
      ) {
        assert.ok(
          ALLOWED.has(rel),
          `${rel} has a semver top-level "version" but is not registered in ` +
          'scripts/sync-manifest-versions.cjs VERSIONED_MANIFESTS (nor an npm-managed file). ' +
          "Register it so 'npm version' keeps it in sync (issue #844)."
        );
      }
    }
  });
});

// ─── E: stageManifests in a non-git dir must not throw ───────────────────────
describe('E: stageManifests — non-git dir is a no-op, not a throw', () => {

  test('stageManifests({root}) with a non-git tempdir warns and returns without throwing', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-844-nogit-'));
    try {
      // Write a minimal package.json so getPackageVersion doesn't error if called
      fs.writeFileSync(
        path.join(tmpRoot, 'package.json'),
        JSON.stringify({ name: 'x', version: '0.0.0' }, null, 2) + '\n'
      );
      // Must not throw even though tmpRoot is not a git repo
      assert.doesNotThrow(() => {
        stageManifests({ root: tmpRoot });
      }, 'stageManifests must not throw outside a git work tree');
    } finally {
      helpers.cleanup(tmpRoot);
    }
  });
});

// ─── D: CLI --check exits 0 when in sync ─────────────────────────────────────
describe('D: CLI --check exits 0 when manifests are in sync', () => {

  test('node scripts/sync-manifest-versions.cjs --check exits 0', () => {
    // Will throw if exit code != 0
    execFileSync(
      process.execPath,
      [path.join(ROOT, 'scripts', 'sync-manifest-versions.cjs'), '--check'],
      { cwd: ROOT }
    );
  });
});
