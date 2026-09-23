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

import { tokenizeHeadings, collectSections, scanFencedBlocks, iterateBullets } from './markdown-sectionizer.cjs';
import { splitTableRow, isDelimiterRow, parseMarkdownTable } from './markdown-table.cjs';
import { isCanonicalPlanningFile, CANONICAL_EXACT } from './artifacts.cjs';
// `frontmatter.cts` uses `export =` (CJS-style single export object), so it
// is imported as a default import (esModuleInterop), not a named import.
import frontmatterModule from './frontmatter.cjs';
import type { Result } from './write-set.cjs';

const { frontmatterRegion } = frontmatterModule;

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

/**
 * Locate the frontmatter block, if any, by COMPOSING `frontmatter.cts`'s
 * `frontmatterRegion` — the fence-detection grammar (byte-0 rule, BOM strip,
 * `\n---` search, CR handling) lives there, once, and this seam never
 * re-derives it (ADR-4910 Decision 1).
 *
 * `frontmatterRegion` reports the YAML body's own bounds (`region`,
 * `terminated`, and the possibly BOM-stripped `content`), not this seam's
 * `Span` shape (an absolute byte range into the UNSTRIPPED `source`,
 * inclusive of both fences). This adapter translates one into the other by
 * reading ONLY the two boundary characters `frontmatterRegion` already
 * anchored (whether the YAML end / closing fence sit on a CRLF line) — it
 * does not re-scan for the fences themselves.
 */
function findFrontmatterSpan(source: string): { span: Span; terminated: boolean } | null {
  const found = frontmatterRegion(source);
  if (!found) return null;

  // `found.content` may be `source` with a single leading BOM stripped;
  // every offset below is relative to `found.content`, so translate back to
  // `source` coordinates by the same delta.
  const bomDelta = source.length - found.content.length;
  const content = found.content;

  if (!found.terminated) {
    return { span: { start: bomDelta, end: bomDelta + content.length }, terminated: false };
  }

  // `frontmatterRegion` already did fence DETECTION — `found` being non-null
  // and `terminated` IS that result. It reports only the YAML body's bounds
  // (`region`), not an absolute span, so recover the closing fence's end
  // from `region`'s length. The one thing still read directly here is the
  // opening fence's fixed-width line ending (`\n` vs `\r\n`), needed to
  // translate `region`'s length into a `content` offset — not a re-scan for
  // the fence itself.
  const headerEnd = content.startsWith('---\r\n') ? 5 : 4;
  const yamlEnd = headerEnd + found.region.length;
  const closingLineStart = content[yamlEnd] === '\r' ? yamlEnd + 1 : yamlEnd;
  const fenceLineStart = closingLineStart + 1;
  let fenceEnd = fenceLineStart + 3;
  if (content[fenceEnd] === '\r') fenceEnd += 1;
  return { span: { start: bomDelta, end: bomDelta + fenceEnd }, terminated: true };
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

/** Matches both shipped bold-field spellings: colon-inside (`**Label:**`,
 * the original grammar) and colon-outside (`**Label**:`, the canonical form
 * used throughout `templates/roadmap.md`). Each alternative's trailing
 * marker is exactly 3 characters (`:**` or `**:`), so `token.slice(2, -3)`
 * in `parseBoldFieldLine` strips the leading `**` and the spelling-specific
 * trailing marker identically for both, yielding the same `label` either
 * way. Deliberately excludes a bare unbolded `Label:` form — see Phase 1's
 * prose-vs-field disambiguation design. */
const BOLD_FIELD_RE = /^(\s*)(\*\*[^*\r\n]+(?::\*\*|\*\*:))([ \t]*)([^\r\n]*)$/;
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

/** A checklist line is one whose SOLE bullet, per `iterateBullets` (the same
 * grammar the repo's other bullet consumers use), is a checkbox marker, OR
 * whose bullet TEXT begins with a task-list marker.
 *
 * `iterateBullets` owns bullet *structure* — is this a bullet, where does its
 * text start — and continues to own that here unchanged. It only classifies
 * `-`-prefixed bullets as `checkbox-checked`/`checkbox-unchecked`; GFM also
 * permits `*` and `+` as bullet markers, and `* [ ] x` / `+ [x] y` are valid
 * GFM task-list items that `iterateBullets` reports as plain `dash`-family
 * bullets with the `[ ]`/`[x]` left in the bullet's own text. Widening
 * `iterateBullets` itself is forbidden by ADR-2143 §2's extend-never-mutate
 * lock (inherited by this epic), so the task-list-marker interpretation is
 * layered on here, over the bullet's already-extracted text — never by
 * re-scanning the raw line with a new hand-rolled regex.
 *
 * Known limit inherited from `iterateBullets`, not introduced here:
 * `-\t[ ] text` (a tab between the marker and the text) is not recognised as
 * a bullet at all, so it can never become a checklist line. That is a
 * pre-existing `markdown-sectionizer` boundary affecting every consumer of
 * `iterateBullets`, and fixing it would mean altering the locked seam. */
function isChecklistLine(text: string): boolean {
  const items = iterateBullets(text);
  if (items.length !== 1) return false;
  const item = items[0];
  if (item.marker === 'checkbox-checked' || item.marker === 'checkbox-unchecked') return true;
  return /^\[[ xX]\] /.test(item.text);
}

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
    if (isChecklistLine(line.text)) {
      let last = i;
      let count = 0;
      while (last < lines.length && !fenced.has(last) && isChecklistLine(lines[last].text)) {
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
  // #4917 / ADR-4910 Decision 2 & 4: a boldField's token boundary is a LINE
  // boundary, not just an offset range — a value containing \n or \r escapes
  // the field's own span and reparses as sibling structure (a forged field)
  // once spliced back into the source. Decision 4 licenses refusal for any
  // value the grammar cannot represent; Phase 3 may widen this to escaping,
  // but Phase 1 refuses outright. Do not remove this as an over-restriction.
  if (/[\r\n]/.test(value)) {
    return { ok: false, reason: 'field value must not contain a line break (\\r or \\n)' };
  }
  // #4917 / ADR-4910 Decision 4: "a value that cannot be represented in the
  // grammar is refused by the writer, with a report." This is a GENERAL
  // round-trip representability check, not a blacklist of forbidden
  // substrings — the `\r`/`\n` guard above is a narrower special case kept
  // for its clearer message, but THIS check is the backstop. It rebuilds the
  // line exactly as it would be written (existing leading/label/spacing +
  // the new value + the existing trailing text) and re-parses that line
  // through the SAME `parseBoldFieldLine` grammar the reader uses. If the
  // value the grammar reads back is not byte-identical to what the caller
  // staged, the grammar cannot represent this value (e.g. it contains the
  // ` — ` trailing-separator token, which would silently reclassify the
  // rest of the value as trailing prose) and the write is refused. Do NOT
  // replace this with a list of forbidden characters/substrings — the next
  // separator the grammar grows would silently slip past a blacklist.
  const leadingText = doc.source.slice(node.span.start, node.labelSpan.start);
  const tokenText = doc.source.slice(node.labelSpan.start, node.labelSpan.end);
  const spacingText = doc.source.slice(node.labelSpan.end, node.valueSpan.start);
  const trailingText = doc.source.slice(node.trailingSpan.start, node.trailingSpan.end);
  const candidateLine = `${leadingText}${tokenText}${spacingText}${value}${trailingText}`;
  const candidateInfo: LineInfo = { text: candidateLine, start: 0, end: candidateLine.length };
  const reparsed = parseBoldFieldLine(candidateInfo);
  if (!reparsed || reparsed.value !== value) {
    return {
      ok: false,
      reason: 'field value is not representable in the boldField grammar (would not round-trip)',
    };
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
