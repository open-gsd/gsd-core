'use strict';

// The standalone /gsd:analyze-dependencies command was removed as a dead skill (#2790); the workflow
// workflows/analyze-dependencies.md stays for direct invocation and COMMANDS.md no longer advertises the
// command. Was tests/analyze-dependencies.test.cjs.

module.exports = {
  id: 'analyze-dependencies',
  issue: '#2790',
  check(ctx) {
    ctx.absent('commands/gsd/analyze-dependencies.md', 'analyze-dependencies.md should have been deleted in #2790');

    ctx.doc('gsd-core/workflows/analyze-dependencies.md')
      .has(/ROADMAP|phase/, 'workflow should reference ROADMAP.md/phases')
      .has(/depends|Depends|dependency/, 'workflow should reference dependency detection')
      .has('file', 'workflow should mention file overlap/conflict detection')
      .has(/overlap|conflict/, 'workflow should mention file overlap/conflict detection');

    // Only the section-header form: workflow-internal references to the capability are fine.
    ctx.doc('docs/COMMANDS.md')
      .lacks(/^### `\/gsd-analyze-dependencies`/m, 'COMMANDS.md should not document the removed /gsd-analyze-dependencies command');
  },
};
