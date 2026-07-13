/**
 * Phase Lifecycle Pure Helpers — pure-computation functions extracted from
 * the phase-lifecycle SDK handler (ADR-457 build-at-publish: the hand-written
 * bin/lib/phase-lifecycle.cjs collapsed to a TypeScript source of truth).
 * Behaviour is preserved byte-for-behaviour from the prior hand-written .cjs;
 * only types are added.
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
 *   - Issue #4 (open-gsd/gsd-core)
 */

import { findTableBySchema } from './markdown-table.cjs';

/** Result of deriveProgressFromRoadmap. */
export interface RoadmapProgress {
  completedPhases: number | null;
  totalPhases: number | null;
  totalPlans: number | null;
}

/**
 * Derive completed_phases, total_phases, and total_plans from ROADMAP content.
 * Root cause fix for issue #4 — see gen-phase-lifecycle.mjs for full documentation.
 *
 * ADR-2143 (epic #2143): the Progress table is located via the markdown-table
 * seam's `findTableBySchema`, which scans the WHOLE document for the first
 * table matching the `RoadmapProgress` schema — instead of position-anchored
 * regexes, and instead of requiring the table to live under a `## Progress`
 * heading. This reads cells by column NAME, fixing #2137 (the old
 * position-based regex assumed "Status" was always the 3rd cell and "Plans
 * Complete" the 2nd, which broke for the 5-column milestone-grouped variant
 * that inserts a `Milestone` column ahead of them) and a later regression
 * where a Progress table not under a `## Progress` heading (or not the first
 * table in the document) returned all-null.
 *
 * Matching is by exact canonical column NAME (`TABLE_SCHEMAS.RoadmapProgress`,
 * ADR-2143 §3) — a ROADMAP whose Progress table uses non-canonical column
 * wording resolves to `null` here (Phase 3 of the epic makes that fail-loud
 * instead of silently returning nulls).
 */
export function deriveProgressFromRoadmap(roadmapContent: string): RoadmapProgress {
  let completedPhases: number | null = null;
  let totalPhases: number | null = null;
  let totalPlans: number | null = null;

  try {
    const table = findTableBySchema(roadmapContent, 'RoadmapProgress');

    if (table) {
      const allRows = table.rows;

      const completed = allRows.filter((r) => /^complete$/i.test((r['Status'] ?? '').trim())).length;
      completedPhases = completed > 0 ? completed : null;

      // Data rows only (exclude 999.x backlog phases). Mirrors init.cts /^999(?:\.|$)/ filter.
      const dataRows = allRows.filter((r) => {
        const phase = (r['Phase'] ?? '').trim();
        return /^\d/.test(phase) && !/^999\b/.test(phase);
      });
      totalPhases = dataRows.length > 0 ? dataRows.length : null;

      let totalPlansSum = 0;
      for (const r of allRows) {
        const cell = (r['Plans Complete'] ?? '').trim();
        const m = /(\d+)\s*\/\s*(\d+)/.exec(cell);
        if (m) totalPlansSum += parseInt(m[2], 10);
      }
      totalPlans = totalPlansSum > 0 ? totalPlansSum : null;
    }
  } catch { /* intentionally empty — fall through to existing values */ }

  return { completedPhases, totalPhases, totalPlans };
}

/**
 * Compute progress percent clamped to 100.
 * Root cause fix for issue #4 — see gen-phase-lifecycle.mjs for full documentation.
 */
export function clampPercent(completed: number, total: number): number {
  if (!total || total <= 0) return 0;
  return Math.min(100, Math.round((completed / total) * 100));
}
