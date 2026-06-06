'use strict';

/**
 * TDD tests for installer migration 003:
 * 2026-06-02-rename-get-shit-done-to-gsd-core  // gsd-allow-legacy-name
 *
 * Verifies plan() logic for:
 * 1. Legacy dir absent -> empty plan (idempotency)
 * 2. gsd-core absent + legacy has managed files -> remove-managed actions emitted
 *    (real first-upgrade scenario: migrations run before new runtime materializes)
 * 3. managed-pristine legacy files -> remove-managed actions
 * 4. managed-modified legacy files -> backup-and-remove actions
 * 5. unknown user file under legacy dir -> baseline-preserve-user (NOT removed)
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// Load compiled module (build:lib compiles src/*.cts -> gsd-core/bin/lib/*.cjs)
const migration = require('../gsd-core/bin/lib/installer-migrations/003-rename-get-shit-done-to-gsd-core.cjs');

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-migration-003-test-'));
}

function cleanup(dir) {
  // eslint-disable-next-line local/no-raw-rmsync-in-tests -- local cleanup in migration test; no helpers import available
  fs.rmSync(dir, { recursive: true, force: true });
}

function writeFile(root, relPath, content) {
  const fullPath = path.join(root, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
}

function writeManifest(root, files) {
  fs.writeFileSync(
    path.join(root, 'gsd-file-manifest.json'),
    JSON.stringify({
      version: '1.49.0',
      timestamp: '2026-05-10T00:00:00.000Z',
      mode: 'full',
      files,
    }, null, 2),
    'utf8'
  );
}

// Build a plan context using the real installer-migrations classifyArtifact,
// so tests exercise the actual manifest-based ownership check.
const {
  classifyArtifact: realClassifyArtifact,
  readInstallManifest,
} = require('../gsd-core/bin/lib/installer-migrations.cjs');

function makePlanCtx(configDir) {
  const manifest = readInstallManifest(configDir);
  return {
    configDir,
    classifyArtifact: (relPath) => realClassifyArtifact(configDir, relPath, manifest),
  };
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

describe('migration metadata', () => {
  test('exports a single migration object with required fields', () => {
    assert.equal(typeof migration, 'object');
    assert.equal(typeof migration.id, 'string');
    assert.ok(migration.id.length > 0, 'id must be non-empty');
    assert.equal(typeof migration.title, 'string');
    assert.equal(typeof migration.description, 'string');
    assert.equal(typeof migration.introducedIn, 'string');
    assert.ok(Array.isArray(migration.scopes), 'scopes must be an array');
    assert.ok(migration.scopes.includes('global'), 'scopes must include global');
    assert.ok(migration.scopes.includes('local'), 'scopes must include local');
    assert.strictEqual(migration.destructive, true);
    assert.equal(typeof migration.plan, 'function');
  });

  test('id contains expected date prefix', () => {
    assert.ok(migration.id.startsWith('2026-06-02-'), `id should start with date prefix, got: ${migration.id}`);
  });
});

// ---------------------------------------------------------------------------
// Case 1: legacy dir absent -> empty plan
// ---------------------------------------------------------------------------

describe('plan() — legacy dir absent', () => {
  test('returns empty array when legacy dir does not exist', () => {
    const configDir = createTempDir();
    try {
      // Create gsd-core/ but NOT legacy dir
      fs.mkdirSync(path.join(configDir, 'gsd-core'), { recursive: true });
      writeManifest(configDir, {});

      const actions = migration.plan(makePlanCtx(configDir));
      assert.deepEqual(actions, []);
    } finally {
      cleanup(configDir);
    }
  });
});

// ---------------------------------------------------------------------------
// Case 2: gsd-core absent + legacy has managed files -> remove-managed emitted
// (first-upgrade scenario: migrations run BEFORE new runtime is materialized)
// ---------------------------------------------------------------------------

describe('plan() — gsd-core not yet present (pre-materialization)', () => {
  test('emits remove-managed actions even when gsd-core/ does not yet exist', () => {
    const configDir = createTempDir();
    try {
      // Real first-upgrade: legacy dir exists, managed files are there,
      // but gsd-core/ has NOT been materialized yet.
      const fileContent = 'managed workflow\n';
      writeFile(configDir, 'get-shit-done/workflows/plan.md', fileContent); // gsd-allow-legacy-name
      writeManifest(configDir, {
        'get-shit-done/workflows/plan.md': sha256(fileContent), // gsd-allow-legacy-name
      });
      // Deliberately do NOT create gsd-core/

      const actions = migration.plan(makePlanCtx(configDir));
      assert.equal(actions.length, 1);
      assert.equal(actions[0].type, 'remove-managed');
      assert.equal(actions[0].relPath, 'get-shit-done/workflows/plan.md'); // gsd-allow-legacy-name
    } finally {
      cleanup(configDir);
    }
  });
});

// ---------------------------------------------------------------------------
// Case 3: managed-pristine legacy files -> remove-managed
// ---------------------------------------------------------------------------

describe('plan() — managed-pristine files', () => {
  test('returns remove-managed action for each managed-pristine legacy file', () => {
    const configDir = createTempDir();
    try {
      const fileA = 'managed workflow A\n';
      const fileB = 'managed workflow B\n';
      writeFile(configDir, 'get-shit-done/workflows/plan.md', fileA); // gsd-allow-legacy-name
      writeFile(configDir, 'get-shit-done/skills/gsd-foo/SKILL.md', fileB); // gsd-allow-legacy-name
      // Do NOT pre-create gsd-core/ — reflects real pre-materialization timing
      writeManifest(configDir, {
        'get-shit-done/workflows/plan.md': sha256(fileA), // gsd-allow-legacy-name
        'get-shit-done/skills/gsd-foo/SKILL.md': sha256(fileB), // gsd-allow-legacy-name
      });

      const actions = migration.plan(makePlanCtx(configDir));
      assert.equal(actions.length, 2);
      for (const action of actions) {
        assert.equal(action.type, 'remove-managed');
        assert.ok(action.relPath.startsWith('get-shit-done/'), `relPath should start with legacy prefix, got: ${action.relPath}`); // gsd-allow-legacy-name
        assert.equal(typeof action.reason, 'string');
        assert.ok(action.reason.length > 0);
        assert.equal(typeof action.ownershipEvidence, 'string');
        assert.ok(action.ownershipEvidence.length > 0);
      }
    } finally {
      cleanup(configDir);
    }
  });

  test('relPaths match the legacy files on disk', () => {
    const configDir = createTempDir();
    try {
      const fileContent = 'managed content\n';
      writeFile(configDir, 'get-shit-done/workflows/plan.md', fileContent); // gsd-allow-legacy-name
      // Do NOT pre-create gsd-core/ — reflects real pre-materialization timing
      writeManifest(configDir, {
        'get-shit-done/workflows/plan.md': sha256(fileContent), // gsd-allow-legacy-name
      });

      const actions = migration.plan(makePlanCtx(configDir));
      assert.equal(actions.length, 1);
      assert.equal(actions[0].relPath, 'get-shit-done/workflows/plan.md'); // gsd-allow-legacy-name
    } finally {
      cleanup(configDir);
    }
  });
});

// ---------------------------------------------------------------------------
// Case 4: managed-modified -> backup-and-remove
// ---------------------------------------------------------------------------

describe('plan() — managed-modified files', () => {
  test('returns backup-and-remove action for managed-modified legacy file', () => {
    const configDir = createTempDir();
    try {
      const originalContent = 'original managed content\n';
      const modifiedContent = 'user-modified content\n';
      // Write with modified content (hash mismatch)
      writeFile(configDir, 'get-shit-done/workflows/plan.md', modifiedContent); // gsd-allow-legacy-name
      // Do NOT pre-create gsd-core/ — reflects real pre-materialization timing
      writeManifest(configDir, {
        // manifest records the original hash, but file has been modified
        'get-shit-done/workflows/plan.md': sha256(originalContent), // gsd-allow-legacy-name
      });

      const actions = migration.plan(makePlanCtx(configDir));
      assert.equal(actions.length, 1);
      assert.equal(actions[0].type, 'backup-and-remove');
      assert.equal(actions[0].relPath, 'get-shit-done/workflows/plan.md'); // gsd-allow-legacy-name
      assert.equal(typeof actions[0].reason, 'string');
      assert.equal(typeof actions[0].ownershipEvidence, 'string');
    } finally {
      cleanup(configDir);
    }
  });
});

// ---------------------------------------------------------------------------
// Case 5: unknown user file -> baseline-preserve-user (NOT removed)
// ---------------------------------------------------------------------------

describe('plan() — unknown user file', () => {
  test('returns baseline-preserve-user for unknown file (not in manifest)', () => {
    const configDir = createTempDir();
    try {
      writeFile(configDir, 'get-shit-done/my-custom-file.md', 'user content\n'); // gsd-allow-legacy-name
      // Do NOT pre-create gsd-core/ — reflects real pre-materialization timing
      // Manifest is empty — this file is not managed
      writeManifest(configDir, {});

      const actions = migration.plan(makePlanCtx(configDir));
      assert.equal(actions.length, 1);
      assert.equal(actions[0].type, 'baseline-preserve-user');
      assert.equal(actions[0].relPath, 'get-shit-done/my-custom-file.md'); // gsd-allow-legacy-name
    } finally {
      cleanup(configDir);
    }
  });

  test('unknown user file under legacy dir is NOT removed by migration', () => {
    const configDir = createTempDir();
    try {
      const userContent = 'precious user content\n';
      writeFile(configDir, 'get-shit-done/my-custom-file.md', userContent); // gsd-allow-legacy-name
      // Do NOT pre-create gsd-core/ — reflects real pre-materialization timing
      writeManifest(configDir, {});

      const { planInstallerMigrations, applyInstallerMigrationPlan } = require('../gsd-core/bin/lib/installer-migrations.cjs');
      const plan = planInstallerMigrations({
        configDir,
        migrations: [migration],
        scope: 'global',
      });

      // baseline-preserve-user actions should NOT be blocked
      assert.equal(plan.blocked.length, 0);
      applyInstallerMigrationPlan({ configDir, plan });

      // File must still exist after apply
      const stillThere = fs.readFileSync(path.join(configDir, 'get-shit-done/my-custom-file.md'), 'utf8'); // gsd-allow-legacy-name
      assert.equal(stillThere, userContent);
    } finally {
      cleanup(configDir);
    }
  });
});

// ---------------------------------------------------------------------------
// Case 6: legacy root is a symlink -> plan returns [] (no destructive actions)
// ---------------------------------------------------------------------------

describe('plan() — legacy root is a symlink', () => {
  test('returns empty array when legacy root is a symlink (symlink safety)', () => {
    const configDir = createTempDir();
    const externalDir = createTempDir();
    try {
      // Create a real external dir with a managed file, but expose it as a symlink
      // at the legacy root path inside configDir.
      writeFile(externalDir, 'workflows/plan.md', 'managed workflow\n');
      const legacyLink = path.join(configDir, 'get-shit-done'); // gsd-allow-legacy-name
      fs.symlinkSync(externalDir, legacyLink);
      writeManifest(configDir, {});

      const actions = migration.plan(makePlanCtx(configDir));
      assert.deepEqual(actions, [], 'plan() must return [] when legacy root is a symlink');
    } finally {
      cleanup(configDir);
      cleanup(externalDir);
    }
  });
});

// ---------------------------------------------------------------------------
// Case 7: symlinked entry inside legacy dir is NOT emitted for removal
// ---------------------------------------------------------------------------

describe('plan() — symlinked entry inside legacy dir is skipped', () => {
  test('symlinked file inside legacy dir is not included in plan actions', () => {
    const configDir = createTempDir();
    const externalTarget = createTempDir();
    try {
      // Set up the legacy dir as a real directory (not symlinked).
      const legacyDir = path.join(configDir, 'get-shit-done'); // gsd-allow-legacy-name
      fs.mkdirSync(legacyDir, { recursive: true });

      // Add a real managed file.
      const realContent = 'real managed file\n';
      writeFile(configDir, 'get-shit-done/real.md', realContent); // gsd-allow-legacy-name

      // Add a symlink to an external target inside the legacy dir.
      const externalFile = path.join(externalTarget, 'external.md');
      fs.writeFileSync(externalFile, 'external content\n', 'utf8');
      fs.symlinkSync(externalFile, path.join(legacyDir, 'symlinked.md'));

      writeManifest(configDir, {
        'get-shit-done/real.md': sha256(realContent), // gsd-allow-legacy-name
        'get-shit-done/symlinked.md': sha256('external content\n'), // gsd-allow-legacy-name
      });

      const actions = migration.plan(makePlanCtx(configDir));

      // Only the real file should appear; the symlinked entry must be skipped.
      assert.equal(actions.length, 1, `expected 1 action (for real.md only), got ${actions.length}`);
      assert.equal(actions[0].relPath, 'get-shit-done/real.md'); // gsd-allow-legacy-name
      const hasSymlinked = actions.some((a) => a.relPath.includes('symlinked'));
      assert.equal(hasSymlinked, false, 'symlinked entry must not appear in plan actions');
    } finally {
      cleanup(configDir);
      cleanup(externalTarget);
    }
  });
});

// ---------------------------------------------------------------------------
// Mixed: multiple classification types in one plan
// ---------------------------------------------------------------------------

describe('plan() — mixed classifications', () => {
  test('handles pristine, modified, and unknown files together', () => {
    const configDir = createTempDir();
    try {
      const pristineContent = 'pristine content\n';
      const originalContent = 'original managed content\n';
      const modifiedContent = 'user-modified content\n';
      const userContent = 'user-added content\n';

      writeFile(configDir, 'get-shit-done/pristine.md', pristineContent); // gsd-allow-legacy-name
      writeFile(configDir, 'get-shit-done/modified.md', modifiedContent); // gsd-allow-legacy-name
      writeFile(configDir, 'get-shit-done/user.md', userContent); // gsd-allow-legacy-name
      // Do NOT pre-create gsd-core/ — reflects real pre-materialization timing
      writeManifest(configDir, {
        'get-shit-done/pristine.md': sha256(pristineContent), // gsd-allow-legacy-name
        'get-shit-done/modified.md': sha256(originalContent), // gsd-allow-legacy-name
      });

      const actions = migration.plan(makePlanCtx(configDir));
      assert.equal(actions.length, 3);

      const byPath = Object.fromEntries(actions.map((a) => [a.relPath, a.type]));
      assert.equal(byPath['get-shit-done/pristine.md'], 'remove-managed'); // gsd-allow-legacy-name
      assert.equal(byPath['get-shit-done/modified.md'], 'backup-and-remove'); // gsd-allow-legacy-name
      assert.equal(byPath['get-shit-done/user.md'], 'baseline-preserve-user'); // gsd-allow-legacy-name
    } finally {
      cleanup(configDir);
    }
  });
});
