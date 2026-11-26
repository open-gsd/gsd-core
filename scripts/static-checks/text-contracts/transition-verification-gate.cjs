'use strict';

// The transition workflow treats unresolved verification as a blocking phase gate (#1522): a preliminary check
// blocks obviously unresolved verification, phase.complete fail-closes on the authoritative stale-aware gate,
// canonical verification status must be `passed`, and the old "does NOT block" / "carry forward as debt"
// wording stays gone. Was tests/transition-verification-gate.test.cjs.

module.exports = {
  id: 'transition-verification-gate',
  issue: '#1522',
  check(ctx) {
    ctx.doc('gsd-core/workflows/transition.md')
      .has(/preliminary check blocks obviously unresolved verification/i, 'a preliminary check must block obviously unresolved verification')
      .satisfies((text) => {
        const lower = text.toLowerCase();
        const at = lower.indexOf('phase.complete');
        return (at >= 0 && lower.indexOf('fail-closes', at + 'phase.complete'.length) >= 0) || 'expected "fail-closes" after "phase.complete"';
      }, 'phase.complete must fail-close')
      .has(/authoritative stale-aware gate/i, 'the authoritative stale-aware gate must be named')
      .has(/canonical verification\s{1,20}status is `passed`/i, 'the canonical verification status must be required to be `passed`')
      .lacks(/does NOT block transition/i, 'unresolved verification must not be described as not blocking the transition')
      .lacks(/carry forward as debt/i, 'unresolved verification must not be carried forward as debt');
  },
};
