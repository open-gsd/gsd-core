'use strict';

// The verification overrides reference (#1747) and the verifier agent's use of it: the reference documents the
// override format (frontmatter block with must_have, reason, accepted_by and accepted_at, never a criterion field),
// the matching rules (fuzzy, case-insensitive, an 80% overlap threshold, never a looser one), the PASSED (override)
// status, an example, when to use and when NOT to use overrides, the overrides_applied counter, the re-verification
// carry-forward and the milestone audit; gsd-verifier.md reads it in required_reading between </role> and
// <project_context>, checks overrides in Step 3b on the must_have field, and carries overrides_applied in its template.
// Where the test accepted a bare word (`Required` anywhere for the two required fields, `milestone` anywhere, `Re-verification`
// as a heading) the contract asks for the phrase the file carries. Was tests/verification-overrides.test.cjs.

const REFERENCE = 'gsd-core/references/verification-overrides.md';
const VERIFIER = 'agents/gsd-verifier.md';

// A line that starts with whitespace and then `criterion:` (a YAML field named criterion).
const hasCriterionField = (text) => text.split('\n').some((line) => line.length > line.trimStart().length && line.trimStart().startsWith('criterion:'));

// A line that names the field and says Required (the field table row).
const requiredRow = (field) => (text) => !text.includes(field) || text.split('\n').some((line) => line.includes(`\`${field}\``) && line.includes('Required')) || `no table row names ${field} as Required`;

// The index of the first `<required_reading>` that begins a line, or -1.
function requiredReadingAt(text) {
  for (let at = text.indexOf('<required_reading>'); at !== -1; at = text.indexOf('<required_reading>', at + 1)) {
    if (at === 0 || '\n\r\u2028\u2029'.includes(text[at - 1])) return at;
  }
  return -1;
}

module.exports = {
  id: 'verification-overrides',
  issue: '#1747',
  walkers: { requiredReadingAt, hasCriterionField },
  check(ctx) {
    ctx.doc(REFERENCE)
      .has('## Override Format', 'the reference should contain an "Override Format" section')
      .has('## Matching Rules', 'the reference should contain a "Matching Rules" section')
      .has('## Verifier Behavior', 'the reference should contain a "Verifier Behavior" section')
      .has('overrides:', 'the reference should document the YAML frontmatter overrides block')
      .has('must_have:', 'the reference should document the must_have field of an override')
      .has('reason:', 'the reference should document the reason field of an override')
      .satisfies((text) => !hasCriterionField(text), 'the reference should use the must_have field, not a criterion field')
      .has('accepted_by', 'the reference should document the accepted_by field')
      .has('accepted_at', 'the reference should document the accepted_at field')
      .satisfies(requiredRow('accepted_by'), 'accepted_by should be described as a required field')
      .satisfies(requiredRow('accepted_at'), 'accepted_at should be described as a required field')
      .has('fuzzy matching', 'the reference should describe fuzzy matching for pairing overrides with must-haves')
      .has(/case-insensitive/i, 'the reference should describe case-insensitive matching')
      .has('80%', 'the reference should describe the 80% word overlap matching threshold')
      .lacks('60% token overlap', 'the reference should not describe a 60% matching threshold (too loose: use 80%)')
      .lacks('60% word overlap', 'the reference should not describe a 60% matching threshold (too loose: use 80%)')
      .has('PASSED (override)', 'the reference should document the PASSED (override) status marker')
      .has('## Example VERIFICATION.md', 'the reference should include an example VERIFICATION.md section')
      .has('## When to Use', 'the reference should contain a "When to Use" section')
      .has('## When NOT to Use', 'the reference should contain guardrails explaining when overrides are not appropriate')
      .has('overrides_applied', 'the reference should document the overrides_applied counter field in frontmatter')
      .has('carry forward', 'the reference should document that overrides carry forward during re-verification')
      .has('audit-milestone', 'the reference should document that overrides are surfaced during milestone audit');

    const verifier = ctx.doc(VERIFIER);
    verifier
      .has('verification-overrides.md', 'gsd-verifier.md should reference verification-overrides.md')
      .satisfies((text) => {
        const roleEnd = text.indexOf('</role>');
        const projectContext = text.indexOf('<project_context>');
        const reading = requiredReadingAt(text);
        if (roleEnd === -1) return 'the </role> tag is missing';
        if (projectContext === -1) return 'the <project_context> tag is missing';
        if (reading === -1) return 'the <required_reading> tag is missing';
        return (reading > roleEnd && reading < projectContext) || '<required_reading> is not between </role> and <project_context>';
      }, '<required_reading> should appear between </role> and <project_context>')
      .slice('## Step 3b', '\n## Step 4')
      .has('must_have', 'Step 3b should reference the must_have field');
    verifier
      .has('overrides_applied', 'the gsd-verifier.md frontmatter template should include the overrides_applied counter');
  },
};
