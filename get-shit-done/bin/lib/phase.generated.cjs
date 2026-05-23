'use strict';

/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Source: sdk/src/query/phase.ts
 * Regenerate: cd sdk && npm run gen:phase
 *
 * Phase Query Module — pure helper functions shared between the CJS CLI and SDK.
 * No I/O. No async. No filesystem operations.
 *
 * Scope: isCanonicalPlanFile, describeNonCanonicalPlans.
 * Async query handlers (findPhase, phasePlanIndex) are I/O-bound and remain
 * per-side per ADR-3524 §4.
 *
 * References:
 *   - ADR-3524 (docs/adr/3524-cjs-sdk-hard-seam.md)
 *   - Issue #4 (open-gsd/get-shit-done-redux)
 */

const isCanonicalPlanFile = (f) => f.endsWith('-PLAN.md') || f === 'PLAN.md';

// Regex constants closed over by describeNonCanonicalPlans (from phase.js module scope)
const PLAN_OUTLINE_RE = /-PLAN-OUTLINE\.md$/i;
const PLAN_PRE_BOUNCE_RE = /-PLAN.*\.pre-bounce\.md$/i;
const looksLikePlanFile = (f) =>
  /\.md$/i.test(f)
  && /PLAN/i.test(f)
  && !PLAN_OUTLINE_RE.test(f)
  && !PLAN_PRE_BOUNCE_RE.test(f);

function describeNonCanonicalPlans(dirFiles, matchedFiles) {
    const matched = new Set(matchedFiles);
    const offenders = dirFiles.filter((f) => looksLikePlanFile(f) && !matched.has(f));
    if (offenders.length === 0)
        return null;
    return (`Found ${offenders.length} plan-shaped file(s) in this phase that don't match the canonical `
        + `naming convention "{padded_phase}-{NN}-PLAN.md" (or bare "PLAN.md") and were skipped: `
        + offenders.map((f) => `"${f}"`).join(', ')
        + `. Rename to the canonical form (e.g. "01-01-PLAN.md") so the executor can detect them. `
        + `See agents/gsd-planner.md write_phase_prompt step for the full contract.`);
}

module.exports = {
  isCanonicalPlanFile,
  describeNonCanonicalPlans,
};
