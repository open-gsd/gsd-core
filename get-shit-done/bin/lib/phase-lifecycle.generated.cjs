'use strict';

/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Source: sdk/src/query/phase-lifecycle.ts
 * Regenerate: cd sdk && npm run gen:phase-lifecycle
 *
 * Phase Lifecycle Pure Helpers — pure-computation functions extracted from
 * the phase-lifecycle SDK handler.
 *
 * I/O adapter pattern (ADR-3524 Section 4): each side supplies its own I/O
 * (sync readFileSync for CJS, async readFile for SDK); the pure computation
 * logic is shared via this generated artifact.
 *
 * Scope:
 *   - deriveProgressFromRoadmap(roadmapContent): count Complete rows => idempotent
 *   - clampPercent(completed, total): percent with 100 ceiling
 *
 * These two functions are the root-cause fix for issue #4.
 *
 * References:
 *   - ADR-3524 (docs/adr/3524-cjs-sdk-hard-seam.md)
 *   - Issue #4 (open-gsd/get-shit-done-redux)
 */

/**
 * Derive completed_phases, total_phases, and total_plans from ROADMAP content.
 * Root cause fix for issue #4 — see gen-phase-lifecycle.mjs for full documentation.
 */
function deriveProgressFromRoadmap(roadmapContent) {
  let completedPhases = null;
  let totalPhases = null;
  let totalPlans = null;

  try {
    // Count Complete rows in the progress table (Status column = "Complete").
    // Pattern: row where the phase cell starts with a digit (data row, not header),
    // followed by any cell content, then a "Complete" status cell.
    // Handles both short form ("| 4. |") and long form ("| 01. Foundation |").
    // See phase-lifecycle.ts ~line 1655 for the original SDK pattern.
    const tableCompletePattern = /\|\s*\d+[^|]*\|\s*[^|]*\|\s*Complete\s*\|/gi;
    const completeMatches = roadmapContent.match(tableCompletePattern);
    completedPhases = completeMatches ? completeMatches.length : null;

    // Count total phase rows in the progress table.
    // Identify the table by looking for Phase|...|Status|...|Completed header.
    const progressTableMatch = roadmapContent.match(
      /\|\s*Phase\s*\|[^|]*\|[^|]*Status[^|]*\|[^|]*Completed[^|]*\|[\s\S]*?(?=\n\n|\n##|$)/i,
    );
    if (progressTableMatch) {
      const tableText = progressTableMatch[0];
      // Count data rows (rows starting with pipe then a phase number)
      const dataRowPattern = /^\|\s*\d+/gm;
      const dataRows = tableText.match(dataRowPattern);
      totalPhases = dataRows ? dataRows.length : null;
    }

    // Sum plan counts from M/N columns in progress table
    let totalPlansSum = 0;
    const planCellPattern = /\|\s*\d+[^|]*\|\s*(\d+)\/(\d+)\s*\|/gi;
    let pm;
    // eslint-disable-next-line no-cond-assign
    while ((pm = planCellPattern.exec(roadmapContent)) !== null) {
      totalPlansSum += parseInt(pm[2], 10);
    }
    if (totalPlansSum > 0) totalPlans = totalPlansSum;
  } catch { /* intentionally empty — fall through to existing values */ }

  return { completedPhases, totalPhases, totalPlans };
}

/**
 * Compute progress percent clamped to 100.
 * Root cause fix for issue #4 — see gen-phase-lifecycle.mjs for full documentation.
 */
function clampPercent(completed, total) {
  if (!total || total <= 0) return 0;
  return Math.min(100, Math.round((completed / total) * 100));
}

module.exports = {
  deriveProgressFromRoadmap,
  clampPercent,
};
