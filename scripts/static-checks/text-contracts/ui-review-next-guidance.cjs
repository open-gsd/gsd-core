'use strict';

// Next-step guidance routes to the current phase before the next one (#1528, #1523): ui-review's Next block offers
// verify-work {N} exactly once and no plan-phase {N+1}; verify-work's security-blocked presentation routes to the
// current-phase secure-phase fix and offers no next-phase plan or execute, while its post-completion block still
// offers next-phase planning; the manager dispatches verify recommendations through their `command` field, never as
// an inline verification fence calling the verify-work skill. The negative fence probe replaces the test's regex (an
// unbounded `[\s\S]*` gap): it finds each `Inline verification:` label that is followed, after any amount of
// whitespace, by a fence, and asks whether the last verify-work Skill call lies after that fence.
// Was tests/ui-review-next-guidance.test.cjs.

const SKILL_CALL = 'Skill(skill="gsd-verify-work", args="{PHASE_NUM}")';

// `Inline verification:` followed by a fence and, later, a verify-work Skill call with the phase argument.
function hasInlineVerificationSkill(text) {
  const label = 'Inline verification:';
  const lastSkill = text.lastIndexOf(SKILL_CALL);
  if (lastSkill === -1) return false;
  for (let at = text.indexOf(label); at !== -1; at = text.indexOf(label, at + 1)) {
    // Any amount of whitespace before the fence: a bound on a negative probe would let a longer gap evade it.
    let fence = at + label.length;
    while (fence < text.length && /\s/.test(text[fence])) fence += 1;
    if (text.startsWith('```', fence) && lastSkill > fence) return true;
  }
  return false;
}

module.exports = {
  id: 'ui-review-next-guidance',
  issue: '#1528',
  check(ctx) {
    ctx.doc('gsd-core/workflows/ui-review.md')
      .slice('## ▶ Next', '## Automated UI Verification')
      .has(/verify-work \{N\}/, 'ui-review must route to current-phase UAT')
      .lacks(/plan-phase \{N\+1\}/, 'ui-review must not present next-phase planning before current-phase verification passes')
      .satisfies((text) => {
        const count = (text.match(/verify-work \{N\}/g) || []).length;
        return count === 1 || `found ${count}`;
      }, 'the ui-review next block must not duplicate verify-work guidance');

    const verifyWork = ctx.doc('gsd-core/workflows/verify-work.md');
    verifyWork
      .slice('If `SECURITY_FILE` is still empty, stop before phase advancement', 'If `SECURITY_FILE` exists')
      .has(/secure-phase \{phase\}/, 'the security-blocked presentation must route to the current-phase secure-phase fix')
      .lacks(/plan-phase \{next\}/, 'the security-blocked presentation must not offer next-phase planning while advancement is blocked')
      .lacks(/execute-phase \{next\}/, 'the security-blocked presentation must not offer next-phase execution while advancement is blocked');
    verifyWork
      .slice('Phase {phase} marked complete.', '<step name="scan_phase_artifacts">')
      .has(/plan-phase \{next\}/, 'the post-completion presentation must still offer next-phase planning');

    ctx.doc('gsd-core/workflows/manager.md')
      .slice('### Compound Action', '### Discuss Phase N')
      .has(/recommended action's `command`/, 'verify recommendations must dispatch through their command field')
      .has(/gsd-execute-phase/, 'the compound action must name gsd-execute-phase')
      .has(/gsd-verify-work/, 'the compound action must name gsd-verify-work')
      .satisfies((text) => !hasInlineVerificationSkill(text), 'the compound action must not carry an inline verification fence calling the verify-work skill');
  },
};
