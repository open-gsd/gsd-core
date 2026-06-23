/**
 * Coverage metadata — deterministic UAT routing (#1602)
 *
 * Parses the optional `coverage:` block in a SUMMARY.md frontmatter, validates
 * each deliverable entry against the coverage schema, and classifies each into
 * `auto_passed` (deterministically covered — no human prompt) or `present`
 * (a human UAT checkpoint is required).
 *
 * Design constraints (see issue #1602, plus the Postel/Goodhart/Hyrum analysis):
 *  - Lenient parse, strict auto-pass. The parser NEVER throws on malformed
 *    input; a structurally surprising entry degrades to `present` + an error.
 *  - Fail-safe asymmetry. Auto-pass is the narrow, fully-proven case
 *    (strict-boolean `human_judgment:false` AND non-empty all-`pass`
 *    verification AND zero validation errors). Everything else is presented to
 *    the human. A false-negative is a redundant prompt (the status quo); a
 *    false-positive ships a bug UAT existed to catch.
 *  - Absent block ≠ empty block. No `coverage:` key → `mode: legacy` so the
 *    caller falls through to today's prose-based extraction (byte-identical for
 *    un-migrated phases). `coverage: []` → `mode: coverage`, zero entries.
 *
 * The classifier is deterministic code, not a prompt heuristic — the issue's
 * central thesis. Tests assert on the frozen typed-IR surface below, not prose.
 */

import fs from 'node:fs';
import path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import io = require('./io.cjs');
const { output, error } = io;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import coreUtils = require('./core-utils.cjs');
const { toPosixPath } = coreUtils;
import { requireSafePath, sanitizeForDisplay } from './security.cjs';

// ─── Frozen typed-IR surface ────────────────────────────────────────────────

const MODE = Object.freeze({
  COVERAGE: 'coverage',
  LEGACY: 'legacy',
});

/** Why an entry was routed to the human path. Order of precedence below. */
const PRESENT_REASON = Object.freeze({
  VALIDATION_FAILED: 'validation_failed',
  HUMAN_JUDGMENT: 'human_judgment',
  NO_VERIFICATION: 'no_verification',
  VERIFICATION_NOT_PASSING: 'verification_not_passing',
});

/** Per-entry validation error codes. */
const ERROR_CODE = Object.freeze({
  MISSING_ID: 'missing_id',
  MISSING_DESCRIPTION: 'missing_description',
  MISSING_HUMAN_JUDGMENT: 'missing_human_judgment',
  INVALID_HUMAN_JUDGMENT: 'invalid_human_judgment',
  MISSING_RATIONALE: 'missing_rationale',
  DUPLICATE_ID: 'duplicate_id',
  VERIFICATION_NOT_LIST: 'verification_not_list',
  INVALID_KIND: 'invalid_kind',
  INVALID_STATUS: 'invalid_status',
  MISSING_REF: 'missing_ref',
  MALFORMED_ENTRY: 'malformed_entry',
  MALFORMED_BLOCK: 'malformed_block',
});

const VALID_KINDS = Object.freeze([
  'unit', 'integration', 'e2e', 'automated_ui', 'manual_procedural', 'other',
]);
const VALID_STATUSES = Object.freeze(['pass', 'fail', 'unknown']);

// ─── Types ──────────────────────────────────────────────────────────────────

type Scalar = string | boolean | null;
type RawVerification = Record<string, unknown>;
interface RawEntry {
  id?: unknown;
  description?: unknown;
  requirement?: unknown;
  verification?: unknown;
  human_judgment?: unknown;
  rationale?: unknown;
  [k: string]: unknown;
}

interface CoverageError {
  index: number;
  id: string | null;
  code: string;
  field?: string;
  message: string;
}

interface VerificationView {
  kind: string | null;
  ref: string | null;
  status: string | null;
}
interface EntryView {
  id: string | null;
  description: string | null;
  requirement?: string;
  verification: VerificationView[];
  human_judgment: boolean | null;
  rationale?: string;
}

interface ClassifyResult {
  mode: string;
  summary_file: string;
  total: number;
  all_auto_covered: boolean;
  auto_passed: (EntryView & { source: 'automated' })[];
  present: (EntryView & { reason: string })[];
  errors: CoverageError[];
}

// ─── YAML-subset block parser (scoped to the coverage schema) ────────────────
//
// `extractFrontmatter` (src/frontmatter.cts) flattens `- ` list items to
// scalars and cannot represent the coverage schema's list-of-maps-with-nested-
// list-of-maps. `parseMustHavesBlock` is the existing precedent for hand-rolling
// a focused parser for one schema; this is the same approach, one level deeper.
// We deliberately do NOT pull in a general YAML engine (no external deps in
// core; Greenspun's-tenth restraint).

function lineIndent(line: string): number {
  const m = /^( *)/.exec(line);
  return m ? m[1].length : 0;
}

function isSignificant(line: string): boolean {
  return line.trim() !== '';
}

function parseScalar(raw: string): Scalar {
  const t = raw.trim();
  if (t === '') return '';
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null' || t === '~') return null;
  return t;
}

/** Parse a block of lines (all indented ≥ `indent`) into a value. */
function parseNode(lines: string[], indent: number): unknown {
  const firstSig = lines.find(isSignificant);
  if (firstSig === undefined) return null;
  if (lineIndent(firstSig) === indent && /^ *-(?: |$)/.test(firstSig)) {
    return parseSequence(lines, indent);
  }
  return parseMapping(lines, indent);
}

function parseSequence(lines: string[], indent: number): unknown[] {
  const items: unknown[] = [];
  // Item-start lines: at exactly `indent`, beginning with a dash.
  const starts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isSignificant(lines[i])) continue;
    if (lineIndent(lines[i]) === indent && /^ *-(?: |$)/.test(lines[i])) starts.push(i);
  }
  for (let k = 0; k < starts.length; k++) {
    const start = starts[k];
    const end = k + 1 < starts.length ? starts[k + 1] : lines.length;
    const itemLines = lines.slice(start, end);
    // Re-base the dash line: replace the `indent` + "- " prefix with spaces so
    // the inline content aligns at `indent + 2` and parses as a normal node.
    itemLines[0] = ' '.repeat(indent + 2) + itemLines[0].slice(indent + 2);
    const itemFirst = itemLines.find(isSignificant);
    const head = itemFirst ? itemFirst.trim() : '';
    if (/^[\w-]+:(?: |$)/.test(head)) {
      items.push(parseMapping(itemLines, indent + 2));
    } else if (head === '') {
      items.push(null);
    } else {
      items.push(parseScalar(head));
    }
  }
  return items;
}

function parseMapping(lines: string[], indent: number): Record<string, unknown> {
  const map: Record<string, unknown> = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!isSignificant(line) || lineIndent(line) !== indent) { i++; continue; }
    const km = /^[\w-]+:\s*(.*)$/.exec(line.trim());
    if (!km) { i++; continue; }
    const key = (/^([\w-]+):/.exec(line.trim()) as RegExpMatchArray)[1];
    const inlineVal = km[1];
    if (inlineVal === '[]') {
      setKey(map, key, []);
      i++;
    } else if (inlineVal === '') {
      // Nested block: following lines indented deeper than `indent`.
      let j = i + 1;
      while (j < lines.length && (!isSignificant(lines[j]) || lineIndent(lines[j]) > indent)) j++;
      const block = lines.slice(i + 1, j);
      const blockFirst = block.find(isSignificant);
      if (blockFirst === undefined) {
        setKey(map, key, null);
      } else {
        setKey(map, key, parseNode(block, lineIndent(blockFirst)));
      }
      i = j;
    } else {
      setKey(map, key, parseScalar(inlineVal));
      i++;
    }
  }
  return map;
}

// Prototype-pollution-safe assignment (CodeQL js/prototype-pollution-utility:
// inline literal key guard at the write site).
function setKey(obj: Record<string, unknown>, key: string, value: unknown): void {
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') return;
  obj[key] = value;
}

// ─── Frontmatter region helpers ──────────────────────────────────────────────

function getFrontmatterYaml(content: string): string | null {
  const headerEnd = content.startsWith('---\r\n') ? 5 : content.startsWith('---\n') ? 4 : -1;
  if (headerEnd === -1) return null;
  const closingLineStart = content.indexOf('\n---', headerEnd);
  if (closingLineStart === -1) return null;
  const yamlEnd = content[closingLineStart - 1] === '\r' ? closingLineStart - 1 : closingLineStart;
  return content.slice(headerEnd, yamlEnd);
}

/**
 * Locate and parse the top-level `coverage:` block from a SUMMARY document.
 * `malformed` is true when a `coverage:` key IS present with body content that
 * does NOT parse into a non-empty sequence of entries — a distinct, fail-safe
 * signal so a broken block can never masquerade as "all covered" (the caller
 * falls back to prose extraction and surfaces the error). Distinct from
 * `coverage: []` / an empty body, which is the legitimate zero-entry case.
 */
function parseCoverage(content: string): { found: boolean; entries: RawEntry[]; malformed: boolean } {
  const yaml = getFrontmatterYaml(content);
  if (yaml === null) return { found: false, entries: [], malformed: false };
  const lines = yaml.split(/\r?\n/);

  let covIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^coverage:(?:\s|$)/.test(lines[i])) { covIdx = i; break; }
  }
  if (covIdx === -1) return { found: false, entries: [], malformed: false };

  // Strip a trailing YAML comment from the header value. The `coverage:` header
  // only ever carries `[]` or a comment — refs (which legitimately contain `#`)
  // live in quoted scalars on deeper lines, never on this line.
  const rawInline = (/^coverage:\s*(.*)$/.exec(lines[covIdx]) as RegExpMatchArray)[1];
  const inline = rawInline.replace(/\s*#.*$/, '').trim();
  if (inline === '[]') return { found: true, entries: [], malformed: false };
  if (inline !== '') {
    // A non-empty, non-`[]` inline scalar where a block was expected is malformed.
    return { found: true, entries: [], malformed: true };
  }

  // Gather the block body: every line after the header up to the next top-level
  // frontmatter key (a `key:` at column 0) or end of frontmatter. Mis-indented
  // lines (tabs, wrong column) are INCLUDED so they surface as a malformed block
  // rather than being silently excluded and the block read as falsely empty.
  let j = covIdx + 1;
  while (j < lines.length) {
    const l = lines[j];
    if (l.trim() === '') { j++; continue; }
    if (/^[A-Za-z0-9_-]+:(?:\s|$)/.test(l)) break; // next top-level key
    j++;
  }
  const block = lines.slice(covIdx + 1, j);
  const blockFirst = block.find(isSignificant);
  if (blockFirst === undefined) return { found: true, entries: [], malformed: false }; // empty body == coverage: []
  const node = parseNode(block, lineIndent(blockFirst));
  if (!Array.isArray(node) || node.length === 0) {
    // Body had content but did not parse into a sequence of entries → malformed.
    return { found: true, entries: [], malformed: true };
  }
  return { found: true, entries: node as RawEntry[], malformed: false };
}

// ─── Validation ───────────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validateEntry(entry: unknown, index: number, seenIds: Set<string>): CoverageError[] {
  const errors: CoverageError[] = [];

  // Object-check FIRST — before any property access — so a `null`/scalar
  // sequence item (e.g. a bare `-` or `- "string"`) can never throw.
  if (!isPlainObject(entry)) {
    errors.push({ index, id: null, code: ERROR_CODE.MALFORMED_ENTRY, message: 'coverage entry is not a mapping' });
    return errors;
  }

  const id = typeof entry.id === 'string' ? entry.id : null;
  const push = (code: string, message: string, field?: string): void => {
    errors.push({ index, id, code, field, message });
  };

  if (typeof entry.id !== 'string' || entry.id.trim() === '') {
    push(ERROR_CODE.MISSING_ID, 'entry is missing a non-empty id', 'id');
  } else if (seenIds.has(entry.id)) {
    push(ERROR_CODE.DUPLICATE_ID, `duplicate coverage id "${entry.id}"`, 'id');
  } else {
    seenIds.add(entry.id);
  }

  if (typeof entry.description !== 'string' || entry.description.trim() === '') {
    push(ERROR_CODE.MISSING_DESCRIPTION, 'entry is missing a non-empty description', 'description');
  }

  if (!('human_judgment' in entry)) {
    push(ERROR_CODE.MISSING_HUMAN_JUDGMENT, 'entry is missing the required human_judgment flag', 'human_judgment');
  } else if (typeof entry.human_judgment !== 'boolean') {
    push(ERROR_CODE.INVALID_HUMAN_JUDGMENT, 'human_judgment must be a boolean (true|false)', 'human_judgment');
  }

  if (entry.human_judgment === true && (typeof entry.rationale !== 'string' || entry.rationale.trim() === '')) {
    push(ERROR_CODE.MISSING_RATIONALE, 'rationale is required when human_judgment is true', 'rationale');
  }

  const v = entry.verification;
  if (v !== undefined && !Array.isArray(v)) {
    push(ERROR_CODE.VERIFICATION_NOT_LIST, 'verification must be a list', 'verification');
  } else if (Array.isArray(v)) {
    v.forEach((ve, vi) => {
      if (!isPlainObject(ve)) {
        push(ERROR_CODE.MALFORMED_ENTRY, 'verification item is not a mapping', `verification[${vi}]`);
        return;
      }
      if (typeof ve.kind !== 'string' || !VALID_KINDS.includes(ve.kind)) {
        push(ERROR_CODE.INVALID_KIND, `verification kind must be one of ${VALID_KINDS.join(', ')}`, `verification[${vi}].kind`);
      }
      if (typeof ve.status !== 'string' || !VALID_STATUSES.includes(ve.status)) {
        push(ERROR_CODE.INVALID_STATUS, `verification status must be one of ${VALID_STATUSES.join(', ')}`, `verification[${vi}].status`);
      }
      if (typeof ve.ref !== 'string' || ve.ref.trim() === '') {
        push(ERROR_CODE.MISSING_REF, 'verification entry is missing a non-empty ref', `verification[${vi}].ref`);
      }
    });
  }

  return errors;
}

// ─── Classification ───────────────────────────────────────────────────────────

function verificationList(entry: RawEntry): RawVerification[] {
  return Array.isArray(entry.verification) ? (entry.verification as RawVerification[]) : [];
}

/**
 * Auto-pass is the narrow, fully-proven case:
 *   - zero validation errors, AND
 *   - human_judgment is the strict boolean `false`, AND
 *   - verification is a NON-EMPTY list, AND
 *   - every verification entry has status === 'pass'.
 * The non-empty guard defeats the vacuous-`every` trap; the strict-boolean
 * guard defeats a gamed string flag; the zero-errors guard means a malformed
 * entry can never auto-pass.
 */
function isAutoPass(entry: RawEntry, errors: CoverageError[]): boolean {
  if (errors.length > 0) return false;
  if (entry.human_judgment !== false) return false;
  const v = verificationList(entry);
  if (v.length === 0) return false;
  return v.every((ve) => isPlainObject(ve) && ve.status === 'pass');
}

function presentReason(entry: RawEntry, errors: CoverageError[]): string {
  if (errors.length > 0) return PRESENT_REASON.VALIDATION_FAILED;
  if (entry.human_judgment === true) return PRESENT_REASON.HUMAN_JUDGMENT;
  const v = verificationList(entry);
  if (v.length === 0) return PRESENT_REASON.NO_VERIFICATION;
  return PRESENT_REASON.VERIFICATION_NOT_PASSING;
}

function san(value: unknown): string | null {
  return typeof value === 'string' ? sanitizeForDisplay(value) : null;
}

function entryView(entry: unknown): EntryView {
  // Null-safe: a malformed (non-object) entry still gets a minimal view so it
  // can be presented to the human rather than dropped or throwing.
  if (!isPlainObject(entry)) {
    return { id: null, description: null, verification: [], human_judgment: null };
  }
  const verification: VerificationView[] = verificationList(entry).map((ve) => ({
    kind: isPlainObject(ve) && typeof ve.kind === 'string' ? ve.kind : null,
    ref: isPlainObject(ve) ? san(ve.ref) : null,
    status: isPlainObject(ve) && typeof ve.status === 'string' ? ve.status : null,
  }));
  const view: EntryView = {
    id: san(entry.id),
    description: san(entry.description),
    verification,
    human_judgment: typeof entry.human_judgment === 'boolean' ? entry.human_judgment : null,
  };
  if (typeof entry.requirement === 'string') view.requirement = sanitizeForDisplay(entry.requirement);
  if (typeof entry.rationale === 'string') view.rationale = sanitizeForDisplay(entry.rationale);
  return view;
}

function legacyResult(summaryFile: string, errors: CoverageError[]): ClassifyResult {
  return {
    mode: MODE.LEGACY,
    summary_file: summaryFile,
    total: 0,
    all_auto_covered: false,
    auto_passed: [],
    present: [],
    errors,
  };
}

/** Pure classification core — no I/O. Testable in isolation. */
function classifyContent(content: string, summaryFile: string): ClassifyResult {
  const { found, entries, malformed } = parseCoverage(content);
  if (!found) return legacyResult(summaryFile, []);
  if (malformed) {
    // A coverage block is present but unparseable. Fail-safe: fall back to the
    // prose `## Accomplishments` path (the human still gets UAT) and surface the
    // error so the author can fix the block. NEVER report all_auto_covered here.
    return legacyResult(summaryFile, [{
      index: -1,
      id: null,
      code: ERROR_CODE.MALFORMED_BLOCK,
      message: 'coverage block is present but could not be parsed into entries; falling back to prose extraction',
    }]);
  }

  const seenIds = new Set<string>();
  const autoPassed: (EntryView & { source: 'automated' })[] = [];
  const present: (EntryView & { reason: string })[] = [];
  const allErrors: CoverageError[] = [];

  entries.forEach((entry, index) => {
    const errs = validateEntry(entry, index, seenIds);
    allErrors.push(...errs);
    const view = entryView(entry);
    if (isAutoPass(entry, errs)) {
      autoPassed.push({ ...view, source: 'automated' });
    } else {
      present.push({ ...view, reason: presentReason(entry, errs) });
    }
  });

  return {
    mode: MODE.COVERAGE,
    summary_file: summaryFile,
    total: entries.length,
    all_auto_covered: present.length === 0,
    auto_passed: autoPassed,
    present,
    errors: allErrors,
  };
}

// ─── CLI command ────────────────────────────────────────────────────────────

function cmdClassify(cwd: string, options: { summary?: string; file?: string } = {}, raw: boolean): void {
  const filePath = options.summary || options.file;
  if (!filePath) {
    error('SUMMARY file required: use uat classify-coverage --summary <path>');
  }

  let resolvedPath: string;
  try {
    resolvedPath = requireSafePath(filePath, cwd, 'SUMMARY file', { allowAbsolute: true });
  } catch (e) {
    // Emit a structured command error instead of leaking a raw stack trace.
    error(`Invalid SUMMARY path: ${e instanceof Error ? e.message : 'unsafe path'}`);
    return;
  }
  if (!fs.existsSync(resolvedPath)) {
    error(`SUMMARY file not found: ${filePath}`);
  }

  const content = fs.readFileSync(resolvedPath, 'utf-8');
  const result = classifyContent(content, toPosixPath(path.relative(cwd, resolvedPath)));
  output(result, raw, undefined);
}

export = {
  cmdClassify,
  classifyContent,
  parseCoverage,
  validateEntry,
  isAutoPass,
  presentReason,
  MODE,
  PRESENT_REASON,
  ERROR_CODE,
  VALID_KINDS,
  VALID_STATUSES,
};
