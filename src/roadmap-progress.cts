/**
 * Roadmap Progress Module (#5761, Phase 1 of epic #5692): the single owner of
 * "which table is this ROADMAP's Progress table, and what is its milestone
 * slice".
 *
 * Before this module the question was answered by six locators/scopers that
 * disagreed on `## Progress Tracker`, on a `## Progress` inside a fenced block,
 * and on the headingless fallback. Every READER now asks `locateRoadmapProgress`
 * (or, for the "does this span hold the Progress section" probe,
 * `findProgressSection`); a second hand-written `## Progress` regex or
 * table-locating call in a reader is the DEFECT.GENERATIVE-FIX shape.
 *
 * The rule, defined once:
 *   - The Progress section is the first level-2 ATX heading, outside fenced
 *     code, whose text starts with the word `Progress` (`## Progress`,
 *     `## Progress Tracker`). It runs to the next level-1/2 heading outside
 *     fenced code.
 *   - The table is the first table in that section whose header is a SUPERSET
 *     of the requested column set (ADR-2143 §3: addressed by NAME, never
 *     ordinal). A section with no matching table yields no table; it does not
 *     fall through to the rest of the document (#2012 decoy avoidance).
 *   - A document with no Progress heading is scanned whole (a headingless
 *     milestone slice, #1445, keeps resolving).
 *   - The milestone slice (#5165): when the caller names a milestone and the
 *     table carries a `Milestone` column, only that milestone's rows.
 *
 * Writers (`roadmap.cts`, `phase.cts`, traceability slices) still carry their
 * own slices, and so does `phase.cts`'s `cmdPhaseComplete` already-complete
 * check (it slices the Milestone column itself, with a blank-milestone-matches-
 * nothing rule this owner deliberately does not share); they move onto this
 * owner in Phase 2 (#5762).
 */

import { findTableWithColumns } from './markdown-table.cjs';
import type { MarkdownTable } from './markdown-table.cjs';
import { tokenizeHeadings } from './markdown-sectionizer.cjs';

/** The canonical column set both RoadmapProgress variants carry. */
const CANONICAL_COLUMNS: readonly string[] = ['Phase', 'Plans Complete', 'Status', 'Completed'];

/** Character range of the Progress section in the searched content. */
export interface ProgressSectionRange {
  /** Offset of the heading's `#`. */
  start: number;
  /** Exclusive end: the next level-1/2 heading, or the end of the content. */
  end: number;
}

export interface LocateRoadmapProgressOptions {
  /**
   * Column sets probed in order; the first set with a matching table wins.
   * Default: the canonical `Phase`/`Plans Complete`/`Status`/`Completed` set.
   */
  columns?: ReadonlyArray<readonly string[]>;
  /** Milestone to slice rows to (#5165). Absent/blank keeps every row. */
  milestone?: string | null;
}

export interface RoadmapProgressLocation {
  /** The Progress table, or null when the document has none. */
  table: MarkdownTable | null;
  /** The table's rows narrowed to `milestone` (all rows when no slice applies). */
  rows: Record<string, string>[];
  /** The Progress section's range, or null for a headingless document. */
  section: ProgressSectionRange | null;
}

/**
 * #5165: a milestone token compared by identity, not spelling — `v1.1`, `V1.1`
 * and ` 1.1 ` name one milestone. A hand-decorated Progress cell
 * (`**v1.1**`, `` `v1.1` ``, `v1.1 (current)`) still names its first
 * whitespace-separated token. Absent/blank tokens normalize to `''`.
 */
export function normalizeMilestoneToken(value: unknown): string {
  // `[v1.1](ROADMAP.md#v11)` names its link text.
  const unlinked = (milestoneVersionOf(value) ?? '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  const first = unlinked.split(/\s+/)[0] ?? '';
  return first.replace(/^[*_`]+|[*_`:,;]+$/g, '').replace(/^v/i, '').toLowerCase();
}

/**
 * #5165: a STATE.md `milestone:` frontmatter value as a trimmed version string,
 * or null when it is absent, blank or not scalar text.
 */
export function milestoneVersionOf(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

/**
 * The Progress section of `content`: the first level-2 heading outside fenced
 * code whose text starts with the word `Progress`, up to the next level-1/2
 * heading. Null when the document has no such heading.
 */
export function findProgressSection(content: string): ProgressSectionRange | null {
  const headings = tokenizeHeadings(content);
  const index = headings.findIndex((h) => h.level === 2 && /^Progress\b/i.test(h.text));
  if (index === -1) return null;
  const next = headings.slice(index + 1).find((h) => h.level <= 2);
  return { start: headings[index].offset, end: next ? next.offset : content.length };
}

/** Which table is the Progress table, and what is its milestone slice. */
export function locateRoadmapProgress(content: string, options: LocateRoadmapProgressOptions = {}): RoadmapProgressLocation {
  const section = findProgressSection(content);
  const scoped = section ? content.slice(section.start, section.end) : content;
  let table: MarkdownTable | null = null;
  for (const columns of options.columns ?? [CANONICAL_COLUMNS]) {
    table = findTableWithColumns(scoped, [...columns]);
    if (table) break;
  }
  if (!table) return { table: null, rows: [], section };

  const want = normalizeMilestoneToken(options.milestone);
  const rows = want !== '' && table.columns.includes('Milestone')
    ? table.rows.filter((r) => normalizeMilestoneToken(r['Milestone']) === want)
    : table.rows;
  return { table, rows, section };
}
