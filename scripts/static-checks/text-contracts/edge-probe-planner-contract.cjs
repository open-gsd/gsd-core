'use strict';

// The edge-probe planner wiring in plan-phase.md (RR-01/02/03): the phase SPEC is resolved from the init payload
// (SPEC_PATH) on an UN-GATED path, not inside the §4.5 AI-SPEC artifact section (gating it there silently starves
// the planner of the SPEC on non-AI phases, the #550 no-op); the planner <required_reading> block that holds
// {UI_SPEC_PATH} also holds a {SPEC_PATH} entry labelled with Edge Coverage; the <downstream_consumer> block tells
// the planner to lift resolved edges into must_haves.truths, and that instruction is NOT in the orphaned
// planner-subagent-prompt.md; the last <quality_gate> block ties resolved edges to must_haves. Was
// tests/edge-probe-planner-contract.test.cjs. Gaps inside one line are bounded at 500 characters.

const SPEC_RESOLUTION = 'SPEC_PATH=$(_gsd_field "$INIT" spec_path)';
const AI_SPEC_HEADING = '## 4.5. Resolve AI-SPEC Artifact';

// From `open` to the end of its closing tag, or null.
function tagBlock(text, open, close, from = 0) {
  const start = text.indexOf(open, from);
  if (start === -1) return null;
  const end = text.indexOf(close, start);
  return end === -1 ? null : text.slice(start, end + close.length);
}

// The first <required_reading> block that holds {UI_SPEC_PATH}.
function plannerFilesBlock(text) {
  let from = 0;
  for (;;) {
    const start = text.indexOf('<required_reading>', from);
    if (start === -1) return null;
    const end = text.indexOf('</required_reading>', start);
    if (end === -1) return null;
    const block = text.slice(start, end + '</required_reading>'.length);
    if (block.includes('{UI_SPEC_PATH}')) return block;
    from = end + 1;
  }
}

// The last <quality_gate> block.
function qualityGateBlock(text) {
  const start = text.lastIndexOf('<quality_gate>');
  if (start === -1) return null;
  const end = text.indexOf('</quality_gate>', start);
  return end === -1 ? null : text.slice(start, end + '</quality_gate>'.length);
}

// The "## " section that starts at `heading` and runs to the next "\n## " (or the end), or null.
function sectionFrom(text, heading) {
  const start = text.indexOf(heading);
  if (start === -1) return null;
  const next = text.indexOf('\n## ', start + heading.length);
  return text.slice(start, next === -1 ? text.length : next);
}

const inBlock = (extract, missing, check) => (text) => {
  const block = extract(text);
  return block === null ? missing : check(block);
};

module.exports = {
  id: 'edge-probe-planner-contract',
  issue: '#550',
  check(ctx) {
    ctx.doc('gsd-core/workflows/plan-phase.md')
      .has(SPEC_RESOLUTION, 'plan-phase.md must resolve SPEC_PATH from the init payload spec_path')
      .satisfies(inBlock(plannerFilesBlock, 'no planner <required_reading> block holds {UI_SPEC_PATH}', (block) => /[{]SPEC_PATH[}]/.test(block) || 'no {SPEC_PATH}'), 'the planner <required_reading> block (containing {UI_SPEC_PATH}) must also contain {SPEC_PATH}')
      .satisfies(inBlock(plannerFilesBlock, 'no planner <required_reading> block holds {UI_SPEC_PATH}', (block) => /[{]SPEC_PATH[}][^\n]{0,500}Edge Coverage/.test(block) || 'the {SPEC_PATH} entry is not labelled'), '{SPEC_PATH} entry in the planner files_to_read must be labelled as carrying the ## Edge Coverage section')
      .satisfies(inBlock((text) => sectionFrom(text, AI_SPEC_HEADING), `no "${AI_SPEC_HEADING}" section`, (section) => !section.includes(SPEC_RESOLUTION) || 'the resolution is inside the section'), 'SPEC_FILE resolution must NOT live inside the §4.5 AI-SPEC artifact block: gating it there silently starves the planner of the SPEC on non-AI phases')
      .satisfies(inBlock((text) => tagBlock(text, '<downstream_consumer>', '</downstream_consumer>'), 'no <downstream_consumer> block', (block) => (/##\s{0,20}Edge Coverage/.test(block) ? true : 'no ## Edge Coverage')), 'the <downstream_consumer> block must reference ## Edge Coverage')
      .satisfies(inBlock((text) => tagBlock(text, '<downstream_consumer>', '</downstream_consumer>'), 'no <downstream_consumer> block', (block) => (/must_haves\.truths/.test(block) ? true : 'no must_haves.truths')), 'the <downstream_consumer> block must reference must_haves.truths as the lift target')
      .satisfies(inBlock(qualityGateBlock, 'no <quality_gate> block', (block) => (/resolved.{0,500}edge.{0,500}must_haves/i.test(block) ? true : 'no resolved-edge item')), 'the planner quality_gate must contain a checklist item tying resolved edges to must_haves');

    ctx.doc('gsd-core/templates/planner-subagent-prompt.md')
      .lacks(/Edge Coverage/, 'planner-subagent-prompt.md is not loaded at runtime: the Edge Coverage lift instruction must not live there');
  },
};
