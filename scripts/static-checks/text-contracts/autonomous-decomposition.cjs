'use strict';

// #2196: autonomous.md exceeded the Claude Code Read tool's 10K-token limit (11,748 tokens), so the
// smart_discuss step moved to a reference file and autonomous.md has to stay under the limit. At about
// 4 characters a token, 10K tokens is 40K characters. Raised from 38K after the #729 + #853 merge added
// runtime-gated converge routing to the interactive planning arm (about 1.2K characters).
// Was tests/autonomous-decomposition.test.cjs.

const WORKFLOW = 'gsd-core/workflows/autonomous.md';
const SMART_DISCUSS = 'gsd-core/references/autonomous-smart-discuss.md';
const SIZE_LIMIT = 40 * 1024;

module.exports = {
  id: 'autonomous-decomposition',
  issue: '#2196',
  check(ctx) {
    ctx.doc(WORKFLOW)
      .shorterThan(SIZE_LIMIT, 'autonomous.md must stay under the 10K-token Read limit: keep the smart_discuss step in autonomous-smart-discuss.md')
      .has('autonomous-smart-discuss.md', 'autonomous.md must reference autonomous-smart-discuss.md after extraction');
    ctx.doc(SMART_DISCUSS)
      .has(/smart_discuss|Smart Discuss|grey area|grey_area/, 'autonomous-smart-discuss.md must contain smart discuss step content')
      .has('CONTEXT.md', 'autonomous-smart-discuss.md must contain instructions for writing CONTEXT.md');
  },
};
