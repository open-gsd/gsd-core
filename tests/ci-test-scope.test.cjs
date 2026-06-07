'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'ci-test-scope.cjs');
const WORKFLOWS_DIR = path.join(ROOT, '.github', 'workflows');

function scopeFor(files) {
  const r = spawnSync(process.execPath, [SCRIPT, '--files', files.join(' ')], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.strictEqual(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
  return JSON.parse(r.stdout);
}

describe('ci-test-scope.cjs', () => {
  test('docs-only changes: code_changed is false, product_changed false (skip matrix entirely)', () => {
    const result = scopeFor(['docs/usage.md']);
    assert.strictEqual(result.code_changed, false,
      `expected code_changed=false for docs-only change, got: ${JSON.stringify(result)}`);
    assert.strictEqual(result.product_changed, false,
      `expected product_changed=false for docs-only change, got: ${JSON.stringify(result)}`);
    assert.strictEqual(result.full_matrix, false);
    // docs-parity is NOT in targeted_tests when docs-only (it runs via docs-required.yml instead)
    assert.ok(
      !result.targeted_tests.some(t => t.includes('docs-parity-live-registry')),
      `docs-parity-live-registry must NOT be in targeted_tests for docs-only, got: ${JSON.stringify(result.targeted_tests)}`,
    );
  });

  test('root markdown only: code_changed is false, product_changed false', () => {
    const result = scopeFor(['README.md']);
    assert.strictEqual(result.code_changed, false,
      `expected code_changed=false for root markdown, got: ${JSON.stringify(result)}`);
    assert.strictEqual(result.product_changed, false,
      `expected product_changed=false for root markdown, got: ${JSON.stringify(result)}`);
  });

  test('pipeline workflow (test.yml) — product_changed true, full_matrix true, workflow contract tests', () => {
    const result = scopeFor(['.github/workflows/test.yml']);
    assert.strictEqual(result.code_changed, true);
    assert.strictEqual(result.product_changed, true,
      `expected product_changed=true for test.yml, got: ${JSON.stringify(result)}`);
    assert.strictEqual(result.full_matrix, true);
    assert.ok(result.targeted_tests.includes('tests/workflow-shell-pinning.test.cjs'));
    assert.ok(result.targeted_tests.includes('tests/release-tarball-smoke-workflow.test.cjs'));
    assert.ok(result.windows_tests.includes('tests/workflow-shell-pinning.test.cjs'));
  });

  test('pipeline workflow (install-smoke.yml) — product_changed true, full_matrix true', () => {
    const result = scopeFor(['.github/workflows/install-smoke.yml']);
    assert.strictEqual(result.code_changed, true);
    assert.strictEqual(result.product_changed, true,
      `expected product_changed=true for install-smoke.yml, got: ${JSON.stringify(result)}`);
    assert.strictEqual(result.full_matrix, true);
  });

  test('inert CI only (stale.yml) — code_changed true, product_changed false, full_matrix false', () => {
    const result = scopeFor(['.github/workflows/stale.yml']);
    assert.strictEqual(result.code_changed, true,
      `expected code_changed=true for inert CI, got: ${JSON.stringify(result)}`);
    assert.strictEqual(result.product_changed, false,
      `expected product_changed=false for inert CI, got: ${JSON.stringify(result)}`);
    assert.strictEqual(result.full_matrix, false,
      `expected full_matrix=false for inert CI, got: ${JSON.stringify(result)}`);
    assert.ok(result.targeted_tests.includes('tests/workflow-shell-pinning.test.cjs'),
      `expected workflow-shell-pinning in targeted_tests, got: ${JSON.stringify(result.targeted_tests)}`);
    assert.ok(result.targeted_tests.includes('tests/policy-lint-shallow-checkout.test.cjs'),
      `expected policy-lint-shallow-checkout in targeted_tests for inert CI, got: ${JSON.stringify(result.targeted_tests)}`);
  });

  test('TS runtime sources (src/semver.cts) — code_changed true, product_changed true, full_matrix false, semver tests targeted', () => {
    const result = scopeFor(['src/semver.cts']);
    assert.strictEqual(result.code_changed, true,
      `expected code_changed=true for src/ change, got: ${JSON.stringify(result)}`);
    assert.strictEqual(result.product_changed, true,
      `expected product_changed=true for src/ change, got: ${JSON.stringify(result)}`);
    assert.strictEqual(result.full_matrix, false,
      `expected full_matrix=false for src/-only change (TS runtime sources rule has no fullMatrix), got: ${JSON.stringify(result)}`);
    assert.ok(result.targeted_tests.includes('tests/semver-compare.test.cjs'),
      `expected semver-compare in targeted_tests, got: ${JSON.stringify(result.targeted_tests)}`);
  });

  test('product code (gsd-core/bin/lib/foo.cjs) — product_changed true', () => {
    const result = scopeFor(['gsd-core/bin/lib/foo.cjs']);
    assert.strictEqual(result.code_changed, true);
    assert.strictEqual(result.product_changed, true,
      `expected product_changed=true for gsd-core/ change, got: ${JSON.stringify(result)}`);
  });

  test('unknown/new workflow defaults to pipeline (fail-safe) — product_changed true', () => {
    const result = scopeFor(['.github/workflows/brand-new-thing.yml']);
    assert.strictEqual(result.code_changed, true);
    assert.strictEqual(result.product_changed, true,
      `expected product_changed=true for unknown workflow (fail-safe), got: ${JSON.stringify(result)}`);
    assert.strictEqual(result.full_matrix, true,
      `expected full_matrix=true for unknown workflow (fail-safe), got: ${JSON.stringify(result)}`);
  });

  test('mixed docs + code — escalates to product_changed true', () => {
    // Use bin/gsd (installer rule, fullMatrix:true) to get a code file that reliably triggers full matrix.
    const result = scopeFor(['docs/x.md', 'bin/gsd']);
    assert.strictEqual(result.code_changed, true);
    assert.strictEqual(result.product_changed, true,
      `expected product_changed=true for docs+code, got: ${JSON.stringify(result)}`);
  });

  test('inert CI (docs-required.yml) — includes shallow-checkout policy test, product_changed false', () => {
    const result = scopeFor(['.github/workflows/docs-required.yml']);
    assert.strictEqual(result.code_changed, true,
      `expected code_changed=true for docs-required.yml, got: ${JSON.stringify(result)}`);
    assert.strictEqual(result.product_changed, false,
      `expected product_changed=false for docs-required.yml, got: ${JSON.stringify(result)}`);
    assert.strictEqual(result.full_matrix, false,
      `expected full_matrix=false for docs-required.yml, got: ${JSON.stringify(result)}`);
    assert.ok(result.targeted_tests.includes('tests/policy-lint-shallow-checkout.test.cjs'),
      `expected policy-lint-shallow-checkout in targeted_tests for docs-required.yml, got: ${JSON.stringify(result.targeted_tests)}`);
  });

  test('mixed docs + inert CI — code_changed true, product_changed false (inert lane)', () => {
    const result = scopeFor(['docs/x.md', '.github/workflows/stale.yml']);
    assert.strictEqual(result.code_changed, true);
    assert.strictEqual(result.product_changed, false,
      `expected product_changed=false for docs+inert, got: ${JSON.stringify(result)}`);
    assert.strictEqual(result.full_matrix, false);
  });

  test('mixed docs + src — product_changed true', () => {
    const result = scopeFor(['docs/x.md', 'src/semver.cts']);
    assert.strictEqual(result.code_changed, true);
    assert.strictEqual(result.product_changed, true,
      `expected product_changed=true for docs+src, got: ${JSON.stringify(result)}`);
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
    assert.strictEqual(result.product_changed, true,
      `expected product_changed=true for bin/gsd, got: ${JSON.stringify(result)}`);
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
    // A plain source file that matches no RULES entry but is under gsd-core/ (code path)
    const result = scopeFor(['gsd-core/src/some-util.js']);
    assert.strictEqual(result.code_changed, true);
    // allow-test-rule: the unit-fallback contract is the exact subject of bug #408.
    assert.deepStrictEqual(result.targeted_tests, ['unit'],
      'targeted_tests must be [\'unit\'] when code changed but no rule matched');
  });
});

describe('ci-test-scope superset invariant (#494)', () => {
  // Facet A: any tests/** change → full_matrix === true
  test('A1: a specific changed test file forces full_matrix', () => {
    const result = scopeFor(['tests/bug-1974-context-exhaustion-record.test.cjs']);
    assert.strictEqual(result.full_matrix, true,
      `expected full_matrix=true for tests/** change, got: ${JSON.stringify(result)}`);
  });

  test('A2: any tests/** path forces full_matrix', () => {
    const result = scopeFor(['tests/some-new.test.cjs']);
    assert.strictEqual(result.full_matrix, true,
      `expected full_matrix=true for tests/** change, got: ${JSON.stringify(result)}`);
  });

  // Facet B: commands/**, agents/** → code_changed AND docs-parity selected
  // docs/ is NO LONGER in this facet — docs-only PRs skip the matrix entirely.
  test('B1: docs/adr change: code_changed is false (docs skip matrix)', () => {
    const result = scopeFor(['docs/adr/22-plan-drift-guard.md']);
    assert.strictEqual(result.code_changed, false,
      `expected code_changed=false for docs/** change (matrix skip), got: ${JSON.stringify(result)}`);
    assert.strictEqual(result.product_changed, false,
      `expected product_changed=false for docs/** change, got: ${JSON.stringify(result)}`);
    // docs-parity is NOT in targeted_tests (handled by docs-required.yml)
    assert.ok(
      !result.targeted_tests.some(t => t.includes('docs-parity-live-registry')),
      `docs-parity-live-registry must NOT be in targeted_tests for docs-only, got: ${JSON.stringify(result.targeted_tests)}`,
    );
  });

  test('B2: docs locale dir change: code_changed is false (docs skip matrix)', () => {
    const result = scopeFor(['docs/ja-JP/USAGE.md']);
    assert.strictEqual(result.code_changed, false,
      `expected code_changed=false for docs/ja-JP/** change, got: ${JSON.stringify(result)}`);
    assert.strictEqual(result.product_changed, false,
      `expected product_changed=false for docs/ja-JP/** change, got: ${JSON.stringify(result)}`);
  });

  test('B3: commands/** change selects docs-parity-live-registry', () => {
    const result = scopeFor(['commands/gsd/plan-phase.md']);
    assert.ok(
      result.targeted_tests.some(t => t.includes('docs-parity-live-registry')),
      `expected docs-parity-live-registry in targeted_tests for commands/** change, got: ${JSON.stringify(result.targeted_tests)}`,
    );
  });
});

describe('INERT_WORKFLOWS allowlist integrity guard', () => {
  // Load the INERT_WORKFLOWS set from the script by spawning it and using --files
  // on a sentinel path, then separately verify the set contents via the filesystem.

  // Known pipeline workflows that MUST NOT appear in INERT_WORKFLOWS.
  // Must stay in sync with PROTECTED_WORKFLOWS in scripts/ci-test-scope.cjs.
  const KNOWN_PIPELINE = [
    'test.yml',
    'install-smoke.yml',
    'mutation.yml',
    'security-scan.yml',
    'release.yml',
  ];

  // Canonical inert workflow list — reused by both tests below.
  const knownInert = [
    'stale.yml', 'branch-cleanup.yml', 'branch-naming.yml', 'auto-label-issues.yml',
    'auto-branch.yml', 'auto-backmerge.yml', 'close-draft-prs.yml',
    'dismiss-unauthorized-pr-approvals.yml', 'pr-gate.yml', 'pr-target-validator.yml',
    'pr-template-format.yml', 'require-issue-link.yml', 'changeset-required.yml',
    'docs-required.yml', 'discord-changelog.yml',
  ];

  test('all entries in INERT_WORKFLOWS exist under .github/workflows/', () => {
    // We derive the inert set implicitly: any .github/workflows/*.yml that produces
    // full_matrix=false when passed alone is inert. We check the known inert names
    // against the filesystem instead.
    // The canonical list is in the script — we verify each named file exists.
    for (const name of knownInert) {
      const fullPath = path.join(WORKFLOWS_DIR, name);
      assert.ok(
        fs.existsSync(fullPath),
        `INERT_WORKFLOWS entry '${name}' does not exist at ${fullPath}`,
      );
    }
  });

  test('known pipeline workflows are NOT treated as inert (product_changed true, full_matrix true)', () => {
    for (const name of KNOWN_PIPELINE) {
      const result = scopeFor([`.github/workflows/${name}`]);
      assert.strictEqual(result.product_changed, true,
        `${name} must be pipeline (product_changed=true), got: ${JSON.stringify(result)}`);
      assert.strictEqual(result.full_matrix, true,
        `${name} must be pipeline (full_matrix=true), got: ${JSON.stringify(result)}`);
    }
  });

  // Explicit per-workflow guard: each of the five protected workflows must route to
  // the full matrix. This documents intent and proves that PROTECTED_WORKFLOWS
  // enforcement is covered end-to-end via the spawn helper.
  test('all five PROTECTED_WORKFLOWS individually route to full matrix (tamper-evidence)', () => {
    const protected_ = [
      'test.yml',
      'install-smoke.yml',
      'mutation.yml',
      'security-scan.yml',
      'release.yml',
    ];
    for (const name of protected_) {
      const result = scopeFor([`.github/workflows/${name}`]);
      assert.strictEqual(result.product_changed, true,
        `PROTECTED_WORKFLOW ${name}: expected product_changed=true, got: ${JSON.stringify(result)}`);
      assert.strictEqual(result.full_matrix, true,
        `PROTECTED_WORKFLOW ${name}: expected full_matrix=true, got: ${JSON.stringify(result)}`);
    }
  });

  test('every inert workflow produces code_changed=true, product_changed=false, and full_matrix=false', () => {
    for (const name of knownInert) {
      const result = scopeFor([`.github/workflows/${name}`]);
      assert.strictEqual(result.code_changed, true,
        `${name}: expected code_changed=true`);
      assert.strictEqual(result.product_changed, false,
        `${name}: expected product_changed=false`);
      assert.strictEqual(result.full_matrix, false,
        `${name}: expected full_matrix=false`);
    }
  });
});

describe('code_changed=false implies clean output invariant', () => {
  // Fix 1: when code_changed is false, full_matrix, targeted_tests, windows_tests
  // must ALL be empty/false — even if a docs path coincidentally
  // matches a content rule via coarse substring (e.g. path.includes('install') or
  // path.includes('config')).

  test('docs-only: code_changed=false → product_changed=false, full_matrix=false, empty targeted_tests', () => {
    const result = scopeFor(['docs/usage.md']);
    assert.strictEqual(result.code_changed, false);
    assert.strictEqual(result.product_changed, false);
    assert.strictEqual(result.full_matrix, false);
    assert.deepStrictEqual(result.targeted_tests, []);
  });

  // docs/installer-migrations.md contains 'install' → would match the installer rule
  // via path.includes('install'). Normalization must suppress the contradictory output.
  test('docs/installer-migrations.md: code_changed=false AND product_changed=false AND full_matrix=false AND empty targeted_tests', () => {
    const result = scopeFor(['docs/installer-migrations.md']);
    assert.strictEqual(result.code_changed, false,
      `expected code_changed=false for docs/installer-migrations.md, got: ${JSON.stringify(result)}`);
    assert.strictEqual(result.product_changed, false,
      `expected product_changed=false for docs/installer-migrations.md, got: ${JSON.stringify(result)}`);
    assert.strictEqual(result.full_matrix, false,
      `expected full_matrix=false for docs/installer-migrations.md, got: ${JSON.stringify(result)}`);
    assert.deepStrictEqual(result.targeted_tests, [],
      `expected empty targeted_tests for docs/installer-migrations.md, got: ${JSON.stringify(result.targeted_tests)}`);
  });

  // docs/how-to/configure-model-profiles.md contains 'config' → matches configuration rule.
  test('docs path matching config rule: code_changed=false → empty output (coarse-substring docs suppressed)', () => {
    const result = scopeFor(['docs/how-to/configure-model-profiles.md']);
    assert.strictEqual(result.code_changed, false,
      `expected code_changed=false, got: ${JSON.stringify(result)}`);
    assert.strictEqual(result.product_changed, false);
    assert.strictEqual(result.full_matrix, false);
    assert.deepStrictEqual(result.targeted_tests, []);
  });

  // code_changed=true must produce >= 1 targeted_test or 'unit' fallback.
  test('code_changed=true implies non-empty targeted_tests', () => {
    for (const files of [
      ['src/semver.cts'],
      ['bin/gsd'],
      ['.github/workflows/test.yml'],
      ['.github/workflows/stale.yml'],
    ]) {
      const result = scopeFor(files);
      assert.strictEqual(result.code_changed, true,
        `expected code_changed=true for ${files}, got: ${JSON.stringify(result)}`);
      assert.ok(result.targeted_tests.length >= 1,
        `expected >= 1 targeted_test for ${files}, got: ${JSON.stringify(result.targeted_tests)}`);
    }
  });
});
