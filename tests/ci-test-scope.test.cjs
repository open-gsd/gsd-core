'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'ci-test-scope.cjs');

function scopeFor(files) {
  const r = spawnSync(process.execPath, [SCRIPT, '--files', files.join(' ')], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.strictEqual(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
  return JSON.parse(r.stdout);
}

describe('ci-test-scope.cjs', () => {
  test('docs-only changes do not request code matrix work', () => {
    const result = scopeFor(['docs/usage.md']);
    assert.strictEqual(result.code_changed, false);
    assert.strictEqual(result.full_matrix, false);
    assert.deepStrictEqual(result.targeted_tests, []);
    assert.deepStrictEqual(result.windows_tests, []);
  });

  test('workflow changes request full matrix and workflow contract tests', () => {
    const result = scopeFor(['.github/workflows/test.yml']);
    assert.strictEqual(result.code_changed, true);
    assert.strictEqual(result.full_matrix, true);
    assert.ok(result.targeted_tests.includes('tests/workflow-shell-pinning.test.cjs'));
    assert.ok(result.targeted_tests.includes('tests/release-tarball-smoke-workflow.test.cjs'));
    assert.ok(result.windows_tests.includes('tests/workflow-shell-pinning.test.cjs'));
  });

  test('command changes request command tests without full parity matrix', () => {
    const result = scopeFor(['commands/gsd/plan-phase.md']);
    assert.strictEqual(result.code_changed, true);
    assert.strictEqual(result.full_matrix, false);
    assert.ok(result.targeted_tests.includes('tests/command-contract.test.cjs'));
    assert.ok(result.targeted_tests.includes('tests/commands.test.cjs'));
  });

  test('changed test files are selected directly', () => {
    const result = scopeFor(['tests/run-tests-harness.test.cjs']);
    assert.strictEqual(result.code_changed, true);
    assert.ok(result.targeted_tests.includes('tests/run-tests-harness.test.cjs'));
  });

  test('installer-sensitive changes request full matrix and install tests', () => {
    const result = scopeFor(['bin/gsd']);
    assert.strictEqual(result.code_changed, true);
    assert.strictEqual(result.full_matrix, true);
    assert.ok(result.targeted_tests.includes('tests/install.test.cjs'));
    assert.ok(result.targeted_tests.includes('tests/release-tarball-smoke.install.test.cjs'));
  });

  test('missing required CLI values fail with usage', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--files'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    assert.notStrictEqual(r.status, 0);
    // allow-test-rule: CLI usage failure text is user-facing contract for this parser guard.
    assert.match(r.stderr, /--files requires a value/);
    // allow-test-rule: CLI usage banner presence is a user-facing contract.
    assert.match(r.stderr, /Usage:/);
  });

  // bug-408: unconditional DEFAULT_SMOKE_TESTS injection removed; unit fallback added
  test('bug-408: code change with matched rules produces exactly the rule-selected tests (no smoke list appended)', () => {
    // commands/ matches the "command definitions" rule only — no smoke list should be added
    const result = scopeFor(['commands/gsd/plan-phase.md']);
    assert.strictEqual(result.code_changed, true);
    const expectedTests = [
      'tests/command-contract.test.cjs',
      'tests/command-routing-hub.test.cjs',
      'tests/commands.test.cjs',
      'tests/phase-command-router.test.cjs',
      'tests/roadmap-command-router.test.cjs',
    ];
    // Every expected test must be present
    for (const t of expectedTests) {
      assert.ok(result.targeted_tests.includes(t), `expected ${t} in targeted_tests`);
    }
    // No DEFAULT_SMOKE_TESTS files should be injected beyond what the rule selects.
    // The former smoke list contained package-manifest.test.cjs and core.test.cjs —
    // neither is in the "command definitions" rule, so they must not appear.
    assert.ok(!result.targeted_tests.includes('tests/core.test.cjs'),
      'tests/core.test.cjs must NOT be unconditionally injected for command changes');
    assert.ok(!result.targeted_tests.includes('tests/package-manifest.test.cjs'),
      'tests/package-manifest.test.cjs must NOT be unconditionally injected for command changes');
  });

  test('bug-408: code change with no rule match falls back to unit suite token', () => {
    // A plain source file that matches no RULES entry but is under get-shit-done/ (code path)
    const result = scopeFor(['get-shit-done/src/some-util.js']);
    assert.strictEqual(result.code_changed, true);
    // allow-test-rule: the unit-fallback contract is the exact subject of bug #408.
    assert.deepStrictEqual(result.targeted_tests, ['unit'],
      'targeted_tests must be [\'unit\'] when code changed but no rule matched');
  });
});
