'use strict';

/**
 * Validate Helpers — pure computation helpers and regex constants extracted from
 * sdk/src/query/validate.ts. No I/O. No async. No filesystem operations.
 *
 * Issue #6 drift items (three helpers):
 *   1. phaseVariants() — replaces parseInt-based padded/unpadded check in verify.cjs
 *      Check 8 (W006 disk-existence and W007 roadmap-membership checks).
 *   2. buildRoadmapPhaseVariants() — replaces raw roadmapPhases set in W007 loop.
 *   3. buildNotStartedPhaseVariants() — replaces raw+zero-padded notStartedPhases
 *      in W006 skip logic.
 *
 * Issue #26 drift items (four constants/helpers):
 *   4. phaseDirNameRe — W005 phase directory naming regex (was inline in verify.cjs Check 6).
 *   5. PHASE_TOKEN_FROM_DIR_RE — extracts phase token from dir name (was inline in
 *      verify.cjs forEachArchivedPhaseToken / collectDiskPhases).
 *   6. MILESTONE_ARCHIVE_DIR_RE — identifies milestone archive directories (was inline).
 *   7. canonicalPlanStem() — I001 PLAN/SUMMARY stem canonicalization (was inline in Check 7).
 *
 * I/O adapter pattern (ADR-3524 §4): pure transforms extracted from the SDK.
 *
 * References:
 *   - ADR-3524 (docs/adr/3524-cjs-sdk-hard-seam.md)
 *   - Issue #6 (open-gsd/get-shit-done-redux)
 *   - Issue #26 (open-gsd/get-shit-done-redux)
 *   - PR #154 (issue #4) — generator pattern precedent
 *   - PR #156 (issue #6) — validate.ts generator that #26 extends
 */

// ── Issue #26: regex constants (W005, W006-archived) ────────────────────────
const phaseDirNameRe = /^\d{2,}(?:\.\d+)*-[\w-]+$/;
const PHASE_TOKEN_FROM_DIR_RE = /^(?:[A-Z]{1,6}-)?(\d+[A-Z]?(?:\.\d+)*)(?:-|$)/i;
const MILESTONE_ARCHIVE_DIR_RE = /^v\d+.*-phases$/i;

// ── Issue #26: I001 canonicalization ────────────────────────────────────────
function canonicalPlanStem(stem) {
    const m = stem.match(/^(\d+[A-Z]?(?:\.\d+)*-\d+)/i);
    return m ? m[1] : stem;
}

// ── Issue #6: phase variant helpers (W006/W007) ──────────────────────────────
function phaseVariants(phase) {

                const variants = new Set([phase]);
                const dotIdx = phase.indexOf('.');
                const head = dotIdx === -1 ? phase : phase.slice(0, dotIdx);
                const tail = dotIdx === -1 ? '' : phase.slice(dotIdx);
                const headMatch = head.match(/^(\d+)([A-Z]?)$/i);
                if (!headMatch)
                    return variants;
                const numericHead = headMatch[1];
                const letterSuffix = headMatch[2] || '';
                variants.add(`${String(parseInt(numericHead, 10))}${letterSuffix}${tail}`);
                variants.add(`${numericHead.padStart(2, '0')}${letterSuffix}${tail}`);
                return variants;
            
}

function buildRoadmapPhaseVariants(roadmapContent) {
  const roadmapPhases = new Set();
  const roadmapPhaseVariants = new Set();
  const phasePattern = /#{2,4}\s*Phase\s+(\d+[A-Z]?(?:\.\d+)*)\s*:/gi;
  let m;
  while ((m = phasePattern.exec(roadmapContent)) !== null) {
    roadmapPhases.add(m[1]);
    for (const variant of phaseVariants(m[1])) roadmapPhaseVariants.add(variant);
  }
  return { roadmapPhases, roadmapPhaseVariants };
}

function buildNotStartedPhaseVariants(roadmapContent) {
  const notStartedPhases = new Set();
  const uncheckedPattern = /-\s*\[\s\]\s*\*{0,2}Phase\s+(\d+[A-Z]?(?:\.\d+)*)[:\s*]/gi;
  let um;
  while ((um = uncheckedPattern.exec(roadmapContent)) !== null) {
    for (const variant of phaseVariants(um[1])) notStartedPhases.add(variant);
  }
  return notStartedPhases;
}

module.exports = {
  // Issue #26 exports (W005 regex, W006-archived regex constants, I001 helper)
  phaseDirNameRe,
  PHASE_TOKEN_FROM_DIR_RE,
  MILESTONE_ARCHIVE_DIR_RE,
  canonicalPlanStem,
  // Issue #6 exports (W006/W007 phase variant helpers)
  phaseVariants,
  buildRoadmapPhaseVariants,
  buildNotStartedPhaseVariants,
};
