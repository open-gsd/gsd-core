/**
 * Roadmap — Roadmap parsing and update operations
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/roadmap.cjs collapsed
 * to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only strict types are added.
 */

import type { PhaseDirectoryContext } from './phase-id.cjs';
import fs from 'node:fs';
import path from 'node:path';
import { realClock } from './clock.cjs';
import { escapeRegex } from './pattern.cjs';
import { PHASE_ENTRY_BOLD_CLOSE_SRC, isBoxCharChecked, isPhaseEntryChecked, phaseEntryPrefixSrc, phaseEntryRegExp } from './phase-entry-grammar.cjs';
import { splitLines, detectEol, joinLines } from './text-lines.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import ioMod = require('./io.cjs');
const { output, error, formatDiagnosticToken, declineNoOp } = ioMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseIdMod = require('./phase-id.cjs');
const { phaseMarkdownRegexSource, stripProjectCodePrefix, OPTIONAL_PHASE_TAG_SOURCE, roadmapPhaseLookupSources, phaseHeadingPrefixSrcFor, PHASE_HEADING_BASELINE, isSentinelPhaseId, scopeToPhase, bracketQualifiedKey, foldBracketId } = phaseIdMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseLocatorMod = require('./phase-locator.cjs');
const {
  phaseDirectoryOptions, findPhaseInternal, listMilestonePhaseDirs, listAllPhaseDirs,
  resolvePhaseDirectoryLookup, matchPhaseDirsForLookup,
} = phaseLocatorMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningScopeMod = require('./planning-scope.cjs');
const { SCOPE } = planningScopeMod;
type Scope = planningScopeMod.Scope;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import roadmapParserModule = require('./roadmap-parser.cjs');
const { stripShippedMilestones, extractCurrentMilestone, extractCurrentMilestoneScoped, checklistBulletExtent, phaseChecklistBullet: phaseChecklistBulletFor, withPhaseSection, listMilestoneHeadings, scanMilestonePhaseIds, collectTablePhaseRows, hasPhaseListingTableHeader } = roadmapParserModule;

/** Every phase-list entry line, any phase: the rows between two of them belong to the first. */
const ANY_PHASE_ENTRY_LINE = phaseEntryRegExp('Phase[ \\t][^\\r\\n]*$', 'gi');
import { tokenizeHeadings } from './markdown-sectionizer.cjs';
import { escapeCell, findTableWithColumns, parseMarkdownTable, updateTableCell } from './markdown-table.cjs';
import { clampPercent } from './phase-lifecycle.cjs';
import { normalizeMilestoneToken, editRoadmapProgress } from './roadmap-progress.cjs';
import { platformWriteSync, contentChangedAfterNormalize } from './shell-command-projection.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspace = require('./planning-workspace.cjs');
const { planningPaths, withPlanningLock, findContextMdIn, resolvePhaseIdConvention } = planningWorkspace;
// #3641: milestone-scope's convention resolution reads the project config
// (no cycle — config-loader does not import this module).
// eslint-disable-next-line @typescript-eslint/no-require-imports
import configLoaderForScope = require('./config-loader.cjs');
const { loadConfig: loadConfigForScope } = configLoaderForScope;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import scanPhasePlans = require('./plan-scan.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import coreUtils = require('./core-utils.cjs');
const { findUnsummarizedPlans } = coreUtils;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import frontmatter = require('./frontmatter.cjs');
const { extractFrontmatter, frontmatterRegion, parseMustHavesBlock } = frontmatter;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import verificationMod = require('./verification.cjs');
const { isPhaseComplete, failOnVerificationStatusError, firstStatusError } = verificationMod;
// #4906 Phase 2 (#4917/ADR-4910): the PlanningDoc parse -> mutate -> serialize
// seam, mirroring phase.cts's already-migrated `writePlansField` site.
import { parsePlanningDoc, findField, readNode, setFieldValue, serialize } from './planning-document.cjs';
// #5060: the Phase Status Module owns the ladder; roadmap.cts is a consumer.
import { phaseStatus, phaseStatusFromFacts, toDiskStatus, toRoadmapStatusCell, matchRoadmapStatusCell, parseRoadmapStatusCell, ROADMAP_STATUS_TOKEN, DISK_STATUS, WIRE_STATUS } from './phase-status.cjs';

// ─── Types ────────────────────────────────────────────────────────────────────

interface PhasePlansAndSummaries {
  planCount: number;
  summaryCount: number;
  hasContext: boolean;
  hasResearch: boolean;
  /**
   * #3885 (ADR-3473 §8.5): null when the phase directory's readdirSync
   * succeeded OR was genuinely absent (ENOENT — a real "not built yet"
   * answer, not an error). A message naming the phase directory when
   * readdirSync failed for any other reason (EACCES/EIO/...), so an
   * unreadable directory is never silently reported the same as one that was
   * successfully read and genuinely has no CONTEXT.md.
   *
   * #4014 (epic #3473 B4): kept — `AnalyzePhase.context_read_error` (the
   * shipped, tested `roadmap analyze` JSON field this feeds) is an existing
   * consumer, so this field stays additive rather than being retired. `scope`
   * below is the new, typed sibling signal; this field is now derived from
   * it rather than owning its own readdirSync.
   */
  contextReadError: string | null;
  /** #4014 (epic #3473 B4): the `SCOPE` this phase dir's listing resolved to
   * — `SCOPE.UNREADABLE` distinguishes a real read failure from a
   * genuinely empty/absent phase dir (`SCOPE.COMPLETE`), which
   * `contextReadError`/`hasContext` alone cannot. */
  scope: Scope;
}

interface PhaseSearchResult {
  found: boolean;
  phase_number: string;
  phase_name: string;
  goal?: string | null;
  mode?: string | null;
  success_criteria?: string[];
  section?: string;
  error?: string;
  message?: string;
}

interface TruthValue {
  count: number;
  text: string;
}

// ─── coerceTruthToString ──────────────────────────────────────────────────────

/**
 * Coerce an arbitrary YAML scalar/object into a string for cross-cutting
 * truth aggregation. Handles:
 *   - strings (passthrough)
 *   - numbers / booleans (String() coercion — issue #2770: bare YAML ints
 *     like `- 3` must be surfaced, not silently skipped)
 *   - kv-shaped objects from parseMustHavesBlock continuation kv (issue
 *     #2757) — extract the first meaningful string field
 *
 * Returns the empty string when no usable text can be derived; callers should
 * skip empty results.
 */
function coerceTruthToString(t: unknown): string {
  if (t === null || t === undefined) return '';
  if (typeof t === 'string') return t;
  if (typeof t === 'number' || typeof t === 'boolean' || typeof t === 'bigint') {
    return String(t);
  }
  if (typeof t === 'object') {
    // Prefer common title-bearing keys produced by parseMustHavesBlock. `statement` is the canonical
    // truth/prohibition payload field — and the carrier of #1154's object-form backstop truth
    // `{ statement, verification: backstop }`, so it leads (a non-inferable truth must be coerced by
    // its statement, never dropped — the Hyrum backward-compat guard for the new marker).
    for (const k of ['statement', 'title', 'text', 'name', 'rule', 'path', 'provides']) {
      const v = (t as Record<string, unknown>)[k];
      if (typeof v === 'string' && v.trim()) return v;
      if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    }
  }
  return '';
}

// ─── countPhasePlansAndSummaries ──────────────────────────────────────────────

function countPhasePlansAndSummaries(phaseDir: string, convention?: string | null): PhasePlansAndSummaries {
  const { planCount, summaryCount } = scanPhasePlans(phaseDir);
  // hasContext and hasResearch are not plan-scan concerns — read the directory
  // once and share the listing for all non-plan metadata that cmdRoadmapAnalyze needs.
  //
  // #4014 (epic #3473 B4): the listing + unreadable-vs-empty discrimination
  // is now owned by findContextMdIn's directory-string form, retiring this
  // function's own readdirSync try/catch (mirrors core-utils.cts's
  // getPhaseFileStats / phase-locator.cts's listMilestonePhaseDirs
  // SCOPE.UNREADABLE discriminator).
  const { files: phaseFiles, scope } = findContextMdIn(phaseDir);
  // #3885 (ADR-3473 §8.5): `contextReadError` stays additive for the shipped
  // `AnalyzePhase.context_read_error` JSON field — derived from `scope`
  // rather than from its own caught error, since findContextMdIn's
  // directory-string form reports SCOPE, not the raw errno message.
  const contextReadError = scope === SCOPE.UNREADABLE
    ? `Could not read phase directory ${formatDiagnosticToken(phaseDir)}`
    : null;
  // #3511: scope the raw listing to this phase dir before the
  // phase-numbered-artifact predicates (hasContext/hasResearch) — planCount/
  // summaryCount above stay on scanPhasePlans's own unscoped listing since a
  // PLAN/SUMMARY leading number is a plan sequence number, not a phase
  // number. Mirrors core-utils.cts's getPhaseFileStats.
  // #612: `convention` threaded from the one caller (which already threads it
  // into matchPhaseDirs) so a bracket dir scopes by its real token.
  const scopedFiles = scopeToPhase(phaseFiles, path.basename(phaseDir), convention);
  return {
    planCount,
    summaryCount,
    hasContext: findContextMdIn(scopedFiles) !== null,
    hasResearch: scopedFiles.some(f => f.endsWith('-RESEARCH.md') || f === 'RESEARCH.md'),
    contextReadError,
    scope,
  };
}

// `phaseMarkdownRegexSource` lives in phase-id.cjs (#3537) and is imported above.

// ─── searchPhaseInContent ─────────────────────────────────────────────────────

/**
 * Build the phase-heading regex used by `searchPhaseInContent` for a given
 * pre-escaped phase source. Extracted (#3412) so tests can assert against the
 * exact production pattern instead of hand-duplicating it.
 * #1729: OPTIONAL_PHASE_TAG_SOURCE after the number tolerates a pre-colon ( ) tag.
 */
function buildPhaseHeadingRegex(escapedPhase: string, convention?: string | null): RegExp {
  return new RegExp(
    `^${phaseHeadingPrefixSrcFor(PHASE_HEADING_BASELINE.ANY_BRACKET, convention)}${escapedPhase}${OPTIONAL_PHASE_TAG_SOURCE}:\\s*(.+)$`,
    'i'
  );
}

/**
 * Search for a phase header (and its section) within the given content string.
 * Returns a result object if found (either a full match or a malformed_roadmap
 * checklist-only match), or null if the phase is not present at all.
 */
function searchPhaseInContent(content: string, escapedPhase: string, phaseNum: string, convention?: string | null): PhaseSearchResult | null {
  const headingPattern = buildPhaseHeadingRegex(escapedPhase, convention);
  const headings = tokenizeHeadings(content);
  const headingIndex = headings.findIndex((heading) => headingPattern.test(heading.text));
  const headerMatch = headingIndex === -1 ? null : headings[headingIndex].text.match(headingPattern);

  if (!headerMatch) {
    // Fallback: check if phase exists in summary list but missing detail section
    // A BARE `Phase\s+` at base — takes the label-only baseline, so a bracket
    // repo gains the bracket-ID form and nothing else.
    const checklistPattern = phaseEntryRegExp(
      `${phaseHeadingPrefixSrcFor(PHASE_HEADING_BASELINE.LABEL_ONLY, convention)}${escapedPhase}${OPTIONAL_PHASE_TAG_SOURCE}:\\s*([^*]+?)${PHASE_ENTRY_BOLD_CLOSE_SRC}`,
      'i',
      { bold: 'required' },
    );
    const checklistMatch = content.match(checklistPattern);

    if (checklistMatch) {
      return {
        found: false,
        phase_number: phaseNum,
        phase_name: checklistMatch[1].trim(),
        error: 'malformed_roadmap',
        message: `Phase ${phaseNum} exists in summary list but missing "### Phase ${phaseNum}:" detail section. ROADMAP.md needs both formats.`
      };
    }

    return null;
  }

  const phaseName = headerMatch[1].trim();
  const headerIndex = headings[headingIndex].offset;

  const currentHeading = headings[headingIndex];
  const nextHeading = headings
    .slice(headingIndex + 1)
    .find((candidate) => candidate.level <= currentHeading.level);
  const sectionEnd = nextHeading ? nextHeading.offset : content.length;

  const section = content.slice(headerIndex, sectionEnd).trim();

  // Extract goal if present (supports both **Goal:** and **Goal**: formats).
  // #4731: multiline-aware — hard-wrapped Goals read past the line break.
  const goal = roadmapParserModule.extractPhaseFieldMultiline(section, 'Goal');

  // Mode: vertical-MVP slice mode flag. Lowercased + trimmed for canonical
  // comparison; unrecognized values are preserved verbatim for forward-compat.
  const modeMatch = section.match(/\*\*Mode(?::\*\*|\*\*:)\s*([^\n]+)/i);
  const mode = modeMatch ? modeMatch[1].trim().toLowerCase() : null;

  // Extract success criteria as structured array. A criterion may wrap onto extra
  // indented lines (no `N.` prefix); those continuations must fold INTO their
  // criterion, not end the run (#2522 — the old `(?:\s*\d+\.\s*[^\n]+)+` broke on a
  // wrapped line, truncating it and silently dropping every criterion below it).
  // `\n*` before each numbered line keeps blank-line-separated criteria working.
  const criteriaMatch = section.match(
    /\*\*Success Criteria\*\*[^\n]*:\s*\n((?:\n*[ \t]*\d+\.[^\n]*\n?(?:[ \t]+(?!\d+\.)[^\n]*\n?)*)+)/i);
  const success_criteria = criteriaMatch
    ? criteriaMatch[1].trim().split(/\n+(?=[ \t]*\d+\.)/)
        .map(entry => entry.replace(/^\s*\d+\.\s*/, '').replace(/\s*\n\s*/g, ' ').trim())
        .filter(Boolean)
    : [];

  return {
    found: true,
    phase_number: phaseNum,
    phase_name: phaseName,
    goal,
    mode,
    success_criteria,
    section,
  };
}

// ─── getRoadmapPhaseWithFallback ──────────────────────────────────────────────

/**
 * Two-pass phase lookup that mirrors cmdRoadmapGetPhase's resolution strategy.
 *
 * Pass 1: current-milestone slice (extractCurrentMilestone).
 * Pass 2: full roadmap content (stripShippedMilestones) — covers cross-milestone
 *         and older frontend phases that are no longer in the current milestone slice.
 *
 * Returns the phase section string if found, null if ROADMAP.md is missing,
 * or throws if ROADMAP.md read fails.
 *
 * Used by the shared gate phase context (lookupRoadmapPhase in gate-phase-context.cts, which
 * computeUiPlanGate in gate-ui-plan.cts calls) so ui-plan-gate uses the SAME
 * phase resolution as `roadmap.get-phase` — not a milestone-only subset.
 */
function getRoadmapPhaseWithFallback(cwd: string, phaseNum: string): string | null {
  // #3185: canonical sentinel predicate (SENTINEL_RANGES [0,999]) — this was a local 999-only literal that admitted Phase 0.
  if (isSentinelPhaseId(stripProjectCodePrefix(phaseNum))) return null;
  const roadmapPath = planningPaths(cwd).roadmap;
  // Read directly rather than gating on fs.existsSync: existsSync returns false
  // on EACCES/EIO too, which would mask an UNREADABLE roadmap as "missing" and
  // let a blocking gate certify empty scope (#2365 review). Honor the documented
  // contract — null only when genuinely absent (ENOENT), otherwise throw.
  let rawContent: string;
  try {
    rawContent = fs.readFileSync(roadmapPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return null;
    throw err;
  }
  const milestoneContent = extractCurrentMilestone(rawContent, cwd);
  const fullContent = stripShippedMilestones(rawContent);

  // #2121/#2114: iterate the shared lookup-source list (exact → numeric →
  // prefix-tolerant) so this resolver matches getRoadmapPhaseInternal and a
  // bare-number query resolves a drifted project-code-prefixed heading.
  const convention = resolvePhaseIdConvention(cwd);
  for (const source of roadmapPhaseLookupSources(phaseNum)) {
    const milestoneResult = searchPhaseInContent(milestoneContent, source, phaseNum, convention);
    if (milestoneResult && !milestoneResult.error) return milestoneResult.section ?? null;
    const fullResult = searchPhaseInContent(fullContent, source, phaseNum, convention);
    if (fullResult && !fullResult.error) return fullResult.section ?? null;
  }

  return null;
}

// ─── cmdRoadmapGetPhase ───────────────────────────────────────────────────────

function cmdRoadmapGetPhase(cwd: string, phaseNum: string, raw: boolean): void {
  // #3185: canonical sentinel predicate (SENTINEL_RANGES [0,999]) — this was a local 999-only literal that admitted Phase 0.
  if (isSentinelPhaseId(stripProjectCodePrefix(phaseNum))) {
    output({ found: false, phase_number: phaseNum }, raw, '');
    return;
  }
  const roadmapPath = planningPaths(cwd).roadmap;

  if (!fs.existsSync(roadmapPath)) {
    output({ found: false, error: 'ROADMAP.md not found' }, raw, '');
    return;
  }

  try {
    const rawContent = fs.readFileSync(roadmapPath, 'utf-8');
    const milestoneContent = extractCurrentMilestone(rawContent, cwd);

    const fullContent = stripShippedMilestones(rawContent);
    const convention = resolvePhaseIdConvention(cwd);

    // #2121/#2114: iterate the shared lookup-source list (exact → numeric →
    // prefix-tolerant) so all three roadmap resolvers share one contract and a
    // bare-number query resolves a drifted `### Phase AB-29:` heading. This
    // preserves the #3599 exact-prefix-first and #3537 padding-tolerant behavior
    // (both now encoded in roadmapPhaseLookupSources' ordering). A clean match
    // (milestone or full, any source) wins immediately; a malformed_roadmap
    // (checklist-only) candidate is surfaced only if no source finds a real
    // heading — so a milestone checklist never blocks a full-roadmap header.
    let malformed: PhaseSearchResult | null = null;
    for (const source of roadmapPhaseLookupSources(phaseNum)) {
      const milestoneResult = searchPhaseInContent(milestoneContent, source, phaseNum, convention);
      if (milestoneResult && !milestoneResult.error) {
        output(milestoneResult, raw, milestoneResult.section);
        return;
      }
      const fullResult = searchPhaseInContent(fullContent, source, phaseNum, convention);
      if (fullResult && !fullResult.error) {
        output(fullResult, raw, fullResult.section);
        return;
      }
      if (!malformed) malformed = (milestoneResult?.error ? milestoneResult : (fullResult?.error ? fullResult : null));
    }

    // #3577: no heading or checklist entry matched — fall back to a
    // markdown-table row declaration (the same last-resort tier
    // getRoadmapPhaseInternal gained). Zero-pad-tolerant id compare (#3572
    // lesson: the declared form may be padded).
    const stripPad = (s: string) => s.replace(/^0+(?=.)/, '');
    const tableHit = collectTablePhaseRows(milestoneContent).find((tr) => stripPad(tr.id) === stripPad(phaseNum))
      ?? collectTablePhaseRows(fullContent).find((tr) => stripPad(tr.id) === stripPad(phaseNum));
    if (tableHit) {
      output(
        { found: true, phase_number: phaseNum, phase_name: tableHit.name ?? `Phase ${tableHit.id}`, goal: null, section: tableHit.row.trim() },
        raw,
        tableHit.row.trim(),
      );
      return;
    }

    if (malformed) {
      output(malformed, raw, '');
      return;
    }

    output({ found: false, phase_number: phaseNum }, raw, '');
  } catch (e) {
    error('Failed to read ROADMAP.md: ' + (e as Error).message);
  }
}

// ─── cmdRoadmapAnalyze ────────────────────────────────────────────────────────

/**
 * #3165: a single phase-detail heading enriched with its on-disk status, as
 * `cmdRoadmapAnalyze` reports it. Extracted so the SAME enrichment runs on both
 * the scoped milestone window and, when that window is suspect (non-COMPLETE
 * scope, zero phases, phase dirs on disk), the shipped-milestone-stripped
 * fallback document.
 */
type AnalyzePhase = {
  number: string;
  name: string;
  goal: string | null;
  mode: string | null;
  depends_on: string | null;
  plan_count: number;
  summary_count: number;
  has_context: boolean;
  has_research: boolean;
  disk_status: string;
  roadmap_complete: boolean;
  /** #3885 (ADR-3473 §8.5): see PhasePlansAndSummaries.contextReadError. */
  context_read_error: string | null;
  /** #4014 (epic #3473 B4): see PhasePlansAndSummaries.scope. Additive
   * sibling of context_read_error — SCOPE.UNREADABLE for the same read
   * failure context_read_error names, SCOPE.COMPLETE otherwise (including a
   * genuinely absent/no_directory phase). */
  context_scope: Scope;
};

/**
 * #4757: the phase records whose `roadmap_complete` was READ from a ROADMAP
 * checkbox. Table rows and headings with no checklist entry also report
 * `roadmap_complete: false`, but there is no checkbox behind it, so they must
 * not be compared against disk status by `checkbox_conflict`. A WeakSet keeps
 * this out of the emitted `phases[]` shape.
 */
const PHASES_WITH_CHECKBOX = new WeakSet<AnalyzePhase>();

type PhaseStatusError = ReturnType<typeof phaseStatus>['value']['statusError'];

type AnalyzePhaseCollection = {
  phases: AnalyzePhase[];
  detailKeys: Set<string>;
  /**
   * #5118: the first phase whose verification report `status` is outside the
   * closed set — carried here (never thrown past the other phases) so
   * `roadmap analyze` fails with it instead of printing an answer computed
   * over a report the owner refused.
   */
  statusError: PhaseStatusError;
};

// #612 composes the convention-qualified sentinel reading with upstream's
// canonical legacy sentinel owner. A reserved bracket milestone OR a reserved
// phase token excludes the occurrence.
const isSentinelPhase = (num: string, bracketId?: string): boolean => {
  if (bracketId && isSentinelPhaseId(`${bracketId}-${num}`, 'bracket')) return true;
  return isSentinelPhaseId(num);
};

// #2761 M1: missing-detail identity is milestone-qualified under bracket.
// Prefer the canonical qualified-key owner, which case-folds accepted ids, so
// `[gsd.02] 01` and `[GSD.02] 01` are one occurrence. It is intentionally not
// padding-tolerant: the milestone grammar has one canonical spelling (pad2
// below 100, no leading zero above), so `[GSD.2]` is malformed rather than an
// alternate spelling of `[GSD.02]`. Hyphenated tokens and other shapes the
// qualified-key owner refuses retain a folded composite, keeping distinct
// bracket/token pairs from collapsing onto one missing-detail verdict.
const occurrenceKey = (num: string, bracketId?: string): string => {
  if (!bracketId) return num;
  const qualified = num.includes('-')
    ? null
    : bracketQualifiedKey(`${bracketId}-${num}`, 'bracket');
  return qualified ?? `${foldBracketId(bracketId)}|${num}`;
};

/**
 * #3165: scan `content` for phase-detail headings (`##/###/#### Phase N: Name`)
 * and enrich each with its on-disk plan/summary/completion status and ROADMAP
 * checkbox. Pure extraction over `content` + the pre-built `phaseDirNames`
 * lookup index — no milestone windowing of its own; the caller chooses the
 * content (scoped window or fallback). Extracted verbatim from
 * `cmdRoadmapAnalyze`'s former inline loop so the fallback re-runs the EXACT
 * same enrichment, not a second derivation.
 */
function collectAnalyzePhases(
  cwd: string,
  content: string,
  phasesDir: string,
  phaseDirNames: string[],
  convention: string | null | undefined,
  directoryContext: PhaseDirectoryContext,
): AnalyzePhaseCollection {
  // Extract all phase headings: ## Phase N: Name or ### Phase N: Name
  // #1729: `(?:\s*\([^)\n]{0,200}\))?` tolerates a pre-colon ( ) tag (literal mirror of OPTIONAL_PHASE_TAG_SOURCE).
  // #612: CAPTURING intro under the bracket convention — group 1 is the
  // `[CODE.MM]` bracket id (undefined otherwise), group 2 the token, group 3 the
  // name. The bracket id is what the sentinel filter needs: READING-B puts the
  // sentinel milestone in the bracket, not in the token.
  // phase-id-owner: uses the [.-] (dot-or-dash) separator variant, not the canonical dot-only token; a swap to PHASE_NUMBER_TOKEN_SOURCE would drop hyphenated phase-id matches.
  // #3036: widen the id capture to accept non-numeric-leading ids (e.g. B7, P0.3-2)
  // that get-phase/execute-phase already resolve. An optional leading letter prefix
  // ([A-Za-z]?) covers letter-prefixed ids without breaking numeric-leading ones.
  // #4478: line-anchored (`^ {0,3}`, `/m`) — unanchored, `#{2,4}` matched a
  // `### Phase N:`-shaped mention ANYWHERE `exec()`'s scan reached: mid-sentence
  // prose, inside a blockquote, inside an inline code span (backtick-quoted on
  // the same line, not a fenced block `tokenizeHeadings` would exclude). Any
  // such line minted a phantom phase entry, inflating phase_count and able to
  // collide on a phase NUMBER with a real heading nearby. `{0,3}` leading
  // spaces mirrors `tokenizeHeadings`'s own CommonMark ATX-heading tolerance
  // (src/markdown-sectionizer.cts:453) so a legitimately-indented heading that
  // matched before this fix still matches after it.
  // phase-id-owner: uses the [.-] (dot-or-dash) separator variant, not the canonical dot-only token; a swap to PHASE_NUMBER_TOKEN_SOURCE would drop hyphenated phase-id matches.
  const phasePattern = new RegExp(`^ {0,3}#{2,4}\\s*${phaseHeadingPrefixSrcFor(PHASE_HEADING_BASELINE.ANY_BRACKET, convention, true)}(${directoryContext.phaseNaming === 'custom' && convention !== 'bracket' ? phaseIdMod.phaseScanTokenSource(directoryContext) : '[A-Za-z]?\\d+[A-Z]?(?:[.-]\\d+)*'})(?:\\s*\\([^)\\n]{0,200}\\))?\\s*:\\s*([^\\n]+)`, 'gim');
  // The capturing intro inserts the bracket id at group 1 only under the
  // bracket convention; the token and name shift by the same offset.
  const G = convention === 'bracket' ? 1 : 0;
  const phases: AnalyzePhase[] = [];
  let match: RegExpExecArray | null;
  // The caller needs the exact occurrence identities from the same scan that
  // built `phases`; returning them together also keeps fallback rescans atomic.
  const detailKeys = new Set<string>();
  let statusError: PhaseStatusError;
  while ((match = phasePattern.exec(content)) !== null) {
    const bracketId = G ? match[1] : undefined;
    const phaseNum = match[1 + G];
    if (isSentinelPhase(phaseNum, bracketId)) continue;
    detailKeys.add(occurrenceKey(phaseNum, bracketId));
    const phaseName = match[2 + G].replace(/\(INSERTED\)/i, '').trim();

    // Extract goal from the section
    const sectionStart = match.index;
    const restOfContent = content.slice(sectionStart);
    // #3691: `\d` → `\d[\d.]*` so decimal phase headings (e.g. `### Phase 02.3:`) are
    // recognised as section boundaries. #3036: `[A-Za-z]?\d` so non-numeric-leading ids
    // (e.g. B7) are also recognised.
    // #4478 follow-up (independent code review on this same fix): ` {0,3}` after
    // the literal `\n` mirrors phasePattern's own new leading-space tolerance
    // above -- without it, a legitimately-indented (1-3 space) NEXT phase
    // heading was invisible to this boundary lookup, letting the PRIOR phase's
    // goal/mode/depends_on extraction bleed across the section boundary into
    // the next phase's own body.
    const nextHeader = restOfContent.match(new RegExp(`\\n {0,3}#{2,4}\\s+${phaseHeadingPrefixSrcFor(PHASE_HEADING_BASELINE.ANY_BRACKET, convention)}[A-Za-z]?\\d[\\d.-]*`, 'i'));
    const sectionEnd = nextHeader ? sectionStart + nextHeader.index! : content.length;
    const section = content.slice(sectionStart, sectionEnd);

    const goal = roadmapParserModule.extractPhaseFieldMultiline(section, 'Goal');

    const modeMatch = section.match(/\*\*Mode(?::\*\*|\*\*:)\s*([^\n]+)/i);
    const mode = modeMatch ? modeMatch[1].trim().toLowerCase() : null;

    const dependsMatch = section.match(/\*\*Depends on(?::\*\*|\*\*:)\s*([^\n]+)/i);
    const depends_on = dependsMatch ? dependsMatch[1].trim() : null;

    // Check completion on disk
    const lookup = resolvePhaseDirectoryLookup(cwd, phaseNum, undefined, directoryContext);
    let diskStatus: string = DISK_STATUS.NO_DIRECTORY;
    let planCount = 0;
    let summaryCount = 0;
    let hasContext = false;
    let hasResearch = false;
    // #3885 (ADR-3473 §8.5): null unless dirMatch resolves and its readdirSync
    // hit a non-ENOENT error — no directory at all is `disk_status:
    // 'no_directory'`, a real (if uninteresting) answer, not a read error.
    let contextReadError: string | null = null;
    // #4014 (epic #3473 B4): additive sibling — SCOPE.COMPLETE by default
    // (no directory at all is a genuine, not-unreadable answer), overwritten
    // below only when dirMatch resolves.
    let contextScope: Scope = SCOPE.COMPLETE;

    // DEAD catch removed (#2245 audit): matchPhaseDirs(...) is a pure
    // array lookup on an already-resolved string array, and
    // countPhasePlansAndSummaries is itself fully defensive (its own
    // readdirSync is self-guarded, and it delegates to scanPhasePlans, which
    // never throws) — nothing in this block can throw, so the try/catch could
    // never be triggered.
    // #612: the DIRECTORY read is selected by the same `convention` the four
    // heading/checklist patterns above already thread. Left two-argument, this
    // one call reported EVERY canonical `{CODE}.{MM}-{PP}-slug` directory as
    // `disk_status: "no_directory"` with `plan_count`/`summary_count` 0 —
    // `extractPhaseToken('GSD.02-01-one')` with no convention returns the whole
    // dir name — while the same build resolved those same directories correctly
    // in three other places on the same repo (W006/W007 through their shared
    // directory matcher, `state json` via the milestone filter, and the W026
    // milestone-complete read through the same convention-aware owner). It
    // failed ONLY for the directory shape the convention exists to name: a
    // mid-migration bracket repo carrying legacy `01-one` dirs resolved fine.
    // That is verbatim the asymmetry the note above the W026 rule says this PR
    // closed — the directory read widens with the heading read, or every bracket
    // phase resolves to nothing.
    // The locator adapter applies the canonical bracket spelling first and the
    // migration-window legacy spelling only when the canonical pass misses.
    const dirMatch = matchPhaseDirsForLookup(phaseDirNames, lookup, undefined, directoryContext).matches[0];

    if (dirMatch) {
      const counts = countPhasePlansAndSummaries(path.join(phasesDir, dirMatch), convention);
      planCount = counts.planCount;
      summaryCount = counts.summaryCount;
      hasContext = counts.hasContext;
      hasResearch = counts.hasResearch;
      contextReadError = counts.contextReadError;
      contextScope = counts.scope;

      // #5060: route the disk-status ladder through the Phase Status Module's
      // single owner (`phaseStatus`/`toDiskStatus`) rather than a local
      // if/else re-derivation. `convention` still threads through so a
      // bracket phase's verification report resolves and scopes like its
      // legacy twin (#612).
      const ps = phaseStatus(path.join(phasesDir, dirMatch), { convention });
      statusError = firstStatusError(statusError, ps.value.statusError);
      diskStatus = toDiskStatus(ps.value.status, { hasResearch, hasContext });
    }

    // Check ROADMAP checkbox status. #4965: line-anchored, label-first — the
    // old fragment allowed `\s*.*` between the checkbox and the label, which
    // let "Phase N" match ANYWHERE in any checklist line's free-form
    // description (not just this phase's own line), and `content.match`
    // returns only the first hit in the document — so an earlier, unrelated
    // line whose prose merely mentioned "Phase N" shadowed that phase's own
    // checkbox state (both a false negative and a false positive were
    // reported against real ROADMAPs). The label must now be the first thing
    // after the checkbox, tolerating only an optional `**` bold marker and
    // horizontal whitespace — matching `cmdRoadmapAnalyze`'s own
    // `checklistPattern` (the missing-detail-section scan a bit further down
    // in this file), which already hard-requires `\*\*` immediately after the
    // checkbox for the same reason. A decoration the old `.*` used to tolerate
    // by accident — a blockquoted bullet, an emoji/badge before the label —
    // now resolves to `roadmap_complete: false` instead of matching; this is
    // the deliberate, precedent-consistent narrowing (see 10-diagnosis.md's
    // "Negative space" note), not a new gap.
    //
    // ADR-3180 §7.4 (disk-strict, #2957, maintainer decision 2026-08-08):
    // `roadmapComplete` is reported below as metadata ONLY — it carries NO
    // machine authority over `diskStatus`. The override that used to trust a
    // ticked checkbox over disk file structure is DELETED, not generalized
    // (#2957: "a ticked ROADMAP checkbox is a human annotation with no
    // machine authority"). A phase marked complete solely by a ticked
    // checkbox — no passing `*-VERIFICATION.md`, plans outstanding — now
    // reports incomplete; this is the deliberate Tier-2 break (ADR-3180 §7.4
    // Decision 3).
    const checkboxPattern = phaseEntryRegExp(`${phaseHeadingPrefixSrcFor(PHASE_HEADING_BASELINE.LABEL_ONLY, convention)}${phaseMarkdownRegexSource(phaseNum, directoryContext)}${OPTIONAL_PHASE_TAG_SOURCE}[:\\s]`, 'im', { state: 'captured' });
    const checkboxMatch = content.match(checkboxPattern);
    const roadmapComplete = checkboxMatch ? isBoxCharChecked(checkboxMatch[1]) : false;

    const headingPhase: AnalyzePhase = {
      number: phaseNum,
      name: phaseName,
      goal,
      mode,
      depends_on,
      plan_count: planCount,
      summary_count: summaryCount,
      has_context: hasContext,
      has_research: hasResearch,
      disk_status: diskStatus,
      roadmap_complete: roadmapComplete,
      context_read_error: contextReadError,
      context_scope: contextScope,
    };
    if (checkboxMatch) PHASES_WITH_CHECKBOX.add(headingPhase);
    phases.push(headingPhase);
  }

  // #3577: markdown-table row declarations join the enumeration — same
  // enrichment contract as headings (disk counts when the directory exists),
  // zero-pad-tolerant duplicate guard so an id declared in BOTH a heading and
  // a table counts once.
  const stripPadA = (s: string) => s.replace(/^0+(?=.)/, '');
  const seen = new Set(phases.map((ph) => stripPadA(ph.number)));
  for (const tr of collectTablePhaseRows(content)) {
    // #3577 table declarations were part of the pre-existing detail set.
    // Preserve that behavior while heading occurrences gain bracket identity.
    detailKeys.add(occurrenceKey(tr.id));
    if (seen.has(stripPadA(tr.id))) continue;
    const tableLookup = resolvePhaseDirectoryLookup(cwd, tr.id, undefined, directoryContext);
    const dirMatchA = matchPhaseDirsForLookup(phaseDirNames, tableLookup, undefined, directoryContext).matches[0];
    let tPlanCount = 0;
    let tSummaryCount = 0;
    let tHasContext = false;
    let tHasResearch = false;
    let tContextReadError: string | null = null;
    // #4014 (epic #3473 B4): additive sibling, same default rule as the
    // heading-declared branch above.
    let tContextScope: Scope = SCOPE.COMPLETE;
    let tDiskStatus: string = DISK_STATUS.NO_DIRECTORY;
    if (dirMatchA) {
      const counts = countPhasePlansAndSummaries(path.join(phasesDir, dirMatchA), convention);
      tPlanCount = counts.planCount;
      tSummaryCount = counts.summaryCount;
      tHasContext = fs.existsSync(path.join(phasesDir, dirMatchA, 'CONTEXT.md'));
      tHasResearch = fs.existsSync(path.join(phasesDir, dirMatchA, 'RESEARCH.md'));
      // #3885 (ADR-3473 §8.5): reuse the SAME countPhasePlansAndSummaries call's
      // discriminator — this row's hasContext/hasResearch are read via a direct
      // existsSync (which cannot itself distinguish EACCES from absent), but
      // an unreadable phase directory is still surfaced via the sibling call.
      tContextReadError = counts.contextReadError;
      tContextScope = counts.scope;
      // #5060: route through the Phase Status Module's owner rather than the
      // fixed 'ok' sentinel this row used to emit.
      const tps = phaseStatus(path.join(phasesDir, dirMatchA), { convention });
      statusError = firstStatusError(statusError, tps.value.statusError);
      tDiskStatus = toDiskStatus(tps.value.status, { hasResearch: tHasResearch, hasContext: tHasContext });
    }
    phases.push({
      number: tr.id,
      name: tr.name ?? `Phase ${tr.id}`,
      goal: null,
      mode: null,
      depends_on: null,
      plan_count: tPlanCount,
      summary_count: tSummaryCount,
      has_context: tHasContext,
      has_research: tHasResearch,
      disk_status: tDiskStatus,
      roadmap_complete: false,
      context_read_error: tContextReadError,
      context_scope: tContextScope,
    });
  }
  return { phases, detailKeys, statusError };
}

function cmdRoadmapAnalyze(cwd: string, raw: boolean): void {
  const roadmapPath = planningPaths(cwd).roadmap;

  if (!fs.existsSync(roadmapPath)) {
    output({ error: 'ROADMAP.md not found', milestones: [], phases: [], current_phase: null }, raw, undefined);
    return;
  }

  const rawContent = fs.readFileSync(roadmapPath, 'utf-8');
  // #3184/#3165: use the scoped variant so a truncated window is a
  // distinguishable signal in the output instead of a silent `phase_count: 0`
  // indistinguishable from a genuinely empty milestone.
  const { value: content, scope } = extractCurrentMilestoneScoped(rawContent, cwd);
  const phasesDir = planningPaths(cwd).phases;
  // #612: resolve once per command and thread the same reading through both
  // the scoped scan and any fallback scan.
  const directoryContext = phaseDirectoryOptions(cwd, undefined, rawContent);
  const convention = resolvePhaseIdConvention(cwd);
  const G = convention === 'bracket' ? 1 : 0;

  // Build phase directory lookup once (O(1) readdir instead of O(N) per phase)
  // #3185 exemption reason (ADR-3180 Decision 4a): this is a heading->directory
  // LOOKUP INDEX, not a milestone enumeration. It must see the PHYSICAL set so
  // a heading already scoped by extractCurrentMilestoneScoped above can find
  // its directory; filtering it through listMilestonePhaseDirs would scope
  // the same set twice. #3882 (ADR-3473 §8.2): routed through the named
  // "physical set, sentinels included" axis instead of a hand-rolled
  // readdirSync — every heading matched below already excludes sentinel
  // phase numbers via isSentinelPhaseId before it ever consults this list
  // (collectAnalyzePhases), so a sentinel directory's presence here is
  // output-invariant; this only removes the re-derivation, not the reason.
  const _phaseDirNames = listAllPhaseDirs(phasesDir, { includeSentinels: true }).value;

  // Scan the scoped milestone window for phase-detail headings and enrich each
  // with its on-disk status. Extracted into `collectAnalyzePhases` (#3165) so
  // the SAME enrichment re-runs on the fallback below — not a second copy.
  let collected = collectAnalyzePhases(cwd, content, phasesDir, _phaseDirNames, convention, directoryContext);
  let phases = collected.phases;
  let detailKeys = collected.detailKeys;
  // #5118: carried from every phaseStatus read this command makes.
  let statusError: PhaseStatusError = collected.statusError;
  // `effectiveContent` is what the downstream checklist scan (missing_details)
  // iterates. Defaults to the scoped window; switched to the fallback document
  // when the recovery path below fires, so a phase found via fallback is not
  // falsely reported as "in checklist but missing a detail section."
  let effectiveContent = content;

  // #3165: recover phase_count when the scoped window came back empty. A
  // CLOSED milestone heading sitting between the active milestone heading and
  // its own phase-detail sections closes `extractCurrentMilestoneScoped`'s
  // window over prose only — `phases` is empty, and the consuming resume gate
  // (`workflows/next.md` Route 0) iterates `.phases[]` so a safety invariant
  // silently never runs. When the window is suspect (non-COMPLETE scope), the
  // scoped scan found nothing, AND phase directories exist on disk (real
  // evidence phases exist), re-scan the shipped-milestone-stripped document so
  // the phase list reflects the real phases instead of a silent zero. The
  // `scope` field retains its non-COMPLETE value downstream so consumers can
  // still tell this is a best-effort count, not a cleanly scoped one. Position
  // alone cannot attribute phases to the active vs the intervening closed
  // milestone, so this never claims COMPLETE — it converts silence into a
  // populated, flagged result.
  if (phases.length === 0 && scope !== SCOPE.COMPLETE && _phaseDirNames.length > 0) {
    const fallbackContent = stripShippedMilestones(rawContent);
    const fallbackCollection = collectAnalyzePhases(cwd, fallbackContent, phasesDir, _phaseDirNames, convention, directoryContext);
    if (fallbackCollection.phases.length > 0) {
      collected = fallbackCollection;
      phases = collected.phases;
      detailKeys = collected.detailKeys;
      statusError = firstStatusError(statusError, collected.statusError);
      effectiveContent = fallbackContent;
    }
  }

  // Extract milestone info. #3216: routed through the canonical
  // `listMilestoneHeadings` owner (deleted the inline `##…` regex, which
  // truncated names at a parenthetical and had no phase-heading exclusion)
  // rather than re-deriving the enumeration here.
  const milestones: Array<{ heading: string; version: string }> = listMilestoneHeadings(content).map((m) => ({
    heading: m.heading,
    version: m.version,
  }));

  // Find current and next phase
  const currentPhase = phases.find(p => p.disk_status === DISK_STATUS.PLANNED || p.disk_status === DISK_STATUS.PARTIAL || p.disk_status === DISK_STATUS.EXECUTED) || null;
  const nextPhase = phases.find(p => p.disk_status === DISK_STATUS.EMPTY || p.disk_status === DISK_STATUS.NO_DIRECTORY || p.disk_status === DISK_STATUS.DISCUSSED || p.disk_status === DISK_STATUS.RESEARCHED) || null;

  // Aggregated stats
  const totalPlans = phases.reduce((sum, p) => sum + p.plan_count, 0);
  const totalSummaries = phases.reduce((sum, p) => sum + p.summary_count, 0);
  const completedPhases = phases.filter(p => p.disk_status === DISK_STATUS.COMPLETE).length;

  // Detect phases in summary list without detail sections (malformed ROADMAP).
  // The char class must allow `-` (not just `.`) so dash-separated milestone-prefixed
  // IDs (e.g. `1-01`) match the detail-heading scanner above; otherwise they truncate
  // at the dash (`1-01` -> `1`) and every such phase reports a phantom missing detail.
  // #612: CAPTURING label-only intro — the bracket id rides along so the
  // sentinel filter below is not blind to `- [ ] **[GSD.999] 01: Icebox**`.
  // phase-id-owner: uses the [.-] (dot-or-dash) separator variant, not the canonical dot-only token; a swap to PHASE_NUMBER_TOKEN_SOURCE would drop hyphenated phase-id matches.
  // #3036: widen to accept non-numeric-leading ids (same widening as the detail-heading pattern above).
  // phase-id-owner: uses the [.-] (dot-or-dash) separator variant, not the canonical dot-only token; a swap to PHASE_NUMBER_TOKEN_SOURCE would drop hyphenated phase-id matches.
  const customIds = directoryContext.phaseNaming === 'custom' && convention !== 'bracket';
  const checklistPattern = new RegExp(checklistEntrySrc(convention, true, customIds), 'gim');
  // #2761 M1: an OCCURRENCE list keyed by `occurrenceKey`, not a token->bracket
  // map. The map was first-wins on the bare token, so of two checklist entries
  // sharing a token across brackets the FIRST one's bracket id classified BOTH:
  // `- [ ] **[GSD.999] 01: Icebox**` written above `- [ ] **[GSD.02] 01: …**`
  // made the real phase inherit the icebox's sentinel verdict and vanish from
  // `missing_phase_details`; written below it, the same document reported it.
  // Dedupe still happens — it is now per PHASE rather than per token, which is
  // what makes the classification order-independent.
  const checklistOccurrences: Array<{ token: string; bracketId?: string; checked: boolean }> = [];
  const seenChecklistKeys = new Set<string>();
  let checklistMatch: RegExpExecArray | null;
  while ((checklistMatch = checklistPattern.exec(effectiveContent)) !== null) {
    const token = checklistMatch[1 + G];
    const bracketId = G ? checklistMatch[1] : undefined;
    const key = occurrenceKey(token, bracketId);
    if (seenChecklistKeys.has(key)) continue;
    seenChecklistKeys.add(key);
    // #4899: the checkbox state (`[x]` vs `[ ]`) isn't a capturing group in
    // `checklistPattern` — adding one would shift every downstream `1 + G` /
    // `G` index this loop and `missingDetails` below already depend on.
    // Reading it off the full match text instead is index-safe.
    checklistOccurrences.push({ token, bracketId, checked: isPhaseEntryChecked(checklistMatch[0]) });
  }

  // #4899: `collectAnalyzePhases` only recognises `### Phase N:` headings and
  // progress-table rows — the shape `templates/roadmap.md` itself emits
  // (checklist entries only, no detail sections yet) produces `phases: []`
  // even though `checklistOccurrences` above just proved real phases exist.
  // That evidence was computed and then discarded on the way to the final
  // `phases: []` output (ADR-4910 §5/Phase 4). When the heading/table scan
  // found nothing but the checklist did, synthesize a minimal `AnalyzePhase`
  // per non-sentinel checklist occurrence — same enrichment calls
  // (`matchPhaseDirs`, `countPhasePlansAndSummaries`, `isPhaseComplete`) the
  // heading branch of `collectAnalyzePhases` already uses, so a synthesized
  // phase's on-disk status is derived identically, not approximated.
  //
  // `missing_phase_details` is intentionally left untouched by this branch:
  // its contract is "this checklist token has no `### Phase N:` heading or
  // progress-table row", and that remains true for every synthesized token —
  // synthesis fills in `phases[]` from the checklist itself, it does not
  // manufacture a detail section. Removing these tokens from
  // `missing_phase_details` would hide the very malformed-ROADMAP signal
  // ADR-4910 (#4899) treats as evidence to surface, not evidence to launder.
  //
  // Gated on `!hasPhaseListingTableHeader(effectiveContent)` (found by the
  // pre-existing #4480 regression "a status table cannot hide missing phase
  // details"): a `| Phase | Status |`-shaped table with no Name column
  // correctly declares no phases via `collectAnalyzePhases`, but its mere
  // presence signals this roadmap has already moved to table-based tracking —
  // synthesizing phantom phases from checklist entries alongside a
  // deliberately thin tracking table would manufacture phase_count where the
  // roadmap's own structure says "not yet detailed", the same laundering this
  // branch exists to avoid for `missing_phase_details`. #4899's actual target
  // shape (`templates/roadmap.md`: checklist only, no Progress section at
  // all) has no such table and is unaffected.
  if (phases.length === 0 && checklistOccurrences.length > 0 && !hasPhaseListingTableHeader(effectiveContent)) {
    for (const occ of checklistOccurrences) {
      if (isSentinelPhase(occ.token, occ.bracketId)) continue;
      const checklistLookup = resolvePhaseDirectoryLookup(cwd, occ.token, undefined, directoryContext);
      const dirMatch = matchPhaseDirsForLookup(_phaseDirNames, checklistLookup, undefined, directoryContext).matches[0];
      let diskStatus = 'no_directory';
      let planCount = 0;
      let summaryCount = 0;
      let hasContext = false;
      let hasResearch = false;
      let contextReadError: string | null = null;
      let contextScope: Scope = SCOPE.COMPLETE;
      if (dirMatch) {
        const counts = countPhasePlansAndSummaries(path.join(phasesDir, dirMatch), convention);
        planCount = counts.planCount;
        summaryCount = counts.summaryCount;
        hasContext = counts.hasContext;
        hasResearch = counts.hasResearch;
        contextReadError = counts.contextReadError;
        contextScope = counts.scope;
        // #5060: same owner call as the heading branch above.
        const ps = phaseStatus(path.join(phasesDir, dirMatch), { convention });
        statusError = firstStatusError(statusError, ps.value.statusError);
        diskStatus = toDiskStatus(ps.value.status, { hasResearch, hasContext });
      }
      const synthesized: AnalyzePhase = {
        number: occ.token,
        name: `Phase ${occ.token}`,
        goal: null,
        mode: null,
        depends_on: null,
        plan_count: planCount,
        summary_count: summaryCount,
        has_context: hasContext,
        has_research: hasResearch,
        disk_status: diskStatus,
        roadmap_complete: occ.checked,
        context_read_error: contextReadError,
        context_scope: contextScope,
      };
      PHASES_WITH_CHECKBOX.add(synthesized);
      phases.push(synthesized);
    }
  }
  // The EMITTED value stays the bare token, unchanged: `phases[].number` is a
  // token under every convention, and `missing_phase_details` is read against
  // it. Only the classification moved to the qualified key — so two different
  // brackets' `01` both missing report `01` once, rather than one of them
  // silently covering for the other.
  const missingDetails = [...new Set(
    checklistOccurrences
      .filter(o => !detailKeys.has(occurrenceKey(o.token, o.bracketId))
        && !isSentinelPhase(o.token, o.bracketId))
      .map(o => o.token),
  )];

  // #3217 (ADR-3180 §7.6 rules 3-4): `progress_percent` used to accumulate
  // `totalPlans`/`totalSummaries` above — a heading-matched enumeration
  // (`phasePattern` over the milestone-windowed `content`) paired against
  // `_phaseDirNames`, a DELIBERATELY unscoped physical directory listing
  // (see its own comment above: it is a heading->directory lookup index,
  // not a milestone enumeration). That set is not the same set
  // `listMilestonePhaseDirs` scopes for `query progress` / `stats` (#3185
  // Phase 3), so `progress_percent` could silently diverge from both siblings
  // on the same project (rule 3). Route `progress_percent`'s own
  // numerator/denominator through the single scoped owner instead — mirrors
  // cmdProgressRender/cmdStats's own aggregation — and withhold the
  // percentage entirely when THAT scope is not COMPLETE (rule 4), never
  // returning `0` for "could not compute". This does not touch `total_plans`
  // / `total_summaries` / `phases` / `completed_phases` above — those stay
  // the heading-matched detail view; only `progress_percent`'s own inputs
  // move onto the scoped owner.
  let scopedTotalPlans = 0;
  let scopedTotalSummaries = 0;
  let progressScope: Scope = SCOPE.UNREADABLE;
  try {
    const { value: progressDirs, scope: scopedResult } = listMilestonePhaseDirs(phasesDir, { cwd });
    progressScope = scopedResult;
    for (const dir of progressDirs) {
      const scan = scanPhasePlans(path.join(phasesDir, dir));
      scopedTotalPlans += scan.planCount;
      scopedTotalSummaries += scan.summaryCount;
    }
  } catch { /* progressScope stays the pessimistic SCOPE.UNREADABLE default */ }
  const progressPercent = progressScope === SCOPE.COMPLETE
    ? clampPercent(scopedTotalSummaries, scopedTotalPlans)
    : null;

  // #4757: `current_phase` / `next_phase` / `completed_phases` are disk-
  // authoritative (ADR-3180 §7.4, #2957 — a ticked ROADMAP checkbox carries no
  // machine authority), so a phase whose checkbox disagrees with its disk
  // status can be handed back as the phase to work on while the operator has
  // already ticked it (a backfilled phase with a SUMMARY and no PLAN reads
  // `empty`; an all-summarized phase with no VERIFICATION reads `executed`), or
  // withheld from `completed_phases` while ticked-complete. The selectors stay
  // disk-authoritative; the disagreement is SURFACED here rather than silently
  // resolved either way. Computed after the heading/table/checklist phase
  // enumeration is final so synthesized phases are covered too. Only phases
  // that HAVE a checkbox can conflict: a progress-table row or a heading with
  // no checklist entry reports `roadmap_complete: false` because there is no
  // checkbox to read, not because one is unticked.
  const checkboxConflict = phases
    .filter(p => PHASES_WITH_CHECKBOX.has(p)
      && p.roadmap_complete !== (p.disk_status === DISK_STATUS.COMPLETE))
    .map(p => ({
      number: p.number,
      roadmap_complete: p.roadmap_complete,
      disk_status: p.disk_status,
      plan_count: p.plan_count,
      summary_count: p.summary_count,
    }));

  // #5221: ship's completeness gate. Phase number (zero-padding folded per segment, as ship.md's `n`)
  // -> true only when EVERY record of it reads complete: each checklist entry (any bracket — a shared
  // token fails closed) and the phase-table Status cell. Absent = no record. The table is read from the
  // exact slice `update-plan-progress` writes (editProgressTableSlice), so reader and writer agree.
  const roadmapRecord: Record<string, boolean> = {};
  const fold = (token: string, done: boolean): void => {
    const k = foldPhaseId(token);
    roadmapRecord[k] = (roadmapRecord[k] ?? true) && done;
  };
  for (const o of checklistOccurrences) if (!isSentinelPhase(o.token, o.bracketId)) fold(o.token, o.checked);
  // phase_naming: custom ids (`- [ ] **Phase AUTH: …**`, as phase add writes them) are records too.
  const isCustomId = (t: string): boolean => customIds && !/^[A-Za-z]?\d/.test(t);
  if (customIds) {
    for (const m of effectiveContent.matchAll(new RegExp(checklistEntrySrc(convention, false, true), 'gim'))) {
      if (isCustomId(m[1])) fold(m[1], isPhaseEntryChecked(m[0]));
    }
  }
  // A phase table that does not parse (e.g. a ragged row) makes the record unknown: null, so ship stops.
  let tableUnreadable = false;
  const archivedForRecord = roadmapParserModule.maskArchivedDetails(rawContent, cwd);
  editProgressTableSlice(archivedForRecord.visible, (scoped) => {
    // Same table the writer picks (findPhaseTableHeader); a slice without a Plans column keeps the whole-slice Phase + Status scan.
    const planned = findPhaseTableHeader(scoped);
    const header = planned !== -1 ? planned : scoped.search(/^[ \t]*(?=.*\|[ \t]*Phase[ \t]*\|)(?=.*\|[ \t]*Status[ \t]*\|)\|.*$/m);
    if (header === -1) return scoped;
    const table = parseMarkdownTable(scoped.slice(header));
    // A phase table whose Phase/Status headers are not recognised (other case or wording) is unknown: null, so ship stops.
    if (!table.ok || !table.value.columns.includes('Phase') || !table.value.columns.includes('Status')) { tableUnreadable = true; return scoped; }
    const wantMilestone = table.value.columns.includes('Milestone')
      ? normalizeMilestoneToken(roadmapParserModule.getMilestoneInfo(cwd).value?.version)
      : null;
    for (const r of table.value.rows) {
      if (wantMilestone !== null && (wantMilestone === '' || normalizeMilestoneToken(r['Milestone']) !== wantMilestone)) continue;
      const cell = (r['Phase'] ?? '').trim();
      const token = cell.match(/^[A-Za-z]?\d\S*?(?=\.?(?:\s|$))/)?.[0] ?? cell.match(new RegExp(`^${CUSTOM_PHASE_ID_SRC}?(?=\\.?(?:\\s|$))`))?.[0];
      if (token && (/^[A-Za-z]?\d/.test(token) ? !isSentinelPhase(token) : isCustomId(token))) fold(token, parseRoadmapStatusCell(r['Status']) === WIRE_STATUS.COMPLETE);
    }
    return scoped;
  }, archivedForRecord.activeRange);

  const result = {
    milestones,
    phases,
    phase_count: phases.length,
    completed_phases: completedPhases,
    total_plans: totalPlans,
    total_summaries: totalSummaries,
    progress_percent: progressPercent,
    // #3217 finding 2: `progress_percent` is gated by a SECOND, independently
    // computed `listMilestonePhaseDirs` scope (`progressScope` above) — not
    // by the top-level `scope` field, which describes the heading-windowing
    // identity `phases`/`total_plans`/`total_summaries`/`completed_phases`
    // were built from. Those two scopes can legitimately disagree (e.g.
    // `scope: "complete"` alongside a genuinely unreadable phases directory),
    // and per the documented contract "scope tells you whether the counts
    // are trustworthy", a consumer seeing `progress_percent: null` needs a
    // field to tell WHY without reading source. Exposing `progress_scope`
    // (rather than reconciling the two scopes into one, or re-deriving
    // `total_plans`/`phases`/etc. from the scoped set) preserves the
    // deliberate, already-documented choice a few lines up: `phases`/
    // `total_plans`/`total_summaries`/`completed_phases` stay the
    // heading-matched detail view (`_phaseDirNames` is a lookup index, not a
    // milestone enumeration — see its comment); only `progress_percent`'s own
    // inputs move onto the scoped owner.
    progress_scope: progressScope,
    current_phase: currentPhase ? currentPhase.number : null,
    next_phase: nextPhase ? nextPhase.number : null,
    // #4757: phases whose ROADMAP checkbox disagrees with `disk_status`
    // (`roadmap_complete` vs `disk_status === "complete"`); always an array.
    checkbox_conflict: checkboxConflict,
    roadmap_record: tableUnreadable ? null : roadmapRecord,
    missing_phase_details: missingDetails.length > 0 ? missingDetails : null,
    // #3184/#3165: distinguishes a genuinely empty milestone (`scope:
    // "complete"`, `phase_count: 0`) from a window that could not be fully
    // resolved (`"truncated"` / `"unscoped"` / `"unreadable"`) — those cases
    // were previously output-identical.
    scope,
  };

  // #5118: a read-only aggregate over a refused report prints nothing and
  // fails with the error's own reason.
  if (statusError) failOnVerificationStatusError(statusError);
  output(result, raw, undefined);
}

// ─── cmdRoadmapMilestoneScope ────────────────────────────────────────────────

/**
 * #3262 (write-time milestone-scope guard): read-only probe emitting the
 * current milestone window's IDENTITY — its scope classification and the
 * phase ids it declares — so the edit-phase workflow can capture it before
 * its in-place section write, re-derive it after, and roll back on any
 * change. This is the milestone-scope sibling of the workflow's existing
 * `depends_on` gate, expressed as a command because the workflow's write is
 * assistant-driven free-text surgery, not a code path.
 *
 * Deliberately NOT `cmdRoadmapAnalyze`: analyze's #3165 recovery re-populates
 * `phases` from the shipped-milestone-stripped document when the scoped
 * window is suspect, which is right for a human-facing progress report and
 * wrong for a before/after equality probe — the refill would mask exactly
 * the narrowing this guard exists to detect. This probe reports the RAW
 * window (`extractCurrentMilestoneScoped` + `scanMilestonePhaseIds`), no
 * fallback, so a narrowed window is always visible as a changed phase set.
 */
function cmdRoadmapMilestoneScope(cwd: string, raw: boolean): void {
  const roadmapPath = planningPaths(cwd).roadmap;

  if (!fs.existsSync(roadmapPath)) {
    output({ error: 'ROADMAP.md not found', scope: SCOPE.UNREADABLE, phases: [], phase_count: 0 }, raw, undefined);
    return;
  }

  const rawContent = fs.readFileSync(roadmapPath, 'utf-8');
  // #3641: resolve phase_id_convention and thread it into the scope axis, so
  // this probe and `roadmap validate`'s V005 answer the SAME question the
  // SAME way for a bracket-convention project — a window the classifier
  // calls TRUNCATED in validate must never read COMPLETE here (the #3262
  // capture/compare guard consumes this scope). Resolution mirrors the
  // validate router's: .planning/config.json first, ROADMAP.md frontmatter
  // as fallback.
  let phaseIdConvention: string | undefined | null;
  try {
    const cfg = loadConfigForScope(cwd);
    phaseIdConvention = cfg['phase_id_convention'] as string | undefined | null;
  } catch {
    phaseIdConvention = undefined;
  }
  if (phaseIdConvention === undefined || phaseIdConvention === null) {
    // The block is the one the one fence owner finds (`frontmatterRegion`), the same one
    // `roadmap validate` reads, so the two cannot disagree on where it ends (#3641 NEW-1).
    const found = frontmatterRegion(rawContent);
    if (found?.terminated) {
      const kvMatch = found.region.match(/^phase_id_convention:\s*(.*)$/m);
      if (kvMatch) {
        const val = kvMatch[1].trim();
        if (val !== 'null' && val !== '') {
          phaseIdConvention = val.replace(/^["']|["']$/g, '');
        }
      }
    }
  }
  const { value: window, scope } = extractCurrentMilestoneScoped(rawContent, cwd, undefined, phaseIdConvention);
  // Document order (Set insertion order) — deterministic for a given document.
  const phases = [...scanMilestonePhaseIds(window, phaseIdConvention)];
  output({ scope, phases, phase_count: phases.length }, raw, undefined);
}

// ─── cmdRoadmapUpdatePlanProgress ─────────────────────────────────────────────

/** #5221: phase-id fold (leading zeros stripped per segment) keying roadmap_record; ship.md's jq `def n` folds identically (pinned by a test). */
function foldPhaseId(token: string): string {
  return token.split('.').map((s) => s.replace(/^0+(?=\d)/, '')).join('.');
}

/** #5221: whether offset `idx` of `text` sits inside a bare <details> block (an open-attribute wrapper is the active milestone, not shipped) that has not closed. */
function insideOpenDetails(text: string, idx: number): boolean {
  const prior = text.slice(0, idx).toLowerCase();
  return prior.lastIndexOf('<details>') > prior.lastIndexOf('</details>');
}

/** #5221: a `phase_naming: custom` id (`Phase AUTH:`). */
const CUSTOM_PHASE_ID_SRC = '[A-Za-z][\\w-]{0,63}';

/**
 * #5221: source of a `- [ ] **Phase N:` checklist entry, the one shape `roadmap analyze` reads and
 * phase add/insert anchor on. Token is the last group; `custom` also admits a custom id before `:`.
 */
function checklistEntrySrc(convention: string | null | undefined, capturing = false, custom = false): string {
  // phase-id-owner: uses [.-] (dot-or-dash) separator variant, not the canonical dot-only token; swapping to PHASE_NUMBER_TOKEN_SOURCE would drop hyphenated phase-id matches.
  const numeric = '[A-Za-z]?\\d+[A-Z]?(?:[.-]\\d+)*';
  // numeric must end at a word edge, else `P1-setup` matches as `P1` before the custom alternative is tried.
  const token = custom ? `(?:${numeric}(?![\\w-])|${CUSTOM_PHASE_ID_SRC}(?=:))` : numeric;
  return `${phaseEntryPrefixSrc({ bold: 'required' })}${phaseHeadingPrefixSrcFor(PHASE_HEADING_BASELINE.LABEL_ONLY, convention, capturing)}(${token})`;
}

/**
 * #5221: offset of the phase table's header row — the first table row whose cells
 * name `Phase` and `Plans Complete` (or `Plans`), compared case-insensitively. The one
 * predicate `editFromPhaseTable` (writer) and `roadmap analyze`'s `roadmap_record` (reader)
 * both pick the table by, so they never disagree on which table is the phase table. -1: none.
 */
function findPhaseTableHeader(text: string): number {
  for (const m of text.matchAll(/^[ \t]*\|.*$/gm)) {
    const cells = m[0].split('|').map((c) => c.trim().toLowerCase());
    if (cells.includes('phase') && (cells.includes('plans complete') || cells.includes('plans'))) return m.index;
  }
  return -1;
}

function editFromPhaseTable(scoped: string, edit: (scoped: string) => string): string {
  // #5221: Status/Completed bind to the first table carrying that column; start
  // at the phase table so an earlier versions table is never the target. A Progress
  // slice with no Plans column at all keeps the whole-slice scan.
  const at = Math.max(findPhaseTableHeader(scoped), 0);
  return scoped.slice(0, at) + edit(scoped.slice(at));
}

/**
 * Scope a ROADMAP.md content string down to its "Progress table" writable
 * slice, run `edit` against just that slice, then splice the result back into
 * the original content (ADR-2143 §7). Layered scoping:
 *   1. Milestone scope — the caller has already hidden archived `<details>`
 *      blocks (`maskArchivedDetails`, #5553), so a same-numbered phase row in
 *      an archived milestone is never seen here.
 *   2. Heading scope — within the visible text, the `## Progress` heading
 *      section (up to the next `#`/`##` heading) when present, else the whole
 *      milestone slice (mirrors phase-lifecycle.cjs's `deriveProgressFromRoadmap`
 *      read-side scoping, #2012 decoy avoidance — a differently-headed table
 *      sharing the same column names must not be picked up instead).
 * `edit` always returns a string and never fails — a no-op edit (table/row not
 * found within the scoped slice) simply returns its input unchanged, mirroring
 * the prior regex `.replace()`'s no-match-is-a-no-op semantics.
 */
function editProgressTableSlice(content: string, edit: (scoped: string) => string, active: { start: number; end: number } | null = null): string {
  // #5762: the Progress section is the owner's (`editRoadmapProgress`, the write side of the
  // rule every reader uses; the first one inside the active milestone's range wins, #5553).
  // A headingless document is edited whole, from the phase table's header.
  return editRoadmapProgress(content, (scoped) => editFromPhaseTable(scoped, edit), { active });
}

function cmdRoadmapUpdatePlanProgress(cwd: string, phaseNum: string | null | undefined, raw: boolean): void {
  if (!phaseNum) {
    error('phase number required for roadmap update-plan-progress');
  }

  const roadmapPath = planningPaths(cwd).roadmap;

  const directoryContext = phaseDirectoryOptions(cwd);
  const phaseInfo = findPhaseInternal(cwd, phaseNum, undefined, directoryContext);
  if (!phaseInfo) {
    error(`Phase ${phaseNum} not found`);
  }

  const phaseDir = path.join(cwd, phaseInfo!.directory);
  // #5060: ONE count source for this verb — `scanPhasePlans` (the ADR-3180
  // §7.5 count owner) — rather than `phaseInfo.plans.length` /
  // `countMatchedSummaries(phaseInfo.plans, phaseInfo.summaries)`. The two
  // diverge when a plan's frontmatter declares `status: superseded`:
  // scanPhasePlans excludes it (and its summary) from both counts (#2349),
  // the phaseInfo-based counts do not. Using scanPhasePlans everywhere in
  // this verb — the `planCount === 0` decline, the `Plans Complete` cell,
  // the `Plans:` line, the checkbox gate, and the JSON output — keeps every
  // one of those in agreement with the Status-cell ladder below, which
  // already read scanPhasePlans's counts.
  const coverageScan = scanPhasePlans(phaseDir);
  const planCount = coverageScan.planCount;
  const summaryCount = coverageScan.summaryCount;

  if (planCount === 0) {
    declineNoOp(
      raw,
      'updated',
      'No plans found',
      'roadmap update-plan-progress skipped — no plans found for this phase. ROADMAP.md was left unchanged.',
      { plan_count: 0, summary_count: 0 },
    );
    return;
  }

  // Verification gate (#2022): do NOT check the phase checkbox or stamp a
  // completion date until the phase's verification status is 'passed', matching
  // cmdPhaseComplete's gate (phase.cts:1436). Previously the checkbox fired the
  // moment the last plan summary landed — before gsd-verifier had verified.
  //
  // ADR-3180 §7.4 (issue #3186, disk-strict): routed through the canonical
  // owner (`isPhaseComplete`) instead of hand-rolling `summaryCount >=
  // planCount && verificationPassed` locally — the owner calls
  // readVerificationStatus UNCONDITIONALLY, so `isComplete` here always
  // agrees with `roadmap analyze` / `init manager` / `phase complete` for
  // the same phase (ADR-3180 §7.4's headline: one predicate for the read
  // path and the write path).
  // ADR-3180 §7.4 read/write-path symmetry with the threaded site at ~583:
  // thread convention here too, so this write path's completion reading
  // agrees with the read path's under the bracket convention.
  const convention = resolvePhaseIdConvention(cwd);
  const completionResult = isPhaseComplete(phaseDir, { convention });
  // #5118: no write before the error — a report whose `status` is outside the
  // closed set fails this writer before ROADMAP.md is touched.
  if (completionResult.value.statusError) failOnVerificationStatusError(completionResult.value.statusError);
  const verificationResult = completionResult.value.verification;
  // #2648 precedent, applied at this write site (ADR-3180 §7.4 / #3186):
  // `isPhaseComplete` deliberately carries NO plan-count precondition — the
  // owner's `complete` is exactly `verification.status === 'passed'`, and
  // that must stay true (disk-strict: a zero-plan phase with a passing
  // `*-VERIFICATION.md` IS complete, #3168). But `readVerificationStatus`'s
  // staleness check only compares SUMMARY mtimes against the verification
  // file — it has no idea a NEW plan was added after the file was written,
  // so a still-fresh `passed` verification says nothing about a plan added
  // afterward. This command WRITES a checkbox and a completion date into
  // ROADMAP.md, a materially stronger claim than "verification passed" —
  // mirroring cmdPhaseComplete's own fail-closed plan-coverage gate
  // (phase.cts:~1995, #2648: "a coverage gate that passes when it cannot
  // read the plans is no gate at all"), composed explicitly here rather than
  // folded into the predicate: complete AND all plans executed.
  // #5060: `coverageScan` (declared above, before the `planCount === 0`
  // decline) is now this verb's ONE count source — the `Plans Complete`
  // cell, the `Plans:` line, the checkbox gate, the JSON output, and the
  // Status-cell ladder below all read `planCount`/`summaryCount` from it, so
  // a phase with a `status: superseded` plan (#2349) reports the same
  // counts everywhere instead of diverging between the ladder and the rest
  // of this verb's output.
  const unsummarizedPlans = findUnsummarizedPlans(coverageScan.planFiles, coverageScan.summaryFiles);
  const isComplete = completionResult.value.complete && unsummarizedPlans.length === 0;
  // #3057 B3: routing above is unchanged (an indeterminate staleness check
  // still routes as if nothing were stale) — this only makes the fact visible
  // to whatever reads this command's JSON output.
  const verificationStaleCheckIndeterminate =
    'staleCheckIndeterminate' in verificationResult && verificationResult.staleCheckIndeterminate === true;
  // #5060: route the Status-cell token through the Phase Status Module's
  // owner ladder rather than a local if/else, over the same `planCount`/
  // `summaryCount` (from `coverageScan`) every other output in this verb
  // uses.
  const status = toRoadmapStatusCell(phaseStatusFromFacts({
    planCount,
    summaryCount,
    complete: isComplete,
    verificationStatus: verificationResult.status,
  }));
  const today = realClock.localToday();

  if (!fs.existsSync(roadmapPath)) {
    declineNoOp(
      raw,
      'updated',
      'ROADMAP.md not found',
      'roadmap update-plan-progress skipped — ROADMAP.md not found.',
      { plan_count: planCount, summary_count: summaryCount },
    );
    return;
  }

  // Wrap entire read-modify-write in lock to prevent concurrent corruption
  let updated = false;
  // #4247: the refusal flag. The write/report decision below must be keyed to
  // "a writable roadmap representation of THIS phase was found", never to "any
  // byte moved". On a checklist-form ROADMAP (`- [ ] **Phase N: …**`, the
  // roadmapper's own summary-checklist form) every phase-targeted grammar
  // below requires an ATX `#{2,4} Phase N` heading and therefore finds
  // nothing; the Progress-table row is the only other writable target, and
  // when its Phase cell does not match `phaseCellRe` (e.g. a word-prefixed
  // `Phase 68` cell — deliberately unrecognized on the read side too,
  // `deriveProgressFromRoadmap`'s `/^\d/` data-row filter) the command used
  // to fall through to unrelated byte deltas (an UN-scoped plan-checkbox mark
  // anywhere in the document) and report `updated: true` while the phase's
  // own row stayed untouched — with the file-global write then letting the
  // platform write seam's markdown normalization inject blank lines around
  // other phases' bullets, splitting hand-wrapped sentences mid-entry. The
  // refusal below declines with the analyzer's own `missing_phase_details`
  // vocabulary and leaves ROADMAP.md byte-identical.
  let missingPhaseDetails = false;
  let archiveRestoreFailed = false;
  let archiveAmbiguous = false;
  const warnings: string[] = [];
  withPlanningLock(cwd, () => {
    // #3957 (B9.4): captured BEFORE any transform runs, so the write/report
    // decision below reflects whether the transforms actually changed
    // anything — not just that they ran. Every transform below still runs
    // unconditionally exactly as before; only the final write-and-report
    // step becomes conditional on `roadmapContent !== originalContent`.
    const rawContent = fs.readFileSync(roadmapPath, 'utf-8');
    // #5553: every transform below runs on the text with archived `<details>`
    // blocks hidden, so none can reach an archive; restored before the write.
    const archived = roadmapParserModule.maskArchivedDetails(rawContent, cwd);
    const originalContent = archived.visible;
    let roadmapContent = originalContent;
    // #5186: a custom ID such as SETUP-2 is literal, not numeric phase 2.
    const phasePattern = phaseMarkdownRegexSource(phaseNum, directoryContext);
    // #4247: ONE local source for the ATX phase-heading anchor that every
    // section-scoped writer below (`planSectionPattern`,
    // `insertRowsPatternA|B`) starts with — extracted so the target-detection
    // gate below reads the SAME grammar the writers anchor on, and a future
    // edit to one cannot drift from the other three copies.
    // #4906 Phase 5 (#4984): NOT migrated onto the heading-baseline selector —
    // this write-path anchor was never one of the five ADR-4910 §8 call sites
    // this phase owns (init.cts/milestone.cts's buildPhaseHeadingScanRegex
    // sites); a direct any-bracket selector call here would have added a
    // fourth uncounted ANY_BRACKET consumer to roadmap.cts's pinned
    // tests/adr-612-bracket-heading-selection.test.cjs census. Left
    // bracket-blind deliberately, matching this call's pre-#4984 behavior;
    // folding it into the census is Phase 6 work.
    // phase-id-owner: deliberately unmigrated (#4984 revert) — see comment above.
    const phaseHeadingAnchor = `#{2,4}\\s*Phase\\s+${phasePattern}${OPTIONAL_PHASE_TAG_SOURCE}(?=[:\\s])`;
    // #4247: target detection runs against the ORIGINAL content's active
    // (archive-masked) text — the same milestone scoping every writer
    // below applies — so the gate asks "does the file carry a writable phase
    // representation" rather than "did some regex fire mid-transform".
    // Heading target: the exact grammar `planSectionPattern` /
    // `insertRowsPatternA|B` anchor on (an ATX phase heading for this phase).
    const headingTargetFound = new RegExp(phaseHeadingAnchor, 'i').test(originalContent);
    // #5545: the phase-checklist bullet grammar, defined ONCE for the writer
    // (an unchecked bullet to tick) and the gate probe (`anyState`).
    // Line-anchored, with only an optional `**` before the label and horizontal
    // whitespace, so a bullet that merely MENTIONS "Phase N" is not the phase's
    // bullet and no `\s` can run past the line end (which used to land the
    // `(completed …)` annotation on the NEXT line). A decorated bullet (emoji,
    // blockquote, link) is deliberately NOT the phase's bullet either — the
    // same narrowing #4965 made for `roadmap analyze`'s checklist reader.
    // The lookahead only PEEKS (its `\s` may see a newline but consumes none):
    // the label must be followed by `:`, whitespace or the end of the line, so
    // `Phase 2.1` / `Phase 20` are not `Phase 2`. Capture group 1 is everything through
    // the opening `[`, group 2 the rest of the line from the closing `]`. The grammar (marker,
    // box, bold token) is the phase-entry grammar's, shared with every reader
    // and writer through roadmap-parser's `phaseChecklistBullet` (#5764).
    const phaseChecklistBullet = (anyState: boolean): RegExp => phaseChecklistBulletFor(phasePattern, anyState);
    // Checklist target: when the phase is complete, its own checklist bullet
    // (`- [ ] **Phase N: …**`) IS a writable phase row — the completion
    // checkbox stamp below updates it. Same grammar as that writer, widened
    // one notch to `[ x]` so an ALREADY-checked bullet still counts as a
    // found target: an idempotent re-run then takes the honest
    // "no changes were needed" decline instead of this refusal.
    const checklistTargetFound = isComplete && phaseChecklistBullet(true).test(originalContent);
    // Table-row target: set by the row-scoped cell updates below.
    let tableRowFound = false;

    // Progress table row: update Plans Complete/Status/Completed columns BY
    // COLUMN NAME (handles 4- or 5-column RoadmapProgress tables regardless of
    // Milestone-column presence) via the markdown-table seam (ADR-2143 §7) —
    // supersedes the prior ordinal cells[]-index regex. Scoped to the current
    // milestone's `## Progress` table (editProgressTableSlice above).
    // #2245 Blocker 4: optional dot must be followed by whitespace-or-end, not
    // dot-OR-whitespace-OR-end as alternatives — the prior form let a bare "."
    // satisfy the whole lookahead, so completing phase "2" over-matched a
    // decimal sub-phase row like "2.5 Extra". Matches "2", "2.", "2 Alpha";
    // rejects "2.5 Extra" (replicates OLD's `\.?\s` intent on the now-TRIMMED
    // cell value, where end-of-string is the trimmed equivalent of "no more
    // characters after the optional dot").
    const phaseCellRe = new RegExp(`^${phasePattern}\\.?(?:\\s|$)`, 'i');
    const rowMatch = (row: Record<string, string>): boolean => phaseCellRe.test((row['Phase'] ?? '').trim());
    const dateShape = /^\d{4}-\d{2}-\d{2}$/;

    roadmapContent = editProgressTableSlice(roadmapContent, (scoped) => {
      let text = scoped;

      const plansResult = updateTableCell(text, rowMatch, 'Plans Complete', ` ${summaryCount}/${planCount} `);
      if (plansResult.ok) { text = plansResult.value; tableRowFound = true; }

      // #4925: the verb owns the Status cell's leading status TOKEN only — the
      // same split #2853/#3584 made for the `Plans:` line below. It used to
      // overwrite the whole cell with ` ${status.padEnd(11)}` (no trailing
      // space), discarding any operator prose kept after the token. Three arms:
      //   1. empty or a dash placeholder → write the token, padded exactly as
      //      phase complete writes ` Complete    ` (phase.cts).
      //   2. a leading status token → rewrite the token only and keep the prose
      //      after it; an unchanged token leaves the cell byte-identical.
      //   3. freeform prose with no leading token → operator-owned, untouched.
      // #5060: routed through the Phase Status Module's `matchRoadmapStatusCell`
      // owner rather than a local statusTokenRe. `ROADMAP_STATUS_TOKEN.DEFERRED`
      // is now a recognized token (the old regex never matched "deferred" at
      // all, so a Deferred cell fell through to arm 3 unchanged) — the DEFERRED
      // guard below preserves that same "leave it alone" outcome explicitly.
      const statusResult = updateTableCell(text, rowMatch, 'Status', (current) => {
        if (current === '' || /^[-–—]$/.test(current)) return ` ${status.padEnd(11)} `;
        const m = matchRoadmapStatusCell(current);
        if (!m || m.token === ROADMAP_STATUS_TOKEN.DEFERRED || m.text === status) return current;
        const rest = current.slice(m.text.length);
        return rest === '' ? ` ${status.padEnd(11)} ` : ` ${escapeCell(status + rest)} `;
      });
      if (statusResult.ok) { text = statusResult.value; tableRowFound = true; }

      // Preserve only a valid ISO date (#1161: idempotent; self-heal garbage).
      // Ragged-tolerant (#2245 Blocker 2): probe the CURRENT Completed cell via
      // a no-op updateTableCell write (its own tolerant row scan) rather than
      // findTableWithColumns (which requires the WHOLE table to parse — a
      // ragged SIBLING row elsewhere used to silently no-op this row's date
      // stamp/clear too). The decision (write vs no-op) is folded into the
      // newValue callback so a single updateTableCell call both reads and
      // writes.
      const completedResult = updateTableCell(text, rowMatch, 'Completed', (current) => {
        if (isComplete) {
          return dateShape.test(current.trim()) ? current : ` ${today} `;
        }
        // #4925: only a stale ISO completion date — this verb's own stamp — is
        // cleared; a `-` placeholder or operator text stays byte-identical.
        return dateShape.test(current) ? '  ' : current;
      });
      if (completedResult.ok) { text = completedResult.value; tableRowFound = true; }

      return text;
    }, archived.activeRange);

    // #4947: a word-prefixed Phase cell (`Phase 68`) is deliberately not a
    // writable table target (#4247 — the read side ignores it too), but when the
    // phase's heading section is still written the command reports
    // `updated: true` and the unwritten Status cell looked like a silent bug.
    // The row stays byte-identical; the output now says so.
    const wordPrefixedCellRe = new RegExp(`^Phase\\s+${phasePattern}\\.?(?:\\s|$)`, 'i');
    const progressTable = tableRowFound ? null : findTableWithColumns(originalContent, ['Phase', 'Status']);
    if (progressTable && progressTable.rows.some((row) => wordPrefixedCellRe.test((row['Phase'] ?? '').trim()))) {
      warnings.push(`Progress table row for phase ${formatDiagnosticToken(String(phaseNum))} was not updated: its Phase cell is word-prefixed ("Phase N"), and only a bare phase number (N or N.) is recognized. Edit that row by hand or rewrite the cell as the bare number.`);
    }

    // Update plan count in phase detail section.
    // Three recognised forms (all tolerated; canonical template uses the first):
    //   `**Plans**: N plans`  — bold word + outer colon (gsd-core/templates/roadmap.md)
    //   `**Plans:** N plans`  — bold "Plans:" (colon inside bold)
    //   `Plans: N plans`      — plain text header
    //
    // #2853 / #3584: the verb owns the count token ONLY — it must not destroy
    // hand-written prose a human placed on the line. Group $1 = phase header →
    // `Plans:` label + trailing whitespace (unchanged). Group $2 = the existing
    // count token to replace: matches `N/N plans complete`, `N/N plans executed`,
    // or the bare template `N plan(s)` form — singular is part of the tool's OWN
    // grammar (gsd-core/templates/roadmap.md:62 ships `**Plans**: 1 plan` as the
    // documented one-plan-phase shape), so the `s` is optional there (bug #3584
    // Finding B; pre-fix a bare `1 plan` fell into the drop-everything path and
    // was accidentally overwritten with the correct count — post-fix it must be
    // recognised as a token in its own right or it freezes stale forever). Group
    // $3 = whatever else is on the line (`[^\r\n]*`, so a CRLF `\r` is never part
    // of the match and rides along untouched in the unmatched remainder of the
    // string — never stranded, never duplicated).
    //
    // Three arms, in order:
    //   1. $2 present (a real count token) → rewrite the token, preserve $3
    //      verbatim (an annotation a human wrote after a real count; #2853).
    //   2. $2 absent AND $3, trimmed, is the fresh-template PLACEHOLDER shipped
    //      by gsd-core/templates/roadmap.md — either
    //      `[Number of plans, e.g., "3 plans" or "TBD"]` (line 37) or
    //      `[Number of plans]` (lines 51/75/88) → replace it with the computed
    //      count. Detected POSITIVELY on the distinctive `Number of plans`
    //      wording (anchored, case-insensitive), NEVER on "wholly bracketed" —
    //      a bracketed HUMAN annotation such as `[Deferred pending re-scope]`
    //      is structurally identical but must be arm-3 preserved (bug #3584
    //      Finding A).
    //   3. Anything else (freeform prose, `TBD` / `TBD — annotation`, a
    //      bracketed human note, the first line of a wrapped sentence, an
    //      empty value) → leave the whole matched line untouched by returning
    //      `_match` unchanged. An untouched first line cannot orphan its own
    //      continuation on the next line, since the pattern never spans past
    //      `\n` in the first place.
    // #4906 Phase 2 (#4917/ADR-4910): migrated off the one-capture-group
    // regex that replaced to end of line onto the PlanningDoc `boldField`
    // write seam. `planSectionPattern` scopes the match to phase N's OWN
    // detail section (heading + body up to the next heading) — the same
    // window `phaseHeadingAnchor`'s siblings anchor on — and the callback
    // below runs parse -> classify -> (maybe) mutate -> serialize entirely
    // within that section text, mirroring phase.cts's `writePlansField`.
    const planSectionPattern = new RegExp(
      `${phaseHeadingAnchor}(?:(?!\\n#{1,4}\\s)[\\s\\S])*`,
      'i',
    );
    const planCountText = isComplete
      ? `${summaryCount}/${planCount} plans complete`
      : `${summaryCount}/${planCount} plans executed`;
    // Positive detector for the fresh-template placeholder ONLY (bug #3584
    // Finding A). Anchored to the distinctive `Number of plans` wording that
    // gsd-core/templates/roadmap.md actually ships, not to "anything in
    // brackets" — a bracketed human annotation like `[Deferred pending
    // re-scope]` is structurally bracketed too but carries none of this
    // wording, so it correctly falls through to arm 3 untouched. Kept as a
    // caller-side classifier (NOT seam grammar) reused below against the
    // `boldField` node's own parsed `value`.
    // #4947: a value that is exactly `TBD` is the planner's own "no plans yet"
    // marker, not an operator annotation — once plans exist it contradicts the
    // checklist this verb inserts right under it. `TBD — note` keeps its note
    // (row 5): on the bold path the note is the node's trailing span, which the
    // caller checks is empty; on the plain path the note is part of the value,
    // so the whole-value comparison already excludes it.
    const isBareTbd = (value: string): boolean => value.trim() === 'TBD';
    const isTemplatePlaceholder = (value: string): boolean => {
      const trimmed = value.trim();
      return /^\[\s*Number of plans\b[\s\S]*\]$/i.test(trimmed);
    };
    // Positive detectors for the two "real count token" shapes (#2853 /
    // #3584 Finding B): a fraction count (`N/M plans complete|executed`) or a
    // bare singular/plural count (`N plan`/`N plans`, the fresh single-plan
    // template shape at gsd-core/templates/roadmap.md:62). Either one is an
    // existing count token to overwrite (arm 1), never template placeholder
    // (arm 2) or freeform prose (arm 3).
    // #4906 regression fix: PREFIX match (not full-string) — a real count
    // token may have a glued-on annotation with no ` — ` separator (e.g.
    // `0/1 plans executed (11-16 are gap closure from VERIFICATION)`), which
    // `parseBoldFieldLine`'s em-dash-only trailing-content split leaves
    // entirely inside `value` (TRAILING_SEPARATOR_RE in planning-document.cts
    // is unchanged and correct — this is a caller-side classification fix,
    // not a seam fix). Returns the matched prefix length, or -1 if no match.
    const fractionCountPrefixLength = (value: string): number => {
      const m = value.match(/^\d+\s*\/\s*\d+\s+plans(?:\s+(?:complete|executed))?/i);
      return m ? m[0].length : -1;
    };
    const bareCountPrefixLength = (value: string): number => {
      const m = value.match(/^\d+\s+plans?/i);
      return m ? m[0].length : -1;
    };
    // #4947: the pending-plan clause a human or planner glues after the count
    // (`; 2 gap-closure plans pending (48-18, 48-19)`) is DERIVED from the same
    // plan/summary facts this verb already computes, so a completed plan left
    // listed as pending contradicts the count the verb just wrote. The verb
    // owns that one clause: ids that now have a SUMMARY.md are removed, the
    // number is recounted, and an emptied clause is dropped. Everything else in
    // the tail (`in 11 waves`, free prose) stays the operator's — a wave total
    // does not change when a plan completes. A clause whose ids are not all
    // plan ids (`(see backlog)`) is not provably derived, so it is left alone.
    const summarizedPlanIds = new Set(
      phaseInfo!.summaries
        .map((summaryFile) => summaryFile.replace('-SUMMARY.md', '').replace('SUMMARY.md', ''))
        .filter((id) => id !== ''),
    );
    const pendingClauseRe = /;[ \t]*(\d+)[ \t]+((?:[\w-]+[ \t]+)*?)plans?[ \t]+pending[ \t]*\(([^()\r\n]*)\)/i;
    const planIdShape = /^\d+(?:\.\d+)?-\d+(?:\.\d+)?$/;
    const reconcilePendingClause = (tail: string): string => {
      const m = pendingClauseRe.exec(tail);
      if (!m) return tail;
      const ids = m[3].split(',').map((id) => id.trim());
      if (ids.length === 0 || !ids.every((id) => planIdShape.test(id))) return tail;
      const stillPending = ids.filter((id) => !summarizedPlanIds.has(id));
      if (stillPending.length === ids.length) return tail;
      const replacement = stillPending.length === 0
        ? ''
        : `; ${stillPending.length} ${m[2]}plan${stillPending.length === 1 ? '' : 's'} pending (${stillPending.join(', ')})`;
      return tail.slice(0, m.index) + replacement + tail.slice(m.index + m[0].length);
    };
    roadmapContent = roadmapContent.replace(planSectionPattern, (sectionText: string): string => {
      const parsed = parsePlanningDoc(sectionText, 'ROADMAP.md');
      if (!parsed.ok) {
        // Unreadable section (e.g. an unterminated frontmatter fence) —
        // leave it byte-identical rather than throwing.
        return sectionText;
      }
      const fieldId = findField(parsed.value, 'Plans');
      if (!fieldId) {
        // #4906 regression (#1163, caught by gsd-test): a hand-edited or
        // pre-template ROADMAP.md may carry a PLAIN (non-bold) `Plans:` line
        // rather than the canonical `**Plans**:`/`**Plans:**` bold field.
        // BOLD_FIELD_RE is deliberately bold-only (widening it to any bare
        // `Label:` would register ordinary prose like "Note: see below" as a
        // spurious field seam-wide) — this is domain knowledge about ONE
        // field's legacy tolerated shape, the same class of thing
        // `isTemplatePlaceholder` above already keeps caller-side rather
        // than seam grammar, so the fallback lives here, not in
        // planning-document.cts.
        const plainMatch = sectionText.match(/^([ \t]*)Plans:([ \t]*)([^\r\n]*)$/m);
        if (!plainMatch) {
          // No `**Plans:**`/`**Plans**:`/plain `Plans:` line in this phase's
          // own section — nothing to write; not a failure (mirrors the old
          // regex's silent no-match no-op).
          return sectionText;
        }
        const [whole, indent, spacing, plainValue] = plainMatch;
        const plainFractionLen = fractionCountPrefixLength(plainValue);
        const plainBareLen = bareCountPrefixLength(plainValue);
        const plainCountPrefixLen = plainFractionLen >= 0 ? plainFractionLen : plainBareLen;
        if (plainCountPrefixLen < 0 && !isTemplatePlaceholder(plainValue) && !isBareTbd(plainValue)) {
          // Arm 3: freeform prose, TBD, a bracketed human annotation, or an
          // empty value — leave the section exactly as it was.
          return sectionText;
        }
        const plainSuffix = plainCountPrefixLen >= 0 ? reconcilePendingClause(plainValue.slice(plainCountPrefixLen)) : '';
        const newPlainLine = `${indent}Plans:${spacing}${planCountText}${plainSuffix}`;
        const start = plainMatch.index ?? sectionText.indexOf(whole);
        return sectionText.slice(0, start) + newPlainLine + sectionText.slice(start + whole.length);
      }
      const current = readNode(parsed.value, fieldId);
      if (!current.ok) {
        return sectionText;
      }
      const currentValue = current.value;
      const fractionPrefixLen = fractionCountPrefixLength(currentValue);
      const barePrefixLen = bareCountPrefixLength(currentValue);
      const countPrefixLen = fractionPrefixLen >= 0 ? fractionPrefixLen : barePrefixLen;
      const fieldNode = parsed.value.nodes.find((n) => n.id === fieldId);
      const trailingText = fieldNode && fieldNode.kind === 'boldField'
        ? parsed.value.source.slice(fieldNode.trailingSpan.start, fieldNode.trailingSpan.end)
        : '';
      if (countPrefixLen < 0 && !isTemplatePlaceholder(currentValue) && !(isBareTbd(currentValue) && trailingText.trim() === '')) {
        // Arm 3: freeform prose, TBD, a bracketed human annotation, or an
        // empty value — leave the section exactly as it was.
        return sectionText;
      }
      // Arm 1 (real count token, possibly with a glued-on no-separator
      // annotation re-attached verbatim as `suffix`) or arm 2 (fresh-template
      // placeholder, whole value replaced): write the computed count.
      // `setFieldValue`'s valueSpan/trailingSpan split additionally preserves
      // any EM-DASH-separated trailing annotation (#2853) automatically — no
      // separate "preserve trailing" branch needed for that shape.
      const suffix = countPrefixLen >= 0 ? reconcilePendingClause(currentValue.slice(countPrefixLen)) : '';
      const newValueToWrite = planCountText + suffix;
      const staged = setFieldValue(parsed.value, fieldId, newValueToWrite);
      if (!staged.ok) {
        return sectionText;
      }
      const out = serialize(staged.value);
      if (!out.ok) {
        // `hasUnreadableNodes` refusal (ADR-4910 amendment) — a ragged
        // SIBLING node elsewhere in this same section refuses the whole
        // splice. Never throw; leave the section unchanged.
        return sectionText;
      }
      return out.value;
    });

    // If complete: check checkbox
    if (isComplete) {
      roadmapContent = roadmapContent.replace(phaseChecklistBullet(false), `$1x$2 (completed ${today})`);
    }

    // Mark completed plan checkboxes (e.g. "- [ ] 50-01-PLAN.md", "- [ ] 50-01:", or "- [ ] **50-01**")
    // #4741: tick only plans the phase's own COUNT still counts. `plans` is the
    // superseded-filtered set (#2349 via scanPhasePlans) while `summaries` is
    // the raw *-SUMMARY.md listing — a superseded plan can carry a SUMMARY
    // (e.g. `status: halted`), and ticking it read as "executed" right under a
    // count line that excludes it. #5542: a summary belongs to a live plan only
    // by the SAME pairing rule the counts use (`summaryCandidates` via
    // `countMatchedSummaries`), never by id prefix — a leftover `47-1` summary
    // must not survive because a live `47-10` plan starts with `47-1`. Rows
    // match the id up to a boundary (`planRowPattern`), so `47-1` never ticks
    // `47-10-PLAN.md`.
    const tickableSummaries = phaseInfo!.summaries
      .map((summaryFile) => ({ summaryFile, planId: summaryFile.replace('-SUMMARY.md', '').replace('SUMMARY.md', '') }))
      .filter(({ summaryFile, planId }) => planId !== ''
        && coreUtils.summaryPairsWithAnyPlan(phaseInfo!.plans, summaryFile));
    // #5483: a plan's row is ticked only in THIS phase's own scopes (its detail
    // section, then the rows under its checklist bullet, as `phase complete` does).
    // A scope that was located but holds no row ticks nothing, so a sibling phase's
    // same-named row is never touched; only a phase with neither scope falls back
    // to the first row outside every phase bullet's rows. Archived blocks are
    // already hidden by maskArchivedDetails (#5553), which owns which regions are editable.
    const editPhaseScopes = (text: string, edit: (scope: string) => string, levelBounded = false): string => {
      let out = withPhaseSection(text, phaseNum, edit, levelBounded);
      const bullet = phaseChecklistBullet(true).exec(out);
      if (bullet) {
        const { start, end } = checklistBulletExtent(out, bullet);
        out = out.slice(0, start) + edit(out.slice(start, end)) + out.slice(end);
      }
      return out;
    };
    // Read-only view of the scopes `editPhaseScopes` edits: the non-empty text of each.
    const readPhaseScopes = (text: string, levelBounded = false): string[] => {
      const scopes: string[] = [];
      editPhaseScopes(text, (scope) => { if (scope.trim() !== '') scopes.push(scope); return scope; }, levelBounded);
      return scopes;
    };
    // Decided once on the pre-insertion text: insertion only adds rows under an existing section.
    const phaseScopes = readPhaseScopes(roadmapContent, true);
    const located = phaseScopes.length > 0;
    // Same-length copy of `text` with every phase's detail section and checklist-bullet rows blanked: what is
    // left is "unowned" text (e.g. rows under a non-phase heading inside the active milestone), which belongs to no sibling phase.
    const unownedText = (text: string): string => {
      const spans: Array<[number, number]> = [];
      const heads = tokenizeHeadings(text);
      heads.forEach((h, i) => {
        if (/^Phase\b/i.test(h.text.replace(/^\[[^\]]*\]\s*/, ''))) spans.push([h.offset, heads[i + 1]?.offset ?? text.length]);
      });
      for (const b of text.matchAll(ANY_PHASE_ENTRY_LINE)) spans.push([b.index, checklistBulletExtent(text, b).end]);
      let out = text;
      for (const [a, z] of spans) out = out.slice(0, a) + out.slice(a, z).replace(/[^\r\n]/g, ' ') + out.slice(z);
      return out;
    };
    const tickUnowned = (text: string, planId: string): string => {
      const blank = unownedText(text);
      const ticked = coreUtils.tickAnchoredPlanRow(blank, planId);
      if (ticked === blank) return text;
      let out = '';
      for (let i = 0; i < text.length; i++) out += ticked[i] !== blank[i] ? ticked[i] : text[i];
      return out;
    };
    const fallbackTicked = new Set<string>();
    const tickPlanRow = (text: string, planId: string): string => {
      // levelBounded: a row under the phase's own `#### Plans` sub-heading ticks too.
      const out = editPhaseScopes(text, (scope) => coreUtils.tickAnchoredPlanRow(scope, planId), true);
      if (out !== text) return out;
      // A located scope without the row: a row no sibling phase owns (under a non-phase heading) is still this phase's.
      if (located) return tickUnowned(text, planId);
      if (fallbackTicked.has(planId)) return out;
      // First row outside every phase bullet's rows: one nested under a sibling's bullet is that sibling's.
      let ticked = text;
      let from = 0;
      for (const b of text.matchAll(ANY_PHASE_ENTRY_LINE)) {
        const { start, end } = checklistBulletExtent(text, b);
        const seg = text.slice(from, start);
        const t = coreUtils.tickAnchoredPlanRow(seg, planId);
        if (t !== seg) { ticked = text.slice(0, from) + t + text.slice(start); break; }
        from = end;
      }
      if (ticked === text) {
        const tail = coreUtils.tickAnchoredPlanRow(text.slice(from), planId);
        if (tail !== text.slice(from)) ticked = text.slice(0, from) + tail;
      }
      if (ticked !== text) fallbackTicked.add(planId);
      return ticked;
    };
    const tickPlanRows = (text: string): string => tickableSummaries.reduce((acc, { planId }) => tickPlanRow(acc, planId), text);
    roadmapContent = tickPlanRows(roadmapContent);

    // Detection reads presentRows (the archive-masked text plus rows hidden in
    // collapsed blocks of the active range); insertion edits the masked text only.
    // A plan row that exists only in an archived <details> block is therefore
    // not counted as "already present" in the active milestone section.
    // (Finding 1 code-review: detection was previously running against the full
    //  roadmapContent, causing archived rows to suppress active-section inserts.)
    // Compute which plan files are MISSING a checkbox row in the ACTIVE region.
    // This handles three cases:
    //   (a) Fresh template — no rows at all: all plans are missing.
    //   (b) Partial gap — some rows exist, others don't: only the absent ones.
    //   (c) All rows present — nothing to insert (idempotent).
    //
    // Detection is scoped to the active region so a plan that appears in an
    // archived <details> block is still correctly detected as missing from the
    // active milestone section.
    //
    // #4786: a plan row may be written WITH the `-PLAN.md` suffix (canonical
    // template form) or WITHOUT it (hand-written form: `- [x] 659-01 — desc`).
    // The tick loop above keys on the bare planId stem, while detection required
    // the full `-PLAN.md` filename — so every suffix-less row was counted
    // missing and the insertion fired BESIDE the recognized list — 32 checkbox
    // lines for 16 plans, exit 0. The stem arm below accepts the bare id only
    // up to the SAME boundary the tick loop uses (`planRowPattern`, #5542), so
    // `5-011` never satisfies `5-01` and a dotted sub-id (`5-01.5`) is a real
    // distinct plan whose row does not count as 5-01's presence.
    // Rows inside a collapsed block of the active range are hidden from edits but still present.
    // #5483: presence is judged in THIS phase's own scopes (plus rows hidden in collapsed active blocks), so a
    // sibling phase's same-named un-prefixed row never makes a plan look present; a phase with no scope reads the whole text.
    const presentRows = located
      ? `${readPhaseScopes(roadmapContent, true).join('\n')}\n${archived.hiddenInActive}`
      : `${roadmapContent}\n${archived.hiddenInActive}`;
    const unownedNow = located ? unownedText(roadmapContent) : '';
    const hasUnownedAny = (planFile: string, stem: string): boolean =>
      new RegExp(`-\\s*\\[[x ]\\]\\s*(?:\\*\\*)?${escapeRegex(planFile)}`, 'i').test(unownedNow) || coreUtils.planRowPattern(stem, { anyState: true }).test(unownedNow);
    const missingPlans = phaseInfo!.plans.filter((planFile) => {
      const planEscaped = escapeRegex(planFile);
      if (new RegExp(`-\\s*\\[[x ]\\]\\s*(?:\\*\\*)?${planEscaped}`, 'i').test(presentRows)) return false;
      const stem = planFile.replace(/-PLAN\.md$/i, '');
      return !coreUtils.planRowPattern(stem, { anyState: true }).test(presentRows) && !(located && hasUnownedAny(planFile, stem));
    });

    if (missingPlans.length > 0) {
      // Insert missing plan checklist rows (#1163).  We prefer to anchor to the
      // bare `Plans:` checklist header (canonical template form) and fall back to
      // the bold `**Plans**:`/`**Plans:**` summary line only when no bare header
      // is present.  Using two separate patterns avoids the lazy-quantifier trap
      // where a single alternation would stop at the first matching alternative
      // (the bold summary) before reaching the checklist header.
      //
      // Canonical template (gsd-core/templates/roadmap.md) uses BOTH lines:
      //   **Plans**: N plans   ← summary (colon outside bold)
      //   Plans:               ← checklist header (PREFERRED insertion anchor)
      // Rows must land after `Plans:`, not between the summary and the header.
      //
      // Pattern A: anchor to bare `Plans:` header (preferred).
      // Pattern B: fallback to bold summary when no bare header exists.
      const insertRowsPatternA = new RegExp(
        `(${phaseHeadingAnchor}(?:(?!\\n#{1,4}\\s)[\\s\\S])*?(?:^|\\n)(?:Plans:)[^\\n]*)`,
        'i'
      );
      const insertRowsPatternB = new RegExp(
        `(${phaseHeadingAnchor}(?:(?!\\n#{1,4}\\s)[\\s\\S])*?(?:\\*\\*Plans\\*\\*:|\\*\\*Plans:\\*\\*)[^\\n]*)`,
        'i'
      );

      const sortedMissing = [...missingPlans].sort();
      const newRows = sortedMissing.map(p => `- [ ] ${p}`).join('\n');
      const inserter = (match: string) => `${match}\n${newRows}`;

      // Archived `<details>` blocks are already hidden (maskArchivedDetails), so
      // archived duplicate phase headings cannot receive rows.
      const regionA = roadmapContent.replace(insertRowsPatternA, inserter);
      const withRows = regionA !== roadmapContent ? regionA : roadmapContent.replace(insertRowsPatternB, inserter);
      if (withRows !== roadmapContent) {
        roadmapContent = withRows;
        // Mark any newly-inserted rows that already have summaries as complete
        // (#4741: same superseded-filtered tick list as the loop above — a
        // pre-existing superseded row must stay unchecked on this path too).
        roadmapContent = tickPlanRows(roadmapContent);
      }
    }

    // #3957 (B9.4): write and report an update only when the transforms
    // above actually produced different bytes — mirroring the sibling
    // `cmdRoadmapAnnotateDependencies`'s existing `nextContent !== content`
    // gate. Previously this wrote and reported `updated: true`
    // unconditionally, even on an idempotent re-run that changed nothing.
    //
    // #4247: ...but ONLY when a writable representation of THIS phase was
    // found. Without the target gate, a byte delta from an unrelated
    // transform (the un-scoped plan-checkbox mark) satisfied the #3957 gate
    // and produced a success-shaped `updated: true` while the phase's own
    // row stayed untouched — and the file-global write let the platform
    // write seam's markdown normalization reflow unrelated entries. When no
    // target exists the command refuses: no write at all, so ROADMAP.md is
    // left byte-identical, and the caller gets a typed
    // `missing_phase_details` decline instead of a false green.
    const phaseRepresentationFound = tableRowFound || headingTargetFound || checklistTargetFound;
    // Unpaired <details> tags make the archive extents a guess: refuse rather than edit inconsistently.
    const finalContent = archived.ambiguous ? null : archived.restore(roadmapContent);
    if (archived.ambiguous) {
      archiveAmbiguous = true;
    } else if (finalContent === null) {
      archiveRestoreFailed = true;
    } else if (phaseRepresentationFound && finalContent !== rawContent) {
      platformWriteSync(roadmapPath, finalContent);
      updated = true;
    }
    if (!phaseRepresentationFound) {
      missingPhaseDetails = true;
    }
  });

  const computed = {
    phase: phaseNum,
    plan_count: planCount,
    summary_count: summaryCount,
    status,
    complete: isComplete,
    verification_stale_check_indeterminate: verificationStaleCheckIndeterminate,
  };
  if (updated) {
    output(warnings.length > 0 ? { updated: true, ...computed, warnings } : { updated: true, ...computed }, raw, `${summaryCount}/${planCount} ${status}`);
  } else if (archiveAmbiguous) {
    declineNoOp(
      raw,
      'updated',
      'archive_structure_ambiguous',
      'roadmap update-plan-progress skipped — ROADMAP.md has an unpaired <details> tag that hides where an archived block ends. ROADMAP.md was left unchanged.',
      computed,
    );
  } else if (archiveRestoreFailed) {
    // An edit dropped an archive placeholder (#5553): writing would lose that
    // archive, so refuse loudly instead of reporting "no changes were needed".
    declineNoOp(
      raw,
      'updated',
      'archive_placeholder_lost',
      'roadmap update-plan-progress skipped — an edit would have dropped an archived ROADMAP block. ROADMAP.md was left unchanged.',
      computed,
    );
  } else if (missingPhaseDetails) {
    // #4247: honest refusal — the reason names the real condition (the
    // analyzer's `missing_phase_details` vocabulary), never "already
    // reflects", which was false: the ROADMAP was never able to record this
    // phase's progress in the first place.
    declineNoOp(
      raw,
      'updated',
      'missing_phase_details',
      `roadmap update-plan-progress skipped — ROADMAP.md has no writable entry for phase ${formatDiagnosticToken(String(phaseNum))} (no matching Progress-table row, no phase detail section, and no checklist entry this command can update). ROADMAP.md was left unchanged.`,
      computed,
    );
  } else {
    declineNoOp(
      raw,
      'updated',
      "no changes were needed — ROADMAP.md already reflects this phase's plan/summary counts and status",
      "roadmap update-plan-progress skipped — no changes were needed; ROADMAP.md already reflects this phase's plan/summary counts and status.",
      computed,
    );
  }
}

// ─── cmdRoadmapAnnotateDependencies ───────────────────────────────────────────

/** #5321: tags a generated constraints heading so re-runs can tell it from a pre-#5321 one. */
const GENERATED_MARK = ' <!-- gsd:generated -->';
const BULLET_RE = /^\s*-\s+/;

/**
 * #5321: first checklist-shaped row left after the matched Plans block, scanning the rest of the
 * Plans region — it ends at a heading or an unindented non-list line, so a later section's
 * checklist is never mistaken for a stranded plan row. Indented detail lines are skipped, not final.
 */
function findStrandedRow(rest: string[]): string | undefined {
  for (const l of rest) {
    if (/^[ \t]*[-*+][ \t]+\[[ \t]*[xX ]?[ \t]*\]/.test(l)) return l;
    if (/^#{1,6}\s/.test(l) || /^\S/.test(l) && !/^(?:[-*+]\s|\*\*Wave\s+\d+\*\*)/i.test(l)) return undefined;
  }
  return undefined;
}

/**
 * Annotate the ROADMAP.md plan list for a phase with wave dependency notes
 * and a cross-cutting constraints subsection derived from PLAN frontmatter.
 *
 * Wave dependency notes: "Wave 2 — blocked on Wave 1 completion" inserted as
 * bold headers before each wave group in the plan checklist.
 *
 * Cross-cutting constraints: must_haves.truths strings that appear in 2+ plans
 * are surfaced in a "Cross-cutting constraints" subsection below the plan list.
 *
 * Re-running regenerates the annotation from current PLAN frontmatter (replans
 * update waves/constraints, #5321); idempotent: an unchanged result writes nothing.
 */
function cmdRoadmapAnnotateDependencies(cwd: string, phaseNum: string | null | undefined, raw: boolean): void {
  if (!phaseNum) {
    error('phase number required for roadmap annotate-dependencies');
  }

  const roadmapPath = planningPaths(cwd).roadmap;
  if (!fs.existsSync(roadmapPath)) {
    declineNoOp(raw, 'updated', 'ROADMAP.md not found', 'roadmap annotate-dependencies skipped — ROADMAP.md not found.');
    return;
  }

  const directoryContext = phaseDirectoryOptions(cwd);
  const phaseInfo = findPhaseInternal(cwd, phaseNum, undefined, directoryContext);
  // #3957 (B9.1): distinguish "phase does not resolve at all" from "phase
  // resolves but has zero plans" — previously both collapsed into the same
  // 'no plans found for phase' reason, which is simply false for the first
  // case (there IS no such phase to have plans).
  if (!phaseInfo) {
    declineNoOp(
      raw,
      'updated',
      `phase ${phaseNum} not found`,
      `roadmap annotate-dependencies skipped — phase ${formatDiagnosticToken(String(phaseNum))} not found.`,
      { phase: phaseNum },
    );
    return;
  }
  if (phaseInfo.plans.length === 0) {
    declineNoOp(
      raw,
      'updated',
      `phase ${phaseNum} has no plans`,
      `roadmap annotate-dependencies skipped — phase ${formatDiagnosticToken(String(phaseNum))} has no plans.`,
      { phase: phaseNum },
    );
    return;
  }

  // Read each PLAN.md and extract wave + must_haves.truths
  const planData: Array<{ planFile: string; planId: string; wave: number; truths: unknown[] }> = [];
  for (const planFile of phaseInfo.plans) {
    const planPath = path.join(path.resolve(cwd, phaseInfo.directory), planFile);
    try {
      const content = fs.readFileSync(planPath, 'utf-8');
      const fm = extractFrontmatter(content, planPath);
      const wave = parseInt(fm.wave as string, 10) || 1;
      const planId = planFile.replace(/-PLAN\.md$/i, '').replace(/PLAN\.md$/i, '');
      const truths = parseMustHavesBlock(content, 'truths') || [];
      planData.push({ planFile, planId, wave, truths });
    } catch { /* skip unreadable plans */ }
  }

  if (planData.length === 0) {
    declineNoOp(
      raw,
      'updated',
      'could not read plan frontmatter',
      'roadmap annotate-dependencies skipped — could not read plan frontmatter for any plan in this phase.',
    );
    return;
  }

  // Group plans by wave (sorted)
  const waveGroups = new Map<number, typeof planData>();
  for (const p of planData) {
    if (!waveGroups.has(p.wave)) waveGroups.set(p.wave, []);
    waveGroups.get(p.wave)!.push(p);
  }
  const waves = [...waveGroups.keys()].sort((a, b) => a - b);

  // Find cross-cutting truths: appear in 2+ plans (de-duplicated, case-insensitive).
  //
  // Issue #2770: must **coerce, not skip**. A previous guard
  // `if (typeof t !== 'string') continue` silently dropped numeric scalars
  // (YAML ints like `- 3`) and kv-shaped truths (`- title: X`), so the
  // cross-cutting analysis lost real constraints rather than crashing on
  // `t.trim()`. We coerce primitives via `String(t)` and extract a sensible
  // string field from object-shaped items produced by parseMustHavesBlock's
  // continuation-kv path (issue #2757 produces those shapes for nested keys).
  const truthCounts = new Map<string, TruthValue>();
  for (const { truths } of planData) {
    const seen = new Set<string>();
    for (const t of truths) {
      const text = coerceTruthToString(t);
      if (!text) continue;
      const trimmed = text.trim();
      const key = trimmed.toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      if (!truthCounts.has(key)) truthCounts.set(key, { count: 0, text: trimmed });
      truthCounts.get(key)!.count++;
    }
  }
  const crossCuttingTruths = [...truthCounts.values()]
    .filter(v => v.count >= 2)
    .map(v => v.text);

  // Patch ROADMAP.md
  let updated = false;
  let skipped: string | undefined;
  let staleLegacy: string[] = [];
  let droppedGenerated: string[] = [];
  withPlanningLock(cwd, () => {
    const content = fs.readFileSync(roadmapPath, 'utf-8');
    // #3413: preserve the file's own EOL style when the checklist block below
    // is rebuilt and spliced back in — splitLines() cleans each captured line
    // of any dangling \r, so rejoining with a bare '\n' would silently
    // downgrade a CRLF ROADMAP.md's rewritten block to LF only.
    const eol = detectEol(content);

    // Find the phase section.
    // #3537: padding-tolerant fragment so the caller's resolved padded id
    // matches un-padded ROADMAP headings.
    const phaseEscaped = phaseMarkdownRegexSource(phaseNum, directoryContext);
    // #4906 Phase 5 (#4984): NOT migrated onto the heading-baseline selector —
    // this site was never one of the five ADR-4910 §8 call sites this phase
    // owns (init.cts/milestone.cts's buildPhaseHeadingScanRegex sites); a
    // direct any-bracket selector call here would have added a fifth
    // uncounted ANY_BRACKET consumer to roadmap.cts's pinned
    // tests/adr-612-bracket-heading-selection.test.cjs census. Left
    // bracket-blind deliberately, matching this call's pre-#4984 behavior;
    // folding it into the census is Phase 6 work.
    // phase-id-owner: deliberately unmigrated (#4984 revert) — see comment above.
    const phaseHeaderPattern = new RegExp(`(#{2,4}\\s*Phase\\s+${phaseEscaped}${OPTIONAL_PHASE_TAG_SOURCE}:[^\\n]*)`, 'i');
    const phaseMatch = content.match(phaseHeaderPattern);
    if (!phaseMatch) return;

    const phaseStart = phaseMatch.index!;
    const restAfterHeader = content.slice(phaseStart);
    const nextPhaseOffset = restAfterHeader.slice(1).search(/\n#{2,4}\s+Phase\s+\d/i);
    const phaseEnd = nextPhaseOffset >= 0 ? phaseStart + 1 + nextPhaseOffset : content.length;
    const phaseSection = content.slice(phaseStart, phaseEnd);

    // Find the Plans: section within the phase section.
    // #3691 Bug 1: `Plans:\s*\n` required no text after the colon, missing variants like
    // `Plans: 3 plans across 2 waves\n` or `**Plans:** 3 plans\n` (bold-wrapped).
    // `\*{0,2}Plans\*{0,2}:[^\n]*\n` accepts any text (or none) after the colon
    // and tolerates optional `**` markdown bold wrappers on either side.
    // The checklist group uses `+` (not `*`) so that a bold `**Plans:**` description
    // line with no immediately-following checklist items (e.g. a summary line above a
    // separate bare `Plans:` block) does not consume the match and prevent the actual
    // list from being found.
    // Review fix (F2): `(?:^|\n)` anchors the match to start-of-line so mid-line
    // occurrences like `***Plans:***` embedded in a sentence or `OpenPlans: foo`
    // do not trigger a false match. Groups 1 and 2 retain the same semantics.
    // #3415: empirically verified linear-time to 10.9MB / 320,000 lines of adversarial
    // checklist input (0.31ms@1000 lines -> 8.4ms@320,000 lines). The outer `+` group has
    // no trailing constraint after it in the pattern, so a successful greedy pass never
    // needs to explore alternate `\r?\n?` boundary partitions to satisfy something later —
    // it accepts the first complete parse and stops, which rules out the #2128-class
    // ambiguous-boundary blowup despite the nested-quantifier shape. Non-global match on
    // already phase-sliced content, not the whole file.
    // #5321: re-runs rebuild a prior annotation: group 2 swallows generated `**Wave N**` headers
    // only (user prose kept); group 3 the exact constraints header + bullets, never read as plans.
    // Block ends in one blank line (group 3 eats it) so later user bullets survive; legacy blocks
    // (no marker) keep bullets that are not current shared truths; the exact heading is reserved.
    // Blank lines inside the list are crossed only before a plan-id row, so a hand-written bullet after a blank line stays out.
    // Outer `+` has no trailing constraint to force re-partitioning; alternatives start with distinct literals; measured linear to 10.9MB.
    const plansBlockMatch = phaseSection.match(new RegExp(String.raw`(?:^|\r?\n)(\*{0,2}Plans\*{0,2}:[^\r\n]*\r?\n)((?:[ \t]*-\s*\[[ x]\][^\r\n]*\r?\n?|(?:[ \t]*\r?\n)+(?=[ \t]*-\s*\[[ x]\]\s*[\w.-]+?(?:-PLAN\.md|\.md|:|\s—))|\s*\*\*Wave\s+\d+\*\*(?: \*\(blocked on Wave \d+ completion\)\*)?[ \t]*(?:\r?\n|$)(?=\s*-\s*\[[ x]\]))+)(\s*\*\*Cross-cutting constraints:\*\*(${escapeRegex(GENERATED_MARK)})?[ \t]*(?:\r?\n|$)(?:[ \t]*-[ \t]+[^\r\n]*\r?\n?)*(?:[ \t]*\r?\n)?)?`, 'i'));
    if (!plansBlockMatch) return;

    const plansHeader = plansBlockMatch[1];
    const existingList = plansBlockMatch[2];
    const listLines = splitLines(existingList).filter(l => /^\s*-\s*\[[ x]\]/i.test(l));

    if (listLines.length === 0) return;

    const oldBlock = plansBlockMatch[3] ? splitLines(plansBlockMatch[3]) : [];
    // #5321: a checklist row group 2 rejects (`- [  ]`, `* [ ]`), or an empty generated wave
    // header, splits the list; rewriting only the prefix would orphan the rest — skip loudly.
    const stranded = plansBlockMatch[3] ? undefined : findStrandedRow(splitLines(phaseSection.slice(plansBlockMatch.index! + plansBlockMatch[0].length)));
    const warn = (head: string, tail: string): void => {
      process.stderr.write(`[gsd-tools] WARNING: roadmap annotate-dependencies ${head}${formatDiagnosticToken(String(phaseNum))}${tail}`);
    };
    if (stranded) {
      warn(
        `skipped — unrecognised checklist row ${formatDiagnosticToken(stranded.trim())} splits the Plans list of phase `,
        '.\n',
      );
      skipped = 'unrecognised_checklist_row';
      return;
    }

    // #314 perf: build a first-wins Map so per-line lookup is O(1) instead of O(plans).
    // First-wins mirrors .find() semantics: if the same planId appears more than once
    // in planData, the earlier entry wins — identical to what .find() returned before.
    const planById = new Map<string, typeof planData[number]>();
    for (const p of planData) {
      if (!planById.has(p.planId)) planById.set(p.planId, p);
    }

    // Build wave-annotated plan list
    const linesByWave = new Map<number, string[]>();
    for (const line of listLines) {
      // Match plan ID from line: "- [ ] 01-01-PLAN.md — ..." or "- [ ] 01-01: ..."
      // #3691 Bug 3: `[\w-]+?` excluded `.`, so decimal IDs like `02.3-01` were captured
      // as `02` only and never matched planData entries. `[\w.-]+?` preserves the
      // terminating alternation (`-PLAN.md|.md|:|\s—`) as the boundary anchor.
      const idMatch = line.match(/\[\s*[x ]\s*\]\s*([\w.-]+?)(?:-PLAN\.md|\.md|:|\s—)/i);
      const planId = idMatch ? idMatch[1] : null;
      // Review fix (F3): reject malformed IDs that start with `.`, contain consecutive
      // dots, or otherwise violate the `^\w[\w.-]*$` contract. A leading-dot ID
      // (e.g. `.invalid-PLAN.md`) would silently default to wave 1 — defensively
      // skip the line instead so corrupted ROADMAP entries don't corrupt wave layout.
      if (planId && !/^\w[\w.-]*$/.test(planId)) continue;
      const planEntry = planId ? (planById.get(planId) || null) : null;
      const wave = planEntry ? planEntry.wave : 1;
      if (!linesByWave.has(wave)) linesByWave.set(wave, []);
      linesByWave.get(wave)!.push(line);
    }

    const annotatedLines: string[] = [];
    const sortedWaves = [...linesByWave.keys()].sort((a, b) => a - b);
    for (let i = 0; i < sortedWaves.length; i++) {
      const w = sortedWaves[i];
      const waveLines = linesByWave.get(w)!;
      if (sortedWaves.length > 1) {
        const dep = i > 0 ? ` *(blocked on Wave ${sortedWaves[i - 1]} completion)*` : '';
        annotatedLines.push(`**Wave ${w}**${dep}`);
      }
      annotatedLines.push(...waveLines);
      if (i < sortedWaves.length - 1) annotatedLines.push('');
    }

    // Append cross-cutting constraints subsection if any found
    if (crossCuttingTruths.length > 0) {
      annotatedLines.push('');
      annotatedLines.push(`**Cross-cutting constraints:**${GENERATED_MARK}`);
      for (const t of crossCuttingTruths) {
        annotatedLines.push(`- ${t}`);
      }
      annotatedLines.push(''); // #5321: delimiter so user bullets after the block survive re-runs
    }

    // #5321: bullets of the old constraints block that equal ANY current plan truth were generated
    // from one (rebuilt above, or no longer shared): drop them. Any other bullet is a user bullet or
    // a reworded/removed constraint; both look alike. Without the generated marker (pre-#5321) keep
    // and report it; under the marker the block is machine-owned, so drop it but warn.
    if (plansBlockMatch[3]) {
      const unknown = oldBlock
        .filter(l => BULLET_RE.test(l) && !truthCounts.has(l.replace(BULLET_RE, '').trim().toLowerCase()));
      const texts = unknown.map(l => l.replace(BULLET_RE, '').trim());
      const names = texts.map(formatDiagnosticToken).join('; ');
      if (unknown.length > 0 && plansBlockMatch[4]) {
        droppedGenerated = texts;
        warn(
          `dropped ${unknown.length} bullet(s) under the generated `
          + `constraints heading that match no current plan truth in phase `,
          `: ${names} — put your own bullets after a blank line.\n`,
        );
      } else if (unknown.length > 0) {
        if (crossCuttingTruths.length === 0) annotatedLines.push('');
        annotatedLines.push(...unknown);
        staleLegacy = texts;
        warn(
          `kept ${unknown.length} bullet(s) under a pre-#5321 `
          + `constraints block that match no current plan truth in phase `,
          `: ${names} — delete any that are stale.\n`,
        );
      }
    }

    // The old block's trailing blank line separated it from user content below: keep it when the block is dropped.
    if (oldBlock.length > 2 && !oldBlock[oldBlock.length - 2].trim() && annotatedLines[annotatedLines.length - 1] !== '') annotatedLines.push('');

    const newListBlock = joinLines(annotatedLines, eol) + eol;
    // #1103: when `(?:^|\r?\n)` consumed a leading terminator (mid-string
    // match), re-emit it verbatim so the line preceding the Plans: header is
    // not fused onto it. #3413: the widened `(?:^|\r?\n)` can now consume a
    // 2-char `\r\n` — re-emit whatever was actually captured (`''`, `'\n'`,
    // or `'\r\n'`), not a hardcoded `'\n'`, or a CRLF file loses its `\r`.
    const leadingMatch = /^\r?\n/.exec(plansBlockMatch[0]);
    const leadingNewline = leadingMatch ? leadingMatch[0] : '';
    // Review fix (#3413 security): use the FUNCTION-replacement form. The
    // string-replacement form expands String#replace's special patterns
    // (`$&`, `` $` ``, `$'`, `$$`, `$1`-`$9`) inside the replacement — and
    // newListBlock is built from author-controlled truths/plan-file content,
    // so a line containing a literal `` $` `` (etc.) would splice unrelated
    // surrounding phaseSection text into the result. A function replacer is
    // never pattern-interpreted.
    const newPhaseSection = phaseSection.replace(
      plansBlockMatch[0],
      () => leadingNewline + plansHeader + newListBlock
    );

    const nextContent = content.slice(0, phaseStart) + newPhaseSection + content.slice(phaseEnd);
    // #5321: compare post-normalize (platformWriteSync collapses blank runs), not raw strings.
    if (!contentChangedAfterNormalize(roadmapPath, content, nextContent)) return;
    platformWriteSync(roadmapPath, nextContent);
    updated = true;
  });

  output({
    updated,
    phase: phaseNum,
    waves: waves.length,
    cross_cutting_constraints: crossCuttingTruths.length,
    ...(skipped && { skipped }),
    ...(staleLegacy.length > 0 && { stale_legacy_constraints: staleLegacy }),
    ...(droppedGenerated.length > 0 && { dropped_generated_constraints: droppedGenerated }),
  }, raw, updated ? `annotated ${waves.length} wave(s), ${crossCuttingTruths.length} constraint(s)` : skipped ? `skipped (${skipped})` : 'skipped (already up to date or no plan list)');
}


export = {
  cmdRoadmapGetPhase,
  getRoadmapPhaseWithFallback,
  cmdRoadmapAnalyze,
  cmdRoadmapMilestoneScope,
  cmdRoadmapUpdatePlanProgress,
  cmdRoadmapAnnotateDependencies,
  buildPhaseHeadingRegex,
  editFromPhaseTable,
  findPhaseTableHeader,
  editProgressTableSlice,
  foldPhaseId,
  insideOpenDetails,
  checklistEntrySrc,
};
