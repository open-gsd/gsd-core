'use strict';

// The prohibition probe's Step 5.6 in spec-phase.md is prose, not a compiled engine (ADR-550 D1 DIVERGENCE, D7b):
// the block must NOT reference a prohibition-probe.cjs invocation, and it carries the protocol prose: the
// adversarial recall question (PROB-01), the precision stage that drops routine engineering items (PROB-02), the
// soft gate (PROB-06), a non-empty dismissal reason (PROB-05), --auto never auto-dismissing (PROB-06), text-mode
// without a hard AskUserQuestion dependency (PROB-09), the SPEC Prohibitions section, the canon-referral
// breadcrumb to /gsd:secure-phase (PROB-13) and the @-include of references/prohibition-probe.md. Assertions
// scope to the Step 5.6 block. Was tests/prohibition-probe.spec-phase-contract.test.cjs. The test also found the
// block by a bare "Step 5.6" when the "## Step 5.6" heading was missing; the heading is required here. The block also needs a following "\n## " heading (the test read to the end of the file when there was none), so Step 5.6 as the last section of spec-phase.md is a finding. Gaps
// inside one sentence are bounded at 500 characters.

module.exports = {
  id: 'prohibition-probe.spec-phase-contract',
  issue: '#644',
  check(ctx) {
    ctx.doc('gsd-core/workflows/spec-phase.md')
      .slice('## Step 5.6', '\n## ')
      .lacks(/prohibition-probe\.cjs/, 'Step 5.6 must NOT reference a prohibition-probe.cjs engine: the prohibition probe is LLM-propose (ADR-550 D7b)')
      .has(/silently become|would NOT want|must.?not|adversarial/i, 'Step 5.6 must pose the adversarial recall question (PROB-01)')
      .has(/routine engineering|drop[a-z]{0,30}\b[^.]{0,500}engineering|precision[^.]{0,500}classif/i, 'Step 5.6 must describe a precision classifier that drops routine engineering items (PROB-02)')
      .has(/write.?anyway|soft.?gate|with.?flags/i, 'Step 5.6 must be a soft gate (write-anyway-with-flags), not a hard halt (PROB-06)')
      .has(/dismiss[a-z]{0,30}\b[^.]{0,500}reason|reason[^.]{0,500}dismiss/i, 'Step 5.6 must require a non-empty reason when dismissing a prohibition (PROB-05)')
      .has(/--auto[^.]{0,500}(never|not)[^.]{0,500}dismiss|never auto.?dismiss/i, 'Step 5.6 must specify that --auto never auto-dismisses prohibitions (PROB-06)')
      .has(/text.?mode|non-?Claude|AskUserQuestion/i, 'Step 5.6 must handle text-mode (non-Claude, no hard AskUserQuestion) (PROB-09)')
      .has(/Prohibitions/, 'Step 5.6 must populate a SPEC Prohibitions section with confirmed prohibitions')
      .has(/secure-phase|canon[^.]{0,500}security|OWASP|GDPR/i, 'Step 5.6 must emit a canon-referral breadcrumb (owned by /gsd:secure-phase) for canon-security items (PROB-13)')
      .has(/references\/prohibition-probe\.md/, 'Step 5.6 must @-include references/prohibition-probe.md (the portable probe core)');
  },
};
