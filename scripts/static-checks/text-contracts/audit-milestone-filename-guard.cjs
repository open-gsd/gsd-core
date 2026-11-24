'use strict';

// The audit-milestone report writer and its readers agree on the report's filename (#3796): the writer line
// once created `v{version}-v{version}-MILESTONE-AUDIT.md` (a doubled version segment) while every reader
// (heading, Report pointers, `cat`, completion checklist) read `v{version}-MILESTONE-AUDIT.md`. The report
// lives under the resolved planning root (#5861). Was tests/audit-milestone-filename-guard.test.cjs.

const READER = 'v{version}-MILESTONE-AUDIT.md';
const MIN_READERS = 5;

module.exports = {
  id: 'audit-milestone-filename-guard',
  issue: '#3796',
  check(ctx) {
    ctx.doc('gsd-core/workflows/audit-milestone.md')
      .lacks('v{version}-v{version}', 'no doubled version segment may appear anywhere in the workflow')
      .has(/^Create `\$\{PLANNING_ROOT\}\/v\{version\}-MILESTONE-AUDIT\.md` with:$/m, 'the writer line must create exactly ${PLANNING_ROOT}/v{version}-MILESTONE-AUDIT.md')
      .satisfies((text) => {
        const readers = text.split(READER).length - 1;
        return readers >= MIN_READERS || `found ${readers}, expected at least ${MIN_READERS}`;
      }, 'the single-version readers (heading, Report pointers, cat, checklist) must remain');
  },
};
