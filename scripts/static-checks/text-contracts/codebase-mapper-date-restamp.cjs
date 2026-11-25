'use strict';

// On an Update run the codebase mapper restamps the codebase-doc dates unconditionally instead of only filling the
// [YYYY-MM-DD] placeholder (#2279): both gsd-codebase-mapper.md and map-codebase.md carry the overwrite instruction,
// neither keeps the placeholder-only framing, and map-codebase.md carries the overwrite instruction at every
// date-instruction site (four per-spawn prompts and the sequential fallback). The two files phrased the bug
// differently, so each has its own stale pattern. Was tests/codebase-mapper-date-restamp.test.cjs.

const WORKFLOW_STALE_PLACEHOLDER_ONLY = /Use `?\{date\}`?(?: from init context)? for all `?\[YYYY-MM-DD\]`? date placeholders/;
const MAPPER_STALE_PLACEHOLDER_ONLY = /Replace `?\[YYYY-MM-DD\]`? with the date/i;
const OVERWRITE_INSTRUCTION = /overwrit(?:e|ing)\s{1,20}(?:any|whatever)[^.\n]{0,500}date/i;
const WORKFLOW_OVERWRITE_SITE = /overwrit(?:e|ing) any existing date/gi;
const MIN_OVERWRITE_SITES = 5;

module.exports = {
  id: 'codebase-mapper-date-restamp',
  issue: '#2279',
  check(ctx) {
    ctx.doc('agents/gsd-codebase-mapper.md')
      .has(OVERWRITE_INSTRUCTION, 'gsd-codebase-mapper.md must tell the agent to overwrite a prior concrete date, not only fill [YYYY-MM-DD]')
      .lacks(MAPPER_STALE_PLACEHOLDER_ONLY, 'gsd-codebase-mapper.md still contains a placeholder-only date instruction');
    ctx.doc('gsd-core/workflows/map-codebase.md')
      .has(OVERWRITE_INSTRUCTION, 'map-codebase.md must instruct overwriting an existing date, not only [YYYY-MM-DD] placeholders')
      .lacks(WORKFLOW_STALE_PLACEHOLDER_ONLY, 'map-codebase.md still contains a placeholder-only date instruction')
      .satisfies((text) => {
        const sites = (text.match(WORKFLOW_OVERWRITE_SITE) || []).length;
        return sites >= MIN_OVERWRITE_SITES || `found ${sites}, expected at least ${MIN_OVERWRITE_SITES}`;
      }, 'map-codebase.md must carry the overwrite instruction at every date-instruction site (four per-spawn prompts and the sequential fallback)');
  },
};
