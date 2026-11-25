'use strict';

// Adaptive context enrichment for 1M-token models: execute-phase.md reads CONTEXT_WINDOW (default 200000), gates its
// enrichment on CONTEXT_WINDOW >= 500000, carries prior_wave_summaries and the CONTEXT.md and RESEARCH.md reads in the
// executor enrichment block (within 500 characters of the gate) and a required_reading block for the verifier
// (execute-phase/steps/verify-phase-goal.md, #5118); plan-phase.md gates cross-phase context the same way. Was
// tests/context-enrichment.test.cjs.

const EXECUTE = 'gsd-core/workflows/execute-phase.md';
const VERIFY_STEP = 'gsd-core/workflows/execute-phase/steps/verify-phase-goal.md';
const PLAN = 'gsd-core/workflows/plan-phase.md';
const GATE = 'CONTEXT_WINDOW >= 500000';
const ENRICHMENT_WINDOW = 500;

module.exports = {
  id: 'context-enrichment',
  check(ctx) {
    ctx.doc(EXECUTE)
      .has('CONTEXT_WINDOW', 'execute-phase.md should reference the CONTEXT_WINDOW variable')
      .has('config-get context_window', 'execute-phase.md should read context_window via config-get')
      .has('|| echo "200000"', 'execute-phase.md should default CONTEXT_WINDOW to 200000')
      .has(GATE, 'execute-phase.md should gate enrichment on CONTEXT_WINDOW >= 500000')
      .has('prior_wave_summaries', 'execute-phase.md should include prior_wave_summaries in the enrichment block')
      .has('CONTEXT.md', 'execute-phase.md should reference CONTEXT.md in the conditional enrichment')
      .has('RESEARCH.md', 'execute-phase.md should reference RESEARCH.md in the conditional enrichment')
      .satisfies((text) => {
        const gateAt = text.indexOf(GATE);
        if (gateAt < 0) return 'no CONTEXT_WINDOW >= 500000 conditional';
        return text.substring(gateAt, gateAt + ENRICHMENT_WINDOW).includes('CONTEXT.md') || `not within ${ENRICHMENT_WINDOW} characters of the gate`;
      }, 'the executor enrichment block should include CONTEXT.md')
      .satisfies((text) => {
        const gateAt = text.indexOf(GATE);
        if (gateAt < 0) return 'no CONTEXT_WINDOW >= 500000 conditional';
        return text.substring(gateAt, gateAt + ENRICHMENT_WINDOW).includes('RESEARCH.md') || `not within ${ENRICHMENT_WINDOW} characters of the gate`;
      }, 'the executor enrichment block should include RESEARCH.md');

    const verify = ctx.doc(VERIFY_STEP)
      .has('<required_reading>', 'the verifier step should contain the <required_reading> opening tag')
      .has('</required_reading>', 'the verifier step should contain the </required_reading> closing tag');
    // The verifier's files_to_read is the last required_reading block through the end of the step.
    verify
      .satisfies((text) => text.substring(text.lastIndexOf('<required_reading>')).includes('PLAN.md'), 'the verifier files_to_read should reference PLAN.md')
      .satisfies((text) => text.substring(text.lastIndexOf('<required_reading>')).includes('SUMMARY.md'), 'the verifier files_to_read should reference SUMMARY.md')
      .satisfies((text) => text.substring(text.lastIndexOf('<required_reading>')).includes('{requirements_path}'), 'the verifier files_to_read should reference the REQUIREMENTS.md path ({requirements_path}, workstream-aware)');

    ctx.doc(PLAN)
      .has('CONTEXT_WINDOW', 'plan-phase.md should reference the CONTEXT_WINDOW variable')
      .has('config-get context_window', 'plan-phase.md should read context_window via config-get')
      .has(GATE, 'plan-phase.md should gate cross-phase context on CONTEXT_WINDOW >= 500000')
      .has('CONTEXT.md', 'plan-phase.md should reference CONTEXT.md in the cross-phase enrichment')
      .satisfies((text) => text.includes('cross-phase') || text.includes('Cross-phase'), 'plan-phase.md should mention cross-phase context')
      .has('SUMMARY.md', 'plan-phase.md should reference prior SUMMARY.md files')
      .has('|| echo "200000"', 'plan-phase.md should default CONTEXT_WINDOW to 200000');
  },
};
