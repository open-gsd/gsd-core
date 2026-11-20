/**
 * Proof-of-reading check for a reviewer lane (#5491).
 *
 * `agy` can review a prompt it only partly read and still exit 0 with a normal-looking review: a
 * single stdin message is cut at ~191 KB and replaced with `<truncated N bytes>`
 * (google-antigravity/antigravity-cli#224), `view_file` pages at ~46 KB, and a session compacts
 * itself at a fixed ~128K-token limit and then reviews from its own summary. Nothing in the lane
 * result told these apart from a full read.
 *
 * So the lane is asked to restate, per plan, four facts only a reader of that plan has —
 * `requirements`, `wave`, `depends_on` and the task count — and the restatement is compared with
 * the plan files. A missing or wrong line, a `<truncated` marker in the output, or a compaction
 * the handler saw in the session log flags the lane. A live run (agy 1.5.10, 432 KB prompt) read
 * every plan, restated all nine correctly, then compacted while checking repo files and wrote the
 * review from its summary — the restatement alone cannot see that case. Diagnostic only, like the
 * #3301 plan-coverage check: it stamps the review and records the result; it never fails or
 * blocks the lane. The stamp is an evidence-quality discount marker at the plan-review
 * convergence gate, beside `[reviewed-without-repo-access]` and
 * `[reviewed-without-source-citations]`.
 *
 * Lane-agnostic on purpose. Only the antigravity handler wires it in today (the approved scope);
 * another lane opting in needs its prompt to carry `readCheckInstruction()` and its result
 * handling to call `runReadCheck` (passing `compacted` if it can read its own session log).
 */

import frontmatter from './frontmatter.cjs';
import planScan from './plan-scan.cjs';
import { tryWithinRoot, PathAcceptance } from './security.cjs';
import { stripFencedCode, stripInlineCode } from './markdown-sectionizer.cjs';

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
  /** The session compacted its context before the review was written (reported by the lane's handler). */
  compacted: boolean;
  /** Plan ids with no `READ-CHECK` line. */
  missing: string[];
  /** Plan id → the fields whose restated value disagrees with the plan. */
  mismatched: Record<string, string[]>;
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

/** Repo-relative plan paths from the prompt's `#### <path>-PLAN.md` headers (review.md build_prompt). */
export function planPathsFromPrompt(prompt: string): string[] {
  const paths = new Set<string>();
  for (const line of String(prompt ?? '').split(/\r?\n/)) {
    const m = /^#### (\S+)\s*$/.exec(line);
    // plan-scan owns which filenames are plans (lint-plan-count-drift); the canonical rule is the
    // one review.md's `*-PLAN.md` glob uses.
    if (m && planScan.isCanonicalPlanFile(m[1].split(/[\\/]/).pop() ?? '')) paths.add(m[1]);
  }
  return [...paths];
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
  return text.split(',').map((x) => stripEnds(x, VALUE_DECORATION)).filter(Boolean);
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

/** The plan with its HTML comments removed (a bounded scan, not a regex). */
function stripHtmlComments(content: string): string {
  let out = '';
  let at = 0;
  for (;;) {
    const open = content.indexOf('<!--', at);
    if (open === -1) return out + content.slice(at);
    out += content.slice(at, open);
    const close = content.indexOf('-->', open + 4);
    if (close === -1) return out;
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
  const base = planPath.split(/[\\/]/).pop() ?? planPath;
  // The plan parser's task grammar (`<task>` elements, else plan-document's `## Task N` heading
  // regex), run over the plan's prose only: a fenced example, an HTML comment or an inline-code
  // `<task>` is not a task a reader would count (#6286 Minor 5a). Counted here rather than by
  // parsePlanDocument, whose task and objective regexes are quadratic on hostile plans (#6286
  // Minor 6); plan-document itself stays fence-blind for plan-index.
  const prose = stripInlineCode(stripFencedCode(stripHtmlComments(content)).text);
  const openings = countTaskOpenings(prose);
  return {
    id: base.replace(/-PLAN\.md$/, ''),
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

/**
 * A restated id without its wrappers, stacked ones too (`` **`12-01`** ``). `opened` is the
 * decoration `stripLeading` consumed before the label: a wrapper opened there
 * (`**READ-CHECK 12-01**:`) leaves only its closer on the id, and that closer goes as well once
 * the id's own pairs are off (`**READ-CHECK **12-01**:**` keeps its label's closer after the
 * colon). Index pointers, not repeated slices, so a long wrapper run stays linear (#6286 Minor 2).
 */
function unwrapId(raw: string, opened: string): string {
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
  // The wrappers opened right before the label, innermost first. Their closers end the id with
  // the outermost last; one whose closer sits elsewhere (after the colon) is passed over.
  const opens: (readonly [string, string])[] = [];
  for (let o = opened.length; ; ) {
    const w = LABEL_WRAPPERS.find(([open]) => o >= open.length && opened.startsWith(open, o - open.length));
    if (!w) break;
    opens.push(w);
    o -= w[0].length;
  }
  for (let i = opens.length - 1; i >= 0; i -= 1) {
    const close = opens[i][1];
    if (b - a >= close.length && raw.startsWith(close, b - close.length)) b -= close.length;
  }
  unwrapPairs();
  return raw.slice(a, b);
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
    let end = 0;
    while (end < after.length && after[end] !== ':' && after[end] !== '|') end += 1;
    if (end === after.length) continue;
    const unwrapped = unwrapId(after.slice(0, end), labelClosed ? '' : line.slice(0, line.length - rest.length));
    if (/\s/.test(unwrapped)) continue;
    // A path in place of the id names the same plan (#6286 Minor 3).
    const id = unwrapped
      .slice(Math.max(unwrapped.lastIndexOf('/'), unwrapped.lastIndexOf('\\')) + 1)
      .replace(/-PLAN\.md$/i, '')
      .toLowerCase();
    if (!id) continue;
    const fields: Record<string, string> = {};
    for (const part of after.slice(end + 1).split(/[;|]/)) {
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
  const x = [...new Set(a.map((v) => v.toLowerCase()))].sort();
  const y = [...new Set(b.map((v) => v.toLowerCase()))].sort();
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
 * `<truncated 12 KB>`, …) (#6286 Minor 3). A fenced or inline-code occurrence is a quotation and
 * does not count; an output cut inside an open fence drops that fence's tail, which is the same
 * answer. A bare occurrence in prose does count: an echo of the marker cannot be told from a
 * prose quote, and a diagnostic errs toward flagging.
 */
function hasTruncationMarker(review: string): boolean {
  return /<truncated(?![a-z])/i.test(stripInlineCode(stripFencedCode(review).text));
}

/** Compare a review's restatements with the plans it was given. */
export function checkRead(review: string, expected: PlanFacts[], compacted = false): ReadCheck {
  const text = String(review ?? '');
  const truncated = hasTruncationMarker(text);
  const lines = parseReadCheckLines(text);
  const missing: string[] = [];
  const mismatched: Record<string, string[]> = {};
  for (const facts of expected) {
    const got = lines.get(facts.id.toLowerCase());
    if (!got) {
      missing.push(facts.id);
      continue;
    }
    // Any fully matching line proves the read; otherwise report the first line's errors.
    const results = got.map((g) => wrongFields(facts, g));
    // defineProperty, not assignment: `mismatched['__proto__'] = …` would call the prototype
    // setter and drop the plan from the result, reading a mismatch as complete (#6286 Nit 2).
    if (!results.some((bad) => bad.length === 0)) {
      Object.defineProperty(mismatched, facts.id, { value: results[0], enumerable: true, writable: true, configurable: true });
    }
  }
  return {
    complete: !truncated && !compacted && missing.length === 0 && Object.keys(mismatched).length === 0,
    truncated,
    compacted,
    missing,
    mismatched,
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
  if (check.compacted) why.push('its session compacted its context before the review was written');
  if (check.missing.length) why.push(`no READ-CHECK line for ${check.missing.join(', ')}`);
  const wrong = Object.entries(check.mismatched).map(([id, f]) => `${id} (${f.join(', ')})`);
  if (wrong.length) why.push(`READ-CHECK disagrees with the plan for ${wrong.join('; ')}`);
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
  /** Size in bytes of a regular file; null for anything else (a FIFO, a directory). */
  fileSize(p: string): number | null;
}

// The prompt names the plan files, so their size is not ours to trust: a bigger one is skipped
// rather than read into the lane (#6286 Minor 1).
const MAX_PLAN_BYTES = 1024 * 1024;

/**
 * Run the check for one lane's review. Plans come from the prompt's plan headers and are read from
 * the repo, so the expected facts are the plans themselves. `compacted` comes from the lane's own
 * session log, which only its handler can read. Returns `undefined` when there is nothing to check
 * (no plan headers, no truncation marker, no compaction); an unreadable prompt or plan is
 * skipped rather than flagged — this check must never invent a failure it cannot see.
 */
export function runReadCheck(
  review: string,
  promptPath: string,
  repoRoot: string,
  deps: ReadCheckDeps,
  opts: { compacted?: boolean } = {},
): ReadCheck | undefined {
  // Checked here, outside the per-plan try below: a missing seam would throw inside it and skip
  // every plan without a trace (#6286 Minor 1).
  if (typeof deps.fileSize !== 'function') throw new TypeError('runReadCheck: deps.fileSize is required');
  let prompt = '';
  try {
    if (deps.exists(promptPath)) prompt = deps.readFile(promptPath);
  } catch {
    prompt = '';
  }
  const expected: PlanFacts[] = [];
  const root = String(repoRoot).replace(/[\\/]+$/, '');
  for (const rel of planPathsFromPrompt(prompt)) {
    // A header from the prompt is read only when it names a file inside the repo: relative, no
    // `..` segment, and still inside after symlinks resolve (#6286 Minor 1). The resolved path is
    // only the gate; the read keeps the `root/rel` spelling the deps seam is keyed by.
    if (rel.split(/[\\/]/).includes('..') || tryWithinRoot(rel, root, PathAcceptance.RelativeOnly) === null) continue;
    const abs = `${root}/${rel}`;
    try {
      const size = deps.exists(abs) ? deps.fileSize(abs) : null;
      if (size !== null && size <= MAX_PLAN_BYTES) expected.push(planFacts(rel, deps.readFile(abs)));
    } catch {
      // unreadable plan: skip it, see above
    }
  }
  const check = checkRead(review, expected, opts.compacted === true);
  if (expected.length === 0 && !check.truncated && !check.compacted) return undefined;
  return check;
}
