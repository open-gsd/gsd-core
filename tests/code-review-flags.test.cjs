/**
 * Characterization tests for code-review-flags module (and the #3727 regression: /gsd-code-review N --fix must
 * dispatch the fixer workflow, not silently no-op).
 *
 * These assertions lock the flag-parsing and workflow-dispatch behaviour used by the /gsd:code-review command.
 * Covers both exports and every quirk documented in the hand-written .cjs (ADR-457 build-at-publish migration).
 * Pure-function assertions on parseCodeReviewFlags / resolveCodeReviewWorkflow are IR-level (not raw-text-match)
 * per CONTRIBUTING.md L554. The structural assertions on the workflow text (the initialize step, the gated
 * dispatch-fix section and its step file) are the `code-review-flags` text contract in
 * scripts/static-checks/text-contracts/.
 */
'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseCodeReviewFlags,
  resolveCodeReviewWorkflow,
} = require('../gsd-core/bin/lib/code-review-flags.cjs');

const DEFAULTS = { fix: false, all: false, auto: false, depth: '', files: '' };

describe('parseCodeReviewFlags', () => {
  test('no flags → all defaults', () => {
    assert.deepStrictEqual(parseCodeReviewFlags([]), DEFAULTS);
  });

  test('--fix sets fix:true and dispatches the fixer (#3727)', () => {
    const flags = parseCodeReviewFlags(['--fix']);
    assert.strictEqual(flags.fix, true);
    assert.strictEqual(flags.all, false);
    assert.strictEqual(flags.auto, false);
    assert.strictEqual(resolveCodeReviewWorkflow(flags), 'code-review-fix.md', '--fix must dispatch to code-review-fix.md');
  });

  test('--all sets all:true and implies fix:true, so it dispatches the fixer', () => {
    const flags = parseCodeReviewFlags(['--all']);
    assert.strictEqual(flags.all, true);
    assert.strictEqual(flags.fix, true);
    assert.strictEqual(flags.auto, false);
    assert.strictEqual(resolveCodeReviewWorkflow(flags), 'code-review-fix.md', '--all must dispatch to code-review-fix.md');
  });

  test('--auto sets auto:true and implies fix:true, so it dispatches the fixer', () => {
    const flags = parseCodeReviewFlags(['--auto']);
    assert.strictEqual(flags.auto, true);
    assert.strictEqual(flags.fix, true);
    assert.strictEqual(flags.all, false);
    assert.strictEqual(resolveCodeReviewWorkflow(flags), 'code-review-fix.md', '--auto must dispatch to code-review-fix.md');
  });

  test('--fix --all --auto all set simultaneously', () => {
    const flags = parseCodeReviewFlags(['1', '--fix', '--all', '--auto']);
    assert.strictEqual(flags.fix, true);
    assert.strictEqual(flags.all, true);
    assert.strictEqual(flags.auto, true);
    assert.strictEqual(resolveCodeReviewWorkflow(flags), 'code-review-fix.md');
  });

  test('--depth=high sets depth', () => {
    const flags = parseCodeReviewFlags(['--depth=high']);
    assert.strictEqual(flags.depth, 'high');
  });

  test('--files=src/foo sets files', () => {
    const flags = parseCodeReviewFlags(['--files=src/foo']);
    assert.strictEqual(flags.files, 'src/foo');
  });

  test('--depth= (empty value) leaves depth as empty string', () => {
    const flags = parseCodeReviewFlags(['--depth=']);
    assert.strictEqual(flags.depth, '');
  });

  test('first positional argument (phase number) is ignored', () => {
    const flags = parseCodeReviewFlags(['2', '--fix']);
    assert.strictEqual(flags.fix, true);
    assert.strictEqual(flags.all, false);
    assert.strictEqual(flags.auto, false);
    assert.strictEqual(flags.depth, '');
    assert.strictEqual(flags.files, '');
    assert.strictEqual(resolveCodeReviewWorkflow(flags), 'code-review-fix.md');
  });

  test('a phase number alone stays review-only: no --fix, no fixer dispatch (#3727 counter-test)', () => {
    const flags = parseCodeReviewFlags(['2']);
    assert.strictEqual(flags.fix, false, 'without --fix, flags.fix must be false');
    assert.strictEqual(resolveCodeReviewWorkflow(flags), 'code-review.md', 'without --fix, dispatch must stay on code-review.md');
  });

  test('unknown flags are silently ignored', () => {
    assert.deepStrictEqual(parseCodeReviewFlags(['--unknown']), DEFAULTS);
  });

  test('--depth is still parsed alongside --fix (no regression)', () => {
    const flags = parseCodeReviewFlags(['2', '--depth=deep', '--fix']);
    assert.strictEqual(flags.fix, true);
    assert.strictEqual(flags.depth, 'deep');
    assert.strictEqual(resolveCodeReviewWorkflow(flags), 'code-review-fix.md');
  });

  test('--files with several paths is still parsed alongside --fix (no regression)', () => {
    const flags = parseCodeReviewFlags(['2', '--files=src/foo.ts,src/bar.ts', '--fix']);
    assert.strictEqual(flags.fix, true);
    assert.strictEqual(flags.files, 'src/foo.ts,src/bar.ts');
  });

  test('combined: positional + --all + --depth + --files', () => {
    const flags = parseCodeReviewFlags(['3', '--all', '--depth=deep', '--files=a.ts']);
    assert.deepStrictEqual(flags, {
      fix: true,
      all: true,
      auto: false,
      depth: 'deep',
      files: 'a.ts',
    });
  });
});

describe('resolveCodeReviewWorkflow', () => {
  test('fix:true → code-review-fix.md', () => {
    assert.strictEqual(
      resolveCodeReviewWorkflow({ fix: true, all: false, auto: false, depth: '', files: '' }),
      'code-review-fix.md',
    );
  });

  test('fix:false → code-review.md', () => {
    assert.strictEqual(
      resolveCodeReviewWorkflow({ fix: false, all: false, auto: false, depth: '', files: '' }),
      'code-review.md',
    );
  });
});
