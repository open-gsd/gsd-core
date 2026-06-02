/**
 * Characterization tests for code-review-flags module.
 *
 * These assertions lock the flag-parsing and workflow-dispatch behaviour
 * used by the /gsd:code-review command. Covers both exports and every quirk
 * documented in the hand-written .cjs (ADR-457 build-at-publish migration).
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseCodeReviewFlags,
  resolveCodeReviewWorkflow,
} = require('../get-shit-done/bin/lib/code-review-flags.cjs');

describe('parseCodeReviewFlags', () => {
  test('no flags → all defaults', () => {
    assert.deepStrictEqual(parseCodeReviewFlags([]), {
      fix: false,
      all: false,
      auto: false,
      depth: '',
      files: '',
    });
  });

  test('--fix sets fix:true', () => {
    const flags = parseCodeReviewFlags(['--fix']);
    assert.strictEqual(flags.fix, true);
    assert.strictEqual(flags.all, false);
    assert.strictEqual(flags.auto, false);
  });

  test('--all sets all:true and implies fix:true', () => {
    const flags = parseCodeReviewFlags(['--all']);
    assert.strictEqual(flags.all, true);
    assert.strictEqual(flags.fix, true);
    assert.strictEqual(flags.auto, false);
  });

  test('--auto sets auto:true and implies fix:true', () => {
    const flags = parseCodeReviewFlags(['--auto']);
    assert.strictEqual(flags.auto, true);
    assert.strictEqual(flags.fix, true);
    assert.strictEqual(flags.all, false);
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
  });

  test('unknown flags are silently ignored', () => {
    assert.deepStrictEqual(parseCodeReviewFlags(['--unknown']), {
      fix: false,
      all: false,
      auto: false,
      depth: '',
      files: '',
    });
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
