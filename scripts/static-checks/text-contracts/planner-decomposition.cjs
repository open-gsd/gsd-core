'use strict';

// The planner's modular decomposition (#3320, #3440): agents/gsd-planner.md stays under the 100K agent file threshold and
// under 48K characters (the three mode sections were extracted), points at the three extracted references (gap closure,
// revision, reviews), each of which keeps its mode's content; the gap-closure return is artifact based (no retired
// completion marker); the planner keeps fenced implementation code out of `<action>` blocks, and plan-phase.md's
// <deep_work_rules> and quality gate allow behavior and test assertions without code dumps. Was
// tests/planner-decomposition.test.cjs (with the folded bug-3320 cases). Sizes are lengths of the LF-normalised text.

const PLANNER = 'agents/gsd-planner.md';
const GAP_CLOSURE = 'gsd-core/references/planner-gap-closure.md';
const REVISION = 'gsd-core/references/planner-revision.md';
const REVIEWS = 'gsd-core/references/planner-reviews.md';
const GUIDANCE = 'gsd-core/references/planner-guidance.md';
const PLAN_PHASE = 'gsd-core/workflows/plan-phase.md';
const AGENT_FILE_SIZE_LIMIT = 100 * 1024;
const PLANNER_EXTRACTED_LIMIT = 48 * 1024;

module.exports = {
  id: 'planner-decomposition',
  issue: '#3320',
  check(ctx) {
    ctx.doc(PLANNER)
      .shorterThan(AGENT_FILE_SIZE_LIMIT, 'gsd-planner.md must stay under the 100K agent file threshold')
      .shorterThan(PLANNER_EXTRACTED_LIMIT, 'gsd-planner.md must stay under 48K characters after extracting the mode sections')
      .has('planner-gap-closure.md', 'gsd-planner.md must reference planner-gap-closure.md')
      .has('planner-revision.md', 'gsd-planner.md must reference planner-revision.md')
      .has('planner-reviews.md', 'gsd-planner.md must reference planner-reviews.md')
      .lacks('## GAP CLOSURE PLANS CREATED', 'gsd-planner.md must not emit the retired gap-closure marker: no workflow dispatches on it (#3440)')
      .has('NEVER place fenced code blocks (```) inside `<action>`', 'gsd-planner.md must explicitly forbid fenced implementation code in <action>')
      .has('Code excerpts belong in `<read_first>` source files or referenced context', 'gsd-planner.md must route code excerpts to context and read-first material');

    ctx.doc(GAP_CLOSURE).satisfies((text) => {
      const lower = text.toLowerCase();
      return lower.includes('gap_closure') || lower.includes('gap closure') || text.includes('--gaps');
    }, 'planner-gap-closure.md must contain gap closure mode content (gap_closure, gap closure or --gaps)');
    ctx.doc(REVISION).has(/revision|Revision|REVISION/, 'planner-revision.md must contain revision mode content');
    ctx.doc(REVIEWS).has(/reviews|Reviews|REVIEWS/, 'planner-reviews.md must contain reviews mode content');

    ctx.doc(GUIDANCE)
      .lacks('## GAP CLOSURE PLANS CREATED', 'planner-guidance.md must not emit the retired gap-closure marker: no workflow dispatches on it (#3440)')
      .has('gap_closure: true', 'planner-guidance.md must document the artifact return contract (gap_closure: true plans)')
      .has('--gaps-only', 'planner-guidance.md must name the consumer route (execute-phase --gaps-only)');

    const workflow = ctx.doc(PLAN_PHASE);
    workflow.slice('<deep_work_rules>', '</deep_work_rules>')
      .lacks('copy them into the action verbatim', 'deep_work_rules must not tell planners to copy source material verbatim into <action>')
      .lacks('complete the task from the action text alone', 'deep_work_rules must not make <action> self-sufficient without read_first and context')
      .has('Do not include full file contents, fenced code blocks, or complete implementations in `<action>`', 'deep_work_rules must explicitly bound concrete values to avoid code dumping')
      .has('behavior assertion', 'acceptance criteria must allow behavior assertions, not just grep checks')
      .has('test command', 'acceptance criteria must allow test-command assertions');
    workflow
      .has('Every task has `<acceptance_criteria>` with behavior, test-command, CLI, or source assertions', 'the quality gate must not narrow acceptance criteria back to grep-only checks')
      .has('Every `<action>` contains concrete identifiers without fenced code blocks or full implementations', 'the quality gate must enforce concrete prose without implementation dumps');
  },
};
