'use strict';

// Freeform routing specificity (#4051): the `/gsd:progress --do` dispatcher workflow (gsd-core/workflows/do.md)
// orders specific routes before the generic rules they shadow (brownfield onboarding before the greenfield "set up"
// rule, spike and sketch wrap-up before the generic spike and sketch rows, code review before the verify-work
// fallback), routes the existing command families distinctly, confirms the route between its display and dispatch steps
// (REQ-DO-03) with a TEXT_MODE equivalent, and forwards only the arguments the selected command accepts. The command
// descriptions distinguish SDD execution (execute-phase) from multi-phase management (phase). The generic fallback
// routes stay (the fix must not over-suppress). Was tests/do-routing-specificity.test.cjs.

const DO = 'gsd-core/workflows/do.md';

// [route text, what it routes]: each must be present in do.md.
const REQUIRED_ROUTES = [
  ['/gsd:onboard', 'brownfield onboarding'],
  ['/gsd:code-review', 'source code review'],
  ['/gsd:review', 'plan review (cross-AI peer review)'],
  ['/gsd:docs-update', 'documentation update'],
  ['/gsd:audit-milestone', 'milestone audit'],
  ['/gsd:audit-fix', 'autonomous audit-to-fix pass'],
  ['/gsd:ui-review', 'UI review'],
  ['/gsd:secure-phase', 'security verification'],
  ['/gsd:execute-phase', 'SDD phase execution'],
  ['/gsd:phase', 'multi-phase (roadmap CRUD) management'],
];
const GENERIC_ROUTES = [
  ['| `/gsd:new-project` |', 'greenfield project setup'],
  ['| `/gsd:spike` |', 'new spike'],
  ['| `/gsd:sketch` |', 'new sketch'],
  ['| `/gsd:verify-work` |', 'generic quality concern fallback'],
  ['| `/gsd:debug` |', 'bug investigation'],
  ['| `/gsd:quick` |', 'small actionable task'],
  ['| `/gsd:explore` |', 'research / how-does-X-work'],
  ['| `/gsd:progress` |', 'status check'],
  ['| `/gsd:capture` |', 'note capture'],
];

// The `description:` value of a command file's frontmatter (the test searched the whole file for the first one).
const descriptionOf = (text) => {
  const match = /^description:\s{0,20}([^\n]{1,2000})/m.exec(text);
  return match ? match[1] : '';
};

module.exports = {
  id: 'do-routing-specificity',
  issue: '#4051',
  check(ctx) {
    const doc = ctx.doc(DO);
    // Specific rules before the generic rules they shadow.
    doc
      .has('/gsd:onboard', 'do.md must route to /gsd:onboard')
      .has('/gsd:new-project', 'do.md must route to /gsd:new-project')
      .before('/gsd:onboard', '/gsd:new-project', 'the brownfield onboarding rule must precede the greenfield "set up" rule, so "set up this existing codebase" matches onboarding first')
      .has('/gsd:spike --wrap-up', 'do.md must route spike wrap-up to /gsd:spike --wrap-up')
      .has('/gsd:sketch --wrap-up', 'do.md must route sketch wrap-up to /gsd:sketch --wrap-up')
      .has('| `/gsd:spike` |', 'do.md must keep the generic /gsd:spike route')
      .has('| `/gsd:sketch` |', 'do.md must keep the generic /gsd:sketch route')
      .before('/gsd:spike --wrap-up', '| `/gsd:spike` |', 'the spike wrap-up rule must precede the generic spike rule')
      .before('/gsd:sketch --wrap-up', '| `/gsd:sketch` |', 'the sketch wrap-up rule must precede the generic sketch rule')
      .has('/gsd:code-review', 'do.md must route source review to /gsd:code-review')
      .has('| `/gsd:verify-work` |', 'do.md must keep the generic /gsd:verify-work route')
      .before('/gsd:code-review', '| `/gsd:verify-work` |', 'the source code review rule must precede the generic verify-work quality rule');

    for (const [route, family] of REQUIRED_ROUTES) doc.has(route, `the routing table must cover ${family} via ${route}`);

    // The confirm step sits between display and dispatch and offers proceed and cancel, with a TEXT_MODE equivalent.
    doc
      .has('<step name="display">', 'do.md must have a display step')
      .has('<step name="dispatch">', 'do.md must have a dispatch step')
      .has('<step name="confirm">', 'do.md must have a confirm step (REQ-DO-03: confirm before executing)')
      .before('<step name="display">', '<step name="confirm">', 'the confirm step must sit after the display step')
      .before('<step name="confirm">', '<step name="dispatch">', 'the confirm step must sit before the dispatch step');
    doc.slice('<step name="confirm">', '<step name="dispatch">')
      .has(/AskUserQuestion/, 'the confirm step must ask via AskUserQuestion')
      .has(/TEXT_MODE/, 'the confirm step must provide a TEXT_MODE numbered-list equivalent')
      .has(/proceed|dispatch/i, 'the confirm step must offer a proceed choice')
      .has(/cancel|stop/i, 'the confirm step must offer a cancel choice');

    // Dispatch forwards only the arguments the selected command accepts.
    doc.slice('<step name="dispatch">')
      .has(/argument-hint|accepted argument/i, 'the dispatch step must derive arguments from the target command argument-hint or accepted arguments')
      .lacks(/passing \$ARGUMENTS as args/, 'the dispatch step must not forward $ARGUMENTS wholesale')
      .has(/freeform task description|freeform description/i, 'the dispatch step must carve out commands that explicitly accept a freeform task description');

    // The command descriptions distinguish SDD execution from multi-phase coordination.
    ctx.doc('commands/gsd/execute-phase.md').frontmatter()
      .satisfies((text) => /SDD|spec-driven|specification-driven/i.test(descriptionOf(text)) || `got: "${descriptionOf(text)}"`,
        'the execute-phase description must name SDD or spec-driven execution')
      .satisfies((text) => /wave|parallel|dependency/i.test(descriptionOf(text)) || `got: "${descriptionOf(text)}"`,
        'the execute-phase description must name wave, parallel or dependency-aware execution');
    ctx.doc('commands/gsd/phase.md').frontmatter()
      .satisfies((text) => /multi-phase|phase management|add, insert, remove, or edit phases/i.test(descriptionOf(text)) || `got: "${descriptionOf(text)}"`,
        'the phase description must name multi-phase management');

    // The generic fallback routes keep dispatching (no over-suppression).
    for (const [marker, family] of GENERIC_ROUTES) doc.has(marker, `do.md must keep routing ${family} (${marker})`);

    doc.slice('<success_criteria>')
      .has(/confirm/i, 'the success criteria must require confirming the route before dispatch')
      .has(/argument/i, 'the success criteria must require argument-aware dispatch');
  },
};
