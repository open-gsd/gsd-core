'use strict';

// #2043: commands/gsd/autonomous.md must list Agent in allowed-tools. The autonomous skill spawns
// background agents with Agent(..., run_in_background=true); without the tool in the frontmatter the
// runtime rejects those calls silently. Was tests/autonomous-allowed-tools.test.cjs.

module.exports = {
  id: 'autonomous-allowed-tools',
  issue: '#2043',
  check(ctx) {
    // A list item of the frontmatter block, so a mention of Agent elsewhere in the file does not count.
    ctx.doc('commands/gsd/autonomous.md')
      .frontmatter()
      .has(/^[ \t]+-[ \t]+Agent[ \t]*$/m, 'allowed-tools must include "Agent"');
  },
};
