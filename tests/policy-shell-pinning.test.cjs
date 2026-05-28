'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  POLICY,
  VIOLATION,
  inspectWorkflow,
  runPolicyLint,
} = require('../scripts/workflow-policy.cjs');

// ---------------------------------------------------------------------------
// Test 1 — Baseline: repo's current workflow files must yield ZERO violations
// (RED on origin/next; GREEN after YAML fixes are committed)
// ---------------------------------------------------------------------------
describe('baseline: repo workflows comply with H1 shell policy', () => {
  test('runPolicyLint on .github/workflows produces zero violations', () => {
    const workflowsDir = path.resolve(__dirname, '..', '.github', 'workflows');
    const result = runPolicyLint({ workflowsDir });

    if (result.violations.length > 0) {
      const top10 = result.violations.slice(0, 10);
      const msg = top10.map(v =>
        `  ${path.basename(v.filePath)}:${v.evidence.line} [${v.jobId}/${v.stepName}] runner=${v.runner} shell=${v.effectiveShell} type=${v.violation}`
      ).join('\n');
      assert.fail(
        `Expected 0 violations but found ${result.violations.length}. ` +
        `Top violations (mechanism: each step on a macos-* or windows-* runner must use native shell):\n${msg}`
      );
    }

    assert.strictEqual(
      result.violations.length,
      0,
      'All workflow steps must comply with H1 shell policy'
    );
  });
});

// ---------------------------------------------------------------------------
// Test 2 — Positive synthetic: compliant workflow yields zero violations
// Three separate jobs, one per OS, each using H1-compliant shell configuration:
//   ubuntu: no shell pin (runner default bash = policy bash)
//   macos:  job-level defaults.run.shell: zsh
//   windows: no shell pin (runner default pwsh = policy pwsh)
// ---------------------------------------------------------------------------
describe('synthetic: fully-compliant per-OS jobs workflow', () => {
  const COMPLIANT_YAML = `
name: Compliant Workflow
jobs:
  linux-job:
    runs-on: ubuntu-latest
    steps:
      - name: Run tests on ubuntu
        run: npm test
  macos-job:
    runs-on: macos-latest
    defaults:
      run:
        shell: zsh
    steps:
      - name: Run tests on macOS
        run: npm test
  windows-job:
    runs-on: windows-latest
    steps:
      - name: Run tests on windows
        run: npm test
`;

  test('compliant per-OS workflow (ubuntu no pin, macos job-defaults zsh, windows no pin) produces zero violations', () => {
    const result = inspectWorkflow(COMPLIANT_YAML, { filePath: '<synthetic-compliant>' });

    const violations = result.jobs
      .flatMap(j => j.steps)
      .filter(s => s.violation !== null);

    assert.strictEqual(
      violations.length,
      0,
      'Compliant per-OS workflow must have zero violations. Got: ' +
      violations.map(v => `${v.runner}/${v.violation}`).join(', ')
    );
  });
});

// ---------------------------------------------------------------------------
// Test 3 — Counter-test: macOS missing explicit zsh → MACOS_MISSING_EXPLICIT_ZSH
// (mechanism: macos-latest default is bash, not zsh; H1 requires explicit shell: zsh)
// ---------------------------------------------------------------------------
describe('counter-test: macOS step without explicit shell: zsh', () => {
  const MACOS_NO_SHELL_YAML = `
name: macOS No Shell
jobs:
  build:
    runs-on: macos-latest
    steps:
      - name: Run tests
        run: npm test
`;

  test('macos-latest step with no shell pin produces exactly one MACOS_MISSING_EXPLICIT_ZSH violation', () => {
    const result = inspectWorkflow(MACOS_NO_SHELL_YAML, { filePath: '<synthetic-macos-no-shell>' });

    const violations = result.jobs
      .flatMap(j => j.steps)
      .filter(s => s.violation !== null);

    assert.strictEqual(
      violations.length,
      1,
      `Expected exactly 1 violation (MACOS_MISSING_EXPLICIT_ZSH on macos-latest) but got ${violations.length}`
    );

    assert.strictEqual(
      violations[0].violation,
      VIOLATION.MACOS_MISSING_EXPLICIT_ZSH,
      `Expected violation type MACOS_MISSING_EXPLICIT_ZSH but got ${violations[0].violation}`
    );

    assert.strictEqual(
      violations[0].runner,
      'macos-latest',
      `Expected violation runner to be macos-latest but got ${violations[0].runner}`
    );
  });
});

// ---------------------------------------------------------------------------
// Test 4 — Counter-test: wrong shell for OS → WRONG_SHELL_FOR_OS
// (mechanism: windows-2025 default is pwsh; specifying shell: bash is a policy violation)
// ---------------------------------------------------------------------------
describe('counter-test: windows step with explicit shell: bash', () => {
  const WINDOWS_BASH_YAML = `
name: Windows Bash
jobs:
  build:
    runs-on: windows-2025
    steps:
      - name: Run tests with wrong shell
        shell: bash
        run: npm test
`;

  test('windows-2025 step with shell: bash produces exactly one WRONG_SHELL_FOR_OS violation', () => {
    const result = inspectWorkflow(WINDOWS_BASH_YAML, { filePath: '<synthetic-windows-bash>' });

    const violations = result.jobs
      .flatMap(j => j.steps)
      .filter(s => s.violation !== null);

    assert.strictEqual(
      violations.length,
      1,
      `Expected exactly 1 violation (WRONG_SHELL_FOR_OS on windows-2025) but got ${violations.length}`
    );

    assert.strictEqual(
      violations[0].violation,
      VIOLATION.WRONG_SHELL_FOR_OS,
      `Expected violation type WRONG_SHELL_FOR_OS but got ${violations[0].violation}`
    );

    assert.strictEqual(
      violations[0].runner,
      'windows-2025',
      `Expected violation runner to be windows-2025 but got ${violations[0].runner}`
    );
  });
});

// ---------------------------------------------------------------------------
// Test 5 — Counter-test: matrix expansion with shell: bash on every step
// (mechanism: ubuntu realizations are compliant since bash IS policy for ubuntu;
//  macos → WRONG_SHELL_FOR_OS (explicit wrong pin); windows → WRONG_SHELL_FOR_OS)
// Expected: 2 violations total (1 macos + 1 windows), zero for ubuntu
// Note: MACOS_MISSING_EXPLICIT_ZSH fires only when NO shell is set at any level;
// here shell: bash is explicit, so WRONG_SHELL_FOR_OS is the correct subtype.
// ---------------------------------------------------------------------------
describe('counter-test: three-OS matrix with shell: bash on every step', () => {
  const ALL_BASH_MATRIX_YAML = `
name: All Bash Matrix
jobs:
  build:
    runs-on: \${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest, windows-2025]
    steps:
      - name: Run tests
        shell: bash
        run: npm test
`;

  test('three-OS matrix with shell: bash produces exactly 2 WRONG_SHELL_FOR_OS violations (macos + windows), zero for ubuntu', () => {
    const result = inspectWorkflow(ALL_BASH_MATRIX_YAML, { filePath: '<synthetic-all-bash-matrix>' });

    const violations = result.jobs
      .flatMap(j => j.steps)
      .filter(s => s.violation !== null);

    assert.strictEqual(
      violations.length,
      2,
      `Expected exactly 2 violations (macos-latest + windows-2025) but got ${violations.length}: ` +
      violations.map(v => `${v.runner}/${v.violation}`).join(', ')
    );

    const macosViolation = violations.find(v => v.runner === 'macos-latest');
    assert.ok(
      macosViolation,
      'Expected a violation for macos-latest realization'
    );
    // When an explicit shell: bash is set on the step, the violation is WRONG_SHELL_FOR_OS
    // (the explicit pin is wrong for the OS). MACOS_MISSING_EXPLICIT_ZSH only fires when
    // there is NO shell set at any level and the runner default (bash) is inherited silently.
    assert.strictEqual(
      macosViolation.violation,
      VIOLATION.WRONG_SHELL_FOR_OS,
      `macos-latest with explicit shell: bash should be WRONG_SHELL_FOR_OS (explicit wrong pin) but got ${macosViolation?.violation}`
    );

    const windowsViolation = violations.find(v => v.runner === 'windows-2025');
    assert.ok(
      windowsViolation,
      'Expected a violation for windows-2025 realization'
    );
    assert.strictEqual(
      windowsViolation.violation,
      VIOLATION.WRONG_SHELL_FOR_OS,
      `windows-2025 violation should be WRONG_SHELL_FOR_OS but got ${windowsViolation?.violation}`
    );

    const ubuntuViolations = violations.filter(v => v.runner === 'ubuntu-latest');
    assert.strictEqual(
      ubuntuViolations.length,
      0,
      `ubuntu-latest should produce zero violations (bash is both runner default and policy) but got ${ubuntuViolations.length}`
    );
  });
});

// ---------------------------------------------------------------------------
// Test 6 — Counter-test: unknown runner → UNKNOWN_RUNNER
// (mechanism: self-hosted is not in POLICY, so runner cannot be validated)
// ---------------------------------------------------------------------------
describe('counter-test: self-hosted runner produces UNKNOWN_RUNNER violation', () => {
  const SELF_HOSTED_YAML = `
name: Self-Hosted
jobs:
  build:
    runs-on: self-hosted
    steps:
      - name: Run build
        run: npm build
`;

  test('self-hosted runner step produces exactly one UNKNOWN_RUNNER violation', () => {
    const result = inspectWorkflow(SELF_HOSTED_YAML, { filePath: '<synthetic-self-hosted>' });

    const violations = result.jobs
      .flatMap(j => j.steps)
      .filter(s => s.violation !== null);

    assert.strictEqual(
      violations.length,
      1,
      `Expected exactly 1 UNKNOWN_RUNNER violation but got ${violations.length}`
    );

    assert.strictEqual(
      violations[0].violation,
      VIOLATION.UNKNOWN_RUNNER,
      `Expected violation type UNKNOWN_RUNNER but got ${violations[0].violation}`
    );

    assert.strictEqual(
      violations[0].runner,
      'self-hosted',
      `Expected violation runner to be self-hosted but got ${violations[0].runner}`
    );
  });
});

// ---------------------------------------------------------------------------
// Test 7a — Positive: matrix.include with shell key + defaults.run.shell: ${{ matrix.shell }}
// (mechanism: each realization carries its own shell value; the linter resolves
//  the matrix expression against the realization context before checking policy)
// ---------------------------------------------------------------------------
describe('matrix.shell: ${{ matrix.shell }} resolves per realization — zero violations', () => {
  const MATRIX_SHELL_YAML = `
name: Matrix Shell Positive
jobs:
  build:
    runs-on: \${{ matrix.os }}
    defaults:
      run:
        shell: \${{ matrix.shell }}
    strategy:
      matrix:
        include:
          - os: macos-latest
            shell: zsh
          - os: windows-2025
            shell: pwsh
    steps:
      - name: Run tests
        run: npm test
`;

  test('matrix.include with shell:zsh for macOS + shell:pwsh for Windows + defaults.run.shell: ${{ matrix.shell }} yields zero violations', () => {
    const result = inspectWorkflow(MATRIX_SHELL_YAML, { filePath: '<synthetic-matrix-shell-positive>' });

    const violations = result.jobs
      .flatMap(j => j.steps)
      .filter(s => s.violation !== null);

    assert.strictEqual(
      violations.length,
      0,
      'matrix.shell resolved per realization must produce zero violations. Got: ' +
      violations.map(v => `runner=${v.runner} shell=${v.effectiveShell} type=${v.violation}`).join(', ')
    );
  });
});

// ---------------------------------------------------------------------------
// Test 7b — Counter-test: matrix.include row with wrong shell value
// (mechanism: if a row's shell value doesn't match its OS policy, WRONG_SHELL_FOR_OS fires)
// ---------------------------------------------------------------------------
describe('matrix.shell: ${{ matrix.shell }} with wrong value per row — WRONG_SHELL_FOR_OS', () => {
  const MATRIX_SHELL_WRONG_YAML = `
name: Matrix Shell Wrong Row
jobs:
  build:
    runs-on: \${{ matrix.os }}
    defaults:
      run:
        shell: \${{ matrix.shell }}
    strategy:
      matrix:
        include:
          - os: macos-latest
            shell: bash
          - os: windows-2025
            shell: pwsh
    steps:
      - name: Run tests
        run: npm test
`;

  test('matrix.include row with shell:bash for macOS produces WRONG_SHELL_FOR_OS (bash is wrong for macOS)', () => {
    const result = inspectWorkflow(MATRIX_SHELL_WRONG_YAML, { filePath: '<synthetic-matrix-shell-wrong>' });

    const violations = result.jobs
      .flatMap(j => j.steps)
      .filter(s => s.violation !== null);

    // macOS realization: shell resolves to bash → WRONG_SHELL_FOR_OS
    // Windows realization: shell resolves to pwsh → compliant
    assert.strictEqual(
      violations.length,
      1,
      `Expected exactly 1 violation (macos-latest bash→WRONG_SHELL_FOR_OS) but got ${violations.length}: ` +
      violations.map(v => `runner=${v.runner} shell=${v.effectiveShell} type=${v.violation}`).join(', ')
    );

    assert.strictEqual(
      violations[0].runner,
      'macos-latest',
      `Expected violation for macos-latest but got ${violations[0].runner}`
    );

    assert.strictEqual(
      violations[0].violation,
      VIOLATION.WRONG_SHELL_FOR_OS,
      `Expected WRONG_SHELL_FOR_OS but got ${violations[0].violation}`
    );
  });
});

// ---------------------------------------------------------------------------
// Test 7c — Counter-test: matrix.include row missing the shell key while
// defaults.run.shell: ${{ matrix.shell }} references it → UNRESOLVABLE_MATRIX
// ---------------------------------------------------------------------------
describe('matrix.shell expression references missing key — UNRESOLVABLE_MATRIX', () => {
  const MATRIX_SHELL_MISSING_KEY_YAML = `
name: Matrix Shell Missing Key
jobs:
  build:
    runs-on: \${{ matrix.os }}
    defaults:
      run:
        shell: \${{ matrix.shell }}
    strategy:
      matrix:
        include:
          - os: ubuntu-latest
            node-version: 24
    steps:
      - name: Run tests
        run: npm test
`;

  test('matrix.include row without shell key while defaults.run.shell: ${{ matrix.shell }} → UNRESOLVABLE_MATRIX', () => {
    const result = inspectWorkflow(MATRIX_SHELL_MISSING_KEY_YAML, { filePath: '<synthetic-matrix-shell-missing-key>' });

    const violations = result.jobs
      .flatMap(j => j.steps)
      .filter(s => s.violation !== null);

    assert.strictEqual(
      violations.length,
      1,
      `Expected exactly 1 UNRESOLVABLE_MATRIX violation but got ${violations.length}: ` +
      violations.map(v => `runner=${v.runner} type=${v.violation}`).join(', ')
    );

    assert.strictEqual(
      violations[0].violation,
      VIOLATION.UNRESOLVABLE_MATRIX,
      `Expected UNRESOLVABLE_MATRIX but got ${violations[0].violation}`
    );

    assert.strictEqual(
      violations[0].runner,
      'ubuntu-latest',
      `Expected runner ubuntu-latest but got ${violations[0].runner}`
    );
  });
});

// ---------------------------------------------------------------------------
// Test 7 — Counter-test: workflow-level defaults.run.shell: zsh satisfies macOS H1
// (mechanism: resolution order puts workflow defaults above runner default;
//  zsh at workflow level means macOS steps inherit it without step-level pin)
// ---------------------------------------------------------------------------
describe('counter-test: workflow-level defaults.run.shell: zsh satisfies macos-* H1', () => {
  const WORKFLOW_DEFAULTS_ZSH_YAML = `
name: Workflow Defaults ZSH
defaults:
  run:
    shell: zsh
jobs:
  build:
    runs-on: macos-latest
    steps:
      - name: Run tests on macOS
        run: npm test
`;

  test('workflow-level shell: zsh + macos-latest + no step-level shell produces zero violations', () => {
    const result = inspectWorkflow(WORKFLOW_DEFAULTS_ZSH_YAML, { filePath: '<synthetic-workflow-defaults-zsh>' });

    assert.strictEqual(
      result.workflowDefaultsShell,
      'zsh',
      `Expected workflowDefaultsShell to be zsh but got ${result.workflowDefaultsShell}`
    );

    const violations = result.jobs
      .flatMap(j => j.steps)
      .filter(s => s.violation !== null);

    assert.strictEqual(
      violations.length,
      0,
      `Workflow-level shell: zsh must satisfy H1 for macos-latest steps (resolution-order rule). Got ${violations.length} violations: ` +
      violations.map(v => `${v.violation}`).join(', ')
    );
  });

  test('effective shell for macOS step is zsh when inherited from workflow defaults', () => {
    const result = inspectWorkflow(WORKFLOW_DEFAULTS_ZSH_YAML, { filePath: '<synthetic-workflow-defaults-zsh>' });

    const step = result.jobs[0]?.steps[0];
    assert.ok(step, 'Expected at least one step');

    assert.strictEqual(
      step.effectiveShell,
      'zsh',
      `Expected effectiveShell to be zsh (inherited from workflow defaults) but got ${step.effectiveShell}`
    );

    assert.strictEqual(
      step.stepShell,
      null,
      `Expected stepShell to be null (no step-level pin) but got ${step.stepShell}`
    );
  });
});

// ---------------------------------------------------------------------------
// Test 8a — Counter-test: Cartesian matrix os × shell — dedup must not collapse rows by runner alone
// (mechanism: matrix.os: [macos-latest, macos-latest] with matrix.shell: [zsh, bash]
//  and runs-on: ${{ matrix.os }}, step shell: ${{ matrix.shell }}.
//  The base-list path in expandRunsOn previously deduped by runner alone, collapsing
//  both macos-latest rows into one. Post-fix: each entry is pushed unconditionally,
//  producing 2 realizations from the base-list os array.
//
//  NOTE: Cartesian cross-product expansion (expanding the full os × shell grid so
//  that each realization carries BOTH os and shell in its context) is not yet
//  implemented in expandRunsOn. The base-list path only records { os: runner } in
//  context, so ${{ matrix.shell }} on the step cannot be resolved and the linter
//  emits UNRESOLVABLE_MATRIX. The ideal post-Cartesian-expansion behavior would be
//  2 WRONG_SHELL_FOR_OS violations (the bash rows). That is a separate follow-up bug.
//
//  This test validates the dedupe fix only: 2 violations must be produced (not 1),
//  proving the base-list path no longer collapses duplicate runner values.
// ---------------------------------------------------------------------------
describe('Cartesian matrix os × shell — dedup must not collapse rows by runner alone', () => {
  const CARTESIAN_MATRIX_YAML = `
name: Cartesian Matrix
jobs:
  build:
    runs-on: \${{ matrix.os }}
    strategy:
      matrix:
        os: [macos-latest, macos-latest]
        shell: [zsh, bash]
    steps:
      - name: Run tests
        shell: \${{ matrix.shell }}
        run: echo hi
`;

  test('Cartesian matrix os × shell — dedup must not collapse rows by runner alone', () => {
    const result = inspectWorkflow(CARTESIAN_MATRIX_YAML, { filePath: '<synthetic-cartesian-matrix>' });

    const violations = result.jobs
      .flatMap(j => j.steps)
      .filter(s => s.violation !== null);

    // The dedupe fix ensures both macos-latest entries in matrix.os are expanded
    // independently, yielding 2 realizations — not 1 (as the old dedup-by-runner
    // guard would produce). Each realization's ${{ matrix.shell }} is currently
    // UNRESOLVABLE_MATRIX because the base-list path doesn't yet carry shell context
    // (Cartesian cross-product is a separate follow-up fix).
    assert.strictEqual(
      violations.length,
      2,
      `Expected exactly 2 violations (dedup fix: both macos-latest rows preserved) but got ${violations.length}: ` +
      violations.map(v => `runner=${v.runner} shell=${v.effectiveShell} type=${v.violation}`).join(', ')
    );

    for (const v of violations) {
      assert.strictEqual(
        v.runner,
        'macos-latest',
        `Expected violation runner to be macos-latest but got ${v.runner}`
      );
      // UNRESOLVABLE_MATRIX because Cartesian cross-product expansion is not yet
      // implemented; ${{ matrix.shell }} cannot be resolved from base-list context.
      // When Cartesian expansion is added, these will become WRONG_SHELL_FOR_OS
      // (for the bash rows) and compliant (for the zsh rows).
      assert.strictEqual(
        v.violation,
        VIOLATION.UNRESOLVABLE_MATRIX,
        `Expected UNRESOLVABLE_MATRIX (shell key absent from base-list context) but got ${v.violation}`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Test 8 — Counter-test: two macos-latest matrix.include rows where
// row 1 has shell: zsh (compliant) and row 2 has shell: bash (violation).
// Guards against the dedup bug where runner-label-only deduplication would
// collapse both rows into one, hiding the second row's policy violation.
// Expected: EXACTLY ONE WRONG_SHELL_FOR_OS violation (on the second row).
// ---------------------------------------------------------------------------
describe('counter-test: two macos-latest rows — dedup must not hide second row violation', () => {
  const TWO_MACOS_ROWS_YAML = `
name: Two macOS Rows
jobs:
  build:
    runs-on: \${{ matrix.os }}
    strategy:
      matrix:
        include:
          - os: macos-latest
            node-version: 22
            shell: zsh
          - os: macos-latest
            node-version: 24
            shell: bash
    steps:
      - name: Run tests
        shell: \${{ matrix.shell }}
        run: npm test
`;

  test('two macos-latest matrix.include rows (zsh + bash) produce exactly one WRONG_SHELL_FOR_OS violation on the second row', () => {
    const result = inspectWorkflow(TWO_MACOS_ROWS_YAML, { filePath: '<synthetic-two-macos-rows>' });

    const violations = result.jobs
      .flatMap(j => j.steps)
      .filter(s => s.violation !== null);

    assert.strictEqual(
      violations.length,
      1,
      `Expected exactly 1 violation (second macos-latest row shell:bash → WRONG_SHELL_FOR_OS) but got ${violations.length}: ` +
      violations.map(v => `runner=${v.runner} shell=${v.effectiveShell} type=${v.violation}`).join(', ')
    );

    assert.strictEqual(
      violations[0].violation,
      VIOLATION.WRONG_SHELL_FOR_OS,
      `Expected WRONG_SHELL_FOR_OS but got ${violations[0].violation}`
    );

    assert.strictEqual(
      violations[0].runner,
      'macos-latest',
      `Expected violation runner to be macos-latest but got ${violations[0].runner}`
    );

    assert.strictEqual(
      violations[0].effectiveShell,
      'bash',
      `Expected effectiveShell to be bash (the violating row) but got ${violations[0].effectiveShell}`
    );
  });
});
