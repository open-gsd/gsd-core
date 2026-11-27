'use strict';

// The --all flag of /gsd-discuss-phase (#2188): it auto-selects all gray areas without auto-advancing to plan-phase
// (unlike --auto). The command's argument-hint carries it; the workflow handles it in present_gray_areas (auto-select),
// documents it in the initialize step, and does not treat it as an auto-advance trigger in the auto_advance step; the
// docs name it for discuss-phase. Two assertions are tighter than the test: the test looked for `--all` anywhere in the
// command (it is in the argument-hint, which the contract asks for), and anywhere in COMMANDS.md after the first
// discuss-phase mention (a later `--all` of an unrelated command satisfied it; the contract reads the discuss-phase
// section). Was tests/discuss-all-flag.test.cjs.

module.exports = {
  id: 'discuss-all-flag',
  issue: '#2188',
  check(ctx) {
    ctx.doc('commands/gsd/discuss-phase.md')
      .has(/^argument-hint:[^\n]{0,500}--all/m, 'the command argument-hint should include --all')
      .has('--all', 'the command should mention the --all flag');

    const workflow = ctx.doc('gsd-core/workflows/discuss-phase.md')
      .has('--all', 'the workflow should handle the --all flag');
    workflow.step('present_gray_areas')
      .has('--all', 'the present_gray_areas step should handle --all')
      .has(/Auto-select|auto-select/, 'the present_gray_areas step should auto-select areas when --all is set');
    workflow.step('auto_advance')
      .satisfies((text) => !text.includes('--all') || text.includes('--all does not trigger auto-advance') || text.includes('--all is NOT an auto-advance trigger'),
        '--all must not trigger auto-advance in the auto_advance step');
    workflow.slice('<step name="initialize"', '</step>')
      .has('--all', 'the initialize step should document the --all flag');

    ctx.doc('docs/COMMANDS.md')
      .slice('### `/gsd-discuss-phase`', '\n### ')
      .has('`--all`', 'COMMANDS.md should document --all in the discuss-phase section');
  },
};
