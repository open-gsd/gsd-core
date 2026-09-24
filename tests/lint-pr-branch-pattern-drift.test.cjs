'use strict';

/**
 * `scripts/lint-pr-branch-pattern-drift.cjs` — asserts the drift guard both
 * PASSES against the real shipped `gsd-core/workflows/pr-branch.md` (built
 * from the canonical `src/pr-branch-patterns.cts` seam) and FAILS when a
 * markdown mirror diverges from the canonical value (ADR-4910 §8, #4605,
 * #4606).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  findPrBranchPatternDrift, scanRepo, buildAssignment, PATTERN_VARS, WORKFLOW_REL_PATH,
} = require('../scripts/lint-pr-branch-pattern-drift.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');

const CANONICAL_PATTERNS = {
  TRANSIENT_DIRS_SRC: 'phases quick research threads todos debug seeds codebase ui-reviews',
  STRUCTURAL_RE_SRC: '^\\.planning/(STATE|ROADMAP|MILESTONES|PROJECT|REQUIREMENTS)\\.md$|^\\.planning/milestones/[^/]+\\.md$',
  MILESTONE_PHASES_RE_SRC: '^\\.planning/milestones/[^/]+-phases/',
};

function fakeReadFile(files) {
  return (relPath) => (Object.prototype.hasOwnProperty.call(files, relPath) ? files[relPath] : null);
}

describe('lint-pr-branch-pattern-drift', () => {
  test('buildAssignment renders the exact NAME="value" bash form', () => {
    assert.strictEqual(buildAssignment('STRUCTURAL_RE', 'a|b'), 'STRUCTURAL_RE="a|b"');
  });

  test('PATTERN_VARS maps every canonical constant to its bash mirror name', () => {
    assert.deepStrictEqual(PATTERN_VARS, {
      TRANSIENT_DIRS_SRC: 'TRANSIENT_DIRS',
      STRUCTURAL_RE_SRC: 'STRUCTURAL_RE',
      MILESTONE_PHASES_RE_SRC: 'MILESTONE_PHASES_RE',
    });
  });

  test('PASS: an in-memory fixture that mirrors every constant verbatim reports no drift', () => {
    const fixtureText = [
      'TRANSIENT_DIRS="phases quick research threads todos debug seeds codebase ui-reviews"',
      'STRUCTURAL_RE="^\\.planning/(STATE|ROADMAP|MILESTONES|PROJECT|REQUIREMENTS)\\.md$|^\\.planning/milestones/[^/]+\\.md$"',
      'MILESTONE_PHASES_RE="^\\.planning/milestones/[^/]+-phases/"',
    ].join('\n');
    const violations = findPrBranchPatternDrift(
      CANONICAL_PATTERNS,
      fakeReadFile({ [WORKFLOW_REL_PATH]: fixtureText }),
    );
    assert.deepStrictEqual(violations, []);
  });

  test('FAIL: a fixture whose STRUCTURAL_RE literal diverges from the canonical value is reported', () => {
    const fixtureText = [
      'TRANSIENT_DIRS="phases quick research threads todos debug seeds codebase ui-reviews"',
      // Missing the #4605 fix: unanchored milestones alternative.
      'STRUCTURAL_RE="^\\.planning/(STATE|ROADMAP|MILESTONES|PROJECT|REQUIREMENTS)\\.md$|^\\.planning/milestones/"',
      'MILESTONE_PHASES_RE="^\\.planning/milestones/[^/]+-phases/"',
    ].join('\n');
    const violations = findPrBranchPatternDrift(
      CANONICAL_PATTERNS,
      fakeReadFile({ [WORKFLOW_REL_PATH]: fixtureText }),
    );
    assert.strictEqual(violations.length, 1);
    assert.strictEqual(violations[0].constName, 'STRUCTURAL_RE_SRC');
    assert.strictEqual(violations[0].bashVar, 'STRUCTURAL_RE');
    assert.match(violations[0].reason, /not found verbatim/);
  });

  test('FAIL: a fixture missing MILESTONE_PHASES_RE entirely is reported for that constant only', () => {
    const fixtureText = [
      'TRANSIENT_DIRS="phases quick research threads todos debug seeds codebase ui-reviews"',
      'STRUCTURAL_RE="^\\.planning/(STATE|ROADMAP|MILESTONES|PROJECT|REQUIREMENTS)\\.md$|^\\.planning/milestones/[^/]+\\.md$"',
    ].join('\n');
    const violations = findPrBranchPatternDrift(
      CANONICAL_PATTERNS,
      fakeReadFile({ [WORKFLOW_REL_PATH]: fixtureText }),
    );
    assert.strictEqual(violations.length, 1);
    assert.strictEqual(violations[0].constName, 'MILESTONE_PHASES_RE_SRC');
  });

  test('FAIL: workflow file missing/unreadable is reported for every constant', () => {
    const violations = findPrBranchPatternDrift(CANONICAL_PATTERNS, fakeReadFile({}));
    assert.strictEqual(violations.length, 3);
    for (const v of violations) {
      assert.strictEqual(v.reason, 'source file not found or unreadable');
    }
  });

  test('FAIL: a seam missing a constant is reported without needing the workflow file', () => {
    const violations = findPrBranchPatternDrift({}, fakeReadFile({}));
    assert.strictEqual(violations.length, 3);
    for (const v of violations) {
      assert.match(v.reason, /missing or not a string/);
    }
  });

  test('PASS: scanRepo finds zero drift against the real shipped pr-branch.md (npm run build:lib must have run)', () => {
    const violations = scanRepo(REPO_ROOT);
    assert.deepStrictEqual(violations, [], `unexpected drift: ${JSON.stringify(violations)}`);
  });
});
