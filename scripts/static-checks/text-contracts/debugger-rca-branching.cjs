'use strict';

// RCA branching, the anti-single-cause bias of gsd-debugger (#1960, epic #1957 Phase 2A): the reference
// gsd-core/references/debugger-rca-branching.md exists and the agent's Phase 2 @-includes it; the reference names the
// four Ishikawa categories (code, config, environment, data) and asks for branching across at least two of them rather
// than one linear 5-Whys chain; it documents the AND-gate question (could the failure require more than one
// contributing condition simultaneously) and that root_cause may hold a set while single-cause sessions are unchanged;
// the DEBUG.md template's root_cause field notes it may hold a set; the agent's reasoning checkpoint carries
// candidate_causes and and_gate; debugger-philosophy.md calls out the single-cause bias. The reference is held to the
// phrases it carries (a bare `code`, `data` or `set` anywhere would be satisfied by unrelated text). The test's
// four schema fixtures exercised a function defined in that file, not repo text, and were dropped. Was
// tests/debugger-rca-branching.test.cjs.

const REFERENCE = 'gsd-core/references/debugger-rca-branching.md';

module.exports = {
  id: 'debugger-rca-branching',
  issue: '#1960',
  check(ctx) {
    ctx.exists(REFERENCE, 'debugger-rca-branching.md reference must exist');
    ctx.doc('agents/gsd-debugger.md')
      .has('@~/.claude/gsd-core/references/debugger-rca-branching.md', 'gsd-debugger.md must @-include the RCA-branching reference from Phase 2 (or the reasoning checkpoint)')
      .has(/candidate_causes/, 'the reasoning_checkpoint must include a candidate_causes field (the >=2-category branches)')
      .has(/and_gate/, 'the reasoning_checkpoint must include an and_gate field (the AND-gate answer)');

    ctx.doc(REFERENCE)
      .has(/^- \*\*code\*\*/m, 'the reference must document the code category')
      .has(/^- \*\*config\*\*/m, 'the reference must document the config category')
      .has(/^- \*\*environment\*\*/m, 'the reference must document the environment category')
      .has(/^- \*\*data\*\*/m, 'the reference must document the data category')
      .has('Ishikawa (fishbone)', 'the reference must require branching across >=2 categories (Ishikawa/fishbone)')
      .has(/5-Whys single-cause\s{1,20}bias/, 'the reference must name the 5-Whys / single-cause bias failure mode being guarded against')
      .has(/AND-gate check/, 'the reference must name the AND-gate check')
      .has('Could this failure require more than one contributing condition simultaneously?', 'the reference must ask whether the failure requires multiple contributing conditions simultaneously')
      .has(/root_cause[^\n]{0,500}one cause OR a small\s{1,20}set of contributing causes/, 'the reference must document that root_cause can record multiple contributing causes when the AND-gate fires')
      .has(/single-cause sessions are\s{1,20}byte-for-byte unchanged|shape unchanged/, 'the reference must document that single-cause sessions are unaffected (backward compatible)');

    ctx.doc('gsd-core/templates/DEBUG.md')
      .has(/root_cause/, 'the template must still have the root_cause field')
      .has(/root_cause:[^\n]{0,500}small set of contributing causes/, 'the DEBUG.md root_cause field must note it may hold one or more contributing causes (per RCA branching)');

    ctx.doc('gsd-core/references/debugger-philosophy.md')
      .has(/single[\s-]?cause|5-?\s{0,20}whys|root[\s-]?cause bias/i, 'debugger-philosophy.md must note the single-cause-bias / 5-Whys trap alongside the existing cognitive-bias guidance');
  },
};
