'use strict';

// plan-phase.md's planner prompt lifts confirmed SPEC Prohibitions into must_haves.prohibitions, not into
// must_haves.truths (ADR-550 decision 2, PROB-04). The load-bearing lift instruction lives in plan-phase.md's own
// inline <downstream_consumer> block, which spawns the planner, and its <quality_gate> (the last one in the file)
// ties the SPEC prohibitions to must_haves.prohibitions; it must NOT live in templates/planner-subagent-prompt.md,
// which nothing loads at runtime (the edge-probe orphan-prompt regression). Was
// tests/prohibition-probe.planner-contract.test.cjs.

// The last <quality_gate> block of plan-phase.md, or the reason there is none.
function lastQualityGate(text) {
  const start = text.lastIndexOf('<quality_gate>');
  const end = start === -1 ? -1 : text.indexOf('</quality_gate>', start);
  return start === -1 || end === -1 ? null : text.slice(start, end + '</quality_gate>'.length);
}

const inQualityGate = (check) => (text) => {
  const block = lastQualityGate(text);
  return block === null ? 'plan-phase.md has no <quality_gate> block' : check(block);
};

module.exports = {
  id: 'prohibition-probe.planner-contract',
  issue: '#644',
  check(ctx) {
    const planPhase = ctx.doc('gsd-core/workflows/plan-phase.md');
    planPhase.slice('<downstream_consumer>', '</downstream_consumer>')
      .has(/Prohibitions/, 'the <downstream_consumer> block must reference the SPEC Prohibitions section')
      .has(/must_haves\.prohibitions/, 'the <downstream_consumer> block must lift resolved prohibitions into must_haves.prohibitions (ADR-550 D2, not truths)')
      .lacks(/prohibition[^.\n]{0,500}must_haves\.truths|must_haves\.truths[^.\n]{0,500}prohibition/i, 'prohibitions must NOT be lifted into must_haves.truths: truths keeps its positive-observable semantics (ADR-550 D2)');
    planPhase
      .satisfies(inQualityGate((block) => /prohibition/i.test(block) || 'no prohibition item'), 'the planner quality_gate must contain a checklist item covering SPEC prohibitions (PROB-04)')
      .satisfies(inQualityGate((block) => /must_haves\.prohibitions/.test(block) || 'no must_haves.prohibitions'), 'the planner quality_gate must tie SPEC prohibitions to must_haves.prohibitions with no silent drops (PROB-04)');

    ctx.doc('gsd-core/templates/planner-subagent-prompt.md')
      .lacks(/must_haves\.prohibitions/, 'planner-subagent-prompt.md is not loaded at runtime: the prohibitions lift instruction must not live there');
  },
};
