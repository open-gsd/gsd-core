'use strict';

// progress.md step 1.6 segments verification debt by the `archived_milestone` stamp (#3782): it counts only
// non-archived results as current-milestone debt, never reads the cross-population `summary.total_items` as
// `outstanding_debt`, no longer claims the whole query respects milestone boundaries, and keeps archived debt
// visible as its own labeled line. Was tests/progress-debt-segmentation-guard.test.cjs.

module.exports = {
  id: 'progress-debt-segmentation-guard',
  issue: '#3782',
  check(ctx) {
    ctx.doc('gsd-core/workflows/progress.md')
      .slice('**Step 1.6: Cross-phase health check**', '**Step 1.7:')
      .has(/select\(has\("archived_milestone"\)\s{0,20}\|\s{0,20}not\)/, 'the debt count must select results WITHOUT the archived_milestone stamp')
      .lacks(/Track:\s{0,20}`outstanding_debt`\s{0,20}—\s{0,20}`summary\.total_items`/, 'outstanding_debt must not read the cross-population summary.total_items')
      .lacks(/which respects milestone boundaries/, 'the false whole-query milestone-boundaries claim must stay corrected (only the active tree is filtered)')
      .has(/archived_debt/, 'archived debt must be tracked as its own value')
      .has(/items still open in archived milestones\)/, 'the warning header must label the archived segment: segmented, not hidden');
  },
};
