'use strict';

/**
 * `src/pr-branch-patterns.cts` (compiled `gsd-core/bin/lib/pr-branch-patterns.cjs`)
 * — the canonical `.planning/` path-classification regex/list sources
 * mirrored verbatim into `gsd-core/workflows/pr-branch.md` (ADR-4910 §8,
 * #4605, #4606). These are bash regex STRINGS; this file constructs real
 * `RegExp` objects from the exported source strings and tests them against
 * path strings directly in JS, validating the regex source itself
 * independent of the shell.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  TRANSIENT_DIRS_SRC,
  STRUCTURAL_RE_SRC,
  MILESTONE_PHASES_RE_SRC,
} = require('../gsd-core/bin/lib/pr-branch-patterns.cjs');

describe('src/pr-branch-patterns.cts', () => {
  test('TRANSIENT_DIRS_SRC lists the 9 known transient dirs, space-separated', () => {
    const dirs = TRANSIENT_DIRS_SRC.split(/\s+/).filter(Boolean);
    assert.strictEqual(dirs.length, 9);
    assert.deepStrictEqual(dirs, [
      'phases', 'quick', 'research', 'threads', 'todos', 'debug', 'seeds', 'codebase', 'ui-reviews',
    ]);
  });

  describe('STRUCTURAL_RE_SRC', () => {
    const structuralRe = new RegExp(STRUCTURAL_RE_SRC); // allow-adhoc-regex-escape: runtime-contract-is-the-product

    test('.planning/ROADMAP.md matches (top-level structural file)', () => {
      assert.ok(structuralRe.test('.planning/ROADMAP.md'));
    });

    for (const name of ['STATE', 'ROADMAP', 'MILESTONES', 'PROJECT', 'REQUIREMENTS']) {
      test(`.planning/${name}.md matches`, () => {
        assert.ok(structuralRe.test(`.planning/${name}.md`));
      });
    }

    test('.planning/milestones/v1.0-ROADMAP.md matches (file directly under milestones/)', () => {
      assert.ok(structuralRe.test('.planning/milestones/v1.0-ROADMAP.md'));
    });

    test('#4605: .planning/milestones/v1.0-phases/03-live/PLAN.md does NOT match — falls to MILESTONE_PHASES_RE', () => {
      assert.strictEqual(structuralRe.test('.planning/milestones/v1.0-phases/03-live/PLAN.md'), false);
    });

    test('.planning/STATEX.md does NOT match (anchor boundary)', () => {
      assert.strictEqual(structuralRe.test('.planning/STATEX.md'), false);
    });

    test('.planning/STATE.md.bak does NOT match (anchor boundary)', () => {
      assert.strictEqual(structuralRe.test('.planning/STATE.md.bak'), false);
    });
  });

  describe('MILESTONE_PHASES_RE_SRC', () => {
    const milestonePhasesRe = new RegExp(MILESTONE_PHASES_RE_SRC); // allow-adhoc-regex-escape: runtime-contract-is-the-product

    test('#4605: .planning/milestones/v1.0-phases/03-live/PLAN.md matches', () => {
      assert.ok(milestonePhasesRe.test('.planning/milestones/v1.0-phases/03-live/PLAN.md'));
    });

    test('.planning/milestones/v1.0-phases/ (bare directory path) matches', () => {
      assert.ok(milestonePhasesRe.test('.planning/milestones/v1.0-phases/'));
    });

    test('a milestone slug containing a space still matches (shape, not literal path)', () => {
      assert.ok(milestonePhasesRe.test('.planning/milestones/My Milestone-phases/PLAN.md'));
    });

    test('.planning/milestones/v1.0-ROADMAP.md (a FILE, not a -phases dir) does NOT match', () => {
      assert.strictEqual(milestonePhasesRe.test('.planning/milestones/v1.0-ROADMAP.md'), false);
    });
  });

  test('STRUCTURAL_RE_SRC and MILESTONE_PHASES_RE_SRC together classify the full milestones/ shape with no gap', () => {
    const structuralRe = new RegExp(STRUCTURAL_RE_SRC); // allow-adhoc-regex-escape: runtime-contract-is-the-product
    const milestonePhasesRe = new RegExp(MILESTONE_PHASES_RE_SRC); // allow-adhoc-regex-escape: runtime-contract-is-the-product
    const cases = [
      ['.planning/milestones/v1.0-ROADMAP.md', true, false],
      ['.planning/milestones/v1.0-phases/03-live/PLAN.md', false, true],
    ];
    for (const [p, expectStructural, expectPhases] of cases) {
      assert.strictEqual(structuralRe.test(p), expectStructural, `${p} structural mismatch`);
      assert.strictEqual(milestonePhasesRe.test(p), expectPhases, `${p} milestone-phases mismatch`);
    }
  });
});
