'use strict';

// /gsd:scan was consolidated into map-codebase as the --fast flag (#2790); the workflow
// workflows/scan.md stays and carries the focus-to-document mapping. Was tests/scan-command.test.cjs.

const FOCUS_AREAS = ['tech', 'arch', 'quality', 'concerns', 'tech+arch'];

module.exports = {
  id: 'scan-command',
  issue: '#2790',
  check(ctx) {
    ctx.doc('commands/gsd/map-codebase.md')
      .has('--fast', 'map-codebase.md must document --fast flag (absorbed scan)')
      .has('description:', 'Command must have description frontmatter');

    const workflow = ctx.doc('gsd-core/workflows/scan.md')
      .has(/Focus-to-Document Mapping|Focus \| Documents/, 'Workflow should contain a focus-to-document mapping table')
      .has(/Overwrite|overwrite/, 'Workflow should mention overwrite prompt for existing documents')
      .has('gsd-codebase-mapper', 'Workflow should reference the gsd-codebase-mapper agent');
    for (const area of FOCUS_AREAS) {
      workflow.has(`\`${area}\``, `Workflow should document the "${area}" focus area`);
    }
  },
};
