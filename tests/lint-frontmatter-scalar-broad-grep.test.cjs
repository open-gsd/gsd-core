'use strict';
process.env.GSD_TEST_MODE = '1';

/**
 * Frontmatter-scalar-broad-grep lint (DEFECT.FRONTMATTER-SCALAR-BROAD-GREP,
 * CONTEXT.md).
 *
 * scripts/lint-frontmatter-scalar-broad-grep.cjs flags a `grep "^key:"` over
 * a whole markdown report (not scoped to the frontmatter block, no -m1/
 * `head -1` single-match guard) whose result feeds an exact-token comparison
 * — the #586/#651 bug class where a body line beginning `key:` concatenates
 * onto the intended frontmatter value and misroutes a valid state.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const LINT_SCRIPT = path.join(ROOT, 'scripts', 'lint-frontmatter-scalar-broad-grep.cjs');
const { findBroadGrepsInBlock, extractBashBlocks, scan } = require(LINT_SCRIPT);
const { cleanup } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { copyScriptWithDeps } = require('./helpers/copy-script-fixture.cjs');

const LINT_SCRIPT_REL = path.join('scripts', 'lint-frontmatter-scalar-broad-grep.cjs');

describe('frontmatter-scalar-broad-grep lint: findBroadGrepsInBlock (pure)', () => {
  test('the real #586/#651 defect shape IS flagged: whole-file grep, no scope, no -m1, piped to cut|tr', () => {
    const lines = [
      'grep "^status:" "${QUICK_DIR}/${quick_id}-VERIFICATION.md" | cut -d: -f2 | tr -d \' \'',
    ];
    const findings = findBroadGrepsInBlock(lines);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].key, 'status');
  });

  test('a variable captured from a broad grep and later compared with == is also flagged', () => {
    const lines = [
      'STATUS=$(grep "^status:" "$FILE")',
      'if [ "$STATUS" == "passed" ]; then echo ok; fi',
    ];
    const findings = findBroadGrepsInBlock(lines);
    assert.equal(findings.length, 1);
  });

  test('LOOKALIKE: sed-scoped to the frontmatter block is NOT flagged', () => {
    const lines = [
      'sed -n \'/^---$/,/^---$/p\' "$f" | grep -m1 "^status:" | cut -d: -f2 | tr -d \' \'',
    ];
    assert.deepEqual(findBroadGrepsInBlock(lines), []);
  });

  test('LOOKALIKE: -m1 on the grep itself is NOT flagged even without a preceding scope', () => {
    const lines = [
      'grep -m1 "^status:" "$FILE" | cut -d: -f2 | tr -d \' \'',
    ];
    assert.deepEqual(findBroadGrepsInBlock(lines), []);
  });

  test('LOOKALIKE: piped to `head -1` immediately after grep is NOT flagged (frontmatter is always first)', () => {
    const lines = [
      'AUDIT_STATUS=$(grep "^status:" "${AUDIT_FILE}" 2>/dev/null | head -1 | cut -d: -f2 | tr -d \' \')',
    ];
    assert.deepEqual(findBroadGrepsInBlock(lines), []);
  });

  test('LOOKALIKE: a frontmatter block already extracted into a variable (JS regex idiom), then multiple keys parsed from it', () => {
    const lines = [
      'FRONTMATTER=$(node -e "',
      '  const m = content.match(/^---\\n([\\s\\S]*?)\\n---/);',
      '  if (m) process.stdout.write(m[1]);',
      '")',
      'STATUS=$(echo "$FRONTMATTER" | grep "^status:" | cut -d: -f2 | xargs)',
      'FILES_REVIEWED=$(echo "$FRONTMATTER" | grep "^files_reviewed:" | cut -d: -f2 | xargs)',
    ];
    assert.deepEqual(findBroadGrepsInBlock(lines), []);
  });

  test('LOOKALIKE: an explicit `# lint-allow:` suppression comment silences the finding', () => {
    const lines = [
      '# lint-allow: frontmatter-scalar-broad-grep — intentional multi-file scan, not a single report',
      'grep "^status:" reports/*.md | cut -d: -f2 | tr -d \' \'',
    ];
    assert.deepEqual(findBroadGrepsInBlock(lines), []);
  });

  test('a grep not piped to cut/tr and never compared is NOT flagged (not a token-comparison use)', () => {
    const lines = ['grep -c "^status:" "$FILE"'];
    assert.deepEqual(findBroadGrepsInBlock(lines), []);
  });
});

describe('frontmatter-scalar-broad-grep lint: extractBashBlocks (pure)', () => {
  test('extracts a fenced ```bash block and reports its 1-indexed start line', () => {
    const text = [
      'intro',
      '```bash',
      'echo hi',
      '```',
      'outro',
    ].join('\n');
    const blocks = extractBashBlocks(text);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].startLine, 3);
    assert.deepEqual(blocks[0].lines, ['echo hi']);
  });

  test('a non-bash fenced block (e.g. ```json) is ignored', () => {
    const text = ['```json', '{"a":1}', '```'].join('\n');
    assert.deepEqual(extractBashBlocks(text), []);
  });
});

describe('frontmatter-scalar-broad-grep lint: the live repo is clean', () => {
  test('scan() finds zero offenders in the real workflow/agent/command markdown', () => {
    const offenders = scan();
    assert.deepEqual(
      offenders,
      [],
      'un-scoped frontmatter-scalar grep(s) found:\n' + offenders.map((o) => `  ${o.file}:${o.line}  ${o.snippet}`).join('\n'),
    );
  });
});

describe('frontmatter-scalar-broad-grep lint: main() end-to-end wiring', () => {
  test('exit 0 on the real repo tree', () => {
    const result = runNode([LINT_SCRIPT], { cwd: ROOT });
    assert.equal(result.exitCode, 0, `expected exit 0, got ${result.exitCode}: ${result.stderr}`);
  });

  test('exit 1 on a fixture reproducing the real defect shape', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-frontmatter-grep-lint-e2e-'));
    t.after(() => cleanup(tmpDir));
    const workflowsDir = path.join(tmpDir, 'gsd-core', 'workflows');
    fs.mkdirSync(workflowsDir, { recursive: true });
    fs.writeFileSync(
      path.join(workflowsDir, 'quick.md'),
      [
        '# Quick',
        '```bash',
        'grep "^status:" "${QUICK_DIR}/${quick_id}-VERIFICATION.md" | cut -d: -f2 | tr -d \' \'',
        '```',
      ].join('\n'),
    );
    const scriptCopy = copyScriptWithDeps(ROOT, tmpDir, LINT_SCRIPT_REL);

    const result = runNode([scriptCopy]);
    assert.equal(result.exitCode, 1, `expected exit 1, got ${result.exitCode}`);
    assert.match(result.stderr, /FRONTMATTER-SCALAR-BROAD-GREP/);
  });

  test('exit 0 on a fixture that is properly scoped (no false positive)', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-frontmatter-grep-lint-e2e-clean-'));
    t.after(() => cleanup(tmpDir));
    const workflowsDir = path.join(tmpDir, 'gsd-core', 'workflows');
    fs.mkdirSync(workflowsDir, { recursive: true });
    fs.writeFileSync(
      path.join(workflowsDir, 'quick.md'),
      [
        '# Quick',
        '```bash',
        'sed -n \'/^---$/,/^---$/p\' "$f" | grep -m1 "^status:" | cut -d: -f2 | tr -d \' \'',
        '```',
      ].join('\n'),
    );
    const scriptCopy = copyScriptWithDeps(ROOT, tmpDir, LINT_SCRIPT_REL);

    const result = runNode([scriptCopy]);
    assert.equal(result.exitCode, 0, `expected exit 0, got ${result.exitCode}: ${result.stderr}`);
  });
});

// ─── #5118: a raw read of a VERIFICATION report's `status` is red ──────────
//
// ADR-5057 Phase 4 / 40-design.md §R7: the verification status has ONE owner
// (`gsd_run query verification.status`). A workflow that reads a
// VERIFICATION report's frontmatter `status` itself — awk, sed or grep, scoped
// to the frontmatter or not — bypasses the owner's enum, staleness check and
// routing (transition.md's awk read, W15). The old fix-forward this lint used
// to recommend (sed-scoped `grep -m1 "^status:"`) is exactly such a read, so
// it is red too. Rows V51–V55 (#5118, ADR-5057 §3); V56 is the
// live-tree test above (`scan()` finds zero offenders).

describe('#5118: verification-status-raw-read (positive controls)', () => {
  const lintModule = require(LINT_SCRIPT);

  function rawReads(lines) {
    assert.equal(
      typeof lintModule.findRawVerificationStatusReadsInBlock, 'function',
      'findRawVerificationStatusReadsInBlock must be exported',
    );
    return lintModule.findRawVerificationStatusReadsInBlock(lines);
  }

  const TRANSITION_AWK = [
    "VERIFY_STATUS=$(awk 'FNR==1&&/^---$/{in_fm=1;next}in_fm&&/^---$/{exit}in_fm&&/^status: /{print $2}' \\",
    '  "$VERIFICATION_FILE" 2>/dev/null | head -1)',
  ];

  test('V51: the transition.md awk read, split across a backslash continuation, is one finding', () => {
    const findings = rawReads(TRANSITION_AWK);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].rule, 'verification-status-raw-read');
  });

  test('V52: the old fix-forward (sed-scoped, grep -m1) on a VERIFICATION report is red', () => {
    const findings = rawReads([
      "STATUS=$(sed -n '/^---$/,/^---$/p' \"${PHASE_DIR}\"/*-VERIFICATION.md | grep -m1 \"^status:\" | cut -d: -f2 | tr -d ' ')",
    ]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].rule, 'verification-status-raw-read');
  });

  test('V53: a head -1 guarded grep of a VERIFICATION path is red', () => {
    const findings = rawReads(['S=$(grep "^status:" "$VERIFICATION_PATH" | head -1)']);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].rule, 'verification-status-raw-read');
  });

  test('V54 LOOKALIKES: the owner query, a UAT status read, and a SECURITY status read are not flagged', () => {
    assert.deepEqual(rawReads(['STATUS=$(gsd_run query verification.status "$PHASE_DIR" --pick status)']), []);
    assert.deepEqual(rawReads(["U=$(awk '/^status: /{print $2}' \"$UAT_FILE\")"]), []);
    assert.deepEqual(rawReads([
      "S=$(sed -n '/^---$/,/^---$/p' \"${PHASE_DIR}/${P}-SECURITY.md\" | grep -m1 \"^status:\")",
    ]), []);
  });

  // #5118 review G: the path match is case-INsensitive — a lower-case
  // `$verification_file` / `*-verification.md` read is the same bypass.
  // Boundary on the path token (limit = the full word `verification`):
  // limit-1 (`verificatio`) is not a VERIFICATION path; limit and limit+1
  // (`verifications`) are.
  test('V53b: case-insensitive path match — limit-1 / limit / limit+1 on the path token', () => {
    const read = (pathToken) => rawReads([`S=$(grep "^status:" "${pathToken}" | head -1)`]);
    assert.deepEqual(read('$verificatio_file'), [], 'limit-1: not a verification path');
    assert.equal(read('$verification_file').length, 1, 'limit: lower-case variable is flagged');
    assert.equal(read('./01-Verification.md').length, 1, 'limit: mixed-case filename is flagged');
    assert.equal(read('$verifications_dir/x.md').length, 1, 'limit+1: still names verification');
  });

  test('V55: scan() reports the rule on a fixture workflow, and main() exits 1', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5118-raw-read-'));
    t.after(() => cleanup(tmpDir));
    const workflowsDir = path.join(tmpDir, 'gsd-core', 'workflows');
    fs.mkdirSync(workflowsDir, { recursive: true });
    fs.writeFileSync(
      path.join(workflowsDir, 'transition.md'),
      ['# Transition', '```bash', ...TRANSITION_AWK, '```'].join('\n'),
    );

    const offenders = scan([workflowsDir]);
    assert.ok(
      offenders.some((o) => o.rule === 'verification-status-raw-read'),
      `expected a verification-status-raw-read offender, got: ${JSON.stringify(offenders)}`,
    );

    const scriptCopy = copyScriptWithDeps(ROOT, tmpDir, LINT_SCRIPT_REL);
    const result = runNode([scriptCopy]);
    assert.equal(result.exitCode, 1, `expected exit 1, got ${result.exitCode}`);
  });
});
