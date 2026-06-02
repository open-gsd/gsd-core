'use strict';

/**
 * Characterization tests for the 001-legacy-orphan-files installer migration.
 * Locks the migration metadata shape and plan() logic (managed-pristine and
 * managed-modified classification paths; unmanaged artifacts are skipped).
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const migration = require('../../get-shit-done/bin/lib/installer-migrations/001-legacy-orphan-files.cjs');

describe('migration metadata', () => {
  test('exports a single migration object with required fields', () => {
    assert.equal(typeof migration, 'object');
    assert.equal(migration.id, '2026-05-11-legacy-orphan-files');
    assert.equal(typeof migration.title, 'string');
    assert.equal(typeof migration.description, 'string');
    assert.equal(migration.introducedIn, '1.50.0');
    assert.ok(Array.isArray(migration.scopes));
    assert.ok(migration.scopes.includes('global'));
    assert.ok(migration.scopes.includes('local'));
    assert.strictEqual(migration.destructive, true);
    assert.equal(typeof migration.plan, 'function');
  });
});

describe('migration.plan()', () => {
  function makeClassifier(classification) {
    return { classifyArtifact: () => ({ classification }) };
  }

  test('returns remove-managed action for managed-pristine artifact', () => {
    const actions = migration.plan(makeClassifier('managed-pristine'));
    assert.equal(actions.length, 2); // two files in LEGACY_ORPHAN_FILES
    for (const action of actions) {
      assert.equal(action.type, 'remove-managed');
      assert.equal(typeof action.relPath, 'string');
      assert.equal(typeof action.reason, 'string');
      assert.equal(typeof action.ownershipEvidence, 'string');
    }
  });

  test('returns backup-and-remove action for managed-modified artifact', () => {
    const actions = migration.plan(makeClassifier('managed-modified'));
    assert.equal(actions.length, 2);
    for (const action of actions) {
      assert.equal(action.type, 'backup-and-remove');
    }
  });

  test('returns no actions for unmanaged artifact', () => {
    const actions = migration.plan(makeClassifier('unmanaged'));
    assert.deepStrictEqual(actions, []);
  });

  test('relPaths match the two legacy orphan hook files', () => {
    const actions = migration.plan(makeClassifier('managed-pristine'));
    const relPaths = actions.map((a) => a.relPath).sort();
    assert.deepStrictEqual(relPaths, [
      'hooks/gsd-notify.sh',
      'hooks/statusline.js',
    ]);
  });

  test('plan handles mixed classifications per file', () => {
    let callCount = 0;
    const ctx = {
      classifyArtifact: (_relPath) => {
        callCount++;
        // first call: managed-pristine; second call: unmanaged
        return { classification: callCount === 1 ? 'managed-pristine' : 'unmanaged' };
      },
    };
    const actions = migration.plan(ctx);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].type, 'remove-managed');
  });
});
