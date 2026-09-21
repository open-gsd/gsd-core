/**
 * Planning Document — the parse -> mutate -> serialize seam for a `.planning/`
 * root artifact BODY (ADR-4910, epic #4906 Phase 1, #4917).
 *
 * Composes the existing structural seams — never reimplements them:
 *  - `markdown-sectionizer.cjs` (`tokenizeHeadings`, `collectSections`,
 *    `scanFencedBlocks`, `scanInlineCodeSpans`) for headings/sections and
 *    fence/inline-code awareness.
 *  - `markdown-table.cjs` (`splitTableRow`, `isDelimiterRow`,
 *    `parseMarkdownTable`) for GFM table detection and validation.
 *  - `artifacts.cjs` (`isCanonicalPlanningFile`) for the artifact-kind gate.
 *
 * This phase migrates NO call site — it is purely additive (ADR-4910 §7).
 * Only `boldField` nodes are writable; `table`/`checklist` nodes parse and
 * read only (their writers are Phase 3's escaping work).
 *
 * Hyrum's Law commitment (row 3 of the design's behaviour table): `serialize`
 * with zero staged edits returns `doc.source` BYTE-IDENTICAL — never a
 * re-render (#4499's root cause). Every byte outside an edited `valueSpan` is
 * the ORIGINAL source, spliced, never regenerated.
 *
 * ADR-457 build-at-publish: source in src/planning-document.cts, compiled to
 * gsd-core/bin/lib/planning-document.cjs (gitignored).
 */

import { tokenizeHeadings, collectSections, scanFencedBlocks } from './markdown-sectionizer.cjs';
import { splitTableRow, isDelimiterRow, parseMarkdownTable } from './markdown-table.cjs';
import { isCanonicalPlanningFile, CANONICAL_EXACT } from './artifacts.cjs';
import type { Result } from './write-set.cjs';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Character offsets into the ORIGINAL `PlanningDoc.source` string. */
export interface Span {
  start: number;
  end: number;
}

/** Why a node failed to parse, and exactly where the bad span is. */
export interface NodeError {
  reason: string;
  span: Span;
}

export type NodeKind = 'frontmatter' | 'section' | 'boldField' | 'table' | 'checklist';

/** Opaque node handle, minted by `parsePlanningDoc`. A caller cannot name a
 * node the parser did not find — `findField` is the only way to obtain one. */
export type NodeId = string;

/** Common shape every planning node carries. */
interface BaseNode {
  id: NodeId;
  span: Span;
  error: NodeError | null;
}

/** The `---\n...\n---` YAML frontmatter block, span-only (this phase does not
 * parse the YAML itself — that is `frontmatter.cts`'s job). */
export interface FrontmatterNode extends BaseNode {
  kind: 'frontmatter';
}

/** One heading + body region, per `collectSections`. */
export interface SectionNode extends BaseNode {
  kind: 'section';
  heading: string;
  level: number;
}

/**
 * A `**Label:** value` line. `valueSpan` is the WRITE BOUNDARY — the only
 * span any exported function accepts as a write target. `trailingSpan` is
 * the rest of the line (a hand-written annotation, an em-dash note, etc.):
 * readable via `readNode`'s reconstructed text is not exposed for it, but
 * the field itself is public data on this node — there is deliberately no
 * exported function that writes into it (ADR-4910 §1's structural rule).
 */
export interface BoldFieldNode extends BaseNode {
  kind: 'boldField';
  label: string;
  labelSpan: Span;
  valueSpan: Span;
  trailingSpan: Span;
  value: string;
}

/** A GFM pipe table found in the document body. */
export interface TableNode extends BaseNode {
  kind: 'table';
  columns: string[] | null;
}

/** A contiguous run of checkbox-bullet lines (`- [ ] ...` / `- [x] ...`). */
export interface ChecklistNode extends BaseNode {
  kind: 'checklist';
  items: number;
}

export type PlanningNode = FrontmatterNode | SectionNode | BoldFieldNode | TableNode | ChecklistNode;

export interface PlanningDoc {
  readonly source: string;
  readonly artifact: string;
  readonly nodes: readonly PlanningNode[];
  readonly staged: ReadonlyMap<NodeId, string>;
}

export type NodeRead = { ok: true; value: string } | { ok: false; reason: string; span: Span };

export type SerializeOutcome =
  | { ok: true; value: string }
  | {
      ok: false;
      reason: 'unreadable-nodes';
      nodes: Array<{ id: NodeId; kind: NodeKind; span: Span; reason: string }>;
    };

/**
 * Canonical `.planning/` root artifact basenames this seam recognises,
 * derived from the SAME registry `isCanonicalPlanningFile` consults
 * (`artifacts.cts`'s `CANONICAL_EXACT`) — never a second, independently
 * maintained list.
 *
 * Filtered to `.md` names only: `CANONICAL_EXACT` also carries non-markdown
 * artifacts (`config.json`, `state.json`, `milestone.lock`, …) that this
 * parser has no grammar for. Handing that JSON/lock content to the markdown
 * parser below returns a successful EMPTY document (`nodes: []`), which reads
 * as "this document records nothing" when the truth is "wrong kind entirely"
 * — the empty-vs-error confusion #4917 / ADR-4910 §5 exists to eliminate. Do
 * NOT remove this filter to "restore" the full registry.
 */
export const PLANNING_ARTIFACTS: readonly string[] = Object.freeze(
  Array.from(CANONICAL_EXACT).filter((name) => name.endsWith('.md')),
);

// ─── Internal helpers ───────────────────────────────────────────────────────

let nodeCounter = 0;
function mintId(kind: NodeKind): NodeId {
  nodeCounter += 1;
  return `${kind}-${nodeCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

interface LineInfo {
  /** Line text WITHOUT a trailing `\r` (CRLF-safe). */
  text: string;
  /** Absolute char offset of this line's first character in `source`. */
  start: number;
  /** Absolute char offset one past this line's last content char, BEFORE
   * any `\r`/`\n` — i.e. `source.slice(start, end) === text`. */
  end: number;
}

function splitLinesInfo(source: string): LineInfo[] {
  const out: LineInfo[] = [];
  let offset = 0;
  const rawLines = source.split('\n');
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    const hasCR = raw.endsWith('\r');
    const text = hasCR ? raw.slice(0, -1) : raw;
    out.push({ text, start: offset, end: offset + text.length });
    offset += raw.length + 1; // +1 for the '\n' split on ('\r' already counted in raw.length)
  }
  return out;
}

/** Locate the frontmatter block, if any. Byte-0 fence only (matches the
 * house convention in `frontmatter.cts`'s `frontmatterRegion`), but this
 * seam does not tolerate a BOM strip or re-derive the YAML parse — it only
 * needs the block's span and whether it is terminated. */
function findFrontmatterSpan(source: string): { span: Span; terminated: boolean } | null {
  const headerEnd = source.startsWith('---\r\n') ? 5 : source.startsWith('---\n') ? 4 : -1;
  if (headerEnd === -1) return null;

  const closingLineStart = source.indexOf('\n---', headerEnd);
  if (closingLineStart === -1) {
    return { span: { start: 0, end: source.length }, terminated: false };
  }
  // The closing fence line itself: from the '\n' we found, the fence starts
  // right after it (closingLineStart + 1) and runs through '---' (3 chars).
  const fenceLineStart = closingLineStart + 1;
  let fenceEnd = fenceLineStart + 3;
  // Absorb an optional trailing '\r' right after the closing '---' so the
  // frontmatter span never straddles into the following '\n'.
  if (source[fenceEnd] === '\r') fenceEnd += 1;
  return { span: { start: 0, end: fenceEnd }, terminated: true };
}

/** Build the set of 0-based line indices that fall inside a fenced code
 * block (opening/closing delimiter lines included), so `**Label:**`/table/
 * checklist scanning never treats fenced content as a node (rows 9/14). */
function fencedLineIndices(lines: LineInfo[]): Set<number> {
  const raw = lines.map((l) => l.text);
  const blocks = scanFencedBlocks(raw);
  const set = new Set<number>();
  for (const b of blocks) {
    const end = b.closeLineIdx === -1 ? raw.length - 1 : b.closeLineIdx;
    for (let i = b.openLineIdx; i <= end; i++) set.add(i);
  }
  return set;
}

const BOLD_FIELD_RE = /^(\s*)(\*\*[^*\r\n]+:\*\*)([ \t]*)([^\r\n]*)$/;
/** Boundary marking a hand-written trailing annotation on a field line —
 * the token owner must never destroy prose past this separator. */
const TRAILING_SEPARATOR_RE = / — /;

function parseBoldFieldLine(line: LineInfo): BoldFieldNode | null {
  const m = BOLD_FIELD_RE.exec(line.text);
  if (!m) return null;
  const [, leading, token, spacing, rest] = m;
  const labelStart = line.start + leading.length;
  const labelSpan: Span = { start: labelStart, end: labelStart + token.length };
  const label = token.slice(2, -3);
  const restStart = labelSpan.end + spacing.length;

  const sepMatch = TRAILING_SEPARATOR_RE.exec(rest);
  const valueRaw = sepMatch ? rest.slice(0, sepMatch.index) : rest;
  const trimmedValue = valueRaw.replace(/\s+$/, '');
  const valueSpan: Span = { start: restStart, end: restStart + trimmedValue.length };
  const trailingSpan: Span = { start: valueSpan.end, end: line.end };

  return {
    kind: 'boldField',
    id: mintId('boldField'),
    span: { start: labelSpan.start, end: line.end },
    error: null,
    label,
    labelSpan,
    valueSpan,
    trailingSpan,
    value: trimmedValue,
  };
}

const CHECKLIST_LINE_RE = /^\s*[-*+]\s\[[ xX]\]\s/;

/**
 * Scan the document body (everything outside the frontmatter block and
 * outside fenced code) for `boldField`, `table`, and `checklist` nodes, in
 * document order.
 */
function scanBodyNodes(source: string, lines: LineInfo[], frontmatterEnd: number): PlanningNode[] {
  const fenced = fencedLineIndices(lines);
  const nodes: PlanningNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (fenced.has(i) || line.start < frontmatterEnd) {
      i += 1;
      continue;
    }

    const trimmed = line.text.trim();

    // Table: a pipe-shaped header line followed by a valid delimiter row.
    if (trimmed.startsWith('|') && trimmed.indexOf('|', 1) !== -1 && i + 1 < lines.length) {
      const delimiterLine = lines[i + 1];
      const delimiterCells = splitTableRow(delimiterLine.text);
      const headerCells = splitTableRow(line.text);
      if (
        delimiterLine.text.trim().startsWith('|')
        && isDelimiterRow(delimiterCells)
        && delimiterCells.length === headerCells.length
        && !fenced.has(i + 1)
      ) {
        let last = i + 1;
        while (last + 1 < lines.length && lines[last + 1].text.trim().startsWith('|') && !fenced.has(last + 1)) {
          last += 1;
        }
        const span: Span = { start: line.start, end: lines[last].end };
        const tableText = source.slice(span.start, span.end);
        const parsed = parseMarkdownTable(tableText);
        nodes.push(
          parsed.ok
            ? {
                kind: 'table',
                id: mintId('table'),
                span,
                error: null,
                columns: parsed.value.columns,
              }
            : {
                kind: 'table',
                id: mintId('table'),
                span,
                error: { reason: parsed.reason, span },
                columns: null,
              },
        );
        i = last + 1;
        continue;
      }
    }

    // Checklist: a contiguous run of checkbox-bullet lines.
    if (CHECKLIST_LINE_RE.test(line.text)) {
      let last = i;
      let count = 0;
      while (last < lines.length && !fenced.has(last) && CHECKLIST_LINE_RE.test(lines[last].text)) {
        count += 1;
        last += 1;
      }
      last -= 1;
      const span: Span = { start: line.start, end: lines[last].end };
      nodes.push({ kind: 'checklist', id: mintId('checklist'), span, error: null, items: count });
      i = last + 1;
      continue;
    }

    // Bold field.
    const field = parseBoldFieldLine(line);
    if (field) {
      nodes.push(field);
      i += 1;
      continue;
    }

    i += 1;
  }
  return nodes;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Parse `source` (the raw text of a `.planning/` root artifact) into a
 * `PlanningDoc`. Document-level `Result` failure is reserved for: `artifact`
 * not a recognised planning artifact kind, `source` not a readable string, or
 * an opened-but-never-closed frontmatter fence (ADR-4910 §5's reservation).
 * A malformed SUB-structure (a ragged table, say) never fails the whole
 * document — it is recorded as that one node's `error`, and every sibling
 * node stays readable (row 7). `nodes: []` on a genuinely empty document is
 * success, not an error (row 15).
 */
export function parsePlanningDoc(source: string, artifact: string): Result<PlanningDoc> {
  if (typeof source !== 'string') {
    return { ok: false, reason: 'unreadable: source is not a string' };
  }
  if (
    typeof artifact !== 'string' ||
    !isCanonicalPlanningFile(artifact) ||
    !PLANNING_ARTIFACTS.includes(artifact)
  ) {
    return {
      ok: false,
      reason: `not a markdown planning document (artifact: ${String(artifact)})`,
    };
  }

  const nodes: PlanningNode[] = [];
  let frontmatterEnd = 0;

  const fm = findFrontmatterSpan(source);
  if (fm) {
    if (!fm.terminated) {
      return { ok: false, reason: 'no frontmatter terminator' };
    }
    nodes.push({ kind: 'frontmatter', id: mintId('frontmatter'), span: fm.span, error: null });
    frontmatterEnd = fm.span.end;
  }

  if (source.length === 0) {
    return { ok: true, value: { source, artifact, nodes: [], staged: new Map() } };
  }

  const lines = splitLinesInfo(source);

  // Sections: one per heading, in document order — every heading is its own
  // boundary (`collectSections(source, () => true)`), so a nested `####`
  // still gets its own SectionNode rather than being folded into its parent.
  const headings = tokenizeHeadings(source);
  if (headings.length > 0) {
    const sections = collectSections(source, () => true);
    for (const s of sections) {
      nodes.push({
        kind: 'section',
        id: mintId('section'),
        span: { start: s.heading.offset, end: s.bodyEnd },
        error: null,
        heading: s.heading.text,
        level: s.heading.level,
      });
    }
  }

  nodes.push(...scanBodyNodes(source, lines, frontmatterEnd));

  nodes.sort((a, b) => a.span.start - b.span.start);

  return { ok: true, value: { source, artifact, nodes, staged: new Map() } };
}

/** Find the id of the (first, document-order) `boldField` node whose label
 * exactly matches `label`, or `null` when none does. */
export function findField(doc: PlanningDoc, label: string): NodeId | null {
  for (const n of doc.nodes) {
    if (n.kind === 'boldField' && n.label === label) return n.id;
  }
  return null;
}

/** Read a node by id. Node-scoped failure only — an unknown id or a node
 * that failed to parse never throws. */
export function readNode(doc: PlanningDoc, id: NodeId): NodeRead {
  const node = doc.nodes.find((n) => n.id === id);
  if (!node) {
    return { ok: false, reason: 'unknown node id', span: { start: 0, end: 0 } };
  }
  if (node.error) {
    return { ok: false, reason: node.error.reason, span: node.error.span };
  }
  if (node.kind === 'boldField') {
    return { ok: true, value: doc.staged.get(id) ?? node.value };
  }
  return { ok: true, value: doc.source.slice(node.span.start, node.span.end) };
}

/**
 * Stage a new value for a `boldField` node, returning a NEW `PlanningDoc`
 * (immutable — `doc` itself is never mutated). Refuses an id this doc did
 * not mint, and refuses any node kind other than `boldField` — only the
 * `valueSpan` is ever writable this phase (ADR-4910 §1).
 */
export function setFieldValue(doc: PlanningDoc, id: NodeId, value: string): Result<PlanningDoc> {
  const node = doc.nodes.find((n) => n.id === id);
  if (!node) {
    return { ok: false, reason: 'unknown node id' };
  }
  if (node.kind !== 'boldField') {
    return { ok: false, reason: `node kind '${node.kind}' is not writable this phase` };
  }
  const staged = new Map(doc.staged);
  staged.set(id, value);
  return { ok: true, value: { source: doc.source, artifact: doc.artifact, nodes: doc.nodes, staged } };
}

/** True when any node in `doc` failed to parse. */
export function hasUnreadableNodes(doc: PlanningDoc): boolean {
  return doc.nodes.some((n) => n.error !== null);
}

/**
 * Splice every staged edit into `doc.source` and return the resulting text.
 * With zero staged edits, returns `doc.source` BYTE-IDENTICAL — never a
 * re-render (row 3). Refuses outright — even with zero staged edits — when
 * `hasUnreadableNodes(doc)` is true (the ADR-4910 amendment): `serialize`
 * re-emits the WHOLE document, so the refusal is document-scoped, not
 * mutation-scoped.
 */
export function serialize(doc: PlanningDoc): SerializeOutcome {
  if (hasUnreadableNodes(doc)) {
    return {
      ok: false,
      reason: 'unreadable-nodes',
      nodes: doc.nodes
        .filter((n): n is PlanningNode & { error: NodeError } => n.error !== null)
        .map((n) => ({ id: n.id, kind: n.kind, span: n.error.span, reason: n.error.reason })),
    };
  }

  if (doc.staged.size === 0) {
    return { ok: true, value: doc.source };
  }

  const edits: Array<{ start: number; end: number; value: string }> = [];
  for (const [id, value] of doc.staged) {
    const node = doc.nodes.find((n) => n.id === id);
    if (!node || node.kind !== 'boldField') continue; // unreachable: setFieldValue already gated this
    edits.push({ start: node.valueSpan.start, end: node.valueSpan.end, value });
  }
  edits.sort((a, b) => a.start - b.start);

  let out = '';
  let cursor = 0;
  for (const e of edits) {
    out += doc.source.slice(cursor, e.start) + e.value;
    cursor = e.end;
  }
  out += doc.source.slice(cursor);

  return { ok: true, value: out };
}

// Consumers: require('../gsd-core/bin/lib/planning-document.cjs')
// Named CJS exports are the canonical surface (ADR-457 .cts → .cjs build-at-publish).
