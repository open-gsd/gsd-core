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

/** Result of deriveProgressFromRoadmap. */
export interface RoadmapProgress {
  completedPhases: number | null;
  totalPhases: number | null;
  totalPlans: number | null;
}

/**
 * Derive completed_phases, total_phases, and total_plans from ROADMAP content.
 * Root cause fix for issue #4 — see gen-phase-lifecycle.mjs for full documentation.
 */
export function deriveProgressFromRoadmap(roadmapContent: string): RoadmapProgress {
  let completedPhases: number | null = null;
  let totalPhases: number | null = null;
  let totalPlans: number | null = null;

  try {
    // Parse the Progress table by HEADER, not by a fixed column count. The
    // writer (cmdPhaseComplete) already branches on `cells.length === 5`, so it
    // understands both the 4-column greenfield table
    //   | Phase | Plans Complete | Status | Completed |
    // and the 5-column milestone-grouped table the same template ships
    //   | Phase | Milestone | Plans Complete | Status | Completed |
    // The reader used two 4-column-only regexes, so every project past its v1.0
    // milestone (5-column shape) parsed to all-null and phase.complete silently
    // skipped the STATE progress write. Reading column indices by NAME keeps the
    // reader and writer in agreement across both shapes and any future column
    // (#2137). The table is located by its header row rather than a `## Progress`
    // heading because some callers pass a milestone slice with no heading (#1445).
    //
    // When a `## Progress` heading IS present, scope the search to that section
    // (mirroring the writer's #2012 scoping in cmdPhaseComplete) so the reader
    // cannot bind to an earlier Phase/Status/Completed-shaped table elsewhere in
    // the roadmap. Callers that pass a headingless milestone slice fall back to
    // scanning the whole input.
    // Line-anchored h2 match — `indexOf('## Progress')` would also match inside
    // an h3 `### Progress` (the `## Progress` substring starts at the 2nd hash),
    // letting a decoy subheading hijack the slice.
    // Case-insensitive to match the case-insensitive header-cell comparison below.
    //
    // allow-adhoc-markdown: line-based Progress-table scan (header lookup +
    // positional cell indexing); table parsing is out of the markdown-sectionizer
    // seam's scope. Superseded by the ADR-2143 parseMarkdownTable/TABLE_SCHEMAS
    // seam; pending #2143.
    const progressMatch = roadmapContent.match(/^##[ \t]+Progress\b/im);
    let scoped = roadmapContent;
    if (progressMatch && progressMatch.index !== undefined) {
      // Slice from `## Progress` to the next h1/h2 heading (or end); h3+ headings
      // inside the section do not terminate it. The heading sits at index 0 of
      // this slice with no leading newline, so the `\n#` search cannot match it.
      const afterHeading = roadmapContent.slice(progressMatch.index);
      const nextHeading = afterHeading.search(/\n#{1,2}[ \t]/);
      scoped = nextHeading >= 0 ? afterHeading.slice(0, nextHeading) : afterHeading;
    }
    const lines = scoped.split('\n');

    // Split a markdown table row into trimmed cells — the same
    // `split('|').slice(1, -1)` boundary the writer uses (phase.cts).
    const rowCells = (line: string): string[] =>
      line.split('|').slice(1, -1).map((c) => c.trim());
    const isTableRow = (line: string): boolean => line.trim().startsWith('|');
    const isSeparatorRow = (cells: string[]): boolean =>
      cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));

    let headerLine = -1;
    let phaseIdx = -1;
    let statusIdx = -1;
    let plansIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (!isTableRow(lines[i])) continue;
      const lc = rowCells(lines[i]).map((c) => c.toLowerCase());
      const p = lc.indexOf('phase');
      const s = lc.indexOf('status');
      const c = lc.indexOf('completed');
      if (p >= 0 && s >= 0 && c >= 0) {
        headerLine = i;
        phaseIdx = p;
        statusIdx = s;
        plansIdx = lc.findIndex((h) => h.includes('plans'));
        break;
      }
    }

    if (headerLine >= 0) {
      let phaseCount = 0;
      let completedCount = 0;
      let plansSum = 0;
      // Walk the contiguous rows after the header; a markdown table ends at the
      // first non-`|` line.
      for (let i = headerLine + 1; i < lines.length; i++) {
        if (!isTableRow(lines[i])) break;
        const cells = rowCells(lines[i]);
        if (isSeparatorRow(cells)) continue;
        const phaseToken = (cells[phaseIdx] ?? '').trim();
        if (!/^\d/.test(phaseToken)) continue; // not a data row
        if (/^999\b/.test(phaseToken)) continue; // 999.x backlog sentinel (#1445)
        phaseCount++;
        if ((cells[statusIdx] ?? '').toLowerCase() === 'complete') completedCount++;
        if (plansIdx >= 0) {
          const mn = (cells[plansIdx] ?? '').match(/^(\d+)\/(\d+)$/);
          if (mn) plansSum += parseInt(mn[2], 10);
        }
      }
      // Preserve the prior contract: a count of 0 is reported as null (absent),
      // so the consumer leaves the existing STATE value untouched.
      completedPhases = completedCount > 0 ? completedCount : null;
      totalPhases = phaseCount > 0 ? phaseCount : null;
      totalPlans = plansSum > 0 ? plansSum : null;
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
