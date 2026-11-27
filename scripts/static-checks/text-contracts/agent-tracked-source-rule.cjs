'use strict';

// gsd-planner and gsd-pattern-mapper write only git-TRACKED source paths into PLAN.md / PATTERNS.md, never a gitignored
// install/runtime mirror (#3645). The planner's agent file is frozen under a 49152-LF-character cap, so its rule is
// projected onto the spawn contract in plan-phase.md (the <tracked_source_paths> block); the mapper carries the gate
// inline. The test accepted `GSD_SOURCE_MIRROR_SENTINEL` or `.gsd/capabilities` for the mirror shape the block rejects;
// the real block carries `.gsd/capabilities`, which the contract asks for. Was tests/agent-tracked-source-rule.test.cjs.

const PLANNER_CAP = 49152;

module.exports = {
  id: 'agent-tracked-source-rule',
  issue: '#3645',
  check(ctx) {
    ctx.doc('gsd-core/workflows/plan-phase.md')
      .slice('<tracked_source_paths>', '</tracked_source_paths>')
      .has(/files_modified/, 'the block must govern files_modified paths')
      .has(/must_haves/, 'the block must govern must_haves paths')
      .has('git ls-files', 'the block must instruct git ls-files verification')
      .has('.gsd/capabilities', 'the block must name the gitignored install-mirror shape it rejects')
      .has(/plugins\//, 'the block must point at tracked plugin-source fallback locations')
      .has(/PATTERNS_PATH/, 'the block must cover paths inherited from {PATTERNS_PATH}')
      .has(/inherit/, 'the block must cover paths inherited from prior phases');

    ctx.doc('agents/gsd-pattern-mapper.md')
      .has('git ls-files', 'gsd-pattern-mapper.md must verify analog paths via git ls-files')
      .has('gitignored install/runtime mirror', 'the mapper must name the gitignored-mirror rejection explicitly')
      .has('never emit mirror paths', 'PATTERNS.md output must be required to never carry mirror paths')
      .has(/plugins\//, 'the mapper must name the plugins/ tracked-origin fallback location')
      .has(/capabilities\//, 'the mapper must name the capabilities/ tracked-origin fallback location');

    ctx.doc('agents/gsd-planner.md')
      .shorterThan(PLANNER_CAP, 'the planner agent file must stay frozen under its cap (the rule lives in plan-phase.md)')
      .lacks('Tracked-source', 'the rule belongs in the spawn contract, not the frozen agent file');
  },
};
