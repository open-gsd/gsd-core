'use strict';

// advisor-prefilter (#4795): the skill is a same-context, advisory pre-filter that consults the session
// advisor tool. It must be a silent no-op without that tool, must never block / edit / spawn, and must say
// it complements — never replaces — the cold-subagent reviewers.

module.exports = {
  id: 'advisor-prefilter',
  issue: '#4795',
  check(ctx) {
    const skill = ctx.doc('commands/gsd/advisor-prefilter.md')
      .has(/^name: gsd:advisor-prefilter$/m, 'the skill must register as gsd:advisor-prefilter (ref.skill "advisor-prefilter")')
      .lacks(/^\s*-\s*(Agent|Task|Write|Edit)\s*$/m, 'the pre-filter must not spawn subagents or edit files, so allowed-tools carries no Agent, Task, Write or Edit')
      .before('advisor tool', 'one consult', 'the no-advisor early return must come before the consult instructions');

    skill
      .has(/silent no-op/i, 'the skill must declare a silent no-op when the session has no advisor tool')
      .has(/never blocks/i, 'the skill must state it never blocks the workflow')
      .has(/does not replace/i, 'the skill must state it does not replace the reviewer subagents');

    for (const reviewer of ['gsd-code-reviewer', 'gsd-verifier', 'gsd-security-auditor', 'gsd-plan-checker']) {
      skill.has(reviewer, `the skill must name ${reviewer} as unchanged`);
    }
  },
};
