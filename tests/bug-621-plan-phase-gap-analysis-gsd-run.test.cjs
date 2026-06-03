// allow-test-rule: source-text-is-the-product
// The post-planning-gaps gap-analysis invocation is deployed workflow text the
// runtime executes; the contract is that it routes through the gsd_run launcher,
// not a hardcoded $HOME path (#621).

/**
 * Regression test for #621: plan-phase gap-analysis must route through gsd_run
 *
 * Prior to the fix, line 1631 of plan-phase.md hardcoded:
 *   node "$HOME/.claude/gsd-core/bin/gsd-tools.cjs" gap-analysis ...
 * twice on the same line, breaking non-default install layouts.
 *
 * After the fix, both invocations route through gsd_run (the launcher defined
 * at line ~34 of the same file that resolves gsd-tools.cjs against
 * RUNTIME_DIR / git-toplevel / PATH / $HOME in order).
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
  'plan-phase.md'
);

// ─── Fixture ──────────────────────────────────────────────────────────────────

const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');

// ─── #621 regression: gap-analysis routes through gsd_run ────────────────────

describe('plan-phase workflow: post-planning-gaps gap-analysis uses gsd_run launcher (#621)', () => {
  test('gap-analysis call routes through gsd_run, not hardcoded node path', () => {
    assert.ok(
      workflow.includes('gsd_run gap-analysis'),
      'workflow must invoke gap-analysis via gsd_run, not a hardcoded node path'
    );
  });

  test('inner phase_req_ids query also routes through gsd_run', () => {
    assert.ok(
      workflow.includes('gsd_run query init.plan-phase'),
      'workflow must invoke the inner phase_req_ids query via gsd_run launcher'
    );
  });

  test('no hardcoded node "$HOME/.claude/gsd-core/bin/gsd-tools.cjs" invocations remain (#621)', () => {
    const hardcodedCount = (
      workflow.match(/node "\$HOME\/\.claude\/gsd-core\/bin\/gsd-tools\.cjs"/g) || []
    ).length;
    assert.strictEqual(
      hardcodedCount,
      0,
      [
        '#621 regression: workflow must not contain any hardcoded',
        'node "$HOME/.claude/gsd-core/bin/gsd-tools.cjs" invocations;',
        `found ${hardcodedCount}`,
      ].join(' ')
    );
  });

  test('post-planning-gaps block still gates on workflow.post_planning_gaps and preserves required args', () => {
    const hasGate = workflow.includes('workflow.post_planning_gaps');
    const hasPhaseDir = workflow.includes('--phase-dir "${PHASE_DIR}"');
    const hasPickArg = workflow.includes('--pick phase_req_ids');
    assert.ok(
      hasGate,
      'workflow must still gate the gap-analysis step on workflow.post_planning_gaps config key'
    );
    assert.ok(
      hasPhaseDir,
      'gap-analysis invocation must still pass --phase-dir "${PHASE_DIR}"'
    );
    assert.ok(
      hasPickArg,
      'inner query must still pass --pick phase_req_ids to extract phase requirement IDs'
    );
  });
});
