// allow-test-rule: source-text-is-the-product #1369
// Workflow .md files are the installed AI instructions — their text IS what the runtime
// loads. Testing text content tests the deployed contract. Per CONTRIBUTING.md exception matrix.

/**
 * Regression tests for bug #1369: execute-phase worktree agents fork from stale base after
 * a wave merge advances orchestrator HEAD past origin/HEAD.
 *
 * Steps 0.5 and 7b+7c are extracted to reference files to satisfy the ADR-857 size cap.
 * execute-phase.md contains @-reference pointers; the reference files hold the content.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WORKFLOW_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-phase.md');
const WAVE_GUARD_PATH = path.join(__dirname, '..', 'gsd-core', 'references', 'execute-phase-wave-guard.md');
const BETWEEN_WAVE_PATH = path.join(__dirname, '..', 'gsd-core', 'references', 'execute-phase-between-wave-reset.md');

describe('execute-phase: inter-wave worktree base re-check (#1369)', () => {
  test('workflow file exists', () => {
    assert.ok(fs.existsSync(WORKFLOW_PATH), 'workflows/execute-phase.md should exist');
  });

  test('wave-guard reference file exists', () => {
    assert.ok(fs.existsSync(WAVE_GUARD_PATH), 'references/execute-phase-wave-guard.md should exist');
  });

  test('workflow contains @-reference pointer to wave-guard (step 0.5 injected at runtime)', () => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    assert.ok(
      content.includes('execute-phase-wave-guard.md'),
      'execute-phase.md must have an @-reference to execute-phase-wave-guard.md'
    );
  });

  test('workflow contains step 0.5 inter-wave base re-check section', () => {
    const content = fs.readFileSync(WAVE_GUARD_PATH, 'utf-8');
    assert.ok(
      content.includes('0.5.') && content.includes('Inter-wave worktree base re-check'),
      'execute-phase-wave-guard.md must have step 0.5 "Inter-wave worktree base re-check"'
    );
  });

  test('step 0.5 references #1369', () => {
    const content = fs.readFileSync(WAVE_GUARD_PATH, 'utf-8');
    assert.ok(content.includes('#1369'), 'step 0.5 must reference #1369 for traceability');
  });

  test('step 0.5 runs worktree.base-check inside the For-each-wave loop', () => {
    const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    const forEachIdx = workflow.indexOf('**For each wave:**');
    const refIdx = workflow.indexOf('execute-phase-wave-guard.md');
    assert.ok(forEachIdx !== -1, '"For each wave:" section must exist in execute-phase.md');
    assert.ok(refIdx !== -1, '@-reference to wave-guard must exist in execute-phase.md');
    assert.ok(refIdx > forEachIdx, 'wave-guard @-reference must appear AFTER "For each wave:" so step 0.5 runs per-wave');
  });

  test('step 0.5 runs worktree.base-check command', () => {
    const content = fs.readFileSync(WAVE_GUARD_PATH, 'utf-8');
    assert.ok(content.includes('worktree.base-check'), 'step 0.5 must invoke worktree.base-check');
  });

  test('step 0.5 sets USE_WORKTREES=false when shouldDegrade is true', () => {
    const content = fs.readFileSync(WAVE_GUARD_PATH, 'utf-8');
    assert.ok(content.includes('USE_WORKTREES=false'), 'step 0.5 must override USE_WORKTREES=false when base divergence is detected');
  });

  test('step 0.5 appears before step 1 (intra-wave overlap check)', () => {
    const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    const forEachIdx = workflow.indexOf('**For each wave:**');
    const refIdx = workflow.indexOf('execute-phase-wave-guard.md');
    const step1Idx = workflow.indexOf('1. **Intra-wave', forEachIdx);
    assert.ok(refIdx !== -1, 'wave-guard @-reference must exist');
    assert.ok(step1Idx !== -1, 'step 1 (intra-wave overlap check) must exist');
    assert.ok(refIdx < step1Idx, 'wave-guard @-reference must appear before step 1');
  });

  test('step 0.5 guards on RUNTIME=claude (worktree isolation is Claude Code-specific)', () => {
    const content = fs.readFileSync(WAVE_GUARD_PATH, 'utf-8');
    assert.ok(
      content.includes('RUNTIME') && (content.includes('"claude"') || content.includes("'claude'")),
      'step 0.5 must guard on RUNTIME=claude'
    );
  });

  test('step 0.5 explains root cause: wave merges advance HEAD past origin/HEAD', () => {
    const content = fs.readFileSync(WAVE_GUARD_PATH, 'utf-8');
    assert.ok(content.includes('origin/HEAD'), 'step 0.5 must name origin/HEAD as the stale fork base');
  });

  test('step 0.5 cross-references #683 for worktree.baseRef configuration', () => {
    const content = fs.readFileSync(WAVE_GUARD_PATH, 'utf-8');
    assert.ok(content.includes('#683'), 'step 0.5 must cross-reference #683');
  });

  test('step 0.5 mentions worktree.baseRef:"head" as permanent fix', () => {
    const content = fs.readFileSync(WAVE_GUARD_PATH, 'utf-8');
    assert.ok(
      content.includes('worktree.baseRef') && content.includes('head'),
      'step 0.5 must mention worktree.baseRef:"head"'
    );
  });
});

describe('execute-phase: between-wave manifest reset (#1369, #3384)', () => {
  test('between-wave reference file exists', () => {
    assert.ok(fs.existsSync(BETWEEN_WAVE_PATH), 'references/execute-phase-between-wave-reset.md should exist');
  });

  test('workflow contains @-reference pointer to between-wave-reset', () => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    assert.ok(
      content.includes('execute-phase-between-wave-reset.md'),
      'execute-phase.md must have an @-reference to execute-phase-between-wave-reset.md'
    );
  });

  test('step 7c exists with between-wave manifest reset (#1369)', () => {
    const content = fs.readFileSync(BETWEEN_WAVE_PATH, 'utf-8');
    assert.ok(
      content.includes('7c.') && content.includes('Between-wave manifest reset'),
      'execute-phase-between-wave-reset.md must have step 7c "Between-wave manifest reset"'
    );
  });

  test('step 7c unsets WAVE_WORKTREE_MANIFEST between waves', () => {
    const content = fs.readFileSync(BETWEEN_WAVE_PATH, 'utf-8');
    assert.ok(content.includes('unset WAVE_WORKTREE_MANIFEST'), 'step 7c must unset WAVE_WORKTREE_MANIFEST');
  });

  test('step 7c references #1369 and #3384 for traceability', () => {
    const content = fs.readFileSync(BETWEEN_WAVE_PATH, 'utf-8');
    assert.ok(content.includes('#1369'), 'step 7c must reference #1369');
    assert.ok(content.includes('#3384'), 'step 7c must reference #3384');
  });

  test('step 7c calls worktree.set-baseref to re-assert head config', () => {
    const content = fs.readFileSync(BETWEEN_WAVE_PATH, 'utf-8');
    assert.ok(content.includes('worktree.set-baseref'), 'step 7c must call worktree.set-baseref');
  });

  test('step 7c appears after step 7b and before step 8 in the wave loop', () => {
    const ref = fs.readFileSync(BETWEEN_WAVE_PATH, 'utf-8');
    const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    const idx7b = ref.indexOf('7b.');
    const idx7c = ref.indexOf('7c.');
    const refPtr = workflow.indexOf('execute-phase-between-wave-reset.md');
    const idx8 = workflow.indexOf('8. **Execute checkpoint', refPtr);
    assert.ok(idx7b !== -1, 'step 7b must exist in between-wave reference file');
    assert.ok(idx7c !== -1, 'step 7c must exist in between-wave reference file');
    assert.ok(idx8 !== -1, 'step 8 must exist in execute-phase.md after the between-wave @-reference');
    assert.ok(idx7b < idx7c, 'step 7c must appear after step 7b');
    assert.ok(refPtr < idx8, 'between-wave @-reference must appear before step 8');
  });

  test('step 7c guards on RUNTIME=claude for worktree-specific operations', () => {
    const content = fs.readFileSync(BETWEEN_WAVE_PATH, 'utf-8');
    assert.ok(
      content.includes('RUNTIME') && (content.includes('"claude"') || content.includes("'claude'")),
      'step 7c must guard on RUNTIME=claude'
    );
  });
});
