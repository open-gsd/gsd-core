/**
 * Proof-of-reading check for a reviewer lane (#5491).
 *
 * `agy` can review a prompt it only partly read and still exit 0: stdin is cut at ~191 KB with
 * `<truncated N bytes>` (google-antigravity/antigravity-cli#224), `view_file` pages at ~46 KB, and a
 * session compacts at ~128K tokens and then reviews from its own summary. So the lane restates, per
 * plan, four facts only a reader has (`requirements`, `wave`, `depends_on`, the task count), and the
 * restatement is compared with the plan files. A missing or wrong line, a `<truncated` marker, a
 * compaction the handler saw or could not rule out, or a plan that could not be checked flags the
 * lane. Diagnostic only, like the #3301 plan-coverage check: it stamps an evidence-quality discount
 * marker beside `[reviewed-without-repo-access]` and never fails or blocks the lane.
 *
 * Lane-agnostic: only the antigravity handler wires it in today. Another lane needs its prompt to
 * carry `readCheckInstruction()` and its result handling to call `runReadCheck`.
 */

import fs from 'node:fs';
import path from 'node:path';
import frontmatter from './frontmatter.cjs';
import planScan from './plan-scan.cjs';
import { tryWithinRoot, PathAcceptance } from './security.cjs';
import { scanFencedBlocks, stripFencedCode, stripInlineCode } from './markdown-sectionizer.cjs';

/** The four facts a lane must restate for one plan. */
export interface PlanFacts {
  /** Plan id: the file's basename without `-PLAN.md`, the same id the coverage manifest lists. */
  id: string;
  requirements: string[];
  wave: number | null;
  dependsOn: string[];
  tasks: number;
}

export interface ReadCheck {
  complete: boolean;
  /** The output carries agy's `<truncated` marker outside code. */
  truncated: boolean;
  /**
   * The session compacted its context before the review was written (reported by the lane's
   * handler); `'unknown'` when the handler could not tell (#6286 Nit 4).
   */
  compacted: boolean | 'unknown';
  /** Plan ids with no `READ-CHECK` line. */
  missing: string[];
  /** Plan id → the fields whose restated value disagrees with the plan. */
  mismatched: Record<string, string[]>;
  /**
   * Plan ids named in the prompt whose file could not be read within bounds, so went unchecked
   * (#6286 Minor 2): the first ten, as a prompt can name any number (#6286 round 5 Nit 1).
   */
  unchecked: string[];
  /** How many plans went unchecked in all. */
  uncheckedTotal: number;
}

export const READ_CHECK_MARKER = '[incomplete-read]';

const FIELDS = ['requirements', 'wave', 'depends_on', 'tasks'] as const;

/** The sentence appended to a lane's prompt instruction. The line shape is what `parseReadCheckLines` reads. */
export function readCheckInstruction(): string {
  return (
    `If the prompt contains plans, begin each plan's section with this exact line, copying ` +
    `requirements, wave and depends_on from that plan's frontmatter and counting its <task> ` +
    `elements (or its "## Task N" headings if it has none); <plan id> is the plan's file name ` +
    `without -PLAN.md: ` +
    `READ-CHECK <plan id>: requirements=[<ids>]; wave=<n>; depends_on=[<plan ids>]; tasks=<n>`
  );
}

/**
 * Repo-relative plan paths from the prompt's `#### <path>-PLAN.md` headers (review.md build_prompt).
 * A header inside a closed code fence is left out (#6286 Nit 1): it is a plan's own content, or a
 * plan whose header a fence left open above hid, which only the plan files tell apart (see
 * `fencedPlanPaths`). An unclosed fence is not honoured: it would hide every later header.
 */
export function planPathsFromPrompt(prompt: string): string[] {
  return planHeaders(prompt, false);
}

/**
 * The plan headers inside a closed fence. The prompt alone cannot tell a plan quoting a header in
 * a fence from a fence left open in one plan and closed by the next plan's first bare fence, which
 * hides that plan's header; `runReadCheck` tells them apart by the plan files (#6286 round 5 Minor 2).
 */
function fencedPlanPaths(prompt: string): string[] {
  return planHeaders(prompt, true);
}

function planHeaders(prompt: string, inFence: boolean): string[] {
  const lines = String(prompt ?? '').split(/\r?\n/);
  const fenced = closedFenceLines(lines);
  const paths = new Set<string>();
  lines.forEach((line, i) => {
    const p = planHeaderPath(line);
    if (p !== null && Boolean(fenced[i]) === inFence) paths.add(p);
  });
  return [...paths];
}

/** The path a `#### <path>-PLAN.md` header line names, or null. */
function planHeaderPath(line: string): string | null {
  const m = /^#### (\S+)\s*$/.exec(line);
  if (!m || m[1].includes('\0')) return null; // no file name holds a NUL (#6286 Nit 3)
  // plan-scan owns which filenames are plans (lint-plan-count-drift). review.md's glob is
  // `*-PLAN.md`, so a bare PLAN.md, which has no id to restate, is not one of its plans.
  const base = m[1].split(/[\\/]/).pop() ?? '';
  return planScan.isCanonicalPlanFile(base) && planIdOf(base) !== base.normalize('NFC') ? m[1] : null;
}

/** Which lines sit inside a closed code fence; an unclosed fence marks nothing. */
function closedFenceLines(lines: string[]): Uint8Array {
  const fenced = new Uint8Array(lines.length);
  for (const b of scanFencedBlocks(lines)) if (b.closeLineIdx !== -1) fenced.fill(1, b.openLineIdx, b.closeLineIdx + 1);
  return fenced;
}

/** A plan's id: its file name without `-PLAN.md`, NFC-normalized so either spelling matches (#6286 Nit 3). */
function planIdOf(planPath: string): string {
  const base = planPath.split(/[\\/]/).pop() ?? planPath;
  return base.replace(/-PLAN\.md$/, '').normalize('NFC');
}

/** The key one id is compared by. */
function idKey(id: string): string {
  return id.normalize('NFC').toLowerCase();
}

/** A frontmatter or restated scalar as text; anything else (a nested map) has no comparable value. */
function scalar(v: unknown): string {
  return typeof v === 'string' || typeof v === 'number' ? String(v) : '';
}

// Markdown a model wraps around a label, an id or a value. Stripped with character loops, never
// a `[…\s]+$` regex: that form is quadratic on a long whitespace run (#6286 Minor 2).
const DECORATION = new Set([' ', '\t', '\r', '>', '*', '_', '`', '#', '-', '|', '+']);
const VALUE_DECORATION = new Set([' ', '\t', '\r', '*', '_', '`', '"', "'"]);

function stripEnds(text: string, chars: Set<string>): string {
  let a = 0;
  let b = text.length;
  while (a < b && chars.has(text[a])) a += 1;
  while (b > a && chars.has(text[b - 1])) b -= 1;
  return text.slice(a, b);
}

/** Leading list/quote/heading decoration, including an ordered-list token (`1.`, `2)`), in any order. */
function stripLeading(line: string): string {
  let i = 0;
  for (;;) {
    while (i < line.length && DECORATION.has(line[i])) i += 1;
    let j = i;
    while (j < line.length && line[j] >= '0' && line[j] <= '9') j += 1;
    if (j > i && (line[j] === '.' || line[j] === ')')) {
      i = j + 1;
      continue;
    }
    return line.slice(i);
  }
}

const EMPTY_LIST = new Set(['', 'none', 'n/a', '-']);

function toList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => stripEnds(scalar(x), VALUE_DECORATION)).filter(Boolean);
  let text = stripEnds(scalar(v), VALUE_DECORATION);
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  if (EMPTY_LIST.has(stripEnds(text, VALUE_DECORATION).toLowerCase())) return [];
  return text.split(/[,;]/).map((x) => stripEnds(x, VALUE_DECORATION)).filter(Boolean);
}

/** A frontmatter number (lenient, as frontmatter is the plan's own record). */
function toInt(v: unknown): number | null {
  const n = Number.parseInt(scalar(v).trim(), 10);
  return Number.isFinite(n) ? n : null;
}

/** A restated number: exactly digits, so `1abc` is not 1 (#6286 Minor 4); empty or `none` is null. */
function restatedInt(raw: string): number | null | 'invalid' {
  const text = stripEnds(raw, VALUE_DECORATION);
  if (EMPTY_LIST.has(text.toLowerCase())) return null;
  return /^\d+$/.test(text) ? Number(text) : 'invalid';
}

/**
 * The plan with its HTML comments removed (a bounded scan, not a regex). An unclosed `<!--` removes
 * nothing: dropping the rest of the plan would drop its tasks (#6286 round 5 Minor 3).
 */
function stripHtmlComments(content: string): string {
  let out = '';
  let at = 0;
  for (;;) {
    const open = content.indexOf('<!--', at);
    if (open === -1) return out + content.slice(at);
    const close = content.indexOf('-->', open + 4);
    if (close === -1) return out + content.slice(at);
    out += content.slice(at, open);
    at = close + 3;
  }
}

/**
 * `<task …>` openings, counted the way plan-document's `/<task(?=[\s>])[^>]*>/gi` counts them but
 * in one pass: that regex rescans to the end of the plan from every unclosed `<task `, which is
 * quadratic (#6286 Minor 6). A `<task` before the previous opening's `>` is part of that opening.
 */
function countTaskOpenings(prose: string): number {
  const re = /<task(?=[\s>])/gi;
  let n = 0;
  for (let m = re.exec(prose); m; m = re.exec(prose)) {
    // From lastIndex, not the match + 1: a bare `<task>`'s `>` is the lookahead character itself.
    const close = prose.indexOf('>', re.lastIndex);
    if (close === -1) break; // no later opening can close either
    n += 1;
    re.lastIndex = close + 1;
  }
  return n;
}

/** The expected facts for one plan file's content. */
export function planFacts(planPath: string, content: string): PlanFacts {
  const fm = frontmatter.extractFrontmatter(content) as Record<string, unknown>;
  // The plan parser's task grammar (`<task>` elements, else plan-document's `## Task N` heading
  // regex), run over the plan's prose only: a fenced example, an HTML comment or an inline-code
  // `<task>` is not a task a reader would count (#6286 Minor 5a). Counted here rather than by
  // parsePlanDocument, whose task and objective regexes are quadratic on hostile plans (#6286
  // Minor 6); plan-document itself stays fence-blind for plan-index.
  // Stripping only removes text, so each order can only undercount: code first misses a fence
  // opener inside a comment, comments first lets a `<!--` in a fenced example or in inline code
  // swallow the real tasks after it (#6286 round 5 Minor 3). The larger count is the one neither
  // order over-stripped.
  const codeFirst = stripHtmlComments(stripInlineCode(stripFencedCode(content).text));
  const commentsFirst = stripInlineCode(stripFencedCode(stripHtmlComments(content)).text);
  const a = countTaskOpenings(codeFirst);
  const b = countTaskOpenings(commentsFirst);
  const prose = a >= b ? codeFirst : commentsFirst;
  const openings = Math.max(a, b);
  return {
    id: planIdOf(planPath),
    requirements: toList(fm.requirements),
    wave: toInt(fm.wave),
    dependsOn: toList(fm.depends_on),
    tasks: openings > 0 ? openings : (prose.match(/##\s*Task\s*\d+[^\n]*/gi) ?? []).length,
  };
}

const LABEL = 'read-check';

// The id wrappers a model adds, unwrapped only as matched pairs (#6286 Nit 2). A lone `_` or `*` is
// never stripped: it can be part of a plan id.
const ID_WRAPPERS: readonly (readonly [string, string])[] = [['**', '**'], ['`', '`'], ['<', '>']];
const ID_SPACE = new Set([' ', '\t', '\r']);
// Emphasis `stripLeading` can consume before the label. It closes right after the label
// (`*READ-CHECK* 12-01:`), at the id's end (`*READ-CHECK 12-01*:`) or after the colon; either
// way it wraps the label, so its closer is not part of the id.
const LABEL_WRAPPERS: readonly (readonly [string, string])[] = [['**', '**'], ['`', '`'], ['*', '*'], ['_', '_']];
const LABEL_CLOSERS = new Set(['*', '`', '_']);
const MAX_LABEL_WRAPPERS = 8;

/**
 * A restated id without its wrappers, stacked ones too (`` **`12-01`** ``). `opened` is the
 * decoration `stripLeading` consumed before the label: a wrapper opened there
 * (`**READ-CHECK 12-01**:`) leaves only its closer on the id, and that closer goes as well once
 * the id's own pairs are off (`**READ-CHECK **12-01**:**` keeps its label's closer after the
 * colon). Index pointers, not repeated slices, so a long wrapper run stays linear (#6286 Minor 2).
 */
function unwrapId(raw: string, opened: string, tail: string): string {
  let a = 0;
  let b = raw.length;
  while (a < b && ID_SPACE.has(raw[a])) a += 1;
  while (b > a && ID_SPACE.has(raw[b - 1])) b -= 1;
  const unwrapPairs = (): void => {
    for (;;) {
      const w = ID_WRAPPERS.find(([open, close]) =>
        b - a >= open.length + close.length && raw.startsWith(open, a) && raw.startsWith(close, b - close.length));
      if (!w) return;
      a += w[0].length;
      b -= w[1].length;
    }
  };
  unwrapPairs();
  // The wrappers opened right before the label, innermost first (a few at most: a longer run is not
  // a model's emphasis). Their closers end the id with the outermost last; one whose closer sits
  // elsewhere (after the colon) is passed over.
  const opens: (readonly [string, string])[] = [];
  for (let o = opened.length; opens.length < MAX_LABEL_WRAPPERS; ) {
    const w = LABEL_WRAPPERS.find(([open]) => o >= open.length && opened.startsWith(open, o - open.length));
    if (!w) break;
    opens.push(w);
    o -= w[0].length;
  }
  // The outermost closers that open `tail`, the text after the separator (`*READ-CHECK 12-01:*`),
  // are not on the id, so an id's own trailing `*` or `_` stays (#6286 Nit 5).
  let onId = opens.length;
  for (let j = 0; j < opens.length; j += 1) {
    let t = 0;
    let k = j;
    while (k < opens.length && tail.startsWith(opens[k][1], t)) {
      t += opens[k][1].length;
      k += 1;
    }
    if (k === opens.length) {
      onId = j;
      break;
    }
  }
  for (let i = onId - 1; i >= 0; i -= 1) {
    const close = opens[i][1];
    if (b - a >= close.length && raw.startsWith(close, b - close.length)) b -= close.length;
  }
  unwrapPairs();
  return raw.slice(a, b);
}

/**
 * Where a restated id ends: at a `:` or `|` right after the id's word, else at the last `:` or `|`
 * in the word before its first `=`. So an id may hold a `:` (#6286 Nit 3) and a note after the id
 * still ends it (`12-01: note: wave=1`). -1 when the word has no separator. Linear.
 */
function idEnd(after: string): number {
  let i = 0;
  while (i < after.length && ID_SPACE.has(after[i])) i += 1;
  const ws = after.slice(i).search(/\s/);
  const word = ws === -1 ? after.length : i + ws;
  let j = word;
  while (j < after.length && ID_SPACE.has(after[j])) j += 1;
  if (j > word && (after[j] === ':' || after[j] === '|')) return j;
  const eq = after.indexOf('=', i);
  for (let k = (eq !== -1 && eq < word ? eq : word) - 1; k >= i; k -= 1) {
    if (after[k] === ':' || after[k] === '|') return k;
  }
  return -1;
}

/** `k=v` parts split at `;` or `|` outside `[…]`, so a list may use `;` between its ids. Linear. */
function splitFields(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '[') depth += 1;
    else if (c === ']' && depth > 0) depth -= 1;
    else if (depth === 0 && (c === ';' || c === '|')) {
      parts.push(text.slice(from, i));
      from = i + 1;
    }
  }
  parts.push(text.slice(from));
  return parts;
}

/**
 * Every `READ-CHECK <id>: k=v; …` line in a review, keyed by lower-cased id, all lines kept in
 * order. Markdown around the label, id and values (bold, list and quote markers, table pipes,
 * backticks, `<id>`) is tolerated: the facts are what is checked, not the format (#6286 Minor 4).
 * Linear in the line length.
 */
export function parseReadCheckLines(review: string): Map<string, Record<string, string>[]> {
  const out = new Map<string, Record<string, string>[]>();
  for (const line of String(review ?? '').split('\n')) {
    const rest = stripLeading(line);
    if (rest.slice(0, LABEL.length).toLowerCase() !== LABEL) continue;
    // Emphasis closed on the label itself (`**READ-CHECK** 12-01:`) has nothing left to close on
    // the id.
    let start = LABEL.length;
    while (start < rest.length && LABEL_CLOSERS.has(rest[start])) start += 1;
    const labelClosed = start > LABEL.length && ID_SPACE.has(rest[start]);
    const after = rest.slice(labelClosed ? start : LABEL.length);
    const end = idEnd(after);
    if (end === -1) continue;
    const unwrapped = unwrapId(after.slice(0, end), labelClosed ? '' : line.slice(0, line.length - rest.length), after.slice(end + 1));
    // A path in place of the id names the same plan (#6286 Minor 3).
    const id = idKey(unwrapped.slice(Math.max(unwrapped.lastIndexOf('/'), unwrapped.lastIndexOf('\\')) + 1).replace(/-PLAN\.md$/i, ''));
    if (!id || id.includes('\0')) continue;
    const fields: Record<string, string> = {};
    for (const part of splitFields(after.slice(end + 1))) {
      const eq = part.indexOf('=');
      if (eq <= 0) continue;
      fields[stripEnds(part.slice(0, eq), VALUE_DECORATION).toLowerCase()] = stripEnds(part.slice(eq + 1), VALUE_DECORATION);
    }
    const lines = out.get(id) ?? [];
    lines.push(fields);
    out.set(id, lines);
  }
  return out;
}

function sameSet(a: string[], b: string[]): boolean {
  const x = [...new Set(a.map(idKey))].sort();
  const y = [...new Set(b.map(idKey))].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

function wrongFields(facts: PlanFacts, got: Record<string, string>): string[] {
  const bad: string[] = [];
  for (const f of FIELDS) {
    const raw = got[f];
    if (raw === undefined) {
      bad.push(f);
      continue;
    }
    const ok =
      f === 'requirements' ? sameSet(toList(raw), facts.requirements)
        : f === 'depends_on' ? sameSet(toList(raw), facts.dependsOn)
          : f === 'wave' ? restatedInt(raw) === facts.wave
            : restatedInt(raw) === facts.tasks;
    if (!ok) bad.push(f);
  }
  return bad;
}

/**
 * agy's `<truncated` marker, in the approved prefix form (`<truncated>`, `<truncated 1,234 bytes>`,
 * `<truncated 12 KB>`, …) (#6286 Minor 3). An occurrence in a closed fence or in inline code is a
 * quotation and does not count. One after an unclosed fence does: output cut mid-block leaves
 * the fence open, and the marker is then its last line. A bare occurrence in prose counts too: an
 * echo of the marker cannot be told from a prose quote, and a diagnostic errs toward flagging.
 */
function hasTruncationMarker(review: string): boolean {
  const lines = review.split('\n');
  const fenced = closedFenceLines(lines);
  return /<truncated(?![a-z])/i.test(stripInlineCode(lines.filter((_, i) => !fenced[i]).join('\n')));
}

// How many unchecked plan ids a check keeps, and so the stamp names, before it counts the rest.
const UNCHECKED_SHOWN = 10;

/** Compare a review's restatements with the plans it was given; `unchecked` are plans that could not be read. */
export function checkRead(
  review: string,
  expected: PlanFacts[],
  compacted: boolean | 'unknown' = false,
  unchecked: string[] = [],
): ReadCheck {
  const text = String(review ?? '');
  const truncated = hasTruncationMarker(text);
  const lines = parseReadCheckLines(text);
  const missing: string[] = [];
  const mismatched: Record<string, string[]> = {};
  for (const facts of expected) {
    // A matching line is used up, so two plans with one id need two lines (#6286 Minor 4). Taking
    // the first match is exact: a line that matches two plans means their facts are equal.
    const got = lines.get(idKey(facts.id)) ?? [];
    if (got.length === 0) {
      missing.push(facts.id);
      continue;
    }
    const results = got.map((g) => wrongFields(facts, g));
    const hit = results.findIndex((bad) => bad.length === 0);
    if (hit !== -1) {
      got.splice(hit, 1);
      continue;
    }
    // No line matches: report the first line's errors, merged with an earlier plan's of the same id.
    // defineProperty, not assignment: `mismatched['__proto__'] = …` would call the prototype setter
    // and drop the plan (#6286 Nit 2).
    const seen = Object.prototype.hasOwnProperty.call(mismatched, facts.id) ? mismatched[facts.id] : [];
    const merged = FIELDS.filter((f) => seen.includes(f) || results[0].includes(f));
    Object.defineProperty(mismatched, facts.id, { value: merged, enumerable: true, writable: true, configurable: true });
  }
  return {
    complete:
      !truncated && compacted === false && missing.length === 0 && unchecked.length === 0 && Object.keys(mismatched).length === 0,
    truncated,
    compacted,
    missing,
    mismatched,
    unchecked: unchecked.slice(0, UNCHECKED_SHOWN),
    uncheckedTotal: unchecked.length,
  };
}

/**
 * The leading run of evidence-quality discount markers (`> [marker] …` paragraphs), as an end
 * offset. Only the three known markers: a reviewer's own `> [note]` opener must not sit above the
 * stamp, because the convergence gate reads the LEADING blockquote of a reviewer's section.
 */
// A marker paragraph ends at a blank line or at the end of the review, after at most one newline
// there (#6286 Nit 3). A single newline mid-review starts a lazy continuation of the same
// blockquote, so that paragraph is not a marker the stamp can follow.
const LEADING_MARKER_RE = /> \[(?:reviewed-without-repo-access|reviewed-without-source-citations|incomplete-read)\][^\r\n]*(?:\r?\n\r?\n|\r?\n?$)/;

function leadingMarkers(review: string): { end: number; markers: string } {
  const re = new RegExp(LEADING_MARKER_RE.source, 'y');
  let end = 0;
  for (;;) {
    re.lastIndex = end;
    const m = re.exec(review);
    if (!m || m[0].length === 0) return { end, markers: review.slice(0, end) };
    end += m[0].length;
  }
}


/**
 * Stamp the down-weight marker on a review that failed the check. It goes after any leading
 * discount marker already there (#6286 Major 1: `[reviewed-without-repo-access]` must stay the
 * leading blockquote), and is a no-op when that leading run already carries it — a review that
 * merely mentions the marker in its body is still stamped (#6286 Minor 5b).
 */
export function stampIncompleteRead(review: string, check: ReadCheck): string {
  if (check.complete) return review;
  const lead = leadingMarkers(review);
  if (lead.markers.includes(`> ${READ_CHECK_MARKER}`)) return review;
  const why: string[] = [];
  if (check.truncated) why.push('its output contains a `<truncated` marker');
  if (check.compacted === true) why.push('its session compacted its context before the review was written');
  if (check.compacted === 'unknown') why.push('whether its session compacted its context could not be checked');
  if (check.missing.length) why.push(`no READ-CHECK line for ${check.missing.join(', ')}`);
  const wrong = Object.entries(check.mismatched).map(([id, f]) => `${id} (${f.join(', ')})`);
  if (wrong.length) why.push(`READ-CHECK disagrees with the plan for ${wrong.join('; ')}`);
  if (check.unchecked.length) {
    // A hostile prompt can name any number of plans; the list stays readable (#6286 Minor 1).
    const shown = check.unchecked.slice(0, UNCHECKED_SHOWN).join(', ');
    const total = Math.max(check.uncheckedTotal, check.unchecked.length);
    const more = total > UNCHECKED_SHOWN ? ` and ${total - UNCHECKED_SHOWN} more` : '';
    why.push(`the plan file for ${shown}${more} could not be checked`);
  }
  const stamp =
    `> ${READ_CHECK_MARKER} This review may not rest on a full read of its input: ${why.join('; ')}. ` +
    'Down-weight its verdict in the Consensus Summary.';
  const tail = review.slice(lead.end);
  // The stamp is its own paragraph: a marker run that ends the review may end in no newline or in
  // one, and a single newline would make the stamp a continuation of the last marker's quote.
  const sep = lead.end === 0 || /\r?\n\r?\n$/.test(lead.markers) ? '' : /\r?\n$/.test(lead.markers) ? '\n' : '\n\n';
  return `${lead.markers}${sep}${stamp}\n\n${tail}`;
}

/** The filesystem seams `runReadCheck` needs — a subset of the runner's `RunnerDeps`. */
export interface ReadCheckDeps {
  exists(p: string): boolean;
  readFile(p: string): string;
  /** A regular file of at most `maxBytes` bytes, read through one descriptor; null for anything else. */
  readPlanBounded(p: string, maxBytes: number): string | null;
}

// The prompt names the plan files, so neither their size nor their number is ours to trust
// (#6286 Minor 1): one plan is read at most this large, at most this many headers are resolved,
// and at most this many bytes are read in all. A plan past any bound is unchecked.
export const MAX_PLAN_BYTES = 1024 * 1024;
export const MAX_PLAN_HEADERS = 100;
export const MAX_TOTAL_PLAN_BYTES = 8 * MAX_PLAN_BYTES;

/**
 * The production `readPlanBounded` (#6286 Minor 3): open once without blocking, `fstat` that
 * descriptor, and read at most `maxBytes + 1` bytes from it. Null for a FIFO, a device, a directory,
 * a file over `maxBytes`, or one that grew past its `fstat` size after the open. Throws when the
 * path cannot be opened.
 */
export function readPlanBounded(p: string, maxBytes: number): string | null {
  const fd = fs.openSync(p, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOCTTY ?? 0));
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > maxBytes) return null;
    // One byte past the fstat size shows the file grew after the open.
    const buf = Buffer.alloc(st.size + 1);
    let off = 0;
    while (off < buf.length) {
      const n = fs.readSync(fd, buf, off, buf.length - off, off);
      if (n <= 0) break;
      off += n;
    }
    return off > st.size ? null : buf.toString('utf8', 0, off);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Run the check for one lane's review. Plans come from the prompt's plan headers and are read from
 * the repo, so the expected facts are the plans themselves. `compacted` comes from the lane's own
 * session log, which only its handler can read. A header naming no file in the repo is skipped; a
 * plan file that cannot be read within bounds is recorded as unchecked (#6286 Minor 2). A prompt
 * that names no plan was asked for no restatement, so its compaction is not checked; it returns
 * `undefined` unless the output carries a truncation marker (#6286 round 5 Minor 1). A prompt that
 * names a plan returns `undefined` only when there is nothing to report: no plan file, no
 * truncation marker, no compaction.
 */
export function runReadCheck(
  review: string,
  promptPath: string,
  repoRoot: string,
  deps: ReadCheckDeps,
  opts: { compacted?: boolean | 'unknown' } = {},
): ReadCheck | undefined {
  // Checked here, outside the per-plan try below: a missing seam would throw inside it and leave
  // every plan unchecked without saying why (#6286 Minor 1).
  if (typeof deps.readPlanBounded !== 'function') throw new TypeError('runReadCheck: deps.readPlanBounded is required');
  let prompt = '';
  try {
    if (deps.exists(promptPath)) prompt = deps.readFile(promptPath);
  } catch {
    prompt = '';
  }
  const expected: PlanFacts[] = [];
  const unchecked = new Set<string>();
  const seen = new Set<string>();
  let budget = MAX_TOTAL_PLAN_BYTES;
  const root = String(repoRoot).replace(/[\\/]+$/, '');
  const headers = planPathsFromPrompt(prompt);
  if (headers.length === 0) {
    const check = checkRead(review, [], false);
    return check.truncated ? check : undefined;
  }
  const realRoot = tryWithinRoot('.', root, PathAcceptance.RelativeOnly);
  // Every `#### …` line of the plans read: a fenced header one of them holds is that plan's own
  // content; any other fenced header is a plan whose header a fence left open above hid (#6286
  // round 5 Minor 2).
  const quotedHeaders = new Set<string>();
  let considered = 0;
  const readPlan = (rel: string): void => {
    // Past the header cap nothing is resolved or read (#6286 Minor 1).
    if (considered >= MAX_PLAN_HEADERS) {
      unchecked.add(planIdOf(rel));
      return;
    }
    considered += 1;
    // Read only a file inside the repo: relative, no `..` segment, and still inside after symlinks
    // resolve (#6286 Minor 1). The resolved path dedupes spellings of one plan, and is the path
    // read, so a symlink the check followed is not followed again: the repo root as given plus
    // the resolved path below it, the spelling the deps seam is keyed by.
    if (rel.split(/[\\/]/).includes('..')) return;
    const resolved = tryWithinRoot(rel, root, PathAcceptance.RelativeOnly);
    if (resolved === null || realRoot === null || seen.has(resolved)) return;
    seen.add(resolved);
    const abs = `${root}/${path.relative(realRoot, resolved).split(path.sep).join('/')}`;
    try {
      if (!deps.exists(abs)) return;
      const content = budget > 0 ? deps.readPlanBounded(abs, Math.min(MAX_PLAN_BYTES, budget)) : null;
      if (content === null) {
        unchecked.add(planIdOf(rel));
        return;
      }
      budget -= Buffer.byteLength(content, 'utf8');
      expected.push(planFacts(rel, content));
      for (const line of content.split(/\r?\n/)) if (line.startsWith('#### ')) quotedHeaders.add(line.replace(/\s+$/, ''));
    } catch {
      unchecked.add(planIdOf(rel));
    }
  };
  for (const rel of headers) readPlan(rel);
  const named = new Set(headers);
  for (const rel of fencedPlanPaths(prompt)) if (!named.has(rel) && !quotedHeaders.has(`#### ${rel}`)) readPlan(rel);
  const compacted = opts.compacted === 'unknown' ? 'unknown' : opts.compacted === true;
  const check = checkRead(review, expected, compacted, [...unchecked]);
  if (expected.length === 0 && unchecked.size === 0 && !check.truncated && check.compacted === false) return undefined;
  return check;
}
