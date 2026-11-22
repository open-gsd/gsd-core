'use strict';

// plan-phase keeps the --chain flag (#1620) and never renames or creates a git branch (#2388).
// Step 15 (auto-advance) lives in a Read-loaded step file (#5143) and discuss-phase's chain logic in
// modes/chain.md (#717), so each contract reads the union of the two files. Was
// tests/chain-flag-plan-phase.test.cjs (with the folded bug-2388 test).

const PLAN = 'gsd-core/workflows/plan-phase.md';
const PLAN_STEP = 'gsd-core/workflows/plan-phase/steps/auto-advance-check.md';
const DISCUSS = 'gsd-core/workflows/discuss-phase.md';
const DISCUSS_CHAIN = 'gsd-core/workflows/discuss-phase/modes/chain.md';

const GUARD = 'if [[ ! "$GSD_ARGS" =~ --auto ]] && [[ ! "$GSD_ARGS" =~ --chain ]]; then';

module.exports = {
  id: 'chain-flag-plan-phase',
  issue: '#1620',
  check(ctx) {
    ctx.docs([PLAN, PLAN_STEP])
      .has(GUARD, 'plan-phase should check for both --auto and --chain before clearing chain flag')
      .has('config-set workflow._auto_chain_active true', 'plan-phase should persist chain flag via config-set workflow._auto_chain_active true')
      .has('`--auto` or `--chain` flag present OR `AUTO_CHAIN` is true OR `AUTO_CFG` is true', 'plan-phase auto-advance trigger should check for --chain flag')
      .has('Parse `--auto` and `--chain` flags from $ARGUMENTS', 'plan-phase step 15 should parse both --auto and --chain flags');

    ctx.docs([DISCUSS, DISCUSS_CHAIN])
      .has(GUARD, 'discuss-phase (or discuss-phase/modes/chain.md) should use the same dual-flag guard pattern as plan-phase');

    // #2388: a phase rename is plan-level, not git-level.
    ctx.doc(PLAN)
      .has(/do not.{0,80}branch|branch.{0,80}do not|NEVER.{0,80}branch|branch.{0,80}NEVER/i, 'plan-phase.md must include an explicit instruction not to create or rename git branches')
      .has(/phase rename|phase_slug|branch identity|branch name/, 'plan-phase.md should clarify that phase slug changes do not change the git branch')
      .lacks('git checkout -b', 'plan-phase.md must not instruct LLM to create a new branch via git checkout -b');
  },
};
