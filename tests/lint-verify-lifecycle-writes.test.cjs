/**
 * tests/lint-verify-lifecycle-writes.test.cjs — #5105 test matrix rows T17-T23.
 *
 * FAILING-FIRST: `scripts/lint-verify-lifecycle-writes.cjs` (design
 * 40-design.md §R "R4") does not exist yet. Mirrors the pattern of
 * tests/lint-planning-artifact-writer-drift.test.cjs: pure detector functions
 * exercised with in-memory strings, plus one real-tree regression test that
 * imports and calls `scanRepo` in-process.
 *
 * Design: .gsd/phase/fix-5105-verify-lifecycle-writes/40-design.md §R "R4".
 * Matrix: .gsd/phase/fix-5105-verify-lifecycle-writes/50-test-matrix.md T17-T23.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { cleanup } = require('./helpers.cjs');

const REPO_ROOT = path.join(__dirname, '..');

function loadLint() {
  return require('../scripts/lint-verify-lifecycle-writes.cjs');
}

describe('T17: lint over the real tree — non-inert, and (post-fix) green', () => {
  test('scanRepo(REPO_ROOT) finds ≥3 render-hooks sites and reports zero violations', () => {
    const { scanRepo } = loadLint();
    const result = scanRepo(REPO_ROOT);
    assert.ok(result.scannedHosts > 0, 'the scan must not be inert — it must have scanned at least one host file');
    assert.ok(
      Array.isArray(result.renderHookSites) && result.renderHookSites.length >= 3,
      `expected at least 3 "loop render-hooks verify:post" sites; got: ${JSON.stringify(result.renderHookSites)}`,
    );
    assert.deepStrictEqual(
      result.violations, [],
      `unexpected verify-lifecycle-write violation(s) on the real tree (post-fix must be green): ${JSON.stringify(result.violations, null, 2)}`,
    );
  });
});

describe('T18: L1 — a host with "loop render-hooks verify:post" missing --after-fingerprint', () => {
  test('scanText flags the missing-flag invocation as L1', () => {
    const { scanText } = loadLint();
    const text = [
      '```bash',
      'HOOKS_JSON=$(gsd_run loop render-hooks verify:post --cwd "$PROJECT_ROOT")',
      '```',
      '',
    ].join('\n');
    const violations = scanText('gsd-core/workflows/verify-work.md', text, { postFingerprint: true });
    const l1 = violations.filter((v) => v.rule === 'L1');
    assert.strictEqual(l1.length, 1, `expected exactly one L1 violation; got: ${JSON.stringify(violations)}`);
  });

  test('scanText does NOT flag an invocation that already carries --after-fingerprint', () => {
    const { scanText } = loadLint();
    const text = [
      '```bash',
      'HOOKS_JSON=$(gsd_run loop render-hooks verify:post --after-fingerprint "$PHASE_DIR" --cwd "$PROJECT_ROOT")',
      '```',
      '',
    ].join('\n');
    const violations = scanText('gsd-core/workflows/verify-work.md', text, { postFingerprint: true });
    assert.deepStrictEqual(violations.filter((v) => v.rule === 'L1'), []);
  });
});

describe('T19: L2 — raw commit of a coverable phase artifact in post-fingerprint text', () => {
  test('a `query commit … --files "${PHASE_DIR}/${P}-UAT.md"` invocation is flagged', () => {
    const { scanText } = loadLint();
    const text = [
      '```bash',
      'gsd_run query commit "test: complete UAT" --files "${PHASE_DIR}/${PADDED_PHASE}-UAT.md"',
      '```',
      '',
    ].join('\n');
    const violations = scanText('gsd-core/workflows/verify-work.md', text, { postFingerprint: true });
    const l2 = violations.filter((v) => v.rule === 'L2');
    assert.strictEqual(l2.length, 1, `expected exactly one L2 violation; got: ${JSON.stringify(violations)}`);
    assert.match(l2[0].target, /UAT\.md/);
  });

  test('the same text OUTSIDE post-fingerprint scope is not flagged by L2', () => {
    const { scanText } = loadLint();
    const text = [
      '```bash',
      'gsd_run query commit "test: complete UAT" --files "${PHASE_DIR}/${PADDED_PHASE}-UAT.md"',
      '```',
      '',
    ].join('\n');
    const violations = scanText('gsd-core/workflows/execute-phase.md', text, { postFingerprint: false });
    assert.deepStrictEqual(violations.filter((v) => v.rule === 'L2'), []);
  });
});

describe('#5105 review finding 8: L2 runs over backslash-continued lines, same as L1/L3', () => {
  test('`git add \\` on one physical line with its UAT pathspec on the next is flagged', () => {
    const { scanText } = loadLint();
    const text = [
      '```bash',
      'git add \\',
      '  "${PHASE_DIR}/${PADDED_PHASE}-UAT.md"',
      '```',
      '',
    ].join('\n');
    const violations = scanText('gsd-core/workflows/verify-work.md', text, { postFingerprint: true });
    const l2 = violations.filter((v) => v.rule === 'L2');
    assert.strictEqual(l2.length, 1, `expected a backslash-continued git add pathspec to be flagged; got: ${JSON.stringify(violations)}`);
    assert.match(l2[0].target, /UAT\.md/);
  });
});

describe('T20: L2 fail-closed — an unresolvable variable pathspec', () => {
  test('`--files "$X"` is flagged (fail-closed on an unresolvable pathspec)', () => {
    const { scanText } = loadLint();
    const text = [
      '```bash',
      'gsd_run query commit "audit" --files "$X"',
      '```',
      '',
    ].join('\n');
    const violations = scanText('gsd-core/workflows/verify-work.md', text, { postFingerprint: true });
    const l2 = violations.filter((v) => v.rule === 'L2');
    assert.strictEqual(l2.length, 1, `an unresolvable variable pathspec must fail closed; got: ${JSON.stringify(violations)}`);
  });
});

describe('T21: L2 negative space — a shared planning doc is inert', () => {
  test('`--files .planning/ROADMAP.md` is NOT flagged', () => {
    const { scanText } = loadLint();
    const text = [
      '```bash',
      'gsd_run query commit "roadmap update" --files ".planning/ROADMAP.md"',
      '```',
      '',
    ].join('\n');
    const violations = scanText('gsd-core/workflows/verify-work.md', text, { postFingerprint: true });
    assert.deepStrictEqual(violations, [], 'a shared planning doc pathspec must be inert under L2');
  });

  test('a report path (…-VERIFICATION.md) is NOT flagged', () => {
    const { scanText } = loadLint();
    const text = [
      '```bash',
      'gsd_run query commit "canon" --files "${PHASE_DIR}/${PADDED_PHASE}-VERIFICATION.md"',
      '```',
      '',
    ].join('\n');
    const violations = scanText('gsd-core/workflows/verify-work.md', text, { postFingerprint: true });
    assert.deepStrictEqual(violations, [], 'a report path must be inert under L2');
  });
});

describe('T22: allowlist — a free-text reason and a stale entry are each a violation', () => {
  test('an allowlist entry whose reason does not match #\\d+ is itself a violation', () => {
    const { validateAllowlist } = loadLint();
    const entries = [
      { file: 'gsd-core/workflows/validate-phase.md', rule: 'L2', command: '{test_files}', reason: 'looks fine to me' },
    ];
    const violations = []; // no real findings — the entry itself is the problem
    const problems = validateAllowlist(entries, violations);
    assert.ok(problems.length >= 1, 'a free-text reason must be flagged');
    assert.ok(problems.some((p) => /reason/i.test(p.message || JSON.stringify(p))));
  });

  test('a URL-only reason is ALSO a violation — #5105 S13 drops the URL alternative', () => {
    const { validateAllowlist } = loadLint();
    const entries = [
      {
        file: 'gsd-core/workflows/validate-phase.md',
        rule: 'L2',
        command: '{test_files}',
        reason: 'https://github.com/open-gsd/gsd-core/issues/4981',
      },
    ];
    const violations = [];
    const problems = validateAllowlist(entries, violations);
    assert.ok(problems.length >= 1, 'a URL-only reason must be flagged now that only #\\d+ is accepted');
    assert.ok(problems.some((p) => /reason/i.test(p.message || JSON.stringify(p))));
  });

  test('an allowlist entry that no longer matches any finding is itself a violation (stale entry)', () => {
    const { validateAllowlist } = loadLint();
    const entries = [
      { file: 'gsd-core/workflows/validate-phase.md', rule: 'L2', command: '{test_files}', reason: '#4981' },
    ];
    // No violation at all corresponds to this allowlisted command -> stale.
    const violations = [];
    const problems = validateAllowlist(entries, violations);
    assert.ok(problems.length >= 1, 'an allowlist entry with a valid reason but no matching finding must still be flagged as stale');
  });

  test('a valid, non-stale entry produces no problems', () => {
    const { validateAllowlist } = loadLint();
    const entries = [
      { file: 'gsd-core/workflows/validate-phase.md', rule: 'L2', command: '{test_files}', reason: '#4981' },
    ];
    const violations = [
      { rule: 'L2', file: 'gsd-core/workflows/validate-phase.md', line: 155, target: '{test_files}', text: '{test_files}' },
    ];
    const problems = validateAllowlist(entries, violations);
    assert.deepStrictEqual(problems, []);
  });
});

describe('T25: allowlist key pins the exact site (#5105 S13) — file + rule + normalized command text', () => {
  test('an allowlisted site A does not exempt a different, unallowlisted site B in the same file+rule', () => {
    const { filterAllowedViolations } = loadLint();
    const violations = [
      {
        rule: 'L1',
        file: 'gsd-core/workflows/verify-work.md',
        line: 10,
        target: 'loop render-hooks verify:post',
        text: 'HOOKS_JSON=$(gsd_run loop render-hooks verify:post --raw)',
      },
      {
        rule: 'L1',
        file: 'gsd-core/workflows/verify-work.md',
        line: 40,
        target: 'loop render-hooks verify:post',
        text: 'OTHER_JSON=$(gsd_run loop render-hooks verify:post --cwd "$X")',
      },
    ];
    const entries = [
      {
        file: 'gsd-core/workflows/verify-work.md',
        rule: 'L1',
        command: 'HOOKS_JSON=$(gsd_run loop render-hooks verify:post --raw)',
        reason: '#5105',
      },
    ];
    const remaining = filterAllowedViolations(violations, entries);
    assert.strictEqual(remaining.length, 1, `site B must still be flagged; got: ${JSON.stringify(remaining)}`);
    assert.match(remaining[0].text, /OTHER_JSON/);
  });

  test('whitespace differences alone do not create a new key (normalized comparison)', () => {
    const { filterAllowedViolations } = loadLint();
    const violations = [
      {
        rule: 'L2',
        file: 'gsd-core/workflows/verify-work.md',
        line: 5,
        target: '$X',
        text: '  gsd_run   query commit "audit"   --files "$X"  ',
      },
    ];
    const entries = [
      {
        file: 'gsd-core/workflows/verify-work.md',
        rule: 'L2',
        command: 'gsd_run query commit "audit" --files "$X"',
        reason: '#5105',
      },
    ];
    const remaining = filterAllowedViolations(violations, entries);
    assert.deepStrictEqual(remaining, [], 'whitespace-only differences must still match the allowlisted key');
  });
});

describe('T26: fail-closed — zero hosts or zero render-hook sites (#5105 S14)', () => {
  test('scanRepo on an empty temp root fails closed (non-empty violations, would exit 1)', (t) => {
    const { scanRepo } = loadLint();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-lint-vlw-'));
    t.after(() => cleanup(tmp));
    const result = scanRepo(tmp);
    assert.strictEqual(result.scannedHosts, 0);
    assert.strictEqual(result.renderHookSites.length, 0);
    assert.ok(
      result.violations.length > 0,
      'an empty tree must fail closed (non-empty violations), never silently report a clean scan',
    );
  });

  test('parseAllowlist throws a descriptive error on malformed JSON, rather than returning []', () => {
    const { parseAllowlist } = loadLint();
    assert.throws(() => parseAllowlist('{ this is not valid json'), /malformed|JSON/i);
  });

  test('parseAllowlist throws when the parsed JSON is not an array', () => {
    const { parseAllowlist } = loadLint();
    assert.throws(() => parseAllowlist('{"file":"x"}'), /array/i);
  });
});

describe('T27: positive control on real files (#5105 S16) — mutate the actual workflow text', () => {
  test('stripping every --after-fingerprint from the real verify-work.md flags each stripped site with L1', () => {
    const { scanText } = loadLint();
    const real = fs.readFileSync(path.join(REPO_ROOT, 'gsd-core/workflows/verify-work.md'), 'utf-8');
    const cleanL1 = scanText('gsd-core/workflows/verify-work.md', real, { postFingerprint: true })
      .filter((v) => v.rule === 'L1');
    assert.deepStrictEqual(cleanL1, [], 'the unmutated real verify-work.md must have zero L1 violations');

    // Only ONE of verify-work.md's `--after-fingerprint` mentions is on an
    // actual `loop render-hooks verify:post` command line — the others are
    // backtick-quoted prose explaining the flag's effect. Stripping the flag
    // everywhere must flag exactly the real render-hooks site(s), not the
    // prose mentions.
    const AFTER_FINGERPRINT_ARG_RE = /\s*--after-fingerprint\s+(?:"[^"]*"|'[^']*'|\S+)/g;
    assert.ok((real.match(AFTER_FINGERPRINT_ARG_RE) || []).length > 0, 'verify-work.md must actually carry --after-fingerprint arguments to strip');
    const mutated = real.replace(AFTER_FINGERPRINT_ARG_RE, '');
    const mutatedL1 = scanText('gsd-core/workflows/verify-work.md', mutated, { postFingerprint: true })
      .filter((v) => v.rule === 'L1');
    assert.ok(mutatedL1.length >= 1, 'stripping --after-fingerprint must flag at least the real render-hooks verify:post site');
    assert.ok(
      mutatedL1.every((v) => /loop render-hooks verify:post/.test(v.text)),
      `every L1 finding must be an actual render-hooks invocation, not a stripped prose mention: ${JSON.stringify(mutatedL1)}`,
    );
  });

  test('stripping every --after-fingerprint from the real autonomous.md flags each stripped site with L1', () => {
    const { scanText } = loadLint();
    const real = fs.readFileSync(path.join(REPO_ROOT, 'gsd-core/workflows/autonomous.md'), 'utf-8');
    const cleanL1 = scanText('gsd-core/workflows/autonomous.md', real, { postFingerprint: false })
      .filter((v) => v.rule === 'L1');
    assert.deepStrictEqual(cleanL1, [], 'the unmutated real autonomous.md must have zero L1 violations');

    const AFTER_FINGERPRINT_ARG_RE = /\s*--after-fingerprint\s+(?:"[^"]*"|'[^']*'|\S+)/g;
    assert.ok((real.match(AFTER_FINGERPRINT_ARG_RE) || []).length > 0, 'autonomous.md must actually carry --after-fingerprint arguments to strip');
    const mutated = real.replace(AFTER_FINGERPRINT_ARG_RE, '');
    const mutatedL1 = scanText('gsd-core/workflows/autonomous.md', mutated, { postFingerprint: false })
      .filter((v) => v.rule === 'L1');
    assert.ok(mutatedL1.length >= 1, 'stripping --after-fingerprint must flag at least the real render-hooks verify:post site');
    assert.ok(
      mutatedL1.every((v) => /loop render-hooks verify:post/.test(v.text)),
      `every L1 finding must be an actual render-hooks invocation, not a stripped prose mention: ${JSON.stringify(mutatedL1)}`,
    );
  });

  test('inserting a raw --files UAT commit line into the real verify-work.md text is flagged by L2', () => {
    const { scanText } = loadLint();
    const real = fs.readFileSync(path.join(REPO_ROOT, 'gsd-core/workflows/verify-work.md'), 'utf-8');
    // Note: scanText alone does not apply the allowlist (only scanRepo does),
    // so the unmutated real text still carries its one known-inert-at-the-
    // repo-level $VERIFICATION_FILE site here — T17 covers scanRepo's
    // post-allowlist zero-violations contract. This test only asserts that
    // the injected site adds a NEW L2 finding on top of whatever baseline
    // scanText reports for the unmutated text.
    const baselineL2 = scanText('gsd-core/workflows/verify-work.md', real, { postFingerprint: true })
      .filter((v) => v.rule === 'L2');

    const injected = `${real}\n\`\`\`bash\ngsd_run query commit "x" --files "\${PHASE_DIR}/\${PADDED_PHASE}-UAT.md"\n\`\`\`\n`;
    const mutatedL2 = scanText('gsd-core/workflows/verify-work.md', injected, { postFingerprint: true })
      .filter((v) => v.rule === 'L2');
    assert.strictEqual(
      mutatedL2.length, baselineL2.length + 1,
      `expected exactly one new L2 finding from the injected UAT --files line; got: ${JSON.stringify(mutatedL2)}`,
    );
    assert.ok(mutatedL2.some((v) => /UAT\.md/.test(v.target)), 'the injected raw UAT --files line must be flagged by L2');
  });
});

describe('T28: L1 sees a backslash-continued invocation and a quoted "verify:post" token (#5105 S12)', () => {
  test('a "loop render-hooks verify:post" split across a backslash-continued line is flagged', () => {
    const { scanText } = loadLint();
    const text = [
      '```bash',
      'HOOKS_JSON=$(gsd_run loop render-hooks \\',
      '  verify:post --cwd "$PROJECT_ROOT")',
      '```',
      '',
    ].join('\n');
    const violations = scanText('gsd-core/workflows/verify-work.md', text, { postFingerprint: true });
    const l1 = violations.filter((v) => v.rule === 'L1');
    assert.strictEqual(l1.length, 1, `expected the continuation-split invocation to be flagged; got: ${JSON.stringify(violations)}`);
  });

  test('a quoted "verify:post" argument is still recognized', () => {
    const { scanText } = loadLint();
    const text = [
      '```bash',
      'HOOKS_JSON=$(gsd_run loop render-hooks "verify:post" --cwd "$PROJECT_ROOT")',
      '```',
      '',
    ].join('\n');
    const violations = scanText('gsd-core/workflows/verify-work.md', text, { postFingerprint: true });
    const l1 = violations.filter((v) => v.rule === 'L1');
    assert.strictEqual(l1.length, 1, `expected the quoted verify:post form to be flagged; got: ${JSON.stringify(violations)}`);
  });

  test('a continuation-split invocation that DOES carry --after-fingerprint is not flagged', () => {
    const { scanText } = loadLint();
    const text = [
      '```bash',
      'HOOKS_JSON=$(gsd_run loop render-hooks \\',
      '  verify:post --after-fingerprint "$PHASE_DIR" --cwd "$PROJECT_ROOT")',
      '```',
      '',
    ].join('\n');
    const violations = scanText('gsd-core/workflows/verify-work.md', text, { postFingerprint: true });
    assert.deepStrictEqual(violations.filter((v) => v.rule === 'L1'), []);
  });
});

describe('T29: L2 checks every pathspec token, not just the first (#5105 S11)', () => {
  test('--files a.md "${PHASE_DIR}/${P}-UAT.md" flags the second token too', () => {
    const { scanText } = loadLint();
    const text = [
      '```bash',
      'gsd_run query commit "audit" --files a.md "${PHASE_DIR}/${P}-UAT.md"',
      '```',
      '',
    ].join('\n');
    const violations = scanText('gsd-core/workflows/verify-work.md', text, { postFingerprint: true });
    const l2 = violations.filter((v) => v.rule === 'L2');
    assert.strictEqual(l2.length, 2, `expected both pathspec tokens flagged; got: ${JSON.stringify(violations)}`);
    assert.ok(l2.some((v) => v.target === 'a.md'));
    assert.ok(l2.some((v) => /UAT\.md/.test(v.target)));
  });

  test('git add with multiple operands flags every non-inert operand', () => {
    const { scanText } = loadLint();
    const text = [
      '```bash',
      'git add a.md "${PHASE_DIR}/${P}-UAT.md" ".planning/ROADMAP.md"',
      '```',
      '',
    ].join('\n');
    const violations = scanText('gsd-core/workflows/verify-work.md', text, { postFingerprint: true });
    const l2 = violations.filter((v) => v.rule === 'L2');
    assert.strictEqual(l2.length, 2, `expected the two non-inert operands flagged, .planning/ROADMAP.md inert; got: ${JSON.stringify(violations)}`);
  });
});

describe('T30: identity — the lint module re-exports the shared verification.cjs primitives (#5105 S15)', () => {
  test('lint.isVerificationReportPath and lint.isSharedPlanningDoc ARE the compiled verification.cjs functions', () => {
    const lint = loadLint();
    const verification = require('../gsd-core/bin/lib/verification.cjs');
    assert.strictEqual(lint.isVerificationReportPath, verification.isVerificationReportPath);
    assert.strictEqual(lint.isSharedPlanningDoc, verification.isSharedPlanningDoc);
  });

  test('a small path corpus behaves as expected through the shared functions', () => {
    const { isVerificationReportPath, isSharedPlanningDoc } = loadLint();
    assert.strictEqual(isVerificationReportPath('03-VERIFICATION.md'), true);
    assert.strictEqual(isVerificationReportPath('phases/03/VERIFICATION.md'), true);
    assert.strictEqual(isVerificationReportPath('phases/03/03-UAT.md'), false);
    assert.strictEqual(isSharedPlanningDoc('.planning/ROADMAP.md'), true);
    assert.strictEqual(isSharedPlanningDoc('.planning/phases/03/03-UAT.md'), false);
  });
});

describe('T23: positive control — planted minimal pre-fix shapes go red', () => {
  test('a render-hooks verify:post site with no --after-fingerprint (pre-fix verify-work shape) is red', () => {
    const { scanText } = loadLint();
    const text = [
      '## Dispatch verify:post hooks',
      '',
      '```bash',
      'HOOKS_JSON=$(gsd_run loop render-hooks verify:post --cwd "$PROJECT_ROOT")',
      '```',
      '',
    ].join('\n');
    const violations = scanText('gsd-core/workflows/verify-work.md', text, { postFingerprint: true });
    assert.ok(violations.some((v) => v.rule === 'L1'), 'the pre-fix verify-work.md shape must be flagged by L1');
  });

  test('an autonomous.md re-dispatch site with no --after-fingerprint is red', () => {
    const { scanText } = loadLint();
    const text = [
      '### 3d.5 — re-dispatch verify:post hooks',
      '',
      '```bash',
      'HOOKS_JSON=$(gsd_run loop render-hooks verify:post --cwd "$PROJECT_ROOT")',
      '```',
      '',
    ].join('\n');
    const violations = scanText('gsd-core/workflows/autonomous.md', text, { postFingerprint: false });
    assert.ok(violations.some((v) => v.rule === 'L1'), 'the pre-fix autonomous.md 3d.5 shape must be flagged by L1');
  });

  test('a raw UAT commit (pre-fix verify-work complete_session shape) is red', () => {
    const { scanText } = loadLint();
    const text = [
      '## complete_session',
      '',
      '```bash',
      'gsd_run query commit "test(${PHASE_NUM}): complete UAT" --files "${PHASE_DIR}/${PADDED_PHASE}-UAT.md"',
      '```',
      '',
    ].join('\n');
    const violations = scanText('gsd-core/workflows/verify-work.md', text, { postFingerprint: true });
    assert.ok(violations.some((v) => v.rule === 'L2'), 'the pre-fix raw UAT commit shape must be flagged by L2');
  });
});

describe('T24: L3 — secure-phase enablement phrasing must reference skippedHooks (#5105 S1)', () => {
  test('a gated host with the bare "active secure-phase step hook exists" phrase is red', () => {
    const { scanText } = loadLint();
    const text = [
      '```bash',
      'HOOKS_JSON=$(gsd_run loop render-hooks verify:post --after-fingerprint "$PHASE_DIR")',
      '```',
      '',
      'If an active secure-phase step hook exists AND `SECURITY_FILE` is empty, dispatch it.',
    ].join('\n');
    const violations = scanText('gsd-core/workflows/verify-work.md', text, { postFingerprint: true });
    const l3 = violations.filter((v) => v.rule === 'L3');
    assert.strictEqual(l3.length, 1, `expected exactly one L3 violation; got: ${JSON.stringify(violations)}`);
  });

  test('a gated host with the bare "no active secure-phase step hook" phrase is red', () => {
    const { scanText } = loadLint();
    const text = [
      '```bash',
      'HOOKS_JSON=$(gsd_run loop render-hooks verify:post --after-fingerprint "$PHASE_DIR")',
      '```',
      '',
      'If no active secure-phase step hook exists OR (`SECURITY_FILE` exists AND `threats_open` is `0`):',
    ].join('\n');
    const violations = scanText('gsd-core/workflows/verify-work.md', text, { postFingerprint: true });
    assert.ok(violations.some((v) => v.rule === 'L3'), 'the "no active secure-phase step hook" phrase must also be flagged');
  });

  test('the same phrase, with skippedHooks referenced on the same line, is NOT flagged', () => {
    const { scanText } = loadLint();
    const text = [
      '```bash',
      'HOOKS_JSON=$(gsd_run loop render-hooks verify:post --after-fingerprint "$PHASE_DIR")',
      '```',
      '',
      'If an active secure-phase step hook exists (in `activeHooks`, not `skippedHooks`) AND `SECURITY_FILE` is empty, dispatch it.',
    ].join('\n');
    const violations = scanText('gsd-core/workflows/verify-work.md', text, { postFingerprint: true });
    assert.deepStrictEqual(violations.filter((v) => v.rule === 'L3'), []);
  });

  test('the phrase in a host with NO --after-fingerprint invocation at all is not flagged (self-gated)', () => {
    const { scanText } = loadLint();
    const text = [
      '```bash',
      'HOOKS_JSON=$(gsd_run loop render-hooks verify:post --cwd "$PROJECT_ROOT")',
      '```',
      '',
      'If an active secure-phase step hook exists AND `SECURITY_FILE` is empty, dispatch it.',
    ].join('\n');
    // Note: this text alone would also fire L1 (missing --after-fingerprint) —
    // the point here is narrowly that L3 does not fire when no gated
    // invocation is present anywhere in the file.
    const violations = scanText('gsd-core/workflows/verify-work.md', text, { postFingerprint: true });
    assert.deepStrictEqual(violations.filter((v) => v.rule === 'L3'), []);
  });
});
