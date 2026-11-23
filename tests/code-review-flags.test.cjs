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

  // #6240: a bare `--files a.py,b.py` was silently dropped, so a narrowed
  // review fell back to SUMMARY/git-diff scoping and reported success. The
  // space-separated form must parse identically to the `=` form — and a bare
  // `--files` with no usable value must be refused, never silently ignored.
  test('--files a.py,b.py (space form, #6240) sets files like the = form', () => {
    const flags = parseCodeReviewFlags(['184', '--files', 'a.py,b.py']);
    assert.strictEqual(flags.files, 'a.py,b.py');
  });

  test('--files space form produces the same IR as the = form (#6240)', () => {
    assert.deepStrictEqual(
      parseCodeReviewFlags(['2', '--fix', '--files', 'src/a.ts,src/b.ts', '--all']),
      parseCodeReviewFlags(['2', '--fix', '--files=src/a.ts,src/b.ts', '--all']),
    );
  });

  test('--files space form consumes exactly its value token (#6240)', () => {
    const flags = parseCodeReviewFlags(['--files', 'a.py,b.py', '--fix']);
    assert.strictEqual(flags.files, 'a.py,b.py');
    assert.strictEqual(flags.fix, true);
  });

  test('bare --files at end of argv is refused naming the accepted forms (#6240)', () => {
    assert.throws(
      () => parseCodeReviewFlags(['184', '--files']),
      /Missing value for --files \(use --files=<file1,file2> or --files <file1,file2>\)/,
    );
  });

  test('bare --files followed by another flag is refused naming the accepted forms (#6240)', () => {
    assert.throws(
      () => parseCodeReviewFlags(['184', '--files', '--fix']),
      /Missing value for --files \(use --files=<file1,file2> or --files <file1,file2>\)/,
    );
  });

  // #6240 triage: `--depth` has the same shape and the same question — a bare
  // `--depth deep` was dropped the same way, silently keeping the default tier.
  // The space-separated form must parse identically to the `=` form, and a
  // bare `--depth` must be refused, never silently ignored.
  test('--depth deep (space form, #6240) sets depth like the = form', () => {
    const flags = parseCodeReviewFlags(['184', '--depth', 'deep']);
    assert.strictEqual(flags.depth, 'deep');
  });

  test('--depth space form produces the same IR as the = form (#6240)', () => {
    assert.deepStrictEqual(
      parseCodeReviewFlags(['3', '--fix', '--all', '--depth', 'deep', '--files', 'src/x.ts']),
      parseCodeReviewFlags(['3', '--fix', '--all', '--depth=deep', '--files', 'src/x.ts']),
    );
  });

  test('--depth space form consumes exactly its value token (#6240)', () => {
    const flags = parseCodeReviewFlags(['--depth', 'deep', '--fix']);
    assert.strictEqual(flags.depth, 'deep');
    assert.strictEqual(flags.fix, true);
  });

  test('bare --depth at end of argv is refused naming the accepted forms (#6240)', () => {
    assert.throws(
      () => parseCodeReviewFlags(['184', '--depth']),
      /Missing value for --depth \(use --depth=<value> or --depth <value>\)/,
    );
  });

  test('bare --depth followed by another flag is refused naming the accepted forms (#6240)', () => {
    assert.throws(
      () => parseCodeReviewFlags(['184', '--depth', '--fix']),
      /Missing value for --depth \(use --depth=<value> or --depth <value>\)/,
    );
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
// allow-test-rule: source-text-is-the-product (see #3727)
// The workflow .md IS the product: its text is loaded and interpreted at
// runtime by the agent host. Structural assertions (step existence, flag
// references in the initialize step) verify the deployed dispatch contract.
// Pure-function assertions on parseCodeReviewFlags / resolveCodeReviewWorkflow
// are IR-level (not raw-text-match) per CONTRIBUTING.md L554.

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
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const FLAGS_LIB = path.join(ROOT, 'gsd-core', 'bin', 'lib', 'code-review-flags.cjs');
const WORKFLOW_PATH = path.join(ROOT, 'gsd-core', 'workflows', 'code-review.md');

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

// ---------------------------------------------------------------------------
// Docs-parity: the workflow .md must contain the dispatch_fix step and
// reference code-review-flags.cjs in the initialize step.
// These are structural invariants on the deployed product text.
// Source-text-is-the-product exemption applies (see file header).
// ---------------------------------------------------------------------------

describe('#3727 — code-review.md structural dispatch contract', () => {
  const src = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  // #2994: dispatch_fix moved wholly into a marker-gated step file
  // (gsd-core/workflows/code-review/steps/dispatch-fix.md, when="flag:--fix")
  // — the host now carries only the gsd:section marker + read-or-skip stub.
  const DISPATCH_FIX_STEP_PATH = path.join(
    ROOT,
    'gsd-core',
    'workflows',
    'code-review',
    'steps',
    'dispatch-fix.md',
  );
  const dispatchFixSrc = fs.readFileSync(DISPATCH_FIX_STEP_PATH, 'utf8');

  test('initialize step references code-review-flags.cjs for flag parsing', () => {
    const initStart = src.indexOf('<step name="initialize">');
    const initEnd = src.indexOf('</step>', initStart);
    assert.ok(initStart !== -1, 'workflow must have an initialize step');
    const initSection = src.slice(initStart, initEnd);
    assert.ok(
      initSection.includes('code-review-flags.cjs'),
      'initialize step must reference code-review-flags.cjs to parse --fix/--all/--auto flags'
    );
  });

  test('workflow gates a dispatch-fix section (flag:--fix) whose step file has the dispatch_fix step', () => {
    assert.ok(
      src.includes('<!-- gsd:section id="dispatch-fix" when="flag:--fix" -->') &&
        src.includes('gsd-core/workflows/code-review/steps/dispatch-fix.md'),
      'code-review.md must gate a dispatch-fix section pointing at dispatch-fix.md (missing = --fix is silently no-op)'
    );
    assert.ok(
      dispatchFixSrc.includes('<step name="dispatch_fix">'),
      'dispatch-fix.md step file must contain the dispatch_fix step'
    );
  });

  test('dispatch_fix step delegates to code-review-fix.md when fix flag is true', () => {
    assert.ok(
      dispatchFixSrc.includes('code-review-fix.md'),
      'dispatch_fix step must reference code-review-fix.md workflow'
    );
  });

  test('dispatch_fix step references gsd-code-fixer agent (via code-review-fix.md chain)', () => {
    // The dispatch step must show that fixing will occur, either directly or
    // by loading code-review-fix.md (which in turn spawns gsd-code-fixer).
    assert.ok(
      dispatchFixSrc.includes('gsd-code-fixer') || dispatchFixSrc.includes('code-review-fix.md'),
      'dispatch_fix step must reference gsd-code-fixer agent or code-review-fix.md workflow'
    );
  });
});
  });
}

// ---------------------------------------------------------------------------
// #6251 review Minor 1 — the fix has two halves: the parser throws on a
// refused flag, and the shipped workflow block (`FLAGS_JSON=$(node -e …)
// || exit 1`) turns that into a halted workflow instead of an empty IR (the
// old `2>/dev/null` hid any parser failure, so the review silently re-scoped).
// These rows execute the SHIPPED block, extracted from the workflow text, so a
// later edit that drops the `|| exit 1` or the `catch` fails here instead of
// silently re-scoping reviews.
// ---------------------------------------------------------------------------

describe('#6251 — the shipped code-review.md flag block halts on a refused flag', () => {
  const { execFileSync } = require('node:child_process');
  const { QUICK_SPAWN_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
  const reviewFs = require('node:fs');
  const reviewPath = require('node:path');
  const reviewRoot = reviewPath.resolve(__dirname, '..');
  const reviewWorkflowPath = reviewPath.join(reviewRoot, 'gsd-core', 'workflows', 'code-review.md');

  const workflowSrc = reviewFs.readFileSync(reviewWorkflowPath, 'utf8');
  const blockStart = workflowSrc.indexOf('FLAGS_JSON=$(node -e "');
  const blockEndMarker = '" -- "$@") || exit 1';
  const blockEnd = workflowSrc.indexOf(blockEndMarker, blockStart);
  assert.ok(blockStart !== -1, 'code-review.md must contain the FLAGS_JSON=$(node -e …) block');
  assert.ok(blockEnd !== -1, 'code-review.md FLAGS_JSON block must end with " -- "$@") || exit 1');
  const flagsBlock = workflowSrc.slice(blockStart, blockEnd + blockEndMarker.length);

  const runBlock = (args) => {
    // The shipped block only ASSIGNS FLAGS_JSON (the workflow's next lines read
    // the variable), so the harness prints it in the same shell afterwards —
    // `|| exit 1` still halts before the printf when the parser refuses.
    const harness = flagsBlock + `; printf '%s' "$FLAGS_JSON"`;
    try {
      // The block ends with `-- "$@"`, so the argv must arrive as real bash -c
      // positional arguments (argv[0] is the $0 placeholder).
      const stdout = execFileSync('bash', ['-c', harness, 'code-review', ...args], {
        encoding: 'utf8',
        timeout: QUICK_SPAWN_TIMEOUT_MS,
        env: { ...process.env, GSD_LIB_DIR: reviewPath.join(reviewRoot, 'gsd-core', 'bin', 'lib') },
      });
      return { exitCode: 0, stdout, stderr: '' };
    } catch (err) {
      return { exitCode: err.status, stdout: err.stdout || '', stderr: err.stderr || '' };
    }
  };

  test('the extracted block is the shipped one (sanity)', () => {
    assert.ok(flagsBlock.includes('parseCodeReviewFlags'), 'block must call parseCodeReviewFlags');
    assert.ok(flagsBlock.includes('|| exit 1'), 'block must halt via || exit 1');
    assert.ok(flagsBlock.includes('catch'), 'block must catch the parser error');
  });

  test('bare --files: non-zero exit, ERROR: on stderr, no JSON on stdout', { skip: process.platform === 'win32' }, () => {
    const r = runBlock(['184', '--files']);
    assert.notStrictEqual(r.exitCode, 0, `the workflow must halt on a refused flag, got stdout: ${r.stdout}`);
    assert.ok(r.stderr.includes('ERROR: Missing value for --files'),
      `stderr must carry the ERROR: line, got: ${r.stderr}`);
    assert.strictEqual(r.stdout.trim(), '',
      `no IR JSON may reach stdout when the parser refused the flags, got: ${r.stdout}`);
  });

  test('space-separated --files a.py: exit 0 and the IR JSON on stdout', { skip: process.platform === 'win32' }, () => {
    const r = runBlock(['184', '--files', 'a.py']);
    assert.strictEqual(r.exitCode, 0, `exit 0 expected, stderr: ${r.stderr}`);
    const ir = JSON.parse(r.stdout);
    assert.strictEqual(ir.files, 'a.py', `the IR must carry the files override, got: ${r.stdout}`);
  });
});
