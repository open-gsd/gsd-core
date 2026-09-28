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
      { file: 'gsd-core/workflows/validate-phase.md', rule: 'L2', target: '{test_files}', reason: 'looks fine to me' },
    ];
    const violations = []; // no real findings — the entry itself is the problem
    const problems = validateAllowlist(entries, violations);
    assert.ok(problems.length >= 1, 'a free-text reason must be flagged');
    assert.ok(problems.some((p) => /reason/i.test(p.message || JSON.stringify(p))));
  });

  test('an allowlist entry that no longer matches any finding is itself a violation (stale entry)', () => {
    const { validateAllowlist } = loadLint();
    const entries = [
      { file: 'gsd-core/workflows/validate-phase.md', rule: 'L2', target: '{test_files}', reason: '#4981' },
    ];
    // No violation at all corresponds to this allowlisted target -> stale.
    const violations = [];
    const problems = validateAllowlist(entries, violations);
    assert.ok(problems.length >= 1, 'an allowlist entry with a valid reason but no matching finding must still be flagged as stale');
  });

  test('a valid, non-stale entry produces no problems', () => {
    const { validateAllowlist } = loadLint();
    const entries = [
      { file: 'gsd-core/workflows/validate-phase.md', rule: 'L2', target: '{test_files}', reason: '#4981' },
    ];
    const violations = [
      { rule: 'L2', file: 'gsd-core/workflows/validate-phase.md', line: 155, target: '{test_files}' },
    ];
    const problems = validateAllowlist(entries, violations);
    assert.deepStrictEqual(problems, []);
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
