// allow-test-rule: source-text-is-the-product #1369
// Workflow .md files are the installed AI instructions — their text IS what the runtime
// loads. Testing text content tests the deployed contract. Per CONTRIBUTING.md exception matrix.

/**
 * Regression tests for bug #1369: execute-phase worktree agents fork from stale base after
 * a wave merge advances orchestrator HEAD past origin/HEAD.
 *
 * The fix: execute-phase.md now re-runs worktree.base-check at the start of EVERY wave
 * (step 0.5 in the "For each wave" loop). If HEAD has diverged from origin/HEAD (which
 * happens as soon as Wave N's merges land), USE_WORKTREES is overridden to false for that
 * wave, preventing the `worktree_branch_check` exit-42 halts observed in the bug.
 *
 * Step 0.5 content lives in references/execute-phase-wave-guard.md (extracted to satisfy
 * the ADR-857 size cap). execute-phase.md retains the @-reference pointer so the runtime
 * loads it inline. Step 7c (and 7b) live in references/execute-phase-between-wave-reset.md.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WORKFLOW_PATH = path.join(
  __dirname,
  '..',
  'gsd-core',
  'workflows',
  'execute-phase.md'
);

const WAVE_GUARD_PATH = path.join(
  __dirname,
  '..',
  'gsd-core',
  'references',
  'execute-phase-wave-guard.md'
);

const BETWEEN_WAVE_RESET_PATH = path.join(
  __dirname,
  '..',
  'gsd-core',
  'references',
  'execute-phase-between-wave-reset.md'
);

describe('execute-phase: inter-wave worktree base re-check (#1369)', () => {
  test('workflow file exists', () => {
    assert.ok(fs.existsSync(WORKFLOW_PATH), 'workflows/execute-phase.md should exist');
  });

  test('workflow contains step 0.5 inter-wave base re-check section', () => {
    // Step 0.5 content was extracted to execute-phase-wave-guard.md (ADR-857 size cap).
    // execute-phase.md must retain the @-reference pointer so the runtime loads it inline.
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    assert.ok(
      content.includes('execute-phase-wave-guard.md'),
      'execute-phase.md must @-reference execute-phase-wave-guard.md (which contains step 0.5 "Inter-wave worktree base re-check")'
    );
    // The reference file itself must contain the step header
    const guardContent = fs.readFileSync(WAVE_GUARD_PATH, 'utf-8');
    assert.ok(
      guardContent.includes('0.5.') && guardContent.includes('Inter-wave worktree base re-check'),
      'execute-phase-wave-guard.md must have step 0.5 "Inter-wave worktree base re-check"'
    );
  });

  test('step 0.5 references #1369', () => {
    const content = fs.readFileSync(WAVE_GUARD_PATH, 'utf-8');
    const idx = content.indexOf('0.5.');
    assert.ok(idx !== -1, 'step 0.5 must exist in execute-phase-wave-guard.md');
    // Check #1369 appears in the vicinity (within 2000 chars of step 0.5)
    const excerpt = content.slice(idx, idx + 2000);
    assert.ok(
      excerpt.includes('#1369'),
      'step 0.5 must reference #1369 for traceability'
    );
  });

  test('step 0.5 runs worktree.base-check inside the For-each-wave loop', () => {
    const workflowContent = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    // The "For each wave" header must appear BEFORE the @-reference to execute-phase-wave-guard.md
    const forEachIdx = workflowContent.indexOf('**For each wave:**');
    const refIdx = workflowContent.indexOf('execute-phase-wave-guard.md');
    assert.ok(forEachIdx !== -1, '"For each wave:" section must exist in execute-phase.md');
    assert.ok(refIdx !== -1, '@-reference to execute-phase-wave-guard.md must exist in execute-phase.md');
    assert.ok(
      refIdx > forEachIdx,
      'execute-phase-wave-guard.md @-reference must appear AFTER "For each wave:" so step 0.5 runs per-wave, not once at init'
    );
  });

  test('step 0.5 runs worktree.base-check command', () => {
    const content = fs.readFileSync(WAVE_GUARD_PATH, 'utf-8');
    const idx = content.indexOf('0.5.');
    assert.ok(idx !== -1, 'step 0.5 must exist in execute-phase-wave-guard.md');
    const excerpt = content.slice(idx, idx + 2000);
    assert.ok(
      excerpt.includes('worktree.base-check'),
      'step 0.5 must invoke worktree.base-check to detect HEAD vs fork-base divergence'
    );
  });

  test('step 0.5 sets USE_WORKTREES=false when shouldDegrade is true', () => {
    const content = fs.readFileSync(WAVE_GUARD_PATH, 'utf-8');
    const idx = content.indexOf('0.5.');
    assert.ok(idx !== -1, 'step 0.5 must exist in execute-phase-wave-guard.md');
    const excerpt = content.slice(idx, idx + 2000);
    assert.ok(
      excerpt.includes('USE_WORKTREES=false'),
      'step 0.5 must override USE_WORKTREES=false when base divergence is detected'
    );
  });

  test('step 0.5 appears before step 1 (intra-wave overlap check)', () => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    // The @-reference for step 0.5 must appear BEFORE step 1 in execute-phase.md
    const refIdx = content.indexOf('execute-phase-wave-guard.md');
    // Find "1. **Intra-wave" after the "For each wave" heading
    const forEachIdx = content.indexOf('**For each wave:**');
    const step1Idx = content.indexOf('1. **Intra-wave', forEachIdx);
    assert.ok(refIdx !== -1, '@-reference to execute-phase-wave-guard.md must exist');
    assert.ok(step1Idx !== -1, 'step 1 (intra-wave overlap check) must exist in execute-phase.md');
    assert.ok(
      refIdx < step1Idx,
      'execute-phase-wave-guard.md @-reference must appear before step 1 so the base re-check runs before overlap detection'
    );
  });

  test('step 0.5 guards on RUNTIME=claude (worktree isolation is Claude Code-specific)', () => {
    const content = fs.readFileSync(WAVE_GUARD_PATH, 'utf-8');
    const idx = content.indexOf('0.5.');
    assert.ok(idx !== -1, 'step 0.5 must exist in execute-phase-wave-guard.md');
    const excerpt = content.slice(idx, idx + 2000);
    assert.ok(
      excerpt.includes('RUNTIME') && (excerpt.includes('"claude"') || excerpt.includes("'claude'")),
      'step 0.5 must guard on RUNTIME=claude (isolation="worktree" is Claude Code-specific)'
    );
  });

  test('step 0.5 explains root cause: wave merges advance HEAD past origin/HEAD', () => {
    const content = fs.readFileSync(WAVE_GUARD_PATH, 'utf-8');
    const idx = content.indexOf('0.5.');
    assert.ok(idx !== -1, 'step 0.5 must exist in execute-phase-wave-guard.md');
    const excerpt = content.slice(idx, idx + 2000);
    assert.ok(
      excerpt.includes('origin/HEAD'),
      'step 0.5 must name origin/HEAD as the stale fork base that causes the mismatch'
    );
  });

  test('step 0.5 cross-references #683 for worktree.baseRef configuration', () => {
    const content = fs.readFileSync(WAVE_GUARD_PATH, 'utf-8');
    const idx = content.indexOf('0.5.');
    assert.ok(idx !== -1, 'step 0.5 must exist in execute-phase-wave-guard.md');
    const excerpt = content.slice(idx, idx + 2000);
    assert.ok(
      excerpt.includes('#683'),
      'step 0.5 must cross-reference #683 where worktree.baseRef:"head" is the permanent fix'
    );
  });

  test('step 0.5 mentions worktree.baseRef:"head" as permanent fix', () => {
    const content = fs.readFileSync(WAVE_GUARD_PATH, 'utf-8');
    const idx = content.indexOf('0.5.');
    assert.ok(idx !== -1, 'step 0.5 must exist in execute-phase-wave-guard.md');
    const excerpt = content.slice(idx, idx + 2000);
    assert.ok(
      excerpt.includes('worktree.baseRef') && excerpt.includes('head'),
      'step 0.5 must mention worktree.baseRef:"head" as the way to avoid per-wave degradation'
    );
  });
});

describe('execute-phase: between-wave manifest reset (#1369, #3384)', () => {
  test('step 7c exists with between-wave manifest reset (#1369)', () => {
    // Step 7c content was extracted to execute-phase-between-wave-reset.md (ADR-857 size cap).
    // execute-phase.md must retain the @-reference pointer so the runtime loads it inline.
    const workflowContent = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    assert.ok(
      workflowContent.includes('execute-phase-between-wave-reset.md'),
      'execute-phase.md must @-reference execute-phase-between-wave-reset.md (which contains step 7c "Between-wave manifest reset")'
    );
    const content = fs.readFileSync(BETWEEN_WAVE_RESET_PATH, 'utf-8');
    assert.ok(
      content.includes('7c.') && content.includes('Between-wave manifest reset'),
      'execute-phase-between-wave-reset.md must have step 7c "Between-wave manifest reset"'
    );
  });

  test('step 7c unsets WAVE_WORKTREE_MANIFEST between waves', () => {
    const content = fs.readFileSync(BETWEEN_WAVE_RESET_PATH, 'utf-8');
    const idx = content.indexOf('7c.');
    assert.ok(idx !== -1, 'step 7c must exist in execute-phase-between-wave-reset.md');
    const excerpt = content.slice(idx, idx + 2000);
    assert.ok(
      excerpt.includes('unset WAVE_WORKTREE_MANIFEST'),
      'step 7c must unset WAVE_WORKTREE_MANIFEST so wave N+1 creates a fresh manifest (#3384)'
    );
  });

  test('step 7c references #1369 and #3384 for traceability', () => {
    const content = fs.readFileSync(BETWEEN_WAVE_RESET_PATH, 'utf-8');
    const idx = content.indexOf('7c.');
    assert.ok(idx !== -1, 'step 7c must exist in execute-phase-between-wave-reset.md');
    const excerpt = content.slice(idx, idx + 2000);
    assert.ok(excerpt.includes('#1369'), 'step 7c must reference #1369');
    assert.ok(excerpt.includes('#3384'), 'step 7c must reference #3384 (manifest guard)');
  });

  test('step 7c calls worktree.set-baseref to re-assert head config', () => {
    const content = fs.readFileSync(BETWEEN_WAVE_RESET_PATH, 'utf-8');
    const idx = content.indexOf('7c.');
    assert.ok(idx !== -1, 'step 7c must exist in execute-phase-between-wave-reset.md');
    const excerpt = content.slice(idx, idx + 2000);
    assert.ok(
      excerpt.includes('worktree.set-baseref'),
      'step 7c must call worktree.set-baseref to idempotently re-assert head config between waves'
    );
  });

  test('step 7c appears after step 7b and before step 8 in the wave loop', () => {
    const refContent = fs.readFileSync(BETWEEN_WAVE_RESET_PATH, 'utf-8');
    const workflowContent = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    // 7b and 7c are both in the between-wave-reset reference file
    const idx7b = refContent.indexOf('7b.');
    const idx7c = refContent.indexOf('7c.');
    // Step 8 is in execute-phase.md, after the @-reference to between-wave-reset
    const refIdx = workflowContent.indexOf('execute-phase-between-wave-reset.md');
    const idx8 = workflowContent.indexOf('\n8. **Execute checkpoint plans', refIdx);
    assert.ok(idx7b !== -1, 'step 7b must exist in execute-phase-between-wave-reset.md');
    assert.ok(idx7c !== -1, 'step 7c must exist in execute-phase-between-wave-reset.md');
    assert.ok(idx8 !== -1, 'step 8 must exist in execute-phase.md after the between-wave-reset @-reference');
    assert.ok(idx7b < idx7c, 'step 7c must appear after step 7b');
    // Also verify the @-reference comes before step 8 (confirming step 7c is inline before step 8)
    assert.ok(refIdx < idx8, '@-reference to execute-phase-between-wave-reset.md must appear before step 8');
  });

  test('step 7c guards on RUNTIME=claude for worktree-specific operations', () => {
    const content = fs.readFileSync(BETWEEN_WAVE_RESET_PATH, 'utf-8');
    const idx = content.indexOf('7c.');
    assert.ok(idx !== -1, 'step 7c must exist in execute-phase-between-wave-reset.md');
    const excerpt = content.slice(idx, idx + 2000);
    assert.ok(
      excerpt.includes('RUNTIME') && (excerpt.includes('"claude"') || excerpt.includes("'claude'")),
      'step 7c must guard on RUNTIME=claude for Claude Code-specific worktree operations'
    );
  });
});
