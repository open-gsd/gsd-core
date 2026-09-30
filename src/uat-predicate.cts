/**
 * UAT Predicate — Pure-computation UAT pass/fail evaluation
 *
 * Evaluates all *-UAT.md and *-VERIFICATION.md files in a phase directory and
 * returns a typed report. Used by `phase uat-passed` to harden against the
 * naive whole-file regex in cmdPhaseComplete which false-matches `result:` lines
 * inside frontmatter, fenced code blocks, blockquotes, and HTML comments.
 *
 * Issue #247 — phase uat-passed predicate
 *
 * ADR-457 build-at-publish: compiled by tsc to gsd-core/bin/lib/uat-predicate.cjs.
 */

import fs from 'node:fs';
import path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import frontmatter = require('./frontmatter.cjs');
const { extractFrontmatter, frontmatterBlock } = frontmatter;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import markdownSectionizer = require('./markdown-sectionizer.cjs');
const { stripFencedCode } = markdownSectionizer;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import verification = require('./verification.cjs');
const { readVerificationStatus, reportStatusOf, isReportContained, VERIFICATION_STATUS } = verification;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseIdMod = require('./phase-id.cjs');
const { scopeToPhase } = phaseIdMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import coreUtils = require('./core-utils.cjs');
const { normalizeLineEndings, countMatchedSummaries } = coreUtils;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planScanMod = require('./plan-scan.cjs');
const { isRootPlanFile } = planScanMod;

// Two CommonMark-legal line terminators (LINE SEPARATOR, PARAGRAPH SEPARATOR)
// that a naive `split('\n')`-only scan would not treat as line breaks.
// Built via String.fromCharCode rather than written as a regex-literal escape
// sequence, deliberately: this source file is round-tripped through tooling
// that decodes a literal backslash-u escape into the real character, which
// would leave an ACTUAL U+2028/U+2029 sitting inside a regex literal — and
// both are themselves JS/TS source line terminators, so the regex literal
// containing one would be truncated at that point and fail to parse at all.
const EXOTIC_LINE_SEPARATORS = String.fromCharCode(0x2028) + String.fromCharCode(0x2029);
const LINE_SPLIT_RE = new RegExp('[\\n' + EXOTIC_LINE_SEPARATORS + ']');

// ─── Types ────────────────────────────────────────────────────────────────────

interface UatCheckItem {
  file: string;
  test: number;
  name: string;
  result: string;
  passing: boolean;
  /**
   * #4546: true when this item is a `skipped` whose reason matches the
   * verify-work writer's "Deferred follow-up:" template — a deliberately
   * deferred follow-up (#1921) counts as passing and never blocks. Additive
   * report field: consumers read `passed`/`blockers`.
   */
  deferred: boolean;
  /**
   * #4983: true when this item is an `issue` whose `## Gaps` entry (matched
   * by `test:`) has been reconciled to `status: resolved` by an executed
   * gap-closure plan (#1921's reconcile_gaps step) — a resolved issue counts
   * as passing and never blocks. See `isTestGapResolved` for the fail-closed
   * validity criteria. Additive report field: consumers read
   * `passed`/`blockers`.
   */
  resolved: boolean;
}

interface UatPassedReport {
  passed: boolean;
  uat_files: string[];
  verification_files: string[];
  checks: UatCheckItem[];
  blockers: string[];
  no_uat_artifacts: boolean;
  policy: {
    require_verification: boolean;
    /**
     * #4663: true when the report was produced in uat-only mode — UAT rows
     * evaluated, VERIFICATION-file blockers (and only those) skipped. The
     * verify-work canonicalize pre-check uses this form; the flip it gates is
     * what removes the human_needed verification status, so the full
     * predicate could never pass at pre-check time.
     */
    uat_only: boolean;
  };
  /**
   * #3057 B3: true when the `requireVerification` policy check's own
   * readVerificationStatus call could not complete its internal staleness
   * check (fs / scanPhasePlans / clock failure). `passed`/`blockers` above are
   * UNCHANGED by this — the pre-existing fail-open routing (indeterminate
   * treated as not-stale) is preserved — this only makes the fact visible to
   * cmdPhaseUatPassed's JSON output (which spreads this whole report), rather
   * than silently indistinguishable from "checked; nothing is stale". Always
   * false when `requireVerification` is not set (the check is never reached).
   */
  verification_stale_check_indeterminate: boolean;
}

// ─── Blocking state sets (documented for maintainability) ─────────────────────

// UAT file frontmatter `status` values that indicate the file is not fully done
const BLOCKING_UAT_FM_STATUSES = new Set([
  'partial', 'diagnosed', 'pending', 'blocked', 'in_progress', 'failed',
]);

// UAT file frontmatter `result` values that indicate failure
const BLOCKING_UAT_FM_RESULTS = new Set(['pending', 'blocked', 'failed']);

// #5118: the VERIFICATION report's `status` vocabulary is the owner's closed
// enum (src/verification.cts) — this module no longer keeps its own passing /
// blocking sets. `pending|blocked|partial|failed|in_progress` were never
// written by the verifier; a report carrying one (or any other out-of-set
// value) is now a VerificationStatusError from the owner, not a blocker.

// UAT test-item `result` values that count as passing
const PASSING_RESULTS = new Set(['passed', 'pass']);
// #4546 — a `skipped` test-item whose reason carries the verify-work writer's
// deferral template prefix ("Deferred follow-up: …", #1921) is a deliberately
// deferred follow-up: non-blocking. Quote-tolerant (the writer wraps the value
// in double quotes) and case-insensitive (human-edited files vary). Anything
// else — a reasonless skip, a non-deferral reason — still blocks. PARITY: this
// matcher and the writer template in gsd-core/workflows/verify-work.md
// (process_response) are two halves of one contract, pinned together by
// tests/verify-work-deferred-promotion.test.cjs.
const DEFERRED_REASON_RE = /^["']?deferred follow-up\b/i;
// Trust note (#4546 review): the reason line is user-authored state — an
// author could equally write `result: passed` — so this prefix is an
// AUTHORING contract with the verify-work writer, not a security boundary.
// A hand-written deferral that skips the UAT file's ## Deferred Follow-Ups
// section also bypasses the complete_session promotion offer; the section is
// the durable project-level record. Variant spellings that do not match
// ("Deferred follow-ups:", "followup") block — fail-closed by design.

// #4983 — the sibling case #4546 left unfixed: a `result: issue` test whose
// `## Gaps` entry (templates/UAT.md) has been reconciled to `status: resolved`
// by an executed gap-closure plan (verify-work.md's reconcile_gaps step,
// #1921) is a genuinely fixed-and-verified issue: non-blocking. Unlike the
// deferred-skip case above, this signal is NOT trusted on the entry's
// `status:`/`resolved_by:` text alone — `isTestGapResolved` below also
// requires `resolved_by` to name a `*-PLAN.md` file that actually exists in
// this phase directory with a matching `*-SUMMARY.md` (mirroring
// reconcile_gaps' own criterion: a plan whose `gap_ids` names the gap AND has
// a SUMMARY was actually executed) — so a `resolved_by` naming no executed
// plan still blocks, closing the false-green risk a text-only trust model
// would leave open for a status this predicate gate is not free to bypass.

// ─── stripFalsePositiveContexts ───────────────────────────────────────────────

/**
 * Remove contexts that can contain `result: ...` lines that are NOT real test results:
 *   (a) leading frontmatter block at byte 0
 *   (b) HTML comments (unterminated comments swallow to EOF — fail-closed)
 *   (c) fenced code blocks (backtick and tilde, indented too) via CommonMark state machine
 *   (d) blockquote lines
 *
 * Each step is a composable function (Kernighan's Law — independently testable).
 * Returns surviving lines joined by '\n'. Robust to CRLF input.
 */
function stripFalsePositiveContexts(content: string): string {
  // Step (a): strip the leading frontmatter block — the one `frontmatterBlock` (the one fence
  // owner) finds — with its closing fence line's line ending.
  const block = frontmatterBlock(content);
  let stripped = block ? block.rest.replace(/^\r?\n/, '') : content;

  // Step (b): remove HTML comments anywhere; unterminated comment swallows to EOF
  stripped = stripped.replace(/<!--[\s\S]*?(?:-->|$)/g, '');

  // Step (c): remove fenced code blocks via the canonical seam (ADR-1372 T5)
  stripped = stripFencedCode(stripped).text;

  // Step (d): remove blockquote lines
  stripped = stripped
    .split('\n')
    .filter(line => !/^\s*>/.test(line))
    .join('\n');

  return stripped;
}

/**
 * Analyse raw markdown for structural anomalies (unterminated fence / comment).
 * Exported for unit-testability and used by evaluateUatPassed for per-file malformed detection.
 *
 * FIX C: properly balanced comments are stripped before checking for a dangling <!--,
 * so an earlier closed comment does not mask a later unterminated one.
 */
function analyzeMarkdown(raw: string): { unterminatedFence: boolean; unterminatedComment: boolean } {
  // Detect an unterminated HTML comment via a paired scan: every `<!--` must
  // have a following `-->`. Using indexOf (not a regex .replace of the comment
  // token) avoids the js/incomplete-multi-character-sanitization pattern — and
  // is exact: a closed earlier comment never masks a later unterminated one.
  let unterminatedComment = false;
  for (let i = 0; ; ) {
    const open = raw.indexOf('<!--', i);
    if (open === -1) break;
    const close = raw.indexOf('-->', open + 4);
    if (close === -1) { unterminatedComment = true; break; }
    i = close + 3;
  }

  // Fence state machine gives the accurate unterminated-fence signal (seam, ADR-1372 T5).
  const { unterminatedFence } = stripFencedCode(raw);

  return { unterminatedFence, unterminatedComment };
}

// ─── parseUatResultItems ──────────────────────────────────────────────────────

/**
 * HEADING-BLOCK parser: scan the CLEANED body (after stripFalsePositiveContexts)
 * for UAT test blocks.
 *
 * For each ### N. Name heading, the block spans until the next ### heading or EOF.
 * Within each block, find a column-0 anchored result line (rejects indented YAML
 * block-scalar bodies and inline/quoted fakes).
 *
 * - If a heading block has NO column-0 result line → emit result:'missing' (blocker).
 * - Support bracketed [passed] and bare passed (#2273).
 * - Returns ALL items (both passing and non-passing).
 */
function parseUatResultItems(cleanContent: string): Array<{ test: number; name: string; result: string; reason: string }> {
  const items: Array<{ test: number; name: string; result: string; reason: string }> = [];

  // Find all ### N. Name headings.
  // #3078-CR MEDIUM (security review follow-up): STRUCTURE and ATTRIBUTION
  // need different split frames. This is a STRUCTURE scan — finding where a
  // heading block begins — and there is no attribution distinction to
  // preserve, so split on any of the two exotic line separators alongside
  // ordinary `\n` (LINE_SPLIT_RE, above): a heading delimited by one of them
  // (origin/next's `/m`-anchored scan found these; a naive `split('\n')`-only
  // port silently stopped finding them, making the gate MORE permissive than
  // origin/next) is found exactly like a `\n`-delimited one. Contrast the
  // `result:` scan below, which is an ATTRIBUTION scan and must NOT do this.
  const HEADING_LINE_RE = /^###\s*(\d+)\.\s*(.+)$/;
  const headings: Array<{ index: number; lineStart: number; test: number; name: string }> = [];
  {
    // All three separators are exactly one UTF-16 code unit, so the
    // `line.length + 1` offset arithmetic below stays valid regardless of
    // which separator terminated a given line.
    const lines = cleanContent.split(LINE_SPLIT_RE);
    let offset = 0;
    for (const line of lines) {
      const hMatch = line.match(HEADING_LINE_RE);
      if (hMatch) {
        headings.push({
          index: offset + hMatch[0].length,
          lineStart: offset,
          test: parseInt(hMatch[1], 10),
          name: hMatch[2].trim(),
        });
      }
      offset += line.length + 1; // +1 for the separator consumed by split
    }
  }

  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    const blockStart = h.index;
    // A block spans until the START of the next heading's line (tracked
    // directly from the same split-frame scan above), not a re-search for a
    // literal '\n###' over unsplit text -- the latter would silently miss a
    // next heading delimited by an exotic separator instead of '\n' and
    // swallow every subsequent block into this one.
    const blockContent = i + 1 < headings.length
      ? cleanContent.slice(blockStart, headings[i + 1].lineStart)
      : cleanContent.slice(blockStart);

    // Column-0 result line, split-then-match (#3078-CR MEDIUM — same fix as
    // the heading scan above): test each already-split line individually
    // against a single-line (no `/m` anchor) pattern instead of anchoring
    // over unsplit `blockContent`, so a `result:`-shaped line reachable only
    // via an exotic separator inside an `expected: |` scalar body can never
    // register as a fake column-0 match. FIRST MATCH WINS — no ambiguity
    // counting, matching src/uat.cts's contract.
    // Uses [ \t]* (not \s*) so the captured value must sit on the SAME line as result:.
    // A result: key with the value on a subsequent line yields no match → 'missing' (blocker).
    // #4546: the `reason:` line is captured with the same frame and FIRST-match
    // rule — it is the deferral signal the evaluator needs (a `skipped` item
    // whose reason is the verify-work writer's "Deferred follow-up:" template
    // is non-blocking). Quoted values are captured with their quotes so the
    // evaluator's matcher can tolerate them exactly as written.
    const RESULT_LINE_RE = /^result:[ \t]*\[?([\w-]+)\]?/i;
    const resultMatch = blockContent
      .split('\n')
      .map((line) => line.match(RESULT_LINE_RE))
      .find((m): m is RegExpMatchArray => m !== null) ?? null;
    const REASON_LINE_RE = /^reason:[ \t]*(.*)$/i;
    const reasonMatch = blockContent
      .split('\n')
      .map((line) => line.match(REASON_LINE_RE))
      .find((m): m is RegExpMatchArray => m !== null) ?? null;
    const reason = reasonMatch ? reasonMatch[1].trim() : '';
    if (resultMatch) {
      items.push({
        test: h.test,
        name: h.name,
        result: resultMatch[1].toLowerCase(),
        reason,
      });
    } else {
      // No column-0 result line → emit 'missing' (a non-passing state)
      items.push({
        test: h.test,
        name: h.name,
        result: 'missing',
        reason,
      });
    }
  }

  return items;
}

// ─── parseGapsEntries ───────────────────────────────────────────────────────

interface GapEntry {
  test: number | null;
  status: string;
  resolvedBy: string;
  gapId: string;
}

/**
 * #4983: parse the UAT file's `## Gaps` bullet list (templates/UAT.md) for
 * the four scalar fields the predicate needs to decide whether a resolved
 * `result: issue` test still blocks — `test`, `status`, `resolved_by`,
 * `gap_id`.
 *
 * Deliberately a separate, minimal parser from src/uat.cts's `parseGapsItems`
 * (the read-side/audit parser): this module hardens independently, on the
 * ALREADY-CLEANED body (stripFalsePositiveContexts has already removed
 * frontmatter/HTML comments/fenced code/blockquotes), and only needs these
 * four fields — never the nested `artifacts:`/`missing:` sub-lists the
 * read-side parser also handles.
 *
 * Entries are split on column-0 `- ` bullet openers (the template's shape);
 * a nested sub-list item (e.g. a `  artifacts:` key followed by an indented
 * `    - path: "..."` line) is indented and never matches the column-0
 * opener, so it can never be mistaken for a new top-level entry.
 *
 * Fields are matched per line, first-match-wins, bounded to the entry's OWN
 * top-level indentation — either the bullet-opener line itself (0 leading
 * spaces once `BULLET_OPENER_RE` has stripped the `"- "` marker) or a
 * continuation line indented by exactly the template's 2 spaces (each field
 * regex below is anchored `^[ ]{0,2}key:`). A candidate line indented deeper
 * than that (4+ spaces) is a nested sub-list's body or a multi-line scalar
 * VALUE, never a sibling
 * field declaration, and is deliberately NOT trimmed-and-matched the way an
 * earlier revision of this function did (#4983 review round 1, MEDIUM): a
 * block-scalar value line that happens to read "status: resolved" after
 * trimming (e.g. embedded free text) could otherwise be mistaken for a real
 * field at the wrong indentation, the same false-positive class
 * `parseUatResultItems` above already guards against via column-0 anchoring
 * for `result:`/`reason:`.
 */
function parseGapsEntries(cleanContent: string): GapEntry[] {
  const GAPS_HEADING_RE = /^##\s*Gaps\s*$/i;
  const OTHER_HEADING_RE = /^##\s+\S/;
  const lines = cleanContent.split('\n');

  let sectionStart = -1;
  let sectionEnd = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (sectionStart === -1) {
      if (GAPS_HEADING_RE.test(lines[i])) sectionStart = i + 1;
    } else if (OTHER_HEADING_RE.test(lines[i])) {
      sectionEnd = i;
      break;
    }
  }
  if (sectionStart === -1) return [];

  // Split the section body into entries at column-0 `- ` bullet openers.
  // The opener line's own field (if any) is stored with a synthetic 0-space
  // prefix removed — see FIELD_INDENT_RE below, which accepts both 0 and 2
  // leading spaces as "this entry's own top level".
  const BULLET_OPENER_RE = /^-\s?(.*)$/;
  const entryBlocks: string[][] = [];
  for (const line of lines.slice(sectionStart, sectionEnd)) {
    const m = line.match(BULLET_OPENER_RE);
    if (m) {
      entryBlocks.push([m[1]]);
    } else if (entryBlocks.length > 0) {
      entryBlocks[entryBlocks.length - 1].push(line);
    }
    // Lines before the first bullet (blank lines, the template's own
    // `<!-- YAML format ... -->` comment — already stripped by the caller)
    // carry no entry and are simply ignored.
  }

  const stripQuotes = (v: string): string => v.trim().replace(/^["']+|["']+$/g, '').trim();
  // Bounded to 0-2 leading spaces: the bullet-opener line's stored text has
  // 0 (its `- ` marker already stripped), and a real continuation line in
  // the template's own two-space-indented shape has exactly 2. Anything
  // indented deeper (a scalar body, a nested `artifacts:`/`missing:` list
  // item) is excluded by construction, not merely by accident of key name.
  const TEST_FIELD_RE = /^[ ]{0,2}test:[ \t]*(.*)$/i;
  const STATUS_FIELD_RE = /^[ ]{0,2}status:[ \t]*(.*)$/i;
  const RESOLVED_BY_FIELD_RE = /^[ ]{0,2}resolved_by:[ \t]*(.*)$/i;
  const GAP_ID_FIELD_RE = /^[ ]{0,2}gap_id:[ \t]*(.*)$/i;

  const entries: GapEntry[] = [];
  for (const block of entryBlocks) {
    let test: number | null = null;
    let status = '';
    let resolvedBy = '';
    let gapId = '';
    for (const rawLine of block) {
      if (test === null) {
        const tm = rawLine.match(TEST_FIELD_RE);
        if (tm) {
          const n = parseInt(stripQuotes(tm[1]).replace(/[[\]]/g, ''), 10);
          if (!Number.isNaN(n)) test = n;
          continue;
        }
      }
      if (!status) {
        const sm = rawLine.match(STATUS_FIELD_RE);
        if (sm) { status = stripQuotes(sm[1]).toLowerCase(); continue; }
      }
      if (!resolvedBy) {
        const rm = rawLine.match(RESOLVED_BY_FIELD_RE);
        if (rm) { resolvedBy = stripQuotes(rm[1]); continue; }
      }
      if (!gapId) {
        const gm = rawLine.match(GAP_ID_FIELD_RE);
        if (gm) { gapId = stripQuotes(gm[1]); continue; }
      }
    }
    entries.push({ test, status, resolvedBy, gapId });
  }
  return entries;
}

// ─── isTestGapResolved ────────────────────────────────────────────────────────

/**
 * #4983: true only when EVERY `## Gaps` entry recorded against `testNum` is a
 * verified resolution — never on the presence of just one resolved entry,
 * since a later regression re-opens the SAME test number with a fresh
 * `gap_id` (per verify-work.md's reconcile_gaps contract) while a prior entry
 * for it stays `resolved`; an unresolved regression must still block.
 *
 * A single entry only counts as a verified resolution when ALL of:
 *  - `status` is `resolved` (an entry with no gap recorded, or `status:
 *    failed`/blank, is not a resolution — fails closed);
 *  - `resolved_by` is non-empty (a partial resolution missing the writer's
 *    attribution fails closed, per #4983's acceptance criteria);
 *  - `resolved_by`, taken as a bare basename (rejecting any path separator —
 *    no directory traversal), names a `*-PLAN.md` file that actually exists
 *    in this phase directory;
 *  - that plan has a matching `*-SUMMARY.md` sibling in the same directory —
 *    the same "plan executed" evidence verify-work.md's own reconcile_gaps
 *    step requires (elaboration.md §1) before it ever writes `resolved_by`;
 *  - the entry's own `gap_id` is present, AND the named plan's frontmatter
 *    `gap_ids` array includes it — proof the plan resolved THIS gap, not
 *    some other one.
 *
 * The `gap_id` cross-check (#4983 review round 1, CRITICAL) closes a false-
 * green a plan-existence-only check leaves wide open: `resolved_by` naming a
 * real, executed plan is not proof that plan addressed THIS gap. Concretely,
 * a phase with a legitimately-resolved gap on test 3 (`resolved_by:
 * 05-02-PLAN.md`, `05-02-PLAN.md`'s own `gap_ids: [G-05-3]`) could otherwise
 * have an UNRELATED, still-broken test 7 marked `status: resolved,
 * resolved_by: 05-02-PLAN.md` (copy-pasted or mis-attributed) and the prior
 * checks alone would accept it — `05-02-PLAN.md` and its SUMMARY genuinely
 * exist, they just never touched gap 7. Reading the plan's own `gap_ids` and
 * requiring it to name this entry's `gap_id` closes that: a resolution claim
 * this gate cannot independently verify against the phase directory's own
 * files, cross-referenced back to the SPECIFIC gap, is not trusted. An entry
 * with no `gap_id` at all (an older, hand-written entry predating the
 * `gap_id` convention) fails closed — there is nothing to cross-reference,
 * so it cannot be verified.
 *
 * This is deliberately MORE than a text-only trust check (contrast the
 * `DEFERRED_REASON_RE` deferred-skip case above, an accepted authoring
 * contract, not a security boundary): #4983's acceptance criteria explicitly
 * requires that "a `resolved_by` that names no executed plan still blocks" —
 * reading this as "no plan that executed AND resolved THIS gap" is the
 * reading that actually closes the false-green risk, not merely "some plan
 * ran somewhere in this phase."
 */
function isTestGapResolved(entries: GapEntry[], testNum: number, dirEntries: string[], phaseFullDir: string): boolean {
  const forTest = entries.filter((e) => e.test === testNum);
  if (forTest.length === 0) return false;
  return forTest.every((e) => {
    if (e.status !== 'resolved') return false;
    if (!e.resolvedBy) return false;
    if (path.basename(e.resolvedBy) !== e.resolvedBy) return false;
    // Canonical plan-filename predicate (src/plan-scan.cts) rather than a
    // hand-rolled `-PLAN.md$` regex — one owner for "what is a plan file"
    // across the codebase (lint-plan-count-drift.cjs enforces this).
    if (!isRootPlanFile(e.resolvedBy)) return false;
    if (!dirEntries.includes(e.resolvedBy)) return false;
    // Canonical plan→summary pairing (src/core-utils.cts), same reason: a
    // single-plan/single-candidate-set query reuses the exact matching rules
    // scanPhasePlans's own summaryCount is built from, rather than a
    // hand-rolled `-PLAN.md` → `-SUMMARY.md` suffix swap.
    if (countMatchedSummaries([e.resolvedBy], dirEntries) !== 1) return false;
    // Fail closed on an entry with no gap_id to cross-reference — there is
    // nothing to verify the named plan actually resolved THIS gap against.
    if (!e.gapId) return false;
    return planClaimsGapId(phaseFullDir, e.resolvedBy, e.gapId);
  });
}

/**
 * #4983 (review round 1, CRITICAL follow-up): read the named plan's own
 * frontmatter `gap_ids` array and confirm it includes `gapId` — the
 * cross-reference `isTestGapResolved` needs to confirm a plan that exists
 * and has a SUMMARY actually claims to resolve THIS gap, not merely that it
 * ran. Any failure to read or parse the plan (missing file, unreadable,
 * malformed frontmatter, `gap_ids` absent or not an array) returns `false` —
 * fail-closed, matching this module's convention throughout.
 */
function planClaimsGapId(phaseFullDir: string, planBasename: string, gapId: string): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(phaseFullDir, planBasename), 'utf-8');
  } catch {
    return false;
  }
  let fm: Record<string, unknown>;
  try {
    fm = extractFrontmatter(raw, planBasename);
  } catch {
    return false;
  }
  const gapIds = fm['gap_ids'];
  if (!Array.isArray(gapIds)) return false;
  return gapIds.some((id) => typeof id === 'string' && id.trim() === gapId.trim());
}

// ─── evaluateUatPassed ────────────────────────────────────────────────────────

/**
 * Evaluate all UAT/VERIFICATION files in a phase directory.
 * Returns a UatPassedReport with the locked, stable shape defined by the interface.
 *
 * FAIL-CLOSED: any absence/ambiguity/malformed input → NOT passed.
 * Pass requires at least one real passing check AND no blockers.
 */
function evaluateUatPassed(
  phaseFullDir: string,
  opts?: { policy?: { requireVerification?: boolean; uatOnly?: boolean } },
): UatPassedReport {
  // uatOnly (#4663) takes precedence: it evaluates the UAT rows ONLY, skipping
  // the VERIFICATION-file blockers entirely. The verify-work canonicalize
  // pre-check needs exactly that — it runs while the report still reads
  // `human_needed`, which is itself a blocking verification status, so the
  // full predicate could never pass there and the flip would deadlock.
  const uatOnly = opts?.policy?.uatOnly === true;
  const requireVerification = !uatOnly && opts?.policy?.requireVerification === true;

  const blockers: string[] = [];
  const checks: UatCheckItem[] = [];
  const uatFiles: string[] = [];
  const verificationFiles: string[] = [];

  // Read the directory — if unreadable, treat as no files (fail-closed: no artifacts → not passed)
  let dirEntries: string[] = [];
  try {
    dirEntries = fs.readdirSync(phaseFullDir);
  } catch {
    // Unreadable dir — no_uat_artifacts:true, passed:false
    const no_uat_artifacts = true;
    if (requireVerification) {
      blockers.push('policy: verification required but no passing *-VERIFICATION.md found');
    }
    return {
      passed: false,
      uat_files: [],
      verification_files: [],
      checks: [],
      blockers,
      no_uat_artifacts,
      policy: { require_verification: requireVerification, uat_only: uatOnly },
      // readVerificationStatus was never reached on this early-return path.
      verification_stale_check_indeterminate: false,
    };
  }

  // Filter UAT and VERIFICATION files using the same filter as cmdPhaseComplete,
  // scoped to THIS phase's own token (#3511) — a stray, cross-phase, or ad-hoc
  // file can no longer contribute a blocker to a phase it does not belong to.
  const phaseDirBaseName = path.basename(phaseFullDir);
  const uatFileNames = scopeToPhase(
    dirEntries.filter(f => f.includes('-UAT') && f.endsWith('.md')),
    phaseDirBaseName,
  );
  const verFileNames = scopeToPhase(
    dirEntries.filter(f => f.includes('-VERIFICATION') && f.endsWith('.md')),
    phaseDirBaseName,
  );

  // ── Process UAT files ──────────────────────────────────────────────────────
  for (const file of uatFileNames) {
    uatFiles.push(file);
    const uatFilePath = path.join(phaseFullDir, file);
    let raw = '';
    try {
      // #3078-CR MEDIUM: normalize line endings at the read boundary — the
      // same seam src/uat.cts and src/verification.cts route through — so a
      // lone-CR *-UAT.md is not read as one unbroken line by the column-0
      // scans below.
      raw = normalizeLineEndings(fs.readFileSync(uatFilePath, 'utf-8'));
    } catch {
      blockers.push(`${file}: could not read file`);
      continue;
    }

    // ── Per-file malformed markdown guard ──────────────────────────────────
    // FIX D: use accurate signals from analyzeMarkdown instead of heuristics.
    // unterminatedFence: CommonMark state machine detects a genuinely unclosed fence.
    // unterminatedComment: strips balanced comments first, then checks for leftover <!--.
    const { unterminatedFence, unterminatedComment } = analyzeMarkdown(raw);
    if (unterminatedFence || unterminatedComment) {
      blockers.push(`${file}: malformed markdown (unterminated fence or comment)`);
    }

    const fm = extractFrontmatter(raw, uatFilePath) as Record<string, unknown>;

    // File-level frontmatter status check
    if (fm['status'] && BLOCKING_UAT_FM_STATUSES.has(fm['status'] as string)) {
      blockers.push(`${file}: frontmatter status=${fm['status'] as string}`);
    }
    // File-level frontmatter result check
    if (fm['result'] && BLOCKING_UAT_FM_RESULTS.has(fm['result'] as string)) {
      blockers.push(`${file}: frontmatter result=${fm['result'] as string}`);
    }

    // Parse test items from the cleaned body (hardened against false positives)
    const cleanContent = stripFalsePositiveContexts(raw);
    const items = parseUatResultItems(cleanContent);
    // #4983: parsed once per file — `evaluateUatPassed` already has `dirEntries`
    // from the readdir above, so `isTestGapResolved` can verify `resolved_by`
    // against this phase directory's own files.
    const gapEntries = parseGapsEntries(cleanContent);

    for (const item of items) {
      // #4546: a `skipped` item whose reason matches the verify-work writer's
      // "Deferred follow-up:" template is a deliberately deferred follow-up
      // (#1921) — non-blocking. Quote-tolerant because the writer emits the
      // reason WITH its wrapping quotes. Everything else — pending, blocked,
      // issue, missing, and a plain or non-deferral skipped — still blocks.
      const deferred = item.result === 'skipped' && DEFERRED_REASON_RE.test(item.reason);
      // #4983: an `issue` item whose `## Gaps` entry has been verified-resolved
      // (see isTestGapResolved) is a genuinely fixed issue — non-blocking.
      const resolved = item.result === 'issue' && isTestGapResolved(gapEntries, item.test, dirEntries, phaseFullDir);
      const passing = PASSING_RESULTS.has(item.result) || deferred || resolved;
      checks.push({
        file,
        test: item.test,
        name: item.name,
        result: item.result,
        passing,
        deferred,
        resolved,
      });
      if (!passing) {
        blockers.push(`${file}: test ${item.test} (${item.result})`);
      }
    }
  }

  // ── Process VERIFICATION files ─────────────────────────────────────────────
  let hasPassingVerification = false;
  for (const file of uatOnly ? [] : verFileNames) {
    verificationFiles.push(file);
    const verificationFilePath = path.join(phaseFullDir, file);
    // #5118 security review (S1): containment BEFORE the read — a report whose
    // real path escapes the planning root reads `missing` (no status counts,
    // no blocker) and not a byte of it reaches any message.
    if (!isReportContained(phaseFullDir, verificationFilePath)) continue;
    let raw = '';
    try {
      // #3078-CR MEDIUM: same read-boundary normalization as the UAT loop above.
      raw = normalizeLineEndings(fs.readFileSync(verificationFilePath, 'utf-8'));
    } catch {
      blockers.push(`${file}: could not read verification file`);
      continue;
    }

    // #5118: judged by the owner's report reader — a status outside the
    // closed writer set throws VerificationStatusError (no silent pass-through).
    const vStatus = reportStatusOf(extractFrontmatter(raw, verificationFilePath), verificationFilePath);

    if (vStatus === VERIFICATION_STATUS.HUMAN_NEEDED || vStatus === VERIFICATION_STATUS.GAPS_FOUND) {
      blockers.push(`${file}: verification status=${vStatus}`);
    } else if (vStatus === VERIFICATION_STATUS.PASSED) {
      // Allowlist: only an explicitly-passing status counts
      hasPassingVerification = true;
    }
    // No status: does NOT count as passing, does NOT push a blocker
    // (handled by the requireVerification policy check below if needed)
  }

  // ── Policy: requireVerification ───────────────────────────────────────────
  // #3057 B3: routing here is UNCHANGED — an indeterminate staleness check
  // still falls through to the same `verificationStatus !== 'passed'` branch
  // it always did (the pre-existing fail-open contract). `verificationStaleCheckIndeterminate`
  // only records the fact for the report below; it never itself gates `blockers`.
  let verificationStaleCheckIndeterminate = false;
  if (requireVerification) {
    const verificationResult = readVerificationStatus(phaseFullDir);
    const verificationStatus = verificationResult.status;
    verificationStaleCheckIndeterminate = verificationResult.staleCheckIndeterminate === true;
    if (verificationStatus === VERIFICATION_STATUS.STALE) {
      blockers.push(`policy: verification status=${VERIFICATION_STATUS.STALE}`);
    } else if (verificationStatus !== VERIFICATION_STATUS.PASSED || !hasPassingVerification) {
      blockers.push('policy: verification required but no passing *-VERIFICATION.md found');
    }
  }

  // ── Determine no_uat_artifacts and passed ─────────────────────────────────
  // no_uat_artifacts: true when no real UAT test items were parsed from any file
  const no_uat_artifacts = checks.length === 0;

  // FIX 1: require positive passing evidence; no vacuous pass
  // passed = no blockers AND at least one check AND all checks passing
  const passed = blockers.length === 0 && checks.length > 0 && checks.every(c => c.passing);

  return {
    passed,
    uat_files: uatFiles,
    verification_files: verificationFiles,
    checks,
    blockers,
    no_uat_artifacts,
    policy: {
      require_verification: requireVerification,
      uat_only: uatOnly,
    },
    verification_stale_check_indeterminate: verificationStaleCheckIndeterminate,
  };
}

export = {
  stripFalsePositiveContexts,
  parseUatResultItems,
  analyzeMarkdown,
  evaluateUatPassed,
  // #4983: exported for direct unit-testability of the Gaps-resolution
  // parser/validator, independent of a full evaluateUatPassed round-trip.
  parseGapsEntries,
  isTestGapResolved,
};
