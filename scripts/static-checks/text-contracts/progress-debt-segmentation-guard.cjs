'use strict';

// progress.md step 1.6 segments verification debt by the `archived_milestone` stamp (#3782): it counts only
// non-archived results as current-milestone debt, never reads the cross-population `summary.total_items` as
// `outstanding_debt`, no longer claims the whole query respects milestone boundaries, and keeps archived debt
// visible as its own labeled line. Was tests/progress-debt-segmentation-guard.test.cjs.

// A `Track: `outstanding_debt` — `summary.total_items`` line with any amount of whitespace between its parts (no
// bounded quantifier: a bound on a `lacks` would let a longer gap evade it).
function readsSummaryTotalItems(text) {
  const skipWhitespace = (from) => {
    let at = from;
    while (at < text.length && /\s/.test(text[at])) at += 1;
    return at;
  };
  for (let at = text.indexOf('Track:'); at !== -1; at = text.indexOf('Track:', at + 1)) {
    let cursor = at + 'Track:'.length;
    let matched = true;
    for (const part of ['`outstanding_debt`', '—', '`summary.total_items`']) {
      cursor = skipWhitespace(cursor);
      if (!text.startsWith(part, cursor)) { matched = false; break; }
      cursor += part.length;
    }
    if (matched) return true;
  }
  return false;
}

module.exports = {
  id: 'progress-debt-segmentation-guard',
  issue: '#3782',
  check(ctx) {
    ctx.doc('gsd-core/workflows/progress.md')
      .slice('**Step 1.6: Cross-phase health check**', '**Step 1.7:')
      .has(/select\(has\("archived_milestone"\)\s{0,20}\|\s{0,20}not\)/, 'the debt count must select results WITHOUT the archived_milestone stamp')
      .satisfies((text) => !readsSummaryTotalItems(text), 'outstanding_debt must not read the cross-population summary.total_items')
      .lacks(/which respects milestone boundaries/, 'the false whole-query milestone-boundaries claim must stay corrected (only the active tree is filtered)')
      .has(/archived_debt/, 'archived debt must be tracked as its own value')
      .has(/items still open in archived milestones\)/, 'the warning header must label the archived segment: segmented, not hidden');
  },
};
