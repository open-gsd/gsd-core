'use strict';

// advisor-prefilter (#4795): the contribution fragment is a same-context, advisory pre-filter that consults
// the session advisor tool. It must be a silent no-op without that tool, must never block / edit / spawn,
// and must say it complements — never replaces — the cold-subagent reviewers. The workflows that deliver
// it (`verify-work.md` at verify:post, `ship.md` at ship:pre) must dispatch orchestrator contributions.

module.exports = {
  id: 'advisor-prefilter',
  issue: '#4795',
  check(ctx) {
    const fragment = ctx.doc('capabilities/advisor-prefilter/fragments/advisor-prefilter.md')
      .before('advisor tool', 'one consult', 'the no-advisor early return must come before the consult instructions')
      .has(/silent no-op/i, 'the fragment must declare a silent no-op when the session has no advisor tool')
      .has(/never blocks/i, 'the fragment must state it never blocks the workflow')
      .has(/does not replace/i, 'the fragment must state it does not replace the reviewer subagents')
      .has(/do not edit files, do not spawn a subagent/i, 'the fragment must forbid edits and subagents');

    for (const reviewer of ['gsd-code-reviewer', 'gsd-verifier', 'gsd-security-auditor', 'gsd-plan-checker']) {
      fragment.has(reviewer, `the fragment must name ${reviewer} as unchanged`);
    }

    ctx.doc('gsd-core/workflows/verify-work.md')
      .has(/\*\*Contribution dispatch:\*\* inject every `kind == "contribution"` fragment from `VERIFY_POST_HOOKS_JSON`/,
        'verify-work.md must dispatch contributions at verify:post, or the advisor fragment is never delivered');
    ctx.doc('gsd-core/workflows/ship.md')
      .has(/\*\*Contribution dispatch:\*\* inject every `kind == "contribution"` fragment from `SHIP_PRE_HOOKS_JSON`/,
        'ship.md must dispatch contributions at ship:pre, or the advisor fragment is never delivered');
  },
};
