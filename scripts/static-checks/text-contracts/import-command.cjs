'use strict';

// The /gsd-import command and workflow files: the command's frontmatter and workflow reference, and the
// workflow's --from handling, deferred --prd, path validation, REQUIREMENTS.md context, BLOCKER/WARNING/INFO
// severity model, plan-checker gate and usage display. Was tests/import-command.test.cjs.

const COMMAND = 'commands/gsd/import.md';
const WORKFLOW = 'gsd-core/workflows/import.md';

module.exports = {
  id: 'import-command',
  check(ctx) {
    ctx.exists(COMMAND, 'commands/gsd/import.md should exist');
    ctx.exists(WORKFLOW, 'gsd-core/workflows/import.md should exist');

    ctx.doc(COMMAND)
      .has(/^name:[ \t]{0,50}gsd:import$/m, 'the command should have a name field of gsd:import')
      .has(/^description:[ \t]{0,50}\S/m, 'the command should have a description field with a value')
      .has(/^argument-hint:[^\n]{0,500}--from/m, 'the command should have an argument-hint with --from')
      .has('@~/.claude/gsd-core/workflows/import.md', 'the command should reference the workflow via @~/.claude/gsd-core/workflows/import.md');

    ctx.doc(WORKFLOW)
      .has('--from', 'the workflow should contain --from mode handling')
      .has('--prd', 'the workflow should mention --prd exists')
      .has(/not yet implemented|follow-up PR|future release/, 'the workflow should defer --prd to a future release')
      .lacks('## Path B: MODE=prd', 'the workflow should NOT have a Path B implementation for --prd')
      // The original also accepted `validatePath` or any `..`, and the real file carries the word below.
      .has('traversal', 'the workflow should validate the --from file path against traversal')
      .has('REQUIREMENTS.md', 'the workflow should load REQUIREMENTS.md for conflict detection')
      .has('[BLOCKER]', 'the workflow should include BLOCKER severity')
      .has('[WARNING]', 'the workflow should include WARNING severity')
      .has('[INFO]', 'the workflow should include INFO severity')
      .has('gsd-plan-checker', 'the workflow should delegate validation to gsd-plan-checker')
      .has(/Usage: \/gsd[:-]import/, 'the workflow should display usage when no arguments are provided');
  },
};
