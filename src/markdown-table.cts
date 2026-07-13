/**
 * Markdown Table Model — canonical GFM table parsing + schema registry seam
 * (ADR-2143, epic #2143). Pure functions, Node built-ins only, string-in/value-out,
 * no I/O. Compiled by tsc to gsd-core/bin/lib/markdown-table.cjs.
 *
 * NOTE: the `Result<T>` here is the ADR-2143 parse-result shape {ok,value|reason} —
 * deliberately distinct from command-routing-hub's dispatch `Result` {ok,data|kind};
 * the two never mix (different modules).
 */

import { collectSection, replaceSection } from './markdown-sectionizer.cjs';

// ─── Types ────────────────────────────────────────────────────────────────────

export type Result<T> = { ok: true; value: T } | { ok: false; reason: string };

/** A parsed GFM pipe table: header column names + rows addressed by column name. */
export interface MarkdownTable {
  columns: string[];
  rows: Record<string, string>[];
}

/** One recognised header-shape variant of a canonical table kind. */
export interface CanonicalTableVariant {
  label: string;
  columns: string[];
}

// ─── Schema registry ──────────────────────────────────────────────────────────

/**
 * Canonical column-header shapes for every GFM table GSD parses or generates.
 * Each entry in `TABLE_SCHEMAS[id]` is one accepted variant (exact column names,
 * in order); `matchTableSchema` resolves a parsed header back to `{id, label}`.
 *
 * This registry is the single source of truth — a parity test
 * (tests/markdown-table.test.cjs) asserts every variant's header appears
 * verbatim in the template/workflow file that generates it, so the registry
 * and the templates can never silently drift (ADR-2143 §3 Generative-Fix-
 * Divergence guard).
 */
export const TABLE_SCHEMAS: Record<string, CanonicalTableVariant[]> = {
  RoadmapProgress: [
    { label: 'flat', columns: ['Phase', 'Plans Complete', 'Status', 'Completed'] },
    {
      label: 'milestone-grouped',
      columns: ['Phase', 'Milestone', 'Plans Complete', 'Status', 'Completed'],
    },
  ],
  RequirementsTraceability: [
    { label: 'default', columns: ['Requirement', 'Phase', 'Status'] },
  ],
  QuickTasks: [
    { label: 'no-status', columns: ['#', 'Description', 'Date', 'Commit', 'Directory'] },
    {
      label: 'with-status',
      columns: ['#', 'Description', 'Date', 'Commit', 'Status', 'Directory'],
    },
  ],
  Security: [
    { label: 'trust-boundaries', columns: ['Boundary', 'Description', 'Data Crossing'] },
    {
      label: 'threat-register',
      columns: [
        'Threat ID',
        'Category',
        'Component',
        'Severity',
        'Disposition',
        'Mitigation',
        'Status',
      ],
    },
    {
      label: 'accepted-risks',
      columns: ['Risk ID', 'Threat Ref', 'Rationale', 'Accepted By', 'Date'],
    },
    {
      label: 'audit-trail',
      columns: ['Audit Date', 'Threats Total', 'Closed', 'Open', 'Run By'],
    },
  ],
};

/**
 * Resolve a parsed table's header columns to the canonical schema it matches
 * (exact column names, same length, same order), else `null`.
 */
export function matchTableSchema(columns: string[]): { id: string; label: string } | null {
  for (const [id, variants] of Object.entries(TABLE_SCHEMAS)) {
    for (const variant of variants) {
      if (
        variant.columns.length === columns.length
        && variant.columns.every((col, idx) => col === columns[idx])
      ) {
        return { id, label: variant.label };
      }
    }
  }
  return null;
}

// ─── Parsing ──────────────────────────────────────────────────────────────────

/**
 * Split one GFM table row line into trimmed cell strings.
 * Strips one leading and one trailing `|`, splits on unescaped `|`, trims
 * each cell, and unescapes `\\` back to `\` and `\|` back to `|` (the exact
 * reverse of `escapeCell`'s `\`->`\\` then `|`->`\|` order below), so cell
 * values round-trip exactly — including literal backslashes.
 */
function splitTableRow(line: string): string[] {
  let stripped = line.trim();
  if (stripped.startsWith('|')) stripped = stripped.slice(1);
  if (stripped.endsWith('|')) stripped = stripped.slice(0, -1);
  return stripped.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\([\\|])/g, '$1'));
}

/** True when every delimiter cell matches GFM's `:?-{1,}:?` shape (spaces removed). */
function isDelimiterRow(cells: string[]): boolean {
  return cells.every((cell) => /^:?-{1,}:?$/.test(cell.replace(/\s+/g, '')));
}

/**
 * Parse the FIRST GFM pipe table found in `sectionText`.
 *
 * Defensive by design: never throws — every malformed shape (no table,
 * missing/misaligned delimiter row, ragged data row) returns a typed
 * `{ok:false, reason}` instead of silently coercing or dropping data
 * (ADR-2143 §3 — ragged rows are errors, not silent).
 *
 * Scope note: GSD planning tables (STATE.md/ROADMAP.md/requirements.md/
 * SECURITY.md) are always fully-piped (leading + trailing `|` on every row)
 * and non-indented — this parser targets THAT shape, not arbitrary
 * CommonMark (which also allows non-piped rows and up to 3 leading spaces).
 */
export function parseMarkdownTable(sectionText: string): Result<MarkdownTable> {
  if (typeof sectionText !== 'string' || sectionText.trim() === '') {
    return { ok: false, reason: 'empty or non-string input' };
  }

  const lines = sectionText.split(/\r?\n/);

  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('|') && trimmed.indexOf('|', 1) !== -1) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) {
    return { ok: false, reason: 'no table found' };
  }

  const columns = splitTableRow(lines[headerIdx]);

  const delimiterLine = lines[headerIdx + 1];
  if (delimiterLine === undefined || !delimiterLine.trim().startsWith('|')) {
    return { ok: false, reason: 'missing delimiter row' };
  }
  const delimiterCells = splitTableRow(delimiterLine);
  if (!isDelimiterRow(delimiterCells)) {
    return { ok: false, reason: 'missing delimiter row' };
  }
  if (delimiterCells.length !== columns.length) {
    return { ok: false, reason: 'delimiter/header column count mismatch' };
  }

  const rows: Record<string, string>[] = [];
  let rowNum = 0;
  for (let i = headerIdx + 2; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed.startsWith('|')) break;

    rowNum += 1;
    const cells = splitTableRow(lines[i]);
    if (cells.length !== columns.length) {
      return {
        ok: false,
        reason: `row ${rowNum} has ${cells.length} cells, expected ${columns.length}`,
      };
    }

    const row: Record<string, string> = {};
    columns.forEach((col, idx) => {
      row[col] = cells[idx];
    });
    rows.push(row);
  }

  return { ok: true, value: { columns, rows } };
}

/**
 * Find the first table in `text` whose header matches `TABLE_SCHEMAS[schemaId]`,
 * scanning the WHOLE document (not just a named section). Returns `null` when
 * no table with that schema is found.
 *
 * Fixes the regression where callers first located a named heading (e.g.
 * `## Progress`) via `collectSection` and only then parsed a table inside it —
 * a schema-matching table that lives under a differently-named heading (or no
 * heading at all), or that isn't the first table in the document, was
 * invisible to that approach. Scanning the whole document by schema restores
 * the old "find the progress table anywhere" behaviour while staying
 * seam-based (ADR-2143).
 */
export function findTableBySchema(text: string, schemaId: string): MarkdownTable | null {
  if (typeof text !== 'string') return null;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t.startsWith('|') || t.indexOf('|', 1) === -1) continue;
    const cols = splitTableRow(lines[i]);
    const m = matchTableSchema(cols);
    if (m && m.id === schemaId) {
      const parsed = parseMarkdownTable(lines.slice(i).join('\n'));
      if (parsed.ok) return parsed.value;
    }
  }
  return null;
}

/**
 * Find the first GFM table in `text` whose header contains ALL of `required`
 * column names (order-independent; extra/injected columns allowed). Returns
 * the parsed `MarkdownTable`, or `null` when no table's header is a superset
 * of `required`.
 *
 * Column-NAME/order/count-invariant counterpart to `findTableBySchema` (ADR-2143
 * §3 "addressed by NAME, never ordinal"): where `findTableBySchema` requires an
 * EXACT canonical column set+order registered in `TABLE_SCHEMAS`, this scans
 * for any header that names the required columns, in any order, tolerating
 * extra/unrelated injected columns. Cells remain addressable by column NAME
 * via the returned `MarkdownTable`.
 */
export function findTableWithColumns(text: string, required: string[]): MarkdownTable | null {
  if (typeof text !== 'string') return null;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t.startsWith('|') || t.indexOf('|', 1) === -1) continue;
    const cols = splitTableRow(lines[i]);
    if (required.every((rq) => cols.includes(rq))) {
      const parsed = parseMarkdownTable(lines.slice(i).join('\n'));
      if (parsed.ok) return parsed.value;
    }
  }
  return null;
}

// ─── Quick Tasks row append (#2133) ────────────────────────────────────────────

/**
 * Escape one dynamic cell value for insertion into a GFM pipe-table row.
 *
 * Escapes `\` -> `\\` FIRST, then `|` -> `\|` (in that order, so a literal
 * backslash already in the value is never mistaken for part of an escape
 * sequence introduced by this function — CodeQL js/incomplete-sanitization).
 * `splitTableRow` reverses both in the opposite order (`\\` -> `\` then
 * `\|` -> `|`, see line ~114 above), so escaping/unescaping round-trips
 * exactly, including literal backslashes. Newlines are collapsed to a
 * single space — a raw `|` or embedded newline in a cell value (e.g. a task
 * `description`) would otherwise corrupt the table (extra column / a fake
 * extra row) and get rejected by the now-fail-loud `parseMarkdownTable` as a
 * ragged row.
 */
function escapeCell(value: string): string {
  return String(value)
    .replace(/\r?\n+/g, ' ')
    .replace(/\\/g, '\\\\') // escape the escape char FIRST (CodeQL js/incomplete-sanitization)
    .replace(/\|/g, '\\|')
    .trim();
}

/** Fields needed to render one "Quick Tasks Completed" row (schema-driven). */
export interface QuickTaskFields {
  description: string;
  date: string;
  commit: string;
  status?: string;
  directory?: string;
}

/**
 * Append one row to STATE.md's "Quick Tasks Completed" table.
 *
 * Pure, schema-driven replacement for fast.md's inline `awk NF-2` column-count
 * guess (#2133, ADR-2143 §3 schema registry / §7 fail-loud unrecognized-schema
 * guard). Never touches disk, git, or the clock — callers (the `gsd-tools
 * quick-tasks-append` subcommand) compute `date`/`commit` and pass them in.
 *
 * Fails loud (`{ok:false, reason}`, never a silent skip) when:
 *   - no "Quick Tasks Completed" heading exists in `stateContent`
 *   - the section's body doesn't parse as a GFM table (parseMarkdownTable failure)
 *   - the table's header doesn't match a known `TABLE_SCHEMAS.QuickTasks` variant
 *     (the old awk arithmetic silently skipped here instead — that silent-skip
 *     branch is the bug this replaces).
 *
 * The new row is inserted immediately after the LAST existing table row line
 * (or immediately after the header/delimiter when the table has zero data
 * rows), preserving any surrounding blank lines/trailing content in the section.
 */
export function appendQuickTaskRow(
  stateContent: string,
  fields: QuickTaskFields,
): Result<{ content: string; row: string; variant: string }> {
  const section = collectSection(stateContent, (h) => /^quick tasks completed$/i.test(h.text.trim()));
  if (!section) {
    return { ok: false, reason: 'no Quick Tasks Completed section' };
  }

  const parsed = parseMarkdownTable(section.body);
  if (!parsed.ok) {
    return { ok: false, reason: `quick-tasks table: ${parsed.reason}` };
  }

  const match = matchTableSchema(parsed.value.columns);
  if (!match || match.id !== 'QuickTasks') {
    return {
      ok: false,
      reason: `unrecognized Quick Tasks schema (columns: ${parsed.value.columns.join(' | ')})`,
    };
  }

  const variant = TABLE_SCHEMAS.QuickTasks.find((v) => v.label === match.label);
  const columns = variant ? variant.columns : parsed.value.columns;

  const rowNumber = parsed.value.rows.length + 1;
  const cellFor = (col: string): string => {
    switch (col) {
      case '#': return escapeCell(String(rowNumber));
      case 'Description': return escapeCell(fields.description);
      case 'Date': return escapeCell(fields.date);
      case 'Commit': return escapeCell(fields.commit);
      case 'Status': return escapeCell(fields.status ?? '—');
      case 'Directory': return escapeCell(fields.directory ?? '—');
      default: return '—';
    }
  };
  const row = `| ${columns.map(cellFor).join(' | ')} |`;

  // Detect the section's EOL BEFORE splitting on /\r?\n/ (which discards it) so
  // the rejoin below preserves CRLF instead of downgrading a CRLF section to
  // mixed EOL (the inserted `row` itself never contains a newline).
  const eol = /\r\n/.test(section.body) ? '\r\n' : '\n';
  const lines = section.body.split(/\r?\n/);
  let lastTableLineIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith('|')) lastTableLineIdx = i;
  }
  // lastTableLineIdx is always >= 0 here — parseMarkdownTable already
  // confirmed a header + delimiter row exist in this same `section.body`.
  const newLines = [
    ...lines.slice(0, lastTableLineIdx + 1),
    row,
    ...lines.slice(lastTableLineIdx + 1),
  ];
  const newBody = newLines.join(eol);

  const content = replaceSection(stateContent, section, newBody);

  return { ok: true, value: { content, row, variant: match.label } };
}

// Consumers: require('../gsd-core/bin/lib/markdown-table.cjs')
// Named CJS exports are the canonical surface (ADR-457 .cts → .cjs build-at-publish).
