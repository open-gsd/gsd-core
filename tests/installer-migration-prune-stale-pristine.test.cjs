'use strict';

/**
 * TDD tests for installer migration 004:
 * 2026-06-09-prune-stale-pristine-get-shit-done  // gsd-allow-legacy-name
 *
 * Verifies plan() logic for:
 * 1. Stale pristine subdir absent -> empty plan (idempotency)
 * 2. Stale pristine subdir present -> remove-managed actions emitted for each file
 * 3. Stale pristine root is a symlink -> empty plan (symlink safety)
 * 4. Symlinked entry inside stale pristine dir is NOT emitted
 * 5. Mixed files: all get remove-managed (no user-file classification needed)
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Load compiled module (build:lib compiles src/*.cts -> gsd-core/bin/lib/*.cjs)
const migration = require('../gsd-core/bin/lib/installer-migrations/004-prune-stale-pristine-get-shit-done.cjs');

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-migration-004-test-'));
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
      version: '1.3.0',
      timestamp: '2026-06-01T00:00:00.000Z',
      mode: 'full',
      files,
    }, null, 2),
    'utf8'
  );
}

// Build a plan context using the real installer-migrations classifyArtifact.
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

describe('migration 004 metadata', () => {
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
    assert.ok(migration.id.startsWith('2026-06-09-'), `id should start with date prefix, got: ${migration.id}`);
  });

  test('id references prune-stale-pristine', () => {
    assert.ok(
      migration.id.includes('prune-stale-pristine') || migration.id.includes('pristine'),
      `id should reference pristine pruning, got: ${migration.id}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Case 1: stale pristine subdir absent -> empty plan
// ---------------------------------------------------------------------------

describe('plan() — stale pristine subdir absent', () => {
  test('returns empty array when gsd-pristine/get-shit-done/ does not exist', () => { // gsd-allow-legacy-name
    const configDir = createTempDir();
    try {
      // Only gsd-pristine/gsd-core/ exists — no legacy subdir.
      writeFile(configDir, 'gsd-pristine/gsd-core/workflows/plan.md', 'pristine snapshot\n');
      writeManifest(configDir, {});

      const actions = migration.plan(makePlanCtx(configDir));
      assert.deepEqual(actions, []);
    } finally {
      cleanup(configDir);
    }
  });

  test('returns empty array when gsd-pristine/ does not exist at all', () => {
    const configDir = createTempDir();
    try {
      writeManifest(configDir, {});
      const actions = migration.plan(makePlanCtx(configDir));
      assert.deepEqual(actions, []);
    } finally {
      cleanup(configDir);
    }
  });
});

// ---------------------------------------------------------------------------
// Case 2: stale pristine subdir present -> remove-managed for each file
// ---------------------------------------------------------------------------

describe('plan() — stale pristine files present', () => {
  test('emits remove-managed for each file under gsd-pristine/get-shit-done/', () => { // gsd-allow-legacy-name
    const configDir = createTempDir();
    try {
      writeFile(configDir, 'gsd-pristine/get-shit-done/workflows/plan.md', 'old pristine\n'); // gsd-allow-legacy-name
      writeFile(configDir, 'gsd-pristine/get-shit-done/skills/gsd-foo/SKILL.md', 'old skill\n'); // gsd-allow-legacy-name
      writeManifest(configDir, {});

      const actions = migration.plan(makePlanCtx(configDir));
      assert.equal(actions.length, 2, `expected 2 actions, got ${actions.length}`);
      for (const action of actions) {
        assert.equal(action.type, 'remove-managed', `expected remove-managed, got ${action.type}`);
        assert.ok(
          action.relPath.replace(/\\/g, '/').startsWith('gsd-pristine/get-shit-done/'), // gsd-allow-legacy-name
          `relPath should start with gsd-pristine/get-shit-done/, got: ${action.relPath}`, // gsd-allow-legacy-name
        );
        assert.equal(typeof action.reason, 'string');
        assert.ok(action.reason.length > 0, 'reason must not be empty');
        assert.equal(typeof action.ownershipEvidence, 'string');
        assert.ok(action.ownershipEvidence.length > 0, 'ownershipEvidence must not be empty');
      }
    } finally {
      cleanup(configDir);
    }
  });

  test('emits exactly one remove-managed per file (correct relPaths)', () => {
    const configDir = createTempDir();
    try {
      writeFile(configDir, 'gsd-pristine/get-shit-done/workflows/execute-phase.md', 'pristine\n'); // gsd-allow-legacy-name
      writeManifest(configDir, {});

      const actions = migration.plan(makePlanCtx(configDir));
      assert.equal(actions.length, 1);
      const relPathNorm = actions[0].relPath.replace(/\\/g, '/');
      assert.equal(relPathNorm, 'gsd-pristine/get-shit-done/workflows/execute-phase.md'); // gsd-allow-legacy-name
    } finally {
      cleanup(configDir);
    }
  });

  test('actions include classification override to managed-pristine', () => {
    const configDir = createTempDir();
    try {
      writeFile(configDir, 'gsd-pristine/get-shit-done/workflows/plan.md', 'pristine snapshot\n'); // gsd-allow-legacy-name
      writeManifest(configDir, {});

      const actions = migration.plan(makePlanCtx(configDir));
      assert.equal(actions.length, 1);
      // The action must carry classification:'managed-pristine' so the framework
      // does not downgrade remove-managed to preserve-user (the file is not in
      // the manifest so classify() would return 'unknown').
      assert.equal(actions[0].classification, 'managed-pristine',
        'action must carry classification:managed-pristine override');
    } finally {
      cleanup(configDir);
    }
  });
});

// ---------------------------------------------------------------------------
// Case 3: stale pristine root is a symlink -> plan returns [] (symlink safety)
// ---------------------------------------------------------------------------

describe('plan() — stale pristine root is a symlink', () => {
  test('returns empty array when gsd-pristine/get-shit-done/ is a symlink', () => { // gsd-allow-legacy-name
    const configDir = createTempDir();
    const externalDir = createTempDir();
    try {
      writeFile(externalDir, 'workflows/plan.md', 'pristine content\n');
      // Create gsd-pristine/ as a real dir but make get-shit-done/ a symlink.
      fs.mkdirSync(path.join(configDir, 'gsd-pristine'), { recursive: true });
      const legacyLink = path.join(configDir, 'gsd-pristine', 'get-shit-done'); // gsd-allow-legacy-name
      fs.symlinkSync(externalDir, legacyLink);
      writeManifest(configDir, {});

      const actions = migration.plan(makePlanCtx(configDir));
      assert.deepEqual(actions, [], 'plan() must return [] when stale pristine root is a symlink');
    } finally {
      cleanup(configDir);
      cleanup(externalDir);
    }
  });
});

// ---------------------------------------------------------------------------
// Case 4: symlinked entry inside stale pristine dir is skipped
// ---------------------------------------------------------------------------

describe('plan() — symlinked entry inside stale pristine dir is skipped', () => {
  test('symlinked file inside stale pristine dir is not included in plan actions', () => {
    const configDir = createTempDir();
    const externalTarget = createTempDir();
    try {
      // A real file inside gsd-pristine/get-shit-done/
      writeFile(configDir, 'gsd-pristine/get-shit-done/workflows/plan.md', 'real pristine\n'); // gsd-allow-legacy-name

      // A symlink inside the same dir pointing to external target.
      const externalFile = path.join(externalTarget, 'external.md');
      fs.writeFileSync(externalFile, 'external content\n', 'utf8');
      const symlinkPath = path.join(configDir, 'gsd-pristine', 'get-shit-done', 'workflows', 'symlinked.md'); // gsd-allow-legacy-name
      fs.symlinkSync(externalFile, symlinkPath);

      writeManifest(configDir, {});

      const actions = migration.plan(makePlanCtx(configDir));

      // Only the real file should appear; the symlinked entry must be skipped.
      assert.equal(actions.length, 1, `expected 1 action (real file only), got ${actions.length}`);
      const hasSymlinked = actions.some((a) => a.relPath.includes('symlinked'));
      assert.equal(hasSymlinked, false, 'symlinked entry must not appear in plan actions');
    } finally {
      cleanup(configDir);
      cleanup(externalTarget);
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: plan goes through planInstallerMigrations + applyInstallerMigrationPlan
// Files are actually removed from disk.
// ---------------------------------------------------------------------------

describe('plan() — integration: stale pristine files are removed', () => {
  test('stale gsd-pristine/get-shit-done/ file is removed after apply', () => { // gsd-allow-legacy-name
    const configDir = createTempDir();
    try {
      const fileContent = 'old pristine snapshot content written by gsd installer\n';
      writeFile(configDir, 'gsd-pristine/get-shit-done/workflows/plan.md', fileContent); // gsd-allow-legacy-name
      writeManifest(configDir, {});

      const { planInstallerMigrations, applyInstallerMigrationPlan } = require('../gsd-core/bin/lib/installer-migrations.cjs');
      const plan = planInstallerMigrations({
        configDir,
        migrations: [migration],
        scope: 'global',
      });

      assert.equal(plan.blocked.length, 0, `expected no blocked actions; got ${JSON.stringify(plan.blocked)}`);
      applyInstallerMigrationPlan({ configDir, plan });

      // File must be gone after apply.
      const stillThere = fs.existsSync(path.join(configDir, 'gsd-pristine', 'get-shit-done', 'workflows', 'plan.md')); // gsd-allow-legacy-name
      assert.equal(stillThere, false, 'stale pristine file must be removed after apply');
    } finally {
      cleanup(configDir);
    }
  });
});
