'use strict';

/**
 * Characterization tests for the canonical GSD artifact registry.
 * Locks the exact membership of CANONICAL_EXACT, the CANONICAL_PATTERNS
 * shape, and the isCanonicalPlanningFile predicate.
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  CANONICAL_EXACT,
  CANONICAL_PATTERNS,
  isCanonicalPlanningFile,
} = require('../gsd-core/bin/lib/artifacts.cjs');

describe('CANONICAL_EXACT', () => {
  test('is a Set', () => {
    assert.ok(CANONICAL_EXACT instanceof Set);
  });

  test('contains all expected canonical files', () => {
    const expected = [
      'PROJECT.md', 'ROADMAP.md', 'STATE.md', 'REQUIREMENTS.md',
      'MILESTONES.md', 'BACKLOG.md', 'LEARNINGS.md', 'THREADS.md',
      'config.json', 'CLAUDE.md', 'RETROSPECTIVE.md',
    ];
    for (const name of expected) {
      assert.ok(CANONICAL_EXACT.has(name), `expected ${name} in CANONICAL_EXACT`);
    }
  });
});

describe('CANONICAL_PATTERNS', () => {
  test('is an Array of RegExp', () => {
    assert.ok(Array.isArray(CANONICAL_PATTERNS));
    for (const p of CANONICAL_PATTERNS) {
      assert.ok(p instanceof RegExp);
    }
  });

  test('matches milestone audit doc pattern', () => {
    assert.ok(CANONICAL_PATTERNS.some((p) => p.test('v1.2.3-MILESTONE-AUDIT.md')));
    assert.ok(CANONICAL_PATTERNS.some((p) => p.test('v1.2-MILESTONE-AUDIT.md')));
  });

  test('matches version-stamped planning docs', () => {
    assert.ok(CANONICAL_PATTERNS.some((p) => p.test('v2.0.0-release-plan.md')));
  });
});

describe('isCanonicalPlanningFile', () => {
  test('returns true for exact match STATE.md', () => {
    assert.strictEqual(isCanonicalPlanningFile('STATE.md'), true);
  });

  test('returns true for exact match config.json', () => {
    assert.strictEqual(isCanonicalPlanningFile('config.json'), true);
  });

  test('returns false for unrecognized file', () => {
    assert.strictEqual(isCanonicalPlanningFile('random-file.md'), false);
  });

  test('returns false for empty string', () => {
    assert.strictEqual(isCanonicalPlanningFile(''), false);
  });

  test('returns true for version-stamped milestone audit doc', () => {
    assert.strictEqual(isCanonicalPlanningFile('v1.50.0-MILESTONE-AUDIT.md'), true);
  });

  test('returns true for other version-stamped planning docs', () => {
    assert.strictEqual(isCanonicalPlanningFile('v2.0.0-plan.md'), true);
  });

  test('returns false for partial match (wrong case)', () => {
    assert.strictEqual(isCanonicalPlanningFile('state.md'), false);
  });
});
