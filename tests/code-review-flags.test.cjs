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
} = require('../gsd-core/bin/lib/code-review-flags.cjs');

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


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3727-code-review-fix-flag-dispatch.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3727-code-review-fix-flag-dispatch (consolidation epic #1969 B3 #1972)", () => {
// Pure-function assertions on parseCodeReviewFlags / resolveCodeReviewWorkflow
// are IR-level (not raw-text-match) per CONTRIBUTING.md L554. The structural
// assertions on the workflow text moved to the `code-review-flags` text contract.

/**
 * Regression tests for #3727 — /gsd-code-review N --fix silently no-ops.
 *
 * Root cause: code-review.md `initialize` step parses only --depth and
 * --files flags. --fix, --all, and --auto are never parsed, so no dispatch
 * to code-review-fix.md ever occurs.
 *
 * Fix: add parseCodeReviewFlags() to code-review-flags.cjs (typed IR), wire
 * it into the workflow initialize step, and add a dispatch_fix step that
 * delegates to code-review-fix.md when flags.fix is true.
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const FLAGS_LIB = path.join(ROOT, 'gsd-core', 'bin', 'lib', 'code-review-flags.cjs');

// ---------------------------------------------------------------------------
// Stage 2 seam: typed IR from parseCodeReviewFlags and resolveCodeReviewWorkflow
// These functions are the production code under test — not text-matching on
// the .md source.
// ---------------------------------------------------------------------------

const { parseCodeReviewFlags, resolveCodeReviewWorkflow } = require(FLAGS_LIB);

describe('#3727 — parseCodeReviewFlags: typed IR for code-review argv', () => {
  test('code-review workflow parses --fix flag and dispatches gsd-code-fixer', () => {
    // This is the invariant being violated: --fix must be captured into the IR
    // and must route to the fixer workflow, not be silently dropped.
    const flags = parseCodeReviewFlags(['2', '--fix']);
    assert.strictEqual(flags.fix, true,
      '--fix must set flags.fix = true');
    const workflow = resolveCodeReviewWorkflow(flags);
    assert.strictEqual(workflow, 'code-review-fix.md',
      '--fix must dispatch to code-review-fix.md, not code-review.md');
  });

  test('--fix absent: dispatch stays on code-review.md (review-only)', () => {
    // Counter-test (Stage 5 contract 6): omitting --fix must NOT dispatch fixer.
    const flags = parseCodeReviewFlags(['2']);
    assert.strictEqual(flags.fix, false,
      'Without --fix, flags.fix must be false');
    const workflow = resolveCodeReviewWorkflow(flags);
    assert.strictEqual(workflow, 'code-review.md',
      'Without --fix, dispatch must stay on code-review.md');
  });

  test('--all implies --fix', () => {
    const flags = parseCodeReviewFlags(['3', '--all']);
    assert.strictEqual(flags.fix, true,
      '--all must imply flags.fix = true');
    assert.strictEqual(flags.all, true,
      '--all must set flags.all = true');
    const workflow = resolveCodeReviewWorkflow(flags);
    assert.strictEqual(workflow, 'code-review-fix.md',
      '--all must dispatch to code-review-fix.md');
  });

  test('--auto implies --fix', () => {
    const flags = parseCodeReviewFlags(['3', '--auto']);
    assert.strictEqual(flags.fix, true,
      '--auto must imply flags.fix = true');
    assert.strictEqual(flags.auto, true,
      '--auto must set flags.auto = true');
    const workflow = resolveCodeReviewWorkflow(flags);
    assert.strictEqual(workflow, 'code-review-fix.md',
      '--auto must dispatch to code-review-fix.md');
  });

  test('--fix --all --auto all set simultaneously', () => {
    const flags = parseCodeReviewFlags(['1', '--fix', '--all', '--auto']);
    assert.strictEqual(flags.fix, true);
    assert.strictEqual(flags.all, true);
    assert.strictEqual(flags.auto, true);
    assert.strictEqual(resolveCodeReviewWorkflow(flags), 'code-review-fix.md');
  });

  test('--depth flag is still parsed alongside --fix (no regression)', () => {
    const flags = parseCodeReviewFlags(['2', '--depth=deep', '--fix']);
    assert.strictEqual(flags.fix, true);
    assert.strictEqual(flags.depth, 'deep');
    assert.strictEqual(resolveCodeReviewWorkflow(flags), 'code-review-fix.md');
  });

  test('--files flag is still parsed alongside --fix (no regression)', () => {
    const flags = parseCodeReviewFlags(['2', '--files=src/foo.ts,src/bar.ts', '--fix']);
    assert.strictEqual(flags.fix, true);
    assert.strictEqual(flags.files, 'src/foo.ts,src/bar.ts');
  });

  test('empty argv returns all-false IR', () => {
    const flags = parseCodeReviewFlags([]);
    assert.strictEqual(flags.fix, false);
    assert.strictEqual(flags.all, false);
    assert.strictEqual(flags.auto, false);
    assert.strictEqual(flags.depth, '');
    assert.strictEqual(flags.files, '');
  });
});

// The structural half of #3727 (the code-review.md initialize step names code-review-flags.cjs, the gated
// dispatch-fix section and its step file) is the `code-review-flags` text contract in
// scripts/static-checks/text-contracts/.
  });
}
