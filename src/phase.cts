/**
 * Phase — Phase CRUD, query, and lifecycle operations
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/phase.cjs collapsed to
 * a TypeScript source of truth, compiled by tsc to a gitignored .cjs at the
 * same require() path. Behaviour preserved byte-for-behaviour; only types are added.
 *
 * Re-export shim note (issue #4 / ADR-3524):
 *   The phase lifecycle pure-computation helpers live in phase-lifecycle.cjs.
 *   cmdPhaseComplete uses
 *   deriveProgressFromRoadmap + clampPercent from that module to fix the
 *   non-idempotent Completed Phases blind-increment bug.
 *
 *   The async mutation handlers (phaseAdd, phaseInsert, phaseRemove, phaseComplete)
 *   in phase-lifecycle.ts are I/O-bound and remain per-side per ADR-3524 Section 4.
 *   This file provides the CJS (sync) implementations of those handlers.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- io.cjs is an export= CommonJS module
import ioMod = require('./io.cjs');
const { output, error, ERROR_REASON, formatDiagnosticToken } = ioMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import stateContract = require('./state-contract.cjs');
const { publishStateContract } = stateContract;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- config-loader.cjs is an export= CommonJS module
import configLoaderMod = require('./config-loader.cjs');
const { loadConfig } = configLoaderMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- core-utils.cjs is an export= CommonJS module
import coreUtilsMod = require('./core-utils.cjs');
// #2528: `extractCanonicalPlanId` used to exist here as a byte-identical second
// copy, and this PR had to patch BOTH with the same rewind rule — the exact
// generative-fix divergence CLAUDE.md warns about. Collapsed onto core-utils'
// copy, which was already the leaf owner, so there is no second surface left to
// drift and no parity test needed to police one.
const {
  toPosixPath, generateSlugInternal, readSubdirectories, extractCanonicalPlanId,
  findUnsummarizedPlans, normalizeLineEndings,
} = coreUtilsMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- phase-id.cjs is an export= CommonJS module
import phaseIdMod = require('./phase-id.cjs');
const {
  normalizePhaseName,
  phaseMarkdownRegexSource,
  comparePhaseNum,
  matchPhaseDirs,
  phaseNumberForMatch,
  phaseKeyFromDir,
  isSentinelPhaseId,
  scopeToPhase,
  parsePhaseId,
  renderPhaseId,
  renderMilestoneId,
  toDir,
  phaseHeadingPrefixSrcFor,
  parsePhaseChecklistLine,
  PHASE_HEADING_BASELINE,
  OPTIONAL_PROJECT_CODE_PREFIX_SOURCE,
  OPTIONAL_PHASE_TAG_SOURCE,
  PHASE_NUMBER_TOKEN_SOURCE,
  BRACKET_DIR_PREFIX_SRC,
  tokenizePhaseDependencyReferences,
  foldBracketId,
} = phaseIdMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseIdDisplayMod = require('./phase-id-display.cjs');
// #4304 review fix (Major): reuse the Phase Id Display Module's milestone/phase
// numeric canonicalization instead of re-deriving it here — see
// bracketWriteContext/bracketPhaseId below.
const { milestoneToken, phaseToken } = phaseIdDisplayMod;
import { escapeRegex } from './pattern.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- phase-locator.cjs is an export= CommonJS module
import phaseLocatorMod = require('./phase-locator.cjs');
const {
  findPhaseInternal, getArchivedPhaseDirs, listMilestonePhaseDirs, listAllPhaseDirs,
  resolvePhaseDirectoryLookup, matchPhaseDirsForLookup,
} = phaseLocatorMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- planning-scope.cjs is an export= CommonJS module
import planningScopeMod = require('./planning-scope.cjs');
const { SCOPE } = planningScopeMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- roadmap-parser.cjs is an export= CommonJS module
import roadmapParserMod = require('./roadmap-parser.cjs');
const {
  stripShippedMilestones,
  extractCurrentMilestone,
  currentMilestoneRawRanges,
  withPhaseSection,
  findMilestoneScopeHeadingLines,
  getMilestoneInfo,
  scanMilestonePhaseIds,
  // #4304 (W1): every recognized milestone heading in the document,
  // not just the active one — see bracketProgressSectionOwnedByOtherMilestone.
  listMilestoneHeadings,
  selectMilestoneHeading,
  // #4304 (W1): the SAME bracket milestone-boundary grammar the
  // window locator uses (bracketAwareMilestoneSection), reused so the
  // marker set below recognizes a version-less bracket milestone heading
  // too, not only a version-token one.
  isBracketMilestoneBoundary,
  // #4304 (B1): the SAME closed/shipped-heading predicate
  // currentMilestoneRawRanges uses, reused so the pre-mutation window guard
  // (bracketOwnedLineOutsideActiveWindow) can recognize an archived section
  // instead of a re-typed copy of MILESTONE_CLOSED_MARKER_PATTERN.
  isClosedMilestoneHeading,
  isClosedMilestoneDetails,
  isRecognizedMilestoneHeading,
  isPhaseEntryHeading,
} = roadmapParserMod;
// #4129: the single owner of "count the ROADMAP's milestone Complete rows"
// (pure computation, no I/O — no cycle on this path) for the intent-first
// progress counters the phase-complete transaction passes downstream.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- phase-lifecycle.cjs is an export= CommonJS module
import phaseLifecycleMod = require('./phase-lifecycle.cjs');
const { deriveProgressFromRoadmap: deriveProgressFromRoadmapForIntent, clampPercent: clampPercentForIntent } = phaseLifecycleMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- planning-workspace.cjs is an export= CommonJS module
import planningWorkspace = require('./planning-workspace.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- frontmatter.cjs is an export= CommonJS module
import frontmatterMod = require('./frontmatter.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- state.cjs is an export= CommonJS module
import stateMod = require('./state.cjs');
import { platformWriteSync, platformReadSync, platformEnsureDir, retryRenameSync, contentChangedAfterNormalize } from './shell-command-projection.cjs';
import { parsePlanningDoc, findField, readNode, setFieldValue, serialize } from './planning-document.cjs';
import { formatGsdSlash, resolveRuntime } from './runtime-slash.cjs';
import { realClock } from './clock.cjs';
import { transitionCore } from './state-transition.cjs';
import { updateTableCell, deleteTableRow, escapeCell, splitTableRow } from './markdown-table.cjs';
import { deleteSection, updateBullet, tokenizeHeadings, scanFencedBlocks, type HeadingToken } from './markdown-sectionizer.cjs';
import { PathAcceptance, tryWithinRoot } from './security.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- uat-predicate.cjs is an export= CommonJS module
import uatPredicate = require('./uat-predicate.cjs');
const { evaluateUatPassed } = uatPredicate;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- verification.cjs is an export= CommonJS module
import verificationMod = require('./verification.cjs');
// #2572: the artifact↔disk core behind the `verify-summary` verb. `verify.cts`
// has no transitive import path back to `phase.cts`, so this edge introduces no
// cycle (the reverse edge, `state.cts → verify.cjs`, would).
// eslint-disable-next-line @typescript-eslint/no-require-imports -- verify.cjs is an export= CommonJS module
import verifyMod = require('./verify.cjs');
const { readVerificationStatus } = verificationMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- plan-dependency-graph.cjs is an export= CommonJS module
import planDependencyGraphMod = require('./plan-dependency-graph.cjs');
const { computeHaltPropagation, buildSummaryFileIndex, isSummaryFileHalted, isSummaryFileBlocked } = planDependencyGraphMod;

// #612: `resolvePhaseIdConvention` selects the write-time milestone-scope
// guard's terminator vocabulary (see assertDescriptionPreservesMilestoneScope).
const {
  planningDir, withPlanningLock, listAvailableWorkstreams,
  peekActiveWorkstream, diagnoseUnresolvedActiveWorkstream, describeUnresolvedWorkstreamReason,
  resolveEnvWorkstream, resolvePhaseIdConvention,
} = planningWorkspace;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- milestone-lock.cjs is an export= CommonJS module
import milestoneLockMod = require('./milestone-lock.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planDocumentMod = require('./plan-document.cjs');
const { parsePlanDocument, planIdFromFile } = planDocumentMod;
const { extractFrontmatter } = frontmatterMod;
const {
  readModifyWriteStateMd,
  stateExtractField,
  stateReplaceField,
  syncAndPreserveStateMd,
  withStateLock,
  updatePerformanceMetricsSection,
} = stateMod;

// #4304: matchPhaseDirs admits legacy directories under bracket mode for
// migration compatibility. Only a directory carrying the owner grammar's
// bracket prefix may enter bracket-only result parsing.
const BRACKET_DIRECTORY_PREFIX_RE = new RegExp(`^${BRACKET_DIR_PREFIX_SRC}`);

// Any .md file with PLAN anywhere in the basename — diagnostic net
const PLAN_OUTLINE_RE = /-PLAN-OUTLINE\.md$/i;
const PLAN_PRE_BOUNCE_RE = /-PLAN.*\.pre-bounce\.md$/i;
const looksLikePlanFile = (f: string): boolean =>
  /\.md$/i.test(f) &&
  /PLAN/i.test(f) &&
  !PLAN_OUTLINE_RE.test(f) &&
  !PLAN_PRE_BOUNCE_RE.test(f);

/**
 * Scope an `updateTableCell` call to the `## Traceability` (or
 * `## Traceability Status`) heading's own section — up to the next H1/H2
 * heading — instead of handing it the WHOLE REQUIREMENTS.md content.
 *
 * F1 (#2245 review, BLOCKER): `updateTableCell` binds to the FIRST GFM table
 * found in whatever text it is given. The shipped requirements template
 * (gsd-core/templates/requirements.md) puts an `## Out of Scope` table
 * (`| Feature | Reason |`, no `Status` column) BEFORE `## Traceability` — so
 * an unscoped whole-file call targets the Out-of-Scope table instead, fails
 * with `{ok:false, reason:'unknown column: Status'}`, and the real
 * Traceability row is never flipped, while the checkbox surface still flips
 * and the command reports success (the #2140 silent-divergence class one
 * level deeper). Mirrors `editProgressHeadingSlice` below, which scopes
 * `## Progress` writes to that heading's own slice for the same reason.
 *
 * Falls back to running `updateTableCell` against the whole `text` when no
 * `## Traceability` heading exists — matching the previous (unscoped)
 * behaviour for a REQUIREMENTS.md whose traceability table sits under some
 * other heading, or with no heading at all (never worse than before this fix).
 */
function updateTraceabilityCell(
  text: string,
  match: (row: Record<string, string>, index: number) => boolean,
  column: string,
  newValue: string | ((current: string) => string),
): ReturnType<typeof updateTableCell> {
  const headingMatch = text.match(/^##[ \t]+Traceability(?:[ \t]+Status)?\b/im);
  if (!headingMatch || headingMatch.index === undefined) {
    return updateTableCell(text, match, column, newValue);
  }
  const headingOffset = headingMatch.index;
  const before = text.slice(0, headingOffset);
  const fromHeading = text.slice(headingOffset);
  const nextHeadingOffset = fromHeading.search(/\n#{1,2}[ \t]/);
  const scoped = nextHeadingOffset >= 0 ? fromHeading.slice(0, nextHeadingOffset) : fromHeading;
  const after = nextHeadingOffset >= 0 ? fromHeading.slice(nextHeadingOffset) : '';

  const result = updateTableCell(scoped, match, column, newValue);
  if (!result.ok) return result;
  return { ok: true, value: before + result.value + after };
}

/**
 * Extract the MAJOR version segment from a version-ish string: "v1", "v1.3",
 * "V1.0", and "1.0" all yield "1"; "v2" yields "2". Used (#2334 BLOCKER fix)
 * to compare a `## v<N> ...` REQUIREMENTS.md heading against the current
 * milestone's version at MAJOR-version granularity only — "v1" heading vs
 * milestone "v1.3" is the SAME major version and must not be treated as a
 * version mismatch. Returns null when `raw` has no leading digit run (not a
 * version-shaped string), which the caller treats as "cannot resolve".
 */
function extractMajorVersion(raw: string): string | null {
  const m = raw.trim().match(/^v?(\d+)/i);
  return m ? m[1] : null;
}

function describeNonCanonicalPlans(dirFiles: string[], matchedFiles: string[]): string | null {
  const matched = new Set(matchedFiles);
  const offenders = dirFiles.filter((f) => looksLikePlanFile(f) && !matched.has(f));
  if (offenders.length === 0) return null;
  return (
    `Found ${offenders.length} plan-shaped file(s) in this phase that don't match the canonical ` +
    `naming convention "{padded_phase}-{NN}-PLAN.md" (or bare "PLAN.md") and were skipped: ` +
    offenders.map((f) => `"${f}"`).join(', ') +
    `. Rename to the canonical form (e.g. "01-01-PLAN.md") so the executor can detect them. ` +
    `See agents/gsd-planner.md write_phase_prompt step for the full contract.`
  );
}


interface PhaseListOptions {
  type?: string;
  phase?: string;
  includeArchived?: boolean;
}

function cmdPhasesList(cwd: string, options: PhaseListOptions, raw: boolean): void {
  const phasesDir = path.join(planningDir(cwd), 'phases');
  const { type, phase, includeArchived } = options;

  if (!fs.existsSync(phasesDir)) {
    if (type) {
      output({ files: [], count: 0 }, raw, '');
    } else {
      output({ directories: [], count: 0 }, raw, '');
    }
    return;
  }

  try {
    // #3185 (ADR-3180 Decision 1): only the ENUMERATION routes through the
    // single owner. The two other modes below ask genuinely DIFFERENT
    // questions and are exempt by documented reason, never by a file
    // allowlist (ADR-3180 Decision 4a):
    //
    //   --phase <n>        locating ONE phase by token is phase LOCATION, a
    //                      question src/phase-locator.cts already owns via
    //                      findPhaseInternal/searchPhaseInDir. Scoping it to
    //                      the current milestone would make an out-of-window
    //                      phase report "Phase not found".
    //   --include-archived archived directories are BY DEFINITION from other
    //                      milestones; filtering them through the CURRENT
    //                      milestone window would return nothing at all.
    //
    // Generalizing #3183's rule ("a diagnostic about file NAMING wants the
    // physical set; only a question about outstanding WORK wants the live
    // set"): a LOOKUP wants the physical set; only "which phases belong to
    // this milestone" wants the scoped set.
    const archivedLabels: string[] = includeArchived
      ? getArchivedPhaseDirs(cwd).map((a) => `${a.name} [${a.milestone}]`)
      : [];

    let dirs: string[];
    // #3185 (ADR-3180 Decision 2): the enumeration's scope, so a consumer
    // can tell a genuinely-empty milestone from one it could not scope. Only
    // the ENUMERATION path scopes anything; the LOOKUP path below has no
    // enumeration to report a scope for.
    let phaseScope: string | null = null;
    if (phase) {
      // LOOKUP (b): search the physical set, plus archived when asked.
      const lookupPool = [...readSubdirectories(phasesDir, true), ...archivedLabels];
      const lookup = resolvePhaseDirectoryLookup(cwd, phase);
      // The pool is #3185's (physical set + archived); the matcher is this
      // PR's. `dirs` is deliberately not read here: on this base it is not
      // assigned until the branch below picks a match. Under bracket, the
      // active project+milestone identity wins before migration-window legacy
      // names; differently-qualified historical dirs are never first-picked.
      const { matches } = matchPhaseDirsForLookup(lookupPool, lookup);
      const match = matches[0];
      if (!match) {
        output({ files: [], count: 0, phase_dir: null, error: 'Phase not found' }, raw, '');
        return;
      }
      dirs = [match];
    } else {
      // ENUMERATION (a): milestone-scoped and sentinel-filtered, plus
      // archived when asked (c).
      const enumerated = listMilestonePhaseDirs(phasesDir, { cwd });
      phaseScope = enumerated.scope;
      dirs = [...enumerated.value, ...archivedLabels];
      dirs.sort((a, b) => comparePhaseNum(a, b));
    }

    if (type) {
      const files: string[] = [];
      const warnings: string[] = [];
      for (const dir of dirs) {
        const dirPath = path.join(phasesDir, dir);
        const dirFiles = fs.readdirSync(dirPath);

        let filtered: string[];
        if (type === 'plans') {
          // #3183: this is a "what plan files physically exist" query (this
          // IS the file-listing command), not a live-completion question, so
          // it uses the single owner's allPlanFiles (root+nested, INCLUDING
          // status: superseded) rather than a root-only readdirSync filter
          // that also missed nested plans.
          //
          // #2893 (regression fix): `allPlanFiles` also carries
          // `isRootPlanFile`'s loose `/PLAN/i` fallback (deliberately
          // permissive for live-plan COUNTING elsewhere — see
          // plan-count-single-owner.test.cjs). That fallback silently
          // recognized a non-canonically-named file (e.g.
          // `01-PLAN-01-foundation.md`) as "matched", which defeated this
          // command's #2893 naming-convention diagnostic entirely (no
          // warning, file listed as if valid). Intersect with the STRICT
          // `isCanonicalPlanFile` predicate so this diagnostic — and the
          // `files` list this command actually returns — only ever
          // recognizes the canonical root/nested forms, exactly like the
          // pre-#3183 behavior this feature was built and tested against.
          filtered = scanPhasePlans(dirPath).allPlanFiles.filter(isCanonicalPlanFile);
          const w = describeNonCanonicalPlans(dirFiles, filtered);
          if (w) warnings.push(`${dir}: ${w}`);
        } else if (type === 'summaries') {
          filtered = scanPhasePlans(dirPath).summaryFiles;
        } else {
          filtered = dirFiles;
        }

        files.push(...filtered.sort());
      }

      const result: Record<string, unknown> = {
        files,
        count: files.length,
        phase_dir: phase ? dirs[0].replace(/^\d+(?:\.\d+)*-?/, '') : null,
        // #3185 (ADR-3180 Decision 2): the enumeration's scope, so a consumer
        // can tell a genuinely-empty milestone from one it could not scope.
        phase_scope: phaseScope,
      };
      if (warnings.length) result['warning'] = warnings.join(' | ');
      output(result, raw, files.join('\n'));
      return;
    }

    // #3185 (ADR-3180 Decision 2): the enumeration's scope, so a consumer
    // can tell a genuinely-empty milestone from one it could not scope.
    output({ directories: dirs, count: dirs.length, phase_scope: phaseScope }, raw, dirs.join('\n'));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    error('Failed to list phases: ' + msg);
  }
}

function cmdPhaseNextDecimal(cwd: string, basePhase: string, raw: boolean): void {
  const phasesDir = path.join(planningDir(cwd), 'phases');
  const lookup = resolvePhaseDirectoryLookup(cwd, basePhase);
  const normalized = lookup.normalized;
  // #4304: base existence and decimal-child inventory must resolve through
  // the same convention. Round 17 found the former was bracket-aware while
  // the latter still called the legacy-only scanner, proposing an occupied
  // bracket sub-phase. Legacy conventions retain their historical call and
  // output spelling byte-for-byte.
  const convention = resolvePhaseIdConvention(cwd) === 'bracket' ? 'bracket' : undefined;
  const bracketContext = convention === 'bracket'
    ? bracketWriteContext(cwd, loadConfig(cwd))
    : null;

  try {
    let baseExists = false;
    const decimalSet = new Set<number>();
    const bracketScanMeta = { bracketSpellingFound: false };
    const scanDecimals = (roadmapContent: string): void => {
      const found = bracketContext
        ? scanExistingBracketDecimalPhaseNumbers(
          phasesDir,
          roadmapContent ? extractCurrentMilestone(roadmapContent, cwd) : '',
          normalized,
          bracketContext,
          bracketScanMeta,
        )
        : scanExistingDecimalPhaseNumbers(phasesDir, roadmapContent, normalized);
      for (const n of found) decimalSet.add(n);
    };

    if (fs.existsSync(phasesDir)) {
      const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
      const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
      baseExists = matchPhaseDirs(dirs, normalized, convention, lookup.bracketContext).matches.length > 0;
    }

    const roadmapPath = path.join(planningDir(cwd), 'ROADMAP.md');
    if (fs.existsSync(roadmapPath)) {
      try {
        const roadmapContent = fs.readFileSync(roadmapPath, 'utf-8');
        scanDecimals(roadmapContent);
      } catch {
        // ROADMAP.md read failure is non-fatal — fall back to the directory-only
        // scan (empty rawContent) so on-disk decimal directories are still counted.
        scanDecimals('');
      }
    } else {
      scanDecimals('');
    }

    // add-backlog still asks for parent 999 and writes legacy CK-999.x
    // directories. Preserve that upstream output only when the sentinel
    // parent is legacy-only; a real bracket-spelled parent keeps canonical
    // two-digit sub-tokens like every other bracket parent.
    const renderCanonicalBracket = bracketContext !== null
      && !(Number(normalized) === 999 && !bracketScanMeta.bracketSpellingFound);
    const existingDecimals = Array.from(decimalSet)
      .sort((a, b) => a - b)
      .map((n) => renderCanonicalBracket
        ? bracketArtifactToken(bracketPhaseId(bracketContext, normalized, n))
        : `${normalized}.${n}`);

    let nextDecimal: string;
    if (decimalSet.size === 0) {
      nextDecimal = renderCanonicalBracket
        ? bracketArtifactToken(bracketPhaseId(bracketContext, normalized, 1))
        : `${normalized}.1`;
    } else {
      const next = Math.max(...decimalSet) + 1;
      nextDecimal = renderCanonicalBracket
        ? bracketArtifactToken(bracketPhaseId(bracketContext, normalized, next))
        : `${normalized}.${next}`;
    }

    output(
      {
        found: baseExists,
        base_phase: normalized,
        next: nextDecimal,
        existing: existingDecimals,
      },
      raw,
      nextDecimal,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    error('Failed to calculate next decimal phase: ' + msg);
  }
}

function getRoadmapModeForPhase(cwd: string, phaseNum: string): string | null {
  const roadmapPath = path.join(planningDir(cwd), 'ROADMAP.md');
  if (!fs.existsSync(roadmapPath)) return null;

  const rawContent = fs.readFileSync(roadmapPath, 'utf-8');
  const milestoneContent = extractCurrentMilestone(rawContent, cwd);
  const fullContent = stripShippedMilestones(rawContent);
  const convention = resolvePhaseIdConvention(cwd);
  // LABEL_ONLY preserves the legacy `Phase N:` reader while adding the
  // opted-in bracket heading alternative for both the target and its boundary.
  const headingIntro = phaseHeadingPrefixSrcFor(
    PHASE_HEADING_BASELINE.LABEL_ONLY,
    convention,
  );
  const escapedPhase = phaseMarkdownRegexSource(phaseNum);
  const phaseHeader = new RegExp(
    `#{2,4}\\s*${headingIntro}${escapedPhase}${OPTIONAL_PHASE_TAG_SOURCE}\\s*:`,
    'i',
  );

  for (const content of [milestoneContent, fullContent]) {
    const headerMatch = content.match(phaseHeader);
    if (!headerMatch || headerMatch.index === undefined) continue;

    const sectionStart = headerMatch.index;
    const rest = content.slice(sectionStart);
    const nextHeader = rest.slice(headerMatch[0].length).match(
      new RegExp(`\\n#{2,4}\\s+${headingIntro}\\S`, 'i'),
    );
    const sectionEnd = nextHeader
      ? sectionStart + headerMatch[0].length + (nextHeader.index as number)
      : content.length;
    const section = content.slice(sectionStart, sectionEnd);
    const modeMatch = section.match(/\*\*Mode(?::\*\*|\*\*:)\s*([^\n]+)/i);
    if (modeMatch) return modeMatch[1].trim().toLowerCase();
  }

  return null;
}

function cmdPhaseMvpMode(cwd: string, args: string[], raw: boolean): void {
  const phaseNum = args[0];
  if (!phaseNum) {
    error('Usage: phase.mvp-mode <phase-number> [--cli-flag]', ERROR_REASON.USAGE);
  }

  const cliFlagPresent = args.includes('--cli-flag');
  const roadmapMode = getRoadmapModeForPhase(cwd, phaseNum);
  const config = loadConfig(cwd);
  const configMvpMode = Boolean(config.mvp_mode);

  let active = false;
  let source = 'none';
  if (cliFlagPresent) {
    active = true;
    source = 'cli_flag';
  } else if (roadmapMode === 'mvp') {
    active = true;
    source = 'roadmap';
  } else if (configMvpMode) {
    active = true;
    source = 'config';
  }

  output(
    {
      active,
      source,
      roadmap_mode: roadmapMode,
      config_mvp_mode: configMvpMode,
      cli_flag_present: cliFlagPresent,
    },
    raw,
  );
}

/**
 * `phase.tdd-applicable <plan-file> [--cli-flag]` (#4273, Phase 1 of epic
 * #4272) — resolves whether the TDD RED/GREEN/REFACTOR gate applies to a
 * given plan, in strict precedence order: an explicit `--cli-flag` wins over
 * the plan's own `type: tdd` frontmatter, which wins over any task in the
 * plan carrying `tdd="true"` (the #4265 mixed-mode shape), which wins over
 * the project-wide `workflow.tdd_mode` config default. Mirrors
 * `cmdPhaseMvpMode`'s precedence-cascade shape immediately above.
 */
function cmdPhaseTddApplicable(cwd: string, args: string[], raw: boolean): void {
  const planPath = args[0];
  if (!planPath) {
    error('Usage: phase.tdd-applicable <plan-file> [--cli-flag]', ERROR_REASON.USAGE);
  }

  const resolvedPath = path.isAbsolute(planPath) ? planPath : path.join(cwd, planPath);
  if (!fs.existsSync(resolvedPath)) {
    error(`Plan file not found: ${planPath}`, ERROR_REASON.PHASE_NOT_FOUND);
  }

  const cliFlagPresent = args.includes('--cli-flag');
  const content = fs.readFileSync(resolvedPath, 'utf-8');
  const doc = parsePlanDocument(content, resolvedPath);
  const planType = doc.type;
  const taskTddAttribute = doc.tasks.some((t) => t.tdd === 'true');
  const config = loadConfig(cwd);
  const configTddMode = Boolean(config.tdd_mode);

  let applicable = false;
  let source = 'none';
  if (cliFlagPresent) {
    applicable = true;
    source = 'cli_flag';
  } else if (planType === 'tdd') {
    applicable = true;
    source = 'plan_frontmatter';
  } else if (taskTddAttribute) {
    applicable = true;
    source = 'task_attribute';
  } else if (configTddMode) {
    applicable = true;
    source = 'config';
  }

  output(
    {
      applicable,
      source,
      plan_type: planType,
      config_tdd_mode: configTddMode,
      cli_flag_present: cliFlagPresent,
    },
    raw,
  );
}

function cmdFindPhase(cwd: string, phase: string, raw: boolean): void {
  if (!phase) {
    error('phase identifier required');
  }

  const planBase = planningDir(cwd);
  const lookup = resolvePhaseDirectoryLookup(cwd, phase);
  const { normalized, convention } = lookup;
  const notFound = {
    found: false,
    directory: null,
    phase_number: null,
    phase_name: null,
    plans: [],
    summaries: [],
    // #3218: scalar counts alongside the arrays above. Left `null` (not `0`)
    // when the phase can't be resolved at all — a fabricated `0` here would
    // read identically to "phase exists with zero plans", which is a real,
    // distinct answer (see the `status: superseded` case below).
    plan_count: null,
    summary_count: null,
    plan_count_all: null,
    searched_directories: [] as string[],
  };

  const searchDirs: string[] = [];
  const flatPhasesDir = path.join(planBase, 'phases');
  if (fs.existsSync(flatPhasesDir)) searchDirs.push(flatPhasesDir);
  try {
    const milestonesDir = path.join(planBase, 'milestones');
    const entries = fs
      .readdirSync(milestonesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^v\d+.*-phases$/.test(e.name))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const e of entries) {
      searchDirs.push(path.join(milestonesDir, e.name));
    }
  } catch {
    /* no milestones dir */
  }

  notFound.searched_directories = searchDirs.map((searchDir) =>
    toPosixPath(
      path.join(path.relative(cwd, planBase), path.relative(planBase, searchDir)),
    ),
  );

  for (const searchDir of searchDirs) {
    try {
      const entries = fs.readdirSync(searchDir, { withFileTypes: true });
      const dirs = entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort((a, b) => comparePhaseNum(a, b));

      // #2237: fail loud when multiple directories match the same bare phase
      // number — prevents cross-project file writes when unrelated projects
      // share a .planning/phases/ tree.
      // #2528: selection delegates to the canonical two-pass matcher (exact
      // token match, then the bare-integer leading-digit-run fallback) shared
      // with the locator and the phase-plan-index scan.
      const { matches, usedBareFallback } = matchPhaseDirsForLookup(
        dirs,
        lookup,
        searchDir === flatPhasesDir ? undefined : null,
      );
      if (matches.length === 0) continue;
      if (matches.length > 1) {
        output({
          ...notFound,
          ambiguous_matches: matches,
          warning: `Phase ${normalized} is ambiguous: ${matches.length} directories match (${matches.map(m => `"${m}"`).join(', ')}). Set a distinct project_code in .planning/config.json to scope resolution.`,
        }, raw, '');
        return;
      }
      const match = matches[0];

      const isBracketDirectory = convention === 'bracket'
        && BRACKET_DIRECTORY_PREFIX_RE.test(foldBracketId(match));
      const dirMatch = isBracketDirectory
        ? null
        : match.match(
          new RegExp(`^${OPTIONAL_PROJECT_CODE_PREFIX_SOURCE}(${PHASE_NUMBER_TOKEN_SOURCE})-?(.*)`, 'i')
        ) || match.match(new RegExp(`^(${PHASE_NUMBER_TOKEN_SOURCE})-?(.*)`, 'i'));
      const phaseNumber = isBracketDirectory
        ? phaseNumberForMatch(match, usedBareFallback, convention)
        : dirMatch ? dirMatch[1] : normalized;
      let phaseName = dirMatch && dirMatch[2] ? dirMatch[2] : null;
      if (isBracketDirectory) {
        const id = parsePhaseId(match);
        const idToken = `${id.phase}${id.subphase ? `.${id.subphase}` : ''}`;
        phaseName = match.slice(`${id.project}.${id.milestone}-${idToken}`.length).replace(/^-/, '') || null;
      }

      const phaseDir = path.join(searchDir, match);
      const phaseFiles = fs.readdirSync(phaseDir);
      // #3183: canonical, live (superseded-excluded) plan/summary sets
      // (root+nested) from the single owner, rather than a root-only
      // isCanonicalPlanFile filter + hand-rolled summary filter.
      //
      // #2893 (regression fix): both `plans` and the naming-diagnostic
      // "matched" set are further intersected with the STRICT
      // `isCanonicalPlanFile` predicate — scanPhasePlans's own
      // planFiles/allPlanFiles carry `isRootPlanFile`'s loose `/PLAN/i`
      // fallback (deliberately permissive for live-plan COUNTING elsewhere),
      // which silently recognized a non-canonically-named file (e.g.
      // `01-PLAN-01-foundation.md`) as a valid plan here and defeated this
      // command's #2893 naming-convention diagnostic (no warning, offender
      // listed in `plans` as if valid).
      const phaseScan = scanPhasePlans(phaseDir);
      const plans = phaseScan.planFiles.filter(isCanonicalPlanFile).sort();
      const summaries = phaseScan.summaryFiles.slice().sort();
      // describeNonCanonicalPlans is a NAMING-CONVENTION diagnostic, unrelated
      // to supersession — compare against allPlanFiles (every plan-shaped file
      // the owner recognizes, canonical or not) rather than the live-only
      // `plans`, so a superseded-but-canonically-named plan is not misreported
      // as a naming violation.
      const canonicalAllPlanFiles = phaseScan.allPlanFiles.filter(isCanonicalPlanFile);
      const planNamingWarning = describeNonCanonicalPlans(phaseFiles, canonicalAllPlanFiles);

      const result: Record<string, unknown> = {
        found: true,
        directory: toPosixPath(
          path.join(
            path.relative(cwd, planBase),
            path.relative(planBase, searchDir),
            match,
          ),
        ),
        phase_number: phaseNumber,
        phase_name: phaseName,
        plans,
        summaries,
        // #3218: scalar counts additive alongside `plans[]`/`summaries[]`,
        // which stay unchanged for existing consumers. Naming mirrors
        // `roadmap.analyze`'s `plan_count`/`summary_count` (live, i.e.
        // status:superseded EXCLUDED — same set as `plans`/`summaries`
        // above) so the two surfaces read alike. `plan_count_all` is the
        // PHYSICAL count — every canonically-named plan file on disk,
        // status:superseded INCLUDED, same set `planNamingWarning` above
        // diffs against (`canonicalAllPlanFiles`). The `_all` suffix
        // deliberately echoes `scanPhasePlans`'s own `allPlanFiles` field so
        // a reader can trace the name back to its source rather than guess
        // which of two similarly-named integers is the filtered one.
        plan_count: plans.length,
        summary_count: summaries.length,
        plan_count_all: canonicalAllPlanFiles.length,
      };
      if (planNamingWarning) result['warning'] = planNamingWarning;

      output(result, raw, result['directory']);
      return;
    } catch {
      continue;
    }
  }

  output(notFound, raw, '');
}

interface RawPlan {
  id: string;
  declaredWave: number | null;
  dependsOn: string[];
  autonomous: boolean;
  objective: string | null;
  filesModified: string[];
  filesDeleted: string[];
  taskCount: number;
  hasSummary: boolean;
  /** #2830: true iff this plan's own SUMMARY declares `status: halted` (a designed stop). */
  halted: boolean;
  /** #1689: optional per-plan specialist executor hint (frontmatter `agent_hint:`). null when unset. */
  agentHint: string | null;
}

/**
 * Resolve a raw `depends_on` token to the `RawPlan.id` it refers to
 * (case-folded exact match, falling back to canonical-id matching, falling
 * back to the in-phase short-form plan number — #3897 rung 4). Returns
 * `null` when the token does not resolve to any plan in this phase (a typo
 * or a cross-phase reference) — every call site treats that as "ignore this
 * edge", never a throw. Shared by `computeDependencyLevels`'s DAG-edge
 * resolution and (#2830) the halt-propagation node resolution, so the two can
 * never disagree about which token resolves to which plan. NOT used by the
 * `depends_on` display mapping (#3785/N3) — that stays a passthrough by
 * design; see the comment at its call site.
 *
 * `shortFormToId` (#3897 rung 4, ADR-3473 §8.9) is the third tier, consulted
 * only when neither `planMap` nor `canonicalToId` resolves the token. It is
 * optional so any caller that has not been threaded through yet (there are
 * none left in this file) degrades to the pre-#3897 two-tier behavior rather
 * than throwing on a missing argument.
 */
function resolveDependencyId(
  dep: string,
  planMap: Map<string, RawPlan>,
  canonicalToId: Map<string, string>,
  shortFormToId?: Map<string, string>,
): string | null {
  const lower = dep.toLowerCase();
  if (planMap.has(lower)) return (planMap.get(lower) as RawPlan).id;
  if (canonicalToId.has(lower)) return canonicalToId.get(lower) as string;
  return shortFormToId?.get(lower) ?? null;
}

// #3897 rung 4 (ADR-3473 §8.9) — builds the third depends_on resolution tier:
// a map from an in-phase BARE PLAN NUMBER (e.g. "01") to the plan id whose
// canonical id ends with that number. Recovered from the retired SDK lineage
// (sdk/src/query/phase.ts at 11918dcc3^) with ONE deliberate narrowing: the
// lost implementation indexed ANY trailing dash-segment of a canonical id,
// with no constraint that the segment be a plan NUMBER — so a phase
// containing both `09-FIX-auth-PLAN.md` and `09-GAP-auth-PLAN.md` (canonical
// id `09-FIX-auth`, trailing segment "auth") would silently bind
// `depends_on: ["auth"]` to whichever sorted first, fabricating a
// wave-affecting DAG edge with ZERO warning — a mis-resolved edge, which is
// worse than a dropped one (found in isolated correctness review, #3897).
// `docs/reference/plan-md.md` already documents this tier as resolving "the
// bare plan number", so requiring `/^\d+$/` on the trailing segment is a
// strict narrowing onto the tier's OWN documented contract, not a behavior
// change for any legitimate input. Do NOT restore the unconstrained
// lastDash-slice "to match the recovered original" — the original was wrong
// here; this rung deliberately departs from it in this one respect, and only
// this one. Everything else — the `lastDash` bound, first-write-wins,
// lowercasing — is kept exactly as recovered:
//   - first write wins, deterministic because rawPlans is passed in sorted
//     plan-file order (D4/T44) and this loop iterates in that same order;
//   - a canonical id with no dash (`lastDash === -1` or `lastDash === 0`,
//     e.g. "24" or "-01") or a trailing dash (`lastDash === canonical.length
//     - 1`, e.g. "09-") is never indexed (D5).
// Exported so callers can build this map once and so tests assert against
// this REAL implementation rather than a hand-rolled copy that could
// silently disagree with it after a future change here (CLAUDE.md's
// generative-fix-divergence rule).
function buildShortFormToId(rawPlans: RawPlan[]): Map<string, string> {
  const shortFormToId = new Map<string, string>();
  for (const p of rawPlans) {
    const canonical = extractCanonicalPlanId(p.id);
    const lastDash = canonical.lastIndexOf('-');
    if (lastDash > 0 && lastDash < canonical.length - 1) {
      const shortForm = canonical.slice(lastDash + 1).toLowerCase();
      if (/^\d+$/.test(shortForm) && !shortFormToId.has(shortForm)) {
        shortFormToId.set(shortForm, p.id);
      }
    }
  }
  return shortFormToId;
}

// O(V + E). Assigns each in-phase plan its longest-path topological level over the
// in-phase dependsOn DAG (Kahn's algorithm). Returns { level: Map<id,number>, visited: number,
// order: string[] }. visited < rawPlans.length signals a dependency cycle. `order` (#2830) is
// the exact dequeue order this pass already produces — a valid topological order — passed to
// computeHaltPropagation as `precomputedOrder` so halt propagation does not re-run Kahn's
// algorithm a second time over the same graph.
//
// `shortFormToId` (#3897 rung 4, optional — see resolveDependencyId) is threaded through so a
// bare in-phase plan-number token (`depends_on: ["01"]`) resolves as a real DAG edge instead of
// being dropped and silently collapsing the dependent plan to wave 1 (D3).
function computeDependencyLevels(
  rawPlans: RawPlan[],
  planMap: Map<string, RawPlan>,
  canonicalToId: Map<string, string>,
  shortFormToId?: Map<string, string>,
): { level: Map<string, number>; visited: number; order: string[]; unresolved: Array<{ plan: string; token: string }> } {
  const level = new Map<string, number>();
  const inDeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  // #3427 / ADR-3473 §8.5: a depends_on token that resolves via NONE of the
  // three tiers (planMap, canonicalToId, shortFormToId) is a dropped edge.
  // Naming it here (rather than silently `continue`-ing past it) lets
  // cmdPhasePlanIndex surface the token's own warning instead of
  // manufacturing a wave-mismatch verdict from the resulting damaged graph
  // (#3427).
  const unresolved: Array<{ plan: string; token: string }> = [];

  for (const p of rawPlans) {
    if (!inDeg.has(p.id)) inDeg.set(p.id, 0);
    if (!adj.has(p.id)) adj.set(p.id, []);
    for (const dep of p.dependsOn) {
      const resolvedDep = resolveDependencyId(dep, planMap, canonicalToId, shortFormToId);
      if (!resolvedDep) {
        unresolved.push({ plan: p.id, token: String(dep) });
        continue;
      }
      if (!adj.has(resolvedDep)) adj.set(resolvedDep, []);
      (adj.get(resolvedDep) as string[]).push(p.id);
      inDeg.set(p.id, (inDeg.get(p.id) ?? 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const p of rawPlans) {
    if ((inDeg.get(p.id) ?? 0) === 0) {
      queue.push(p.id);
      level.set(p.id, 0);
    }
  }

  // Dequeue by head index (queue[head++]), NOT Array.shift(): shift() is O(n) per
  // call in V8. Head-index dequeue is O(1) amortized -> O(V+E) overall. (#307)
  let head = 0;
  let visited = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    visited++;
    const curLevel = level.get(cur) as number;
    for (const dep of adj.get(cur) ?? []) {
      const newLevel = curLevel + 1;
      if (newLevel > (level.get(dep) ?? -1)) {
        level.set(dep, newLevel);
      }
      inDeg.set(dep, (inDeg.get(dep) as number) - 1);
      if (inDeg.get(dep) === 0) {
        queue.push(dep);
      }
    }
  }

  return { level, visited, order: queue, unresolved };
}

function cmdPhasePlanIndex(cwd: string, phase: string, raw: boolean): void {
  if (!phase) {
    error('phase required for phase-plan-index');
  }

  const phasesDir = path.join(planningDir(cwd), 'phases');
  const lookup = resolvePhaseDirectoryLookup(cwd, phase);
  const { normalized } = lookup;

  let phaseDir: string | null = null;
  let phaseDirName: string | null = null;
  let ambiguousMatches: string[] | null = null;
  try {
    const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => comparePhaseNum(a, b));
    // #2528: selection delegates to the canonical two-pass matcher shared with
    // the locator and the find-phase scan (this site previously first-matched
    // with `.find()` and had no multi-match guard — the #2237 fail-loud rule
    // now applies here too, so the three resolution paths cannot disagree).
    const { matches } = matchPhaseDirsForLookup(dirs, lookup);
    if (matches.length > 1) {
      ambiguousMatches = matches;
    } else if (matches.length === 1) {
      phaseDir = path.join(phasesDir, matches[0]);
      phaseDirName = matches[0];
    }
  } catch {
    // phases dir doesn't exist
  }

  if (ambiguousMatches) {
    output(
      {
        phase: normalized,
        error: `Phase ${normalized} is ambiguous: ${ambiguousMatches.length} directories match (${ambiguousMatches.map((m) => `"${m}"`).join(', ')}).`,
        ambiguous_matches: ambiguousMatches,
        plans: [], waves: {}, incomplete: [], runnable: [], ready_plans: [], has_checkpoints: false,
      },
      raw,
    );
    return;
  }

  if (!phaseDir) {
    output(
      { phase: normalized, error: 'Phase not found', plans: [], waves: {}, incomplete: [], runnable: [], ready_plans: [], has_checkpoints: false },
      raw,
    );
    return;
  }
  void phaseDirName; // used only to set phaseDir above

  // phaseFiles stays root-only readdirSync — it feeds only
  // describeNonCanonicalPlans's near-miss naming diagnostic below, which is
  // advisory text, not a counted/scheduled file set.
  const phaseFiles = fs.readdirSync(phaseDir);
  // #3183 (highest-severity site, ADR-3180 Decision 2): canonical LIVE
  // plan/summary sets (root+nested, status: superseded EXCLUDED) from the
  // single owner. This fixes two real bugs in the wave/dependency index this
  // function builds: (1) a superseded plan used to still get scheduled into
  // an execution wave, and (2) a phase using the #3139 nested `plans/`
  // layout used to report ZERO plans (root-only readdirSync, no `plans/`
  // join).
  // #2893 (regression fix): intersected with the STRICT `isCanonicalPlanFile`
  // predicate — scanPhasePlans's own planFiles/allPlanFiles carry
  // `isRootPlanFile`'s loose `/PLAN/i` fallback (deliberately permissive for
  // live-plan COUNTING elsewhere), which silently scheduled a
  // non-canonically-named file (e.g. `01-PLAN-01-foundation.md`) into a wave
  // here and defeated this command's #2893 naming-convention diagnostic (no
  // warning). Restores the pre-#3183, tested behavior: only canonical
  // root/nested filenames are ever counted or scheduled by this command.
  const phaseScan = scanPhasePlans(phaseDir);
  const planFiles = phaseScan.planFiles.filter(isCanonicalPlanFile).sort();
  const summaryFiles = phaseScan.summaryFiles;
  // describeNonCanonicalPlans is a NAMING-CONVENTION diagnostic, unrelated to
  // supersession — compare against allPlanFiles (every plan-shaped file the
  // owner recognizes, canonical or not) rather than the live-only planFiles,
  // so a superseded-but-canonically-named plan is not misreported as a
  // naming violation.
  const planNamingWarning = describeNonCanonicalPlans(
    phaseFiles,
    phaseScan.allPlanFiles.filter(isCanonicalPlanFile),
  );

  // #3183: completion pairing via the canonical findUnsummarizedPlans
  // (shares its `summaryCandidates` matching rule with countMatchedSummaries,
  // and is layout-agnostic — it pairs a nested `plans/PLAN-01.md` with
  // `plans/SUMMARY-01.md` correctly) instead of a bespoke ID-Set built from
  // extractCanonicalPlanId, which only ever handled the root-canonical
  // `-PLAN.md`/`-SUMMARY.md` naming form.
  //
  // #3345: the summary list is filtered through the SAME shared predicate
  // scanPhasePlans filters its countable set with
  // (plan-dependency-graph.cjs's isSummaryFileBlocked), so a SUMMARY declaring
  // `status: blocked` reads as NO completion record here — has_summary false,
  // the plan lands in `incomplete` — exactly matching the count side. Fail-open
  // on a SUMMARY with no status key / unreadable file (filename fallback);
  // `status: halted` stays summarized (#2830 designed stop). summaryFileByPlanId
  // below still indexes EVERY summary on disk because the halted lookup is a
  // file resolution for reading status, not a completion pairing.
  const countableSummaryFiles = summaryFiles.filter(
    (f) => !isSummaryFileBlocked(path.join(phaseDir, f)),
  );
  const unsummarizedPlanFiles = new Set(findUnsummarizedPlans(planFiles, countableSummaryFiles));
  // #2830: reverse lookup from a completed plan's id (exact or canonical) to
  // the actual summary filename, so a plan's own SUMMARY frontmatter can be
  // read for its `status`. Shared builder (also used by phase-locator.cts's
  // searchPhaseInDir) so the two can never disagree about which summary
  // belongs to which plan. This is a FILE resolution for reading halted
  // status, not a completion-count pairing rule, so it is unaffected by the
  // #3183 pairing migration above.
  const summaryFileByPlanId = buildSummaryFileIndex(summaryFiles, extractCanonicalPlanId);

  // ── Pass 1: parse each plan file ─────────────────────────────────────────

  const rawPlans: RawPlan[] = [];

  for (const planFile of planFiles) {
    const planId = planIdFromFile(planFile);
    const planPath = path.join(phaseDir, planFile);
    const content = fs.readFileSync(planPath, 'utf-8');
    // #2790: plan-body parsing is owned by the shared Plan Document Module, so
    // this command and the read-only `planning.inspect` query cannot drift on
    // what a plan document says. planPath is still passed so a truncated
    // PLAN.md names the file in the #1882 diagnostic.
    const planDoc = parsePlanDocument(content, planPath);

    const hasSummary = !unsummarizedPlanFiles.has(planFile);

    // #2830: a plan can have a SUMMARY (hasSummary=true) and still be halted —
    // a designed stop still writes a completion record, just one whose status
    // says "halted" rather than "complete". Only look up the summary file
    // when one exists; there is nothing to read otherwise.
    const summaryFile =
      summaryFileByPlanId.get(planId) ?? summaryFileByPlanId.get(extractCanonicalPlanId(planFile));
    const halted = hasSummary && summaryFile !== undefined
      ? isSummaryFileHalted(path.join(phaseDir, summaryFile))
      : false;

    rawPlans.push({
      id: planId,
      declaredWave: planDoc.declaredWave,
      dependsOn: planDoc.dependsOn,
      autonomous: planDoc.autonomous,
      objective: planDoc.objective,
      filesModified: planDoc.filesModified,
      filesDeleted: planDoc.filesDeleted,
      agentHint: planDoc.agentHint,
      taskCount: planDoc.taskCount,
      hasSummary,
      halted,
    });
  }

  // ── Pass 2: topological level assignment via depends_on DAG ──────────────

  const seenLower = new Map<string, string>();
  for (const p of rawPlans) {
    const lower = p.id.toLowerCase();
    const existing = seenLower.get(lower);
    if (existing !== undefined) {
      error(
        `depends_on index collision in phase ${normalized}: plan IDs '${existing}' and '${p.id}' are identical when case-folded. Rename one file to avoid ambiguous dependency resolution.`,
      );
      return;
    }
    seenLower.set(lower, p.id);
  }

  const planMap = new Map(rawPlans.map((p) => [p.id.toLowerCase(), p]));
  const canonicalToId = new Map(
    rawPlans.map((p) => [extractCanonicalPlanId(p.id).toLowerCase(), p.id]),
  );
  // #3897 rung 4 (ADR-3473 §8.9) — the third depends_on resolution tier.
  // Resolves a bare in-phase plan-number short form (e.g. "01") to its owning
  // plan id. In-phase only by construction (T49): the map is built from THIS
  // phase's rawPlans alone, so a short form colliding with a different
  // phase's plan can never be a candidate. See {@link buildShortFormToId}'s
  // own comment for the numeric-only narrowing this rung applies on top of
  // the recovered SDK-lineage algorithm.
  const shortFormToId = buildShortFormToId(rawPlans);

  const { level, visited, order, unresolved } = computeDependencyLevels(rawPlans, planMap, canonicalToId, shortFormToId);

  if (visited < rawPlans.length) {
    const cycleNodes = rawPlans.filter((p) => !level.has(p.id)).map((p) => p.id);
    error(
      `depends_on cycle detected in phase ${normalized} — cycle involves: ${cycleNodes.join(', ')}`,
    );
    return;
  }

  // #2830: single shared halt-propagation pass, reusing the SAME id
  // resolution (planMap/canonicalToId) AND the SAME topological order
  // (`order`, computeDependencyLevels's own Kahn's-algorithm dequeue
  // sequence) — passed as `precomputedOrder` so computeHaltPropagation does
  // NOT run Kahn's algorithm a second time over this graph.
  const haltNodes = rawPlans.map((p) => ({
    id: p.id,
    resolvedDependsOn: p.dependsOn
      .map((dep) => resolveDependencyId(String(dep), planMap, canonicalToId, shortFormToId))
      .filter((id): id is string => id !== null),
    halted: p.halted,
  }));
  const { blockedBy } = computeHaltPropagation(haltNodes, order);

  // ── Pass 3: determine lowest bucket key and build output ─────────────────

  const anyWaveZero = rawPlans.some((p) => p.declaredWave === 0);
  const levelOffset = anyWaveZero ? 0 : 1;

  const plans: Record<string, unknown>[] = [];
  const waves: Record<string, string[]> = {};
  const incomplete: string[] = [];
  const runnable: string[] = [];
  // #4628: DAG-ready view — see the per-plan emission below. Keyed by id so
  // the per-plan pass can resolve each plan's dependency edges.
  const resolvedDepsByPlan = new Map(haltNodes.map((n) => [n.id, n.resolvedDependsOn]));
  const readyPlans: string[] = [];
  let hasCheckpoints = false;
  const warnings: string[] = [];

  // #3427 / ADR-3473 §8.5: name every dropped depends_on edge (plan AND
  // token) rather than letting it silently collapse the plan to a DAG root.
  // A plan with at least one unresolved token gets ITS OWN warning here and
  // the wave-mismatch verdict below is suppressed for that plan ONLY — a
  // plan with no dropped edges and a genuinely wrong `wave:` still warns
  // (N3, D6, T25).
  const plansWithUnresolvedTokens = new Set<string>();
  const unresolvedTokensByPlan = new Map<string, string[]>();
  for (const { plan, token } of unresolved) {
    plansWithUnresolvedTokens.add(plan);
    const tokens = unresolvedTokensByPlan.get(plan) ?? [];
    tokens.push(formatDiagnosticToken(token));
    unresolvedTokensByPlan.set(plan, tokens);
    warnings.push(
      `Plan ${plan}: depends_on token ${formatDiagnosticToken(token)} does not resolve to any plan in this phase — edge dropped, wave placement for this plan may be unreliable`,
    );
  }

  for (const rawPlan of rawPlans) {
    if (!rawPlan.autonomous) {
      hasCheckpoints = true;
    }
    const blockedByIds = blockedBy.get(rawPlan.id) ?? [];
    // #4628: readiness fails closed — every resolved dependency must have
    // completion evidence (has_summary), and a depends_on edge that never
    // resolved (#3427 — a dropped edge) carries no evidence to check. A
    // single evaluation feeds both the ready_plans list and the per-plan
    // `ready` / `unresolved_dependencies` fields below.
    // Case-fold the dep before the planMap lookup: planMap is lowercase-keyed
    // (#2237) while resolveDependencyId returns the raw id — a mixed-case id
    // must not read as 'no evidence' (over-blocking a ready plan).
    const missingEvidence = (resolvedDepsByPlan.get(rawPlan.id) ?? [])
      .filter((dep) => planMap.get(dep.toLowerCase())?.hasSummary !== true);
    if (plansWithUnresolvedTokens.has(rawPlan.id)) {
      missingEvidence.push(...(unresolvedTokensByPlan.get(rawPlan.id) ?? []));
    }
    const isReady = blockedByIds.length === 0 && missingEvidence.length === 0;
    if (!rawPlan.hasSummary) {
      incomplete.push(rawPlan.id);
      // #2830: the runnable-only view — incomplete AND not transitively
      // blocked by a halted upstream plan. Additive alongside `incomplete`,
      // which keeps its existing "no SUMMARY yet" meaning unchanged.
      // #4628: runnable says NOTHING about completion evidence — a runnable
      // plan whose dependencies lack a SUMMARY is not DAG-ready. Consumers
      // dispatch from `ready_plans`.
      if (blockedByIds.length === 0) {
        runnable.push(rawPlan.id);
      }
      if (isReady) {
        readyPlans.push(rawPlan.id);
      }
    }

    const computedWave = (level.get(rawPlan.id) ?? 0) + levelOffset;
    const effectiveWave = computedWave;
    // #3427 (D5/N3): suppress the wave-mismatch verdict for a plan that has
    // at least one unresolved depends_on token — its own dropped-edge
    // warning above already explains the degraded wave placement, so the
    // mismatch here would blame the author for a DAG the tool itself
    // couldn't build. A plan with NO unresolved tokens still gets a genuine
    // mismatch reported (N3, T25) — the suppression is per-plan, never blanket.
    if (
      rawPlan.declaredWave !== null &&
      rawPlan.declaredWave !== computedWave &&
      !plansWithUnresolvedTokens.has(rawPlan.id)
    ) {
      warnings.push(
        `Plan ${rawPlan.id}: declared wave: ${rawPlan.declaredWave} but depends_on DAG places it in wave ${computedWave}`,
      );
    }

    const plan: Record<string, unknown> = {
      id: rawPlan.id,
      wave: effectiveWave,
      // DELIBERATELY not `resolveDependencyId`: the emitted field is a DISPLAY
      // mapping, not the DAG resolution. It rewrites a dep only when it names a
      // plan directly (planMap) and otherwise passes it through verbatim — a
      // short canonical prefix like `24-01` stays `24-01` rather than becoming
      // `24-01-auth-hardening`. #3785 pins that contract. Full resolution via
      // canonicalToId is used for the wave DAG and #2830 halt propagation only;
      // routing this line through it too silently changed the output shape.
      depends_on: rawPlan.dependsOn.map((dep) => {
        const lower = String(dep).toLowerCase();
        return planMap.has(lower) ? (planMap.get(lower) as RawPlan).id : dep;
      }),
      autonomous: rawPlan.autonomous,
      objective: rawPlan.objective,
      files_modified: rawPlan.filesModified,
      files_deleted: rawPlan.filesDeleted,
      agent_hint: rawPlan.agentHint,
      task_count: rawPlan.taskCount,
      has_summary: rawPlan.hasSummary,
      // #2830: additive fields — halted is this plan's OWN status; blocked_by
      // names the halted plan(s) transitively upstream of it (empty when not
      // blocked). Neither mutates has_summary/incomplete's existing meaning.
      halted: rawPlan.halted,
      blocked_by: blockedByIds,
    };
    if (!rawPlan.hasSummary) {
      // #4628: readiness is a property of INCOMPLETE plans (a summarized plan
      // is filtered by has_summary before readiness is ever consulted). The
      // unresolved_dependencies list names exactly which predecessors lack
      // completion evidence, for the named-skip report.
      plan['ready'] = isReady;
      if (missingEvidence.length > 0) plan['unresolved_dependencies'] = missingEvidence;
    }

    plans.push(plan);

    const waveKey = String(effectiveWave);
    if (!waves[waveKey]) {
      waves[waveKey] = [];
    }
    waves[waveKey].push(rawPlan.id);
  }

  const result: Record<string, unknown> = {
    phase: normalized,
    plans,
    waves,
    incomplete,
    runnable,
    ready_plans: readyPlans,
    has_checkpoints: hasCheckpoints,
  };
  if (planNamingWarning) result['warning'] = planNamingWarning;
  if (warnings.length > 0) result['warnings'] = warnings;

  output(result, raw);
}

// #2390 — phase.add title-shape heuristic. A description at or under this many
// characters, and with no sentence-ending punctuation followed by more text,
// reads as a short Title. Anything longer or multi-sentence reads as a Goal,
// not a Title. phase.add still writes the phase verbatim (it never mangles
// ROADMAP.md), but when the description looks goal-shaped the JSON result
// gains a `warning` key naming the gap, so the caller — or the orchestrating
// add-phase workflow — can split title vs. goal instead of the whole paragraph
// landing silently in the `### Phase N:` header.
const PHASE_ADD_TITLE_MAX_LEN = 80;
const PHASE_ADD_MULTI_SENTENCE_RE = /[.!?]['")\]]?\s+\S/;

function describeGoalShapedTitle(description: string): string | null {
  const trimmed = description.trim();
  const tooLong = trimmed.length > PHASE_ADD_TITLE_MAX_LEN;
  const multiSentence = PHASE_ADD_MULTI_SENTENCE_RE.test(trimmed);
  if (!tooLong && !multiSentence) return null;
  const reasons = [
    tooLong ? `${trimmed.length} chars (over the ${PHASE_ADD_TITLE_MAX_LEN}-char title threshold)` : null,
    multiSentence ? 'multiple sentences' : null,
  ].filter(Boolean).join(', ');
  return (
    `description looks goal-shaped, not title-shaped (${reasons}). It was written verbatim ` +
    `as the phase title; consider a short title with the detail moved to **Goal:**.`
  );
}

/**
 * #3163: compute the byte offset in `rawContent` where a new `### Phase N:`
 * entry should be inserted — at the end of the active phase list, scoped to the
 * CURRENT MILESTONE so the entry can never land before a trailing `---` in
 * shipped/history/backlog material (the file's last `---` on a long roadmap
 * sits deep in archive). When no current milestone can be resolved (no
 * STATE.md `milestone:` and no in-progress `🚧`/`🔄` marker), fall back to the
 * legacy whole-file lastIndexOf('\n---') so simple no-milestone roadmaps keep
 * their existing behavior.
 *
 * #4304 Blocker 2: `phaseIdConvention` is threaded through to
 * `currentMilestoneRawRanges` so a version-less bracket milestone heading
 * (`## [CK.02] Current`) is still offset-scoped — omitting it here silently
 * degraded to the legacy-only search, which finds nothing for that heading
 * shape and falls back to whole-document insertion, landing `phase add` /
 * `add-batch` outside the active milestone. Optional and additive: every
 * pre-existing non-bracket caller passes nothing and compiles byte-identically.
 */
function phaseEntryInsertOffset(rawContent: string, cwd: string, phaseIdConvention?: string | null): number {
  const ranges = currentMilestoneRawRanges(rawContent, cwd, phaseIdConvention);
  if (!ranges) {
    const legacy = rawContent.lastIndexOf('\n---');
    return legacy > 0 ? legacy : rawContent.length;
  }
  const window = rawContent.slice(ranges.primary.start, ranges.primary.end);
  const lastSeparator = window.lastIndexOf('\n---');
  return lastSeparator > 0 ? ranges.primary.start + lastSeparator : ranges.primary.end;
}

/**
 * #3262 (write-time milestone-scope guard): the phase-creation and
 * phase-insertion entry templates interpolate the caller's `description`
 * verbatim into `### Phase N: ${description}`. A description embedding a
 * level 1-3 heading that carries a milestone marker (version token,
 * ✅/📋/🚧/🔄, or the word "Milestone") would splice a heading that TERMINATES
 * the current milestone window (`computeMilestoneSectionEnd`) and silently
 * drops every later phase out of the derived milestone phase set. Reject
 * before any write or phase-directory creation — the fail-loud sibling of
 * the edit-phase workflow's depends_on gate. The predicate itself
 * (`findMilestoneScopeHeadingLines`) is fence-aware and Phase-heading-exempt,
 * so ordinary descriptions and the phase's own numbered heading never trip it.
 *
 * #612: the predicate is convention-SELECTED, because the terminator
 * vocabulary it mirrors is. On an opted-in bracket repo the ADR-canonical
 * `## [GSD.09] Hidden` carries none of the markers listed above and yet
 * terminates the window, so the blind call accepted the exact description the
 * guard exists to reject — measured at this CLI seam, two `phase add` calls,
 * the second phase silently outside the milestone phase set. Resolved through
 * the same tolerant shape the read path uses (`planningDir` throws on a
 * poisoned `GSD_PROJECT`/`GSD_WORKSTREAM` segment, and this guard runs BEFORE
 * `loadConfig` and the ROADMAP existence check — an unresolvable convention
 * must degrade to the pre-existing legacy vocabulary, never turn a rejection
 * into a crash).
 */
function assertDescriptionPreservesMilestoneScope(cwd: string, description: string, command: string): void {
  let convention: string | null = null;
  try {
    convention = resolvePhaseIdConvention(cwd);
  } catch { /* unresolvable convention → treat as not-configured (base behaviour) */ }
  const offending = findMilestoneScopeHeadingLines(description, convention);
  if (offending.length === 0) return;
  const markerList = convention === 'bracket'
    ? `(a vN.N version token, a ✅/📋/🚧/🔄 marker, the word "Milestone", or — under the bracket convention — a "[CODE.NN] Name" milestone heading)`
    : `(a vN.N version token, a ✅/📋/🚧/🔄 marker, or the word "Milestone")`;
  error(
    `${command}: description contains a milestone-scoping heading line — writing it to ROADMAP.md would terminate ` +
      `the current milestone window and silently drop later phases out of the milestone scope. ` +
      `Offending line(s): ${offending.map((line) => JSON.stringify(line)).join(', ')}. ` +
      `Rewrite the line so it is not a level 1-3 "#" heading carrying a milestone marker ` +
      markerList + `.`
  );
}

type BracketWriteContext = {
  project: string;
  milestone: string;
};

/**
 * Resolve the write identity shared by add/insert/remove. Convention selection
 * happens at the caller and is the sole branch gate; project/milestone checks
 * here validate the identity after that branch has already been selected.
 */
function bracketWriteContext(cwd: string, config: Record<string, unknown>): BracketWriteContext {
  const project = typeof config['project_code'] === 'string' ? config['project_code'].trim() : '';
  if (!project) {
    error('phase_id_convention is "bracket" but project_code is missing in .planning/config.json');
  }

  const milestoneInfo = getMilestoneInfo(cwd) as {
    value?: { version?: string } | null;
  };
  const version = milestoneInfo.value?.version ?? '';
  const milestone = milestoneToken(version);
  if (milestone === null) {
    error('phase_id_convention is "bracket" but the active milestone cannot be resolved');
  }

  return { project, milestone: milestone! };
}

function bracketPhaseId(
  context: BracketWriteContext,
  phase: unknown,
  subphase?: unknown,
): { project: string; milestone: string; phase: string; subphase?: string } {
  const phaseTok = phaseToken(phase);
  if (phaseTok === null) {
    error(`phase ${String(phase)} cannot be rendered by the bracket convention`);
  }
  const id: { project: string; milestone: string; phase: string; subphase?: string } = {
    project: context.project,
    milestone: context.milestone,
    phase: phaseTok!,
  };
  if (subphase !== undefined) {
    const subphaseTok = phaseToken(subphase);
    if (subphaseTok === null) {
      error(`phase ${String(phase)} subphase ${JSON.stringify(subphase)} cannot be rendered by the bracket convention`);
    }
    id.subphase = subphaseTok!;
  }
  return id;
}

/** The owner-rendered bare token used by plan/summary artifact filenames. */
function bracketArtifactToken(id: { project: string; milestone: string; phase: string; subphase?: string }): string {
  return renderPhaseId(id).split('] ')[1];
}

function bracketDirSlug(
  dirName: string,
  id: { project: string; milestone: string; phase: string; subphase?: string },
): string | null {
  const probeSlug = 'phase-slug-probe';
  const probe = toDir(id, probeSlug);
  const prefix = probe.slice(0, -probeSlug.length);
  return dirName.startsWith(prefix) ? dirName.slice(prefix.length) : null;
}

function bracketIdsInContext(
  phasesDir: string,
  context: BracketWriteContext,
): Array<{ dir: string; id: { project: string; milestone: string; phase: string; subphase?: string }; slug: string }> {
  const found: Array<{ dir: string; id: { project: string; milestone: string; phase: string; subphase?: string }; slug: string }> = [];
  for (const dir of readSubdirectories(phasesDir, true)) {
    try {
      const id = parsePhaseId(dir) as { project: string; milestone: string; phase: string; subphase?: string };
      if (id.project !== context.project || id.milestone !== context.milestone) continue;
      const slug = bracketDirSlug(dir, id);
      if (slug) found.push({ dir, id, slug });
    } catch {
      // A bracket writer shares the directory with migration-window legacy
      // names. Names outside the canonical bracket grammar do not allocate an
      // identity in this branch.
    }
  }
  return found;
}

/**
 * Return the top-level phase number when the active bracket reader resolves
 * this one directory. The reader prefers an exact project+milestone bracket
 * identity, falls back to migration-window legacy spellings, and excludes a
 * qualified directory owned by another milestone. Allocation must reserve
 * that same universe or a newly emitted bracket directory can shadow work the
 * reader resolved immediately before the write.
 */
function readerResolvableBracketDirectoryPhaseNumber(
  dir: string,
  context: BracketWriteContext,
): number | null {
  const phaseKey = phaseKeyFromDir(dir, 'bracket');
  if (!/^\d+$/.test(phaseKey)) return null;
  const phase = Number(phaseKey);
  if (!Number.isSafeInteger(phase) || isSentinelPhaseId(phase)) return null;
  const { matches } = matchPhaseDirs([dir], phaseKey, 'bracket', context);
  return matches.includes(dir) ? phase : null;
}

function addBracketRoadmapPhaseNumbers(content: string, used: Set<number>): void {
  for (const token of scanMilestonePhaseIds(content, 'bracket')) {
    const leading = String(token).split('.')[0];
    if (/^\d+$/.test(leading)) used.add(Number(leading));
  }
}

function collectBracketPhaseNumbers(
  roadmapContent: string,
  phasesDir: string,
  context: BracketWriteContext,
): Set<number> {
  const used = new Set<number>();
  addBracketRoadmapPhaseNumbers(roadmapContent, used);
  for (const dir of readSubdirectories(phasesDir, true)) {
    const phase = readerResolvableBracketDirectoryPhaseNumber(dir, context);
    if (phase !== null) used.add(phase);
  }
  used.delete(0);
  used.delete(999);
  return used;
}

/**
 * #3849 — widen "used phase numbers" beyond this checkout. Every sibling git
 * worktree carries its own `.planning/` on its own branch, so a phase minted
 * there is invisible to the cwd-scoped sources (headers, bullets, on-disk
 * dirs). Legacy identities scan each sibling's phase-directory names and whole
 * ROADMAP because their phase number has no milestone qualifier. Bracket ids
 * reserve the same reader-resolvable union used locally: exact identities for
 * the active project+milestone, migration-window legacy directory spellings,
 * and accepted ROADMAP spellings when the sibling is on that same bracket
 * identity. Each writer creates its directory in the same planning lock as its
 * ROADMAP entry.
 *
 * #4225 — the horizon must track the ALLOCATION scope. When the allocation is
 * workstream-scoped (`--ws`/`GSD_WORKSTREAM`, resolved into the env before
 * dispatch), the sibling's copy of the SAME workstream is what carries that
 * scope's independent numbering; the sibling's ROOT roadmap and phases/
 * belong to a different numbering universe (docs/FEATURES.md §51 REQ-WS-01 —
 * workstream state is isolated in `.planning/workstreams/{name}/`) and must
 * not contribute. `planningDir(wt, ws)` reuses the canonical resolver, so the
 * sibling scope matches the local scope's own resolution (env workstream plus
 * env project segment) by construction; `ws === null` (no workstream active)
 * keeps the #3849 root-scope horizon byte-for-byte.
 *
 * Widen, never refuse: a missing `.planning/`, an unreadable sibling, a
 * non-git cwd, or an unavailable git binary each leave `used` untouched —
 * allocation then behaves exactly as it did before this horizon existed.
 * A sibling that simply lacks the active workstream's directory is the same
 * fail-open case: it contributes nothing. Sentinels reuse the canonical
 * `isSentinelPhaseId`; the dir pattern is the same one the on-disk scan uses,
 * so decimal sub-phases (`411.1-foo`) are correctly not integers.
 */
function collectSiblingWorktreePhaseNums(
  cwd: string,
  used: Set<number>,
  bracketContext?: BracketWriteContext,
): void {
  let porcelain: string;
  try {
    porcelain = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd,
      encoding: 'utf-8',
      // Same subprocess band as the other git call sites (smart-entry, check-command-router):
      // inside the 5-30s git window, hidden console window on Windows, bounded buffer.
      timeout: 10_000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch {
    return; // not a git repo / git unavailable — unchanged behavior
  }
  // #4225: the env workstream, read once with planningDir's own discriminator
  // (`?? null` = deliberately no workstream — never re-derived per sibling).
  // A poisoned value would already have thrown at the local `planningDir(cwd)`
  // call every allocator makes before reaching this horizon; the per-sibling
  // try/catch below still keeps any resolution failure fail-open.
  const ws = process.env['GSD_WORKSTREAM'] ?? null;
  const siblingPlanningDir = (wt: string): string => planningDir(wt, ws);
  const dirNumPattern = /^(?:[A-Z][A-Z0-9]*-)?(\d+)-/;
  // Same header shape the allocators scan locally (#1729 tag tolerance).
  const headerPattern = /#{2,4}\s*Phase\s+(\d+)[A-Z]?(?:\.\d+)*(?:\s*\([^)\n]{0,200}\))?:/gi;
  for (const line of porcelain.split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    const wt = line.slice('worktree '.length).trim();
    if (!wt || path.resolve(wt) === path.resolve(cwd)) continue;
    try {
      for (const entry of fs.readdirSync(path.join(siblingPlanningDir(wt), 'phases'))) {
        if (bracketContext) {
          const phase = readerResolvableBracketDirectoryPhaseNumber(entry, bracketContext);
          if (phase !== null) used.add(phase);
          continue;
        }
        const match = entry.match(dirNumPattern);
        if (!match) continue;
        const num = parseInt(match[1], 10);
        if (!isSentinelPhaseId(num)) used.add(num);
      }
    } catch {
      /* worktree has no .planning (or no copy of this scope) — normal, contributes nothing */
    }
    try {
      const content = fs.readFileSync(path.join(siblingPlanningDir(wt), 'ROADMAP.md'), 'utf-8');
      if (bracketContext) {
        const siblingContext = bracketWriteContext(wt, loadConfig(wt));
        if (
          siblingContext.project === bracketContext.project
          && siblingContext.milestone === bracketContext.milestone
        ) {
          addBracketRoadmapPhaseNumbers(extractCurrentMilestone(content, wt), used);
        }
        continue;
      }
      let m: RegExpExecArray | null;
      headerPattern.lastIndex = 0;
      while ((m = headerPattern.exec(content)) !== null) {
        const num = parseInt(m[1], 10);
        if (!isSentinelPhaseId(num)) used.add(num);
      }
    } catch {
      /* no roadmap in that worktree (or scope) — normal, contributes nothing */
    }
  }
}

/**
 * #4304 (B4): `toDir` throws a raw `Error` for a description whose
 * slug sanitizes to empty (e.g. a description that transliterates to
 * nothing) or is all-digit. An uncaught throw from inside a mutation loop
 * is worse than a refusal — it can leave earlier iterations' directories
 * already created with no clean error surface. This wraps that one call so
 * every bracket phase-directory allocation refuses through `error(...)`
 * (clean stderr message, controlled exit) instead of crashing.
 */
function bracketDirNameOrRefuse(
  id: { project: string; milestone: string; phase: string; subphase?: string },
  slug: string,
  description: string,
): string {
  try {
    return toDir(id, slug);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return error(`Cannot create a phase directory for "${description}": ${msg}`);
  }
}

/**
 * #4304: fail closed before a bracket writer creates or renames into a phase
 * directory. Allocation intentionally ignores symlink entries, so the exact
 * destination must be checked with lstat (including dangling links) before a
 * recursive mkdir or child write can follow it. The canonical containment
 * predicate then resolves the existing path, or its nearest existing parent,
 * so a destination reached through a symlinked ancestor cannot escape the
 * planning phases directory either.
 */
function assertPhaseDirectoryDestinationSafe(
  phasesDir: string,
  dirName: string,
  operation: 'create' | 'renumber into',
): void {
  const destination = path.join(phasesDir, dirName);
  let stat: fs.Stats | null = null;
  try {
    stat = fs.lstatSync(destination);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      error(`Cannot ${operation} phase directory "${dirName}": unable to inspect the destination (${code ?? 'unknown error'})`);
    }
  }
  if (stat?.isSymbolicLink()) {
    error(`Cannot ${operation} phase directory "${dirName}": the destination is a symbolic link`);
  }
  if (tryWithinRoot(destination, phasesDir, PathAcceptance.AbsoluteInsideRoot) === null) {
    error(`Cannot ${operation} phase directory "${dirName}": the destination resolves outside the planning phases directory`);
  }
}

function cmdPhaseAdd(cwd: string, description: string, raw: boolean, customId?: string): void {
  if (!description) {
    error('description required for phase add');
  }
  assertDescriptionPreservesMilestoneScope(cwd, description, 'phase add');

  const config = loadConfig(cwd);
  const roadmapPath = path.join(planningDir(cwd), 'ROADMAP.md');
  if (!fs.existsSync(roadmapPath)) {
    error('ROADMAP.md not found');
  }

  const slug = generateSlugInternal(description) || '';
  const convention = resolvePhaseIdConvention(cwd);
  const bracketContext = convention === 'bracket' ? bracketWriteContext(cwd, config) : null;

  const { newPhaseId, dirName } = withPlanningLock(cwd, () => {
    const rawContent = fs.readFileSync(roadmapPath, 'utf-8');
    const content = extractCurrentMilestone(rawContent, cwd);

    const projectCode = (config.project_code as string) || '';
    const prefix = projectCode ? `${projectCode}-` : '';

    let _newPhaseId: number | string;
    let _dirName: string;

    if (bracketContext) {
      const phasesOnDisk = path.join(planningDir(cwd), 'phases');
      const usedPhaseNums = collectBracketPhaseNumbers(content, phasesOnDisk, bracketContext);
      collectSiblingWorktreePhaseNums(cwd, usedPhaseNums, bracketContext);
      _newPhaseId = (usedPhaseNums.size > 0 ? Math.max(...usedPhaseNums) : 0) + 1;
      _dirName = bracketDirNameOrRefuse(bracketPhaseId(bracketContext, _newPhaseId), slug, description);
    } else if (customId || config.phase_naming === 'custom') {
      _newPhaseId = customId || slug.toUpperCase();
      if (!_newPhaseId) error('--id required when phase_naming is "custom"');
      _dirName = `${prefix}${_newPhaseId}-${slug}`;
    } else {
      // Collect all phase numbers visible in the current-milestone content.
      // Three sources are scanned so that a phase in ANY representation
      // (section header, roadmap bullet, or on-disk directory) is counted:

      // 1) Section headers: ### Phase N: / ## Phase N: / #### Phase N:
      // #1729: `(?:\s*\([^)\n]{0,200}\))?` tolerates a pre-colon ( ) tag (literal mirror of OPTIONAL_PHASE_TAG_SOURCE).
      const headerPattern = /#{2,4}\s*Phase\s+(\d+)[A-Z]?(?:\.\d+)*(?:\s*\([^)\n]{0,200}\))?:/gi;
      // 2) Roadmap bullet entries: - [ ] **Phase N: ...** (all checkbox variants)
      // The lookahead accepts colon, decimal-dot, whitespace, bold-close asterisk,
      // or end-of-line so titleless forms ("- [ ] **Phase 11**", "- [ ] Phase 11")
      // are counted and cannot collide with a freshly-added phase. (#1229)
      const bulletPattern = /^[ \t]*-[ \t]*\[[^\]]{0,200}\][ \t]*\*{0,2}Phase[ \t]+(\d+)(?=[:.\s*]|$)/gim;

      const usedPhaseNums = new Set<number>();
      let m: RegExpExecArray | null;

      while ((m = headerPattern.exec(content)) !== null) {
        const num = parseInt(m[1], 10);
        // #3185: canonical sentinel predicate (SENTINEL_RANGES [0,999]) — this was a local 999-only literal that admitted Phase 0.
        if (!isSentinelPhaseId(num)) usedPhaseNums.add(num);
      }
      while ((m = bulletPattern.exec(content)) !== null) {
        const num = parseInt(m[1], 10);
        // #3185: canonical sentinel predicate (SENTINEL_RANGES [0,999]) — this was a local 999-only literal that admitted Phase 0.
        if (!isSentinelPhaseId(num)) usedPhaseNums.add(num);
      }

      // 3) On-disk phase directories (e.g. phases/11-foo/ with no header yet)
      const phasesOnDisk = path.join(planningDir(cwd), 'phases');
      if (fs.existsSync(phasesOnDisk)) {
        const dirNumPattern = /^(?:[A-Z][A-Z0-9]*-)?(\d+)-/;
        for (const entry of fs.readdirSync(phasesOnDisk)) {
          const match = entry.match(dirNumPattern);
          if (!match) continue;
          const num = parseInt(match[1], 10);
          // #3185: canonical sentinel predicate (SENTINEL_RANGES [0,999]) — this was a local 999-only literal that admitted Phase 0.
          if (!isSentinelPhaseId(num)) usedPhaseNums.add(num);
        }
      }

      // phase.add appends after the highest *used* number. Collecting numbers from
      // section headers, roadmap bullets, AND on-disk dirs above is what prevents the
      // #1229 collision (a bullet-only Phase N is now counted), so max+1 cannot reuse
      // an existing number.
      // 4) Sibling git worktrees (#3849) — same max+1, wider horizon: a number
      // taken on another branch is still taken.
      collectSiblingWorktreePhaseNums(cwd, usedPhaseNums);
      const maxUsed = usedPhaseNums.size > 0 ? Math.max(...usedPhaseNums) : 0;
      _newPhaseId = maxUsed + 1;
      const paddedNum = String(_newPhaseId).padStart(2, '0');
      _dirName = `${prefix}${paddedNum}-${slug}`;
    }

    const dirPath = path.join(planningDir(cwd), 'phases', _dirName);

    if (bracketContext) {
      assertPhaseDirectoryDestinationSafe(path.dirname(dirPath), _dirName, 'create');
    }

    platformEnsureDir(dirPath);
    platformWriteSync(path.join(dirPath, '.gitkeep'), '');

    let phaseEntry: string;
    if (bracketContext && typeof _newPhaseId === 'number') {
      const id = bracketPhaseId(bracketContext, _newPhaseId);
      const display = renderPhaseId(id);
      const dependsOn = `\n**Depends on:** ${renderPhaseId(bracketPhaseId(bracketContext, _newPhaseId - 1))}`;
      phaseEntry =
        `\n### ${display}: ${description}\n\n**Goal:** [To be planned]\n**Requirements**: TBD${dependsOn}\n**Plans:** 0 plans\n\nPlans:\n- [ ] TBD (run ${formatGsdSlash('plan-phase', resolveRuntime(cwd)) as string} ${id.phase} to break down)\n`;
    } else {
      const dependsOn =
        config.phase_naming === 'custom'
          ? ''
          : `\n**Depends on:** Phase ${typeof _newPhaseId === 'number' ? _newPhaseId - 1 : 'TBD'}`;
      phaseEntry =
        `\n### Phase ${_newPhaseId}: ${description}\n\n**Goal:** [To be planned]\n**Requirements**: TBD${dependsOn}\n**Plans:** 0 plans\n\nPlans:\n- [ ] TBD (run ${formatGsdSlash('plan-phase', resolveRuntime(cwd)) as string} ${_newPhaseId} to break down)\n`;
    }

    const insertAt = phaseEntryInsertOffset(rawContent, cwd, convention);
    const updatedContent = rawContent.slice(0, insertAt) + phaseEntry + rawContent.slice(insertAt);

    platformWriteSync(
      roadmapPath,
      updatedContent,
      bracketContext ? { preserveFencedMarkdownStructure: true } : undefined,
    );
    return { newPhaseId: _newPhaseId, dirName: _dirName };
  });

  const titleWarning = describeGoalShapedTitle(description);

  const result: Record<string, unknown> = {
    phase_number: typeof newPhaseId === 'number' ? newPhaseId : String(newPhaseId),
    padded:
      typeof newPhaseId === 'number' ? String(newPhaseId).padStart(2, '0') : String(newPhaseId),
    name: description,
    slug,
    directory: toPosixPath(
      path.join(path.relative(cwd, planningDir(cwd)), 'phases', dirName),
    ),
    naming_mode: config.phase_naming,
  };
  if (titleWarning) result['warning'] = titleWarning;

  output(result, raw, result['padded']);
  // #3227 (design doc §40 row 26 / "Not-corruption" rule): every
  // `publishStateContract` call site in this file is audited so a refreshed
  // state.json `updated_at` always means something on disk actually moved —
  // a stale-but-refreshed timestamp is worse than no refresh, because it
  // reads as fresh to a downstream watcher. This site is unconditional
  // because every reachable path either exits via `error()` (process.exit,
  // never reaches here) or falls through to the unconditional
  // `platformEnsureDir`/`platformWriteSync` pair above that always creates
  // the phase directory and rewrites ROADMAP.md — there is no code path that
  // reaches this line without having just written to disk. Best-effort —
  // cannot throw, cannot change this command's exit code or output.
  publishStateContract(cwd);
}

function cmdPhaseAddBatch(cwd: string, descriptions: string[], raw: boolean): void {
  if (!Array.isArray(descriptions) || descriptions.length === 0) {
    error('descriptions array required for phase add-batch');
  }
  // #3262: validate every description BEFORE the lock — the batch is
  // all-or-nothing, so one offending description must reject the whole batch
  // with no ROADMAP write and no phase directories created.
  for (const description of descriptions) {
    assertDescriptionPreservesMilestoneScope(cwd, description, 'phase add-batch');
  }
  const config = loadConfig(cwd);
  const roadmapPath = path.join(planningDir(cwd), 'ROADMAP.md');
  if (!fs.existsSync(roadmapPath)) {
    error('ROADMAP.md not found');
  }
  const projectCode = (config.project_code as string) || '';
  const prefix = projectCode ? `${projectCode}-` : '';
  const convention = resolvePhaseIdConvention(cwd);
  const bracketContext = convention === 'bracket' ? bracketWriteContext(cwd, config) : null;

  const results = withPlanningLock(cwd, () => {
    let rawContent = fs.readFileSync(roadmapPath, 'utf-8');
    const content = extractCurrentMilestone(rawContent, cwd);
    let maxPhase = 0;
    if (bracketContext) {
      const used = collectBracketPhaseNumbers(
        content,
        path.join(planningDir(cwd), 'phases'),
        bracketContext,
      );
      collectSiblingWorktreePhaseNums(cwd, used, bracketContext);
      maxPhase = used.size > 0 ? Math.max(...used) : 0;
    } else if (config.phase_naming !== 'custom') {
      // Same three cwd-scoped sources as cmdPhaseAdd (#1229): headers, roadmap
      // bullets, on-disk dirs. The bullet scan was missing here — a bullet-only
      // `Phase N` row was invisible to batch allocation (#3849 secondary).
      // #1729: `(?:\s*\([^)\n]{0,200}\))?` tolerates a pre-colon ( ) tag (literal mirror of OPTIONAL_PHASE_TAG_SOURCE).
      const phasePattern = /#{2,4}\s*Phase\s+(\d+)[A-Z]?(?:\.\d+)*(?:\s*\([^)\n]{0,200}\))?:/gi;
      const bulletPattern = /^[ \t]*-[ \t]*\[[^\]]{0,200}\][ \t]*\*{0,2}Phase[ \t]+(\d+)(?=[:.\s*]|$)/gim;
      let m: RegExpExecArray | null;
      while ((m = phasePattern.exec(content)) !== null) {
        const num = parseInt(m[1], 10);
        // #3185: canonical sentinel predicate (SENTINEL_RANGES [0,999]) — this was a local 999-only literal that admitted Phase 0.
        if (isSentinelPhaseId(num)) continue;
        if (num > maxPhase) maxPhase = num;
      }
      while ((m = bulletPattern.exec(content)) !== null) {
        const num = parseInt(m[1], 10);
        if (isSentinelPhaseId(num)) continue;
        if (num > maxPhase) maxPhase = num;
      }
      const phasesOnDisk = path.join(planningDir(cwd), 'phases');
      if (fs.existsSync(phasesOnDisk)) {
        const dirNumPattern = /^(?:[A-Z][A-Z0-9]*-)?(\d+)-/;
        for (const entry of fs.readdirSync(phasesOnDisk)) {
          const match = entry.match(dirNumPattern);
          if (!match) continue;
          const num = parseInt(match[1], 10);
          // #3185: canonical sentinel predicate (SENTINEL_RANGES [0,999]) — this was a local 999-only literal that admitted Phase 0.
          if (isSentinelPhaseId(num)) continue;
          if (num > maxPhase) maxPhase = num;
        }
      }
      // 4) Sibling git worktrees (#3849) — same max+1, wider horizon.
      const siblingNums = new Set<number>();
      collectSiblingWorktreePhaseNums(cwd, siblingNums);
      for (const num of siblingNums) {
        if (num > maxPhase) maxPhase = num;
      }
    }
    // #4304 (B4): compute and validate every item's slug/dirName
    // BEFORE the first `platformEnsureDir` — a bracket `toDir` failure
    // (e.g. a description that sanitizes to an empty slug) must refuse the
    // whole batch with zero directories created, not throw mid-loop after
    // earlier items already created theirs. This first pass touches no
    // disk.
    const validated: {
      description: string;
      slug: string;
      newPhaseId: number | string;
      dirName: string;
    }[] = [];
    for (const description of descriptions) {
      const slug = generateSlugInternal(description) || '';
      let newPhaseId: number | string;
      let dirName: string;
      if (bracketContext) {
        maxPhase += 1;
        newPhaseId = maxPhase;
        dirName = bracketDirNameOrRefuse(bracketPhaseId(bracketContext, newPhaseId), slug, description);
      } else if (config.phase_naming === 'custom') {
        newPhaseId = slug.toUpperCase();
        dirName = `${prefix}${newPhaseId}-${slug}`;
      } else {
        maxPhase += 1;
        newPhaseId = maxPhase;
        dirName = `${prefix}${String(newPhaseId).padStart(2, '0')}-${slug}`;
      }
      validated.push({ description, slug, newPhaseId, dirName });
    }

    // Batch creation is all-or-nothing: validate every bracket destination
    // before the first directory or ROADMAP byte is written.
    if (bracketContext) {
      const phasesDir = path.join(planningDir(cwd), 'phases');
      for (const { dirName } of validated) {
        assertPhaseDirectoryDestinationSafe(phasesDir, dirName, 'create');
      }
    }

    const added: Record<string, unknown>[] = [];
    for (const { description, slug, newPhaseId, dirName } of validated) {
      const dirPath = path.join(planningDir(cwd), 'phases', dirName);
      platformEnsureDir(dirPath);
      platformWriteSync(path.join(dirPath, '.gitkeep'), '');
      let phaseEntry: string;
      if (bracketContext && typeof newPhaseId === 'number') {
        const id = bracketPhaseId(bracketContext, newPhaseId);
        const dependsOn = `\n**Depends on:** ${renderPhaseId(bracketPhaseId(bracketContext, newPhaseId - 1))}`;
        phaseEntry =
          `\n### ${renderPhaseId(id)}: ${description}\n\n**Goal:** [To be planned]\n**Requirements**: TBD${dependsOn}\n**Plans:** 0 plans\n\nPlans:\n- [ ] TBD (run ${formatGsdSlash('plan-phase', resolveRuntime(cwd)) as string} ${id.phase} to break down)\n`;
      } else {
        const dependsOn =
          config.phase_naming === 'custom'
            ? ''
            : `\n**Depends on:** Phase ${typeof newPhaseId === 'number' ? newPhaseId - 1 : 'TBD'}`;
        phaseEntry =
          `\n### Phase ${newPhaseId}: ${description}\n\n**Goal:** [To be planned]\n**Requirements**: TBD${dependsOn}\n**Plans:** 0 plans\n\nPlans:\n- [ ] TBD (run ${formatGsdSlash('plan-phase', resolveRuntime(cwd)) as string} ${newPhaseId} to break down)\n`;
      }
      const insertAt = phaseEntryInsertOffset(rawContent, cwd, convention);
      rawContent = rawContent.slice(0, insertAt) + phaseEntry + rawContent.slice(insertAt);
      added.push({
        phase_number: typeof newPhaseId === 'number' ? newPhaseId : String(newPhaseId),
        padded:
          typeof newPhaseId === 'number' ? String(newPhaseId).padStart(2, '0') : String(newPhaseId),
        name: description,
        slug,
        directory: toPosixPath(
          path.join(path.relative(cwd, planningDir(cwd)), 'phases', dirName),
        ),
        naming_mode: config.phase_naming,
      });
    }
    platformWriteSync(
      roadmapPath,
      rawContent,
      bracketContext ? { preserveFencedMarkdownStructure: true } : undefined,
    );
    return added;
  });
  output({ phases: results, count: results.length }, raw);
  // #3227: unconditional here because `platformWriteSync(roadmapPath, rawContent)`
  // above always rewrites ROADMAP.md for every description in the batch before
  // this line is reached; the only refusal path is the `error('ROADMAP.md not
  // found')` above, which terminates the process and never reaches here.
  publishStateContract(cwd);
}

// #4569: scans all three representations of an existing decimal sub-phase
// under `base` — on-disk `phases/` directories, `### Phase BASE.N:` headings,
// and `- [ ] Phase BASE.N:` roadmap SUMMARY CHECKLIST bullets. A bullet-only
// roadmap with no heading yet and no on-disk directory yet must still be
// seen, or an allocator can silently reallocate an already-used decimal
// number. Shared by `cmdPhaseInsert`'s normalized-base scan and its
// sibling-allocation parent-base scan so the two never drift apart.
function scanExistingDecimalPhaseNumbers(phasesDir: string, rawContent: string, base: string): Set<number> {
  const decimalSet = new Set<number>();

  // #2245 audit: existsSync-guarded, mirroring cmdPhaseNextDecimal's identical
  // scan above — a missing phasesDir (no decimal sub-phases yet) is the
  // expected, silent case (empty decimalSet). A readdirSync failure once the
  // dir is confirmed to EXIST is a genuine anomaly; swallowing it used to let
  // `phase insert` proceed with an incomplete decimalSet and risk writing a
  // decimal phase number that collides with an existing on-disk directory
  // the scan simply never saw — surfaced loud instead, like the sibling.
  //
  // #4634 (lint-phase-enumeration-drift): routed through the canonical
  // PHYSICAL-set owner (`listAllPhaseDirs`, phase-locator.cts) instead of a
  // hand-rolled `readdirSync`. This scan — like its sibling `cmdPhaseNextDecimal`
  // and its caller `cmdPhaseInsert` (both exempted in the drift guard for the
  // same reason) — must see EVERY on-disk decimal sub-phase directory
  // regardless of the current milestone window, so `listMilestonePhaseDirs`
  // (windowed) is the wrong owner here; `includeSentinels: true` preserves this
  // function's pre-existing behavior of never sentinel-filtering (the decimal
  // regex below only ever matches `base.N`-shaped names, so sentinel inclusion
  // is a no-op either way).
  if (fs.existsSync(phasesDir)) {
    const { value: dirs, scope } = listAllPhaseDirs(phasesDir, { includeSentinels: true });
    if (scope === SCOPE.UNREADABLE) {
      // The dir EXISTS but could not be read (EACCES/EIO) — a genuine anomaly,
      // not the expected empty-decimalSet case above. Surfaced loud, matching
      // this function's pre-migration `readdirSync` catch: swallowing it would
      // let `phase insert` proceed with an incomplete decimalSet and collide
      // with an existing on-disk decimal directory the scan never saw.
      error(`Failed to scan phase directories for existing decimal phases: unable to read ${phasesDir}`);
    }
    const decimalPattern = new RegExp(`^${OPTIONAL_PROJECT_CODE_PREFIX_SOURCE}${escapeRegex(base)}\\.(\\d+)`);
    for (const dir of dirs) {
      const dm = dir.match(decimalPattern);
      if (dm) decimalSet.add(parseInt(dm[1], 10));
    }
  }

  const rmPhasePattern = new RegExp(
    `#{2,4}\\s*Phase\\s+${phaseMarkdownRegexSource(base)}\\.(\\d+)${OPTIONAL_PHASE_TAG_SOURCE}\\s*:`,
    'gi',
  );
  let rmMatch: RegExpExecArray | null;
  while ((rmMatch = rmPhasePattern.exec(rawContent)) !== null) {
    decimalSet.add(parseInt(rmMatch[1], 10));
  }

  const checklistDecimalPattern = new RegExp(
    `-\\s*\\[[ x]\\]\\s*(?:\\*\\*)?Phase\\s+${phaseMarkdownRegexSource(base)}\\.(\\d+)${OPTIONAL_PHASE_TAG_SOURCE}[:\\s]`,
    'gi',
  );
  let clMatch: RegExpExecArray | null;
  while ((clMatch = checklistDecimalPattern.exec(rawContent)) !== null) {
    decimalSet.add(parseInt(clMatch[1], 10));
  }

  return decimalSet;
}

function scanExistingBracketDecimalPhaseNumbers(
  phasesDir: string,
  roadmapContent: string,
  base: string,
  context: BracketWriteContext,
  meta?: { bracketSpellingFound: boolean },
): Set<number> {
  // A bracket repository can be mid-migration, and add-backlog deliberately
  // remains a legacy sentinel writer. Inventory is therefore the UNION of
  // the legacy spellings and the canonical bracket spellings that readers
  // accept. Do not route the 999 parent exclusively through
  // scanMilestonePhaseIds: that reader intentionally excludes the icebox
  // range for milestone counting, while allocation must include it.
  const decimalSet = scanExistingDecimalPhaseNumbers(phasesDir, roadmapContent, base);
  for (const token of scanMilestonePhaseIds(roadmapContent, 'bracket')) {
    const [phase, subphase, extra] = String(token).split('.');
    if (!extra && Number(phase) === Number(base) && /^\d+$/.test(subphase ?? '')) {
      decimalSet.add(Number(subphase));
    }
  }
  for (const { id } of bracketIdsInContext(phasesDir, context)) {
    if (Number(id.phase) !== Number(base)) continue;
    if (meta) meta.bracketSpellingFound = true;
    if (id.subphase) decimalSet.add(Number(id.subphase));
  }

  const intro = phaseHeadingPrefixSrcFor(PHASE_HEADING_BASELINE.ANY_BRACKET, 'bracket', true);
  const entryPattern = new RegExp(
    `^${intro}(${PHASE_NUMBER_TOKEN_SOURCE})${OPTIONAL_PHASE_TAG_SOURCE}[ \\t]*:`,
    'i',
  );
  const addRoadmapToken = (bracketId: string | undefined, token: string): void => {
    const [phase, subphase, extra] = token.split('.');
    if (extra || Number(phase) !== Number(base) || !/^\d+$/.test(subphase ?? '')) return;
    if (bracketId) {
      if (foldBracketId(bracketId) !== foldBracketId(`${context.project}.${context.milestone}`)) return;
      if (meta) meta.bracketSpellingFound = true;
    }
    decimalSet.add(Number(subphase));
  };

  // tokenizeHeadings is the fence-aware reader surface and, unlike the
  // milestone membership scanner, retains sentinel headings for this
  // allocation-specific inventory.
  for (const heading of tokenizeHeadings(roadmapContent)) {
    if (heading.level < 2 || heading.level > 4) continue;
    const match = entryPattern.exec(heading.text);
    if (match) addRoadmapToken(match[1], match[2]);
  }

  // The manager accepts bracket checklist rows without requiring a detail
  // heading. Match that same phase-intro grammar here so ROADMAP-only children
  // still reserve their number. Fenced examples are documentation, not live
  // inventory.
  const fencedLines = fencedRoadmapLineNumbers(roadmapContent);
  for (const [index, line] of roadmapContent.split('\n').entries()) {
    if (fencedLines.has(index + 1)) continue;
    const checklist = parsePhaseChecklistLine(line.replace(/\r$/, ''), 'bracket');
    if (checklist) addRoadmapToken(checklist.bracketId, checklist.phaseToken);
  }
  return decimalSet;
}

/**
 * #4304 (I1): the ONE bracket-argument canonicalization `phase
 * remove` and `phase insert` both need, extracted from cmdPhaseRemove's own
 * canonicalization so insert accepts every form remove does instead of maintaining a
 * second, narrower copy that could silently disagree with it. A bare token
 * (`2`, `02`, `002`) canonicalizes through phase-id-display's `phaseToken`
 * adapter; a qualified/display token (`CK.02-02`, `[CK.02] 02`) canonicalizes
 * through phase-id.cts's strict `parsePhaseId`, refusing before any mutation
 * when it names a different milestone. `actionVerb` (e.g. "remove", "insert
 * after") only varies the refusal wording.
 */
function canonicalizeBracketPhaseArgument(
  context: BracketWriteContext,
  targetPhase: string,
  actionVerb: string,
): { normalized: string; isDecimal: boolean } {
  const isQualified = targetPhase.startsWith('[') || targetPhase.includes('-');
  if (isQualified) {
    let qualifiedId: ReturnType<typeof parsePhaseId> | null = null;
    try {
      qualifiedId = parsePhaseId(targetPhase);
    } catch {
      error(`Phase ${targetPhase} cannot be resolved to a bracket phase number`);
      return { normalized: '', isDecimal: false };
    }
    if (qualifiedId.project !== context.project || qualifiedId.milestone !== context.milestone) {
      error(
        `Phase ${targetPhase} belongs to milestone [${qualifiedId.project}.${qualifiedId.milestone}], `
        + `but the active milestone is [${context.project}.${context.milestone}]. `
        + `Refusing to ${actionVerb} a phase outside the active milestone.`,
      );
    }
    const isDecimal = qualifiedId.subphase !== undefined;
    return { normalized: isDecimal ? `${qualifiedId.phase}.${qualifiedId.subphase}` : qualifiedId.phase, isDecimal };
  }
  const canonicalToken = phaseToken(targetPhase);
  if (canonicalToken === null) {
    error(`Phase ${targetPhase} cannot be resolved to a bracket phase number`);
    return { normalized: '', isDecimal: false };
  }
  return { normalized: canonicalToken, isDecimal: canonicalToken.includes('.') };
}

/**
 * Select `phase insert`'s bracket target from the reader-owned active ranges.
 * A raw range may still contain a shipped `<details>` archive, so range
 * membership alone is not evidence that a same-numbered heading is live.
 * Reuse bracket removal's historical-section classifier and owned-line parser:
 * the latter derives its bracket intro from phase-id.cts's exported read
 * grammar, then `sameBracketPhaseId` qualifies project, milestone, and the
 * canonical phase number together. The insertion boundary comes from the same
 * fence-aware heading tokens, never a raw next-heading regex. A fenced block
 * that contains a phase-heading example is kept byte-identical and begins a
 * protected boundary, so the live inserted heading lands before the example
 * instead of inside its fence. No bare-number fallback exists here.
 */
function activeBracketInsertHeading(
  content: string,
  targetId: BracketRoadmapPhaseId,
  ranges: ReturnType<typeof currentMilestoneRawRanges>,
): { start: number; length: number; insertAt: number } | null {
  if (!ranges) return null;
  const historicalLineStarts = archivedOrClosedMilestoneLineStarts(content);
  const fencedLineNumbers = fencedRoadmapLineNumbers(content);
  const searchRanges = [ranges.primary, ...(ranges.details ? [ranges.details] : [])];
  const lines = splitRoadmapLineRecords(content);
  const lineByStart = new Map(lines.map((line) => [line.start, line]));
  const headings = tokenizeHeadings(content);
  const rawLines = content.split('\n');
  const protectedFenceStarts = scanFencedBlocks(rawLines)
    .filter((block) => {
      const lastIndex = block.closeLineIdx === -1 ? rawLines.length - 1 : block.closeLineIdx;
      for (let index = block.openLineIdx + 1; index < lastIndex; index++) {
        if (classifyBracketOwnedLine(rawLines[index].replace(/\r$/, '')).kind === 'heading') return true;
      }
      return false;
    })
    .map((block) => lines[block.openLineIdx]?.start)
    .filter((start): start is number => start !== undefined);
  for (const range of searchRanges) {
    const liveHeadings = headings.filter(
      (heading) => heading.offset >= range.start
        && heading.offset < range.end
        && !historicalLineStarts.has(heading.offset),
    );
    for (let headingIndex = 0; headingIndex < liveHeadings.length; headingIndex++) {
      const heading = liveHeadings[headingIndex];
      const line = lineByStart.get(heading.offset);
      if (!line || fencedLineNumbers.has(line.lineNumber)) continue;
      const owned = classifyBracketOwnedLine(line.text);
      if (owned.kind !== 'heading' || !owned.id || !sameBracketPhaseId(owned.id, targetId)) continue;

      let insertAt = range.end;
      for (const nextHeading of liveHeadings.slice(headingIndex + 1)) {
        const nextLine = lineByStart.get(nextHeading.offset);
        if (!nextLine) continue;
        if (classifyBracketOwnedLine(nextLine.text).kind !== 'heading') continue;
        insertAt = nextHeading.offset;
        break;
      }
      for (const fenceStart of protectedFenceStarts) {
        if (fenceStart > heading.offset && fenceStart < insertAt) insertAt = fenceStart;
      }
      for (const historicalStart of historicalLineStarts) {
        if (historicalStart > heading.offset && historicalStart < insertAt) insertAt = historicalStart;
      }
      return { start: line.start, length: line.text.length + line.eol.length, insertAt };
    }
  }
  return null;
}

function cmdPhaseInsert(
  cwd: string,
  afterPhase: string,
  description: string,
  raw: boolean,
  allocation: 'nested' | 'sibling' = 'nested',
): void {
  if (!afterPhase || !description) {
    error('after-phase and description required for phase insert');
  }
  assertDescriptionPreservesMilestoneScope(cwd, description, 'phase insert');

  const roadmapPath = path.join(planningDir(cwd), 'ROADMAP.md');
  if (!fs.existsSync(roadmapPath)) {
    error('ROADMAP.md not found');
  }

  const slug = generateSlugInternal(description) || '';
  const insertConfig = loadConfig(cwd);
  const convention = resolvePhaseIdConvention(cwd);
  const bracketContext = convention === 'bracket' ? bracketWriteContext(cwd, insertConfig) : null;

  const { decimalPhase, dirName } = withPlanningLock(cwd, () => {
    const rawContent = fs.readFileSync(roadmapPath, 'utf-8');
    const content = extractCurrentMilestone(rawContent, cwd);

    // #4304 (W4) / (I1): canonicalize a bracket argument
    // through the SAME adapter `phase remove` uses
    // (canonicalizeBracketPhaseArgument) instead of the legacy
    // normalizePhaseName, which pads only the phase's FIRST segment ("1.1"
    // -> "01.1", never matching the bracket-canonical "01.01" heading) and
    // never accepted a qualified/display form ("CK.02-02", "[CK.02] 02") at
    // all. Every other convention keeps its untouched normalizePhaseName
    // behavior.
    let normalizedAfter: string;
    if (bracketContext) {
      normalizedAfter = canonicalizeBracketPhaseArgument(bracketContext, afterPhase, 'insert after').normalized;
    } else {
      normalizedAfter = normalizePhaseName(afterPhase);
    }
    // #4304 (W4): a bracket id supports at most one decimal level
    // (phase.subphase). Nesting one level deeper under an already-decimal
    // afterPhase would produce a three-level id no bracket function can
    // represent — bracketPhaseId/toDir would otherwise throw uncaught deep
    // inside directory/heading computation instead of refusing cleanly,
    // before any mutation. Sibling allocation is unaffected: it joins
    // afterPhase's PARENT level, which is always representable.
    if (bracketContext && allocation === 'nested' && normalizedAfter.includes('.')) {
      error(
        `Cannot insert a nested sub-phase under phase ${normalizedAfter}: bracket phase ids support at most one decimal level. Use --sibling, or insert after the parent phase instead.`,
      );
    }
    const afterPhaseEscaped = phaseMarkdownRegexSource(normalizedAfter);
    const headingIntro = phaseHeadingPrefixSrcFor(
      PHASE_HEADING_BASELINE.LABEL_ONLY,
      convention,
    );
    const targetPattern = new RegExp(`#{2,4}\\s*${headingIntro}${afterPhaseEscaped}${OPTIONAL_PHASE_TAG_SOURCE}:`, 'i');
    const bracketSectionRanges = bracketContext
      ? currentMilestoneRawRanges(rawContent, cwd, 'bracket')
      : null;
    const [targetPhase, targetSubphase] = normalizedAfter.split('.');
    const bracketTargetId = bracketContext
      ? bracketPhaseId(bracketContext, targetPhase, targetSubphase)
      : null;
    const bracketHeading = bracketTargetId
      ? activeBracketInsertHeading(rawContent, bracketTargetId, bracketSectionRanges)
      : null;
    const headingMatch = bracketContext ? bracketHeading !== null : targetPattern.test(content);

    const bulletPattern = new RegExp(
      `-\\s*\\[[ x]\\]\\s*(?:\\*\\*)?${headingIntro}${afterPhaseEscaped}${OPTIONAL_PHASE_TAG_SOURCE}[:\\s]`,
      'i',
    );
    const anyHeadingPattern = new RegExp(`#{2,4}\\s*${headingIntro}\\d`, 'i');
    const roadmapHasHeadingPhases = anyHeadingPattern.test(content);
    // #4304 review fix (Minor 3): bracket identities live in headings only, so a bracket ROADMAP never takes the legacy bullet-insertion branch — a bullet-only bracket ROADMAP falls through to the checklist-refusal path below instead.
    const isBulletStyle = !bracketContext && !headingMatch && bulletPattern.test(content) && !roadmapHasHeadingPhases;

    if (bracketContext && !bracketHeading) {
      const searchedRanges = bracketSectionRanges?.details
        ? 'primary and Phase Details ranges'
        : 'primary range';
      error(
        `Could not find live ${renderPhaseId(bracketTargetId!)} heading in the active milestone window (${searchedRanges})`,
      );
    }

    if (!headingMatch && !isBulletStyle) {
      const checklistPattern = new RegExp(
        `-\\s*\\[[ x]\\]\\s*(?:\\*\\*)?${headingIntro}${afterPhaseEscaped}${OPTIONAL_PHASE_TAG_SOURCE}[:\\s]`,
        'i',
      );
      if (checklistPattern.test(content)) {
        error(
          `Phase ${afterPhase} exists in roadmap summary but is missing a detail section (### Phase ${afterPhase}: ...).`,
        );
      }
      error(`Phase ${afterPhase} not found in ROADMAP.md`);
    }

    const phasesDir = path.join(planningDir(cwd), 'phases');
    // #4304 (W4): reuse the SAME canonicalization computed above
    // (phaseToken on bracket, normalizePhaseName otherwise) rather than a
    // second, independent normalizePhaseName(afterPhase) call that would
    // silently disagree with it on bracket.
    const normalizedBase = normalizedAfter;
    const decimalSet = bracketContext
      ? scanExistingBracketDecimalPhaseNumbers(phasesDir, content, normalizedBase, bracketContext)
      : scanExistingDecimalPhaseNumbers(phasesDir, rawContent, normalizedBase);

    const nextDecimal = decimalSet.size === 0 ? 1 : Math.max(...decimalSet) + 1;
    let selectedBase = normalizedBase;
    let selectedNextDecimal = nextDecimal;
    let _decimalPhase = `${selectedBase}.${selectedNextDecimal}`;

    // #4569: sibling allocation joins afterPhase's PARENT level instead of nesting
    // one level deeper under afterPhase itself. A top-level phase (no existing
    // decimal segment) has no sibling level to join; nested is the only sensible
    // allocation, so we silently fall back for that case.
    const lastDotIndex = normalizedBase.lastIndexOf('.');
    if (allocation === 'sibling' && lastDotIndex !== -1) {
      const parentBase = normalizedBase.slice(0, lastDotIndex);
      const siblingDecimalSet = bracketContext
        ? scanExistingBracketDecimalPhaseNumbers(phasesDir, content, parentBase, bracketContext)
        : scanExistingDecimalPhaseNumbers(phasesDir, rawContent, parentBase);
      const siblingNextDecimal = siblingDecimalSet.size === 0 ? 1 : Math.max(...siblingDecimalSet) + 1;
      selectedBase = parentBase;
      selectedNextDecimal = siblingNextDecimal;
      _decimalPhase = `${parentBase}.${siblingNextDecimal}`;
    }
    const bracketId = bracketContext
      ? bracketPhaseId(bracketContext, selectedBase, selectedNextDecimal)
      : null;
    if (bracketId) _decimalPhase = bracketArtifactToken(bracketId);
    const projectCode = (insertConfig.project_code as string) || '';
    const pfx = projectCode ? `${projectCode}-` : '';
    // #4304 (I1): route the bracket directory-name allocation
    // through the SAME bracketDirNameOrRefuse wrapper `phase add`/`phase
    // add-batch` already use (B4), instead of a raw `toDir` call —
    // an empty or all-digit slug now refuses cleanly through error(...)
    // before any mutation, matching their wording, instead of an uncaught
    // "toDir: slug sanitizes to empty" throw.
    const _dirName = bracketId
      ? bracketDirNameOrRefuse(bracketId, slug, description)
      : `${pfx}${_decimalPhase}-${slug}`;
    const dirPath = path.join(planningDir(cwd), 'phases', _dirName);

    let updatedContent: string;

    if (isBulletStyle) {
      const boldBulletPattern = new RegExp(
        `-\\s*\\[[ x]\\]\\s*\\*\\*Phase\\s+${afterPhaseEscaped}${OPTIONAL_PHASE_TAG_SOURCE}:`,
        'i',
      );
      const useBold = boldBulletPattern.test(content);
      const phaseLabel = useBold
        ? `**Phase ${_decimalPhase}: ${description}**`
        : `Phase ${_decimalPhase}: ${description}`;
      // #3413 review fix: bulletEntry stays hardcoded '\n'. The on-disk EOL
      // is decided at write time by platformWriteSync's normalizeContent /
      // _normalizeMd (shell-command-projection.cts), which unconditionally
      // converts \r\n -> \n for any .md target — so whatever terminator is
      // used here in memory is erased before the file is ever written, and
      // templating it via detectEol(rawContent) was inert dead code. '\n'
      // matches what platformWriteSync enforces anyway.
      const bulletEntry = `\n- [ ] ${phaseLabel}`;

      // #3413: was `[^\n]*`, which on CRLF content swallows the line's
      // trailing \r into the match, shifting bulletLineEnd to land BETWEEN
      // the \r and \n of the original CRLF pair — a pure splice-POSITION
      // bug on the not-yet-write-normalized CRLF read (independent of the
      // final on-disk EOL, which platformWriteSync always forces to LF for
      // .md targets regardless). Widening to [^\r\n]* stops the match at the
      // true line-content boundary so bulletLineEnd lands cleanly before the
      // terminator.
      const targetBulletPattern = new RegExp(
        `(-\\s*\\[[ x]\\]\\s*(?:\\*\\*)?Phase\\s+${afterPhaseEscaped}${OPTIONAL_PHASE_TAG_SOURCE}[:\\s][^\\r\\n]*)`,
        'i',
      );
      const bulletMatchResult = rawContent.match(targetBulletPattern);
      if (!bulletMatchResult) {
        error(`Could not find Phase ${afterPhase} bullet line`);
      }

      const bulletLineEnd =
        rawContent.indexOf(bulletMatchResult![0]) + bulletMatchResult![0].length;
      const afterBullet = rawContent.slice(bulletLineEnd);
      const nextBulletMatch = afterBullet.match(/\r?\n-\s*\[[ x]\]\s*(?:\*\*)?Phase\s+\d/i);

      let insertIdx: number;
      if (nextBulletMatch) {
        insertIdx = bulletLineEnd + (nextBulletMatch.index as number);
      } else {
        insertIdx = bulletLineEnd;
      }

      updatedContent =
        rawContent.slice(0, insertIdx) + bulletEntry + rawContent.slice(insertIdx);
    } else {
      const headingId = bracketId ? renderPhaseId(bracketId) : `Phase ${_decimalPhase}`;
      let dependsId = `Phase ${afterPhase}`;
      if (bracketContext) {
        const [dependsPhase, dependsSubphase] = normalizedBase.split('.');
        dependsId = renderPhaseId(bracketPhaseId(bracketContext, dependsPhase, dependsSubphase));
      }
      const phaseEntry =
        `\n### ${headingId}: ${description} (INSERTED)\n\n**Goal:** [Urgent work - to be planned]\n**Requirements**: TBD\n**Depends on:** ${dependsId}\n**Plans:** 0 plans\n\nPlans:\n- [ ] TBD (run ${formatGsdSlash('plan-phase', resolveRuntime(cwd)) as string} ${_decimalPhase} to break down)\n`;

      const headerPattern = new RegExp(
        `(#{2,4}\\s*${headingIntro}${afterPhaseEscaped}${OPTIONAL_PHASE_TAG_SOURCE}:[^\\n]*\\n)`,
        'i',
      );
      // #4304: bracket insertion is located by `activeBracketInsertHeading`
      // above, which requires all three ownership facts together: the line is
      // inside the reader-owned active window, is not historical under the
      // shared remove/guard classifier, and parses to the active bracket
      // identity plus canonical target number through the exported read
      // grammar. This closes the raw-range hole where an archived `[CK.01]
      // 01` inside `[CK.02]`'s primary bytes won a bare-number search. The
      // legacy path below keeps its whole-document pattern byte-for-behavior.
      //
      // #4304 (B3): the pre-flight headingMatch check above ran
      // against extractCurrentMilestone's content, which (for a bracket
      // repo) merges the primary section with a later "(Phase Details)"
      // section carrying the same milestone identity — so it can pass even
      // when the target's own detail heading lives ONLY in that Phase
      // Details range, separated from primary by an unrelated sibling
      // milestone. Search the SAME two raw ranges the B3 remove fix
      // discovers (primary, then details) instead of primary alone, so a
      // heading the pre-flight check can see is also found here.
      const headerSearchRanges = bracketSectionRanges
        ? [
          bracketSectionRanges.primary,
          ...(bracketSectionRanges.details ? [bracketSectionRanges.details] : []),
        ]
        : [{ start: 0, end: rawContent.length }];

      let searchStart = bracketHeading?.start ?? headerSearchRanges[0].start;
      let searchEnd = bracketHeading?.insertAt ?? headerSearchRanges[0].end;
      let headerLength = bracketHeading?.length ?? 0;
      if (!bracketHeading) {
        let headerMatch: RegExpMatchArray | null = null;
        for (const range of headerSearchRanges) {
          const searchWindow = rawContent.slice(range.start, range.end);
          const match = searchWindow.match(headerPattern);
          if (match) {
            headerMatch = match;
            searchStart = range.start + (match.index as number);
            searchEnd = range.end;
            headerLength = match[0].length;
            break;
          }
        }
        if (!headerMatch) {
          error(`Could not find Phase ${afterPhase} header`);
        }
      }

      const headerIdx = searchStart;
      let insertIdx: number;
      if (bracketHeading) {
        insertIdx = bracketHeading.insertAt;
      } else {
        const afterHeader = rawContent.slice(headerIdx + headerLength, searchEnd);
        const nextPhaseMatch = afterHeader.match(
          new RegExp(`\\r?\\n#{2,4}\\s+${headingIntro}\\d[\\d.]*`, 'i'),
        );
        insertIdx = nextPhaseMatch
          ? headerIdx + headerLength + (nextPhaseMatch.index as number)
          : searchEnd;
      }

      updatedContent =
        rawContent.slice(0, insertIdx) + phaseEntry + rawContent.slice(insertIdx);
    }

    // #4304 (B3): every validation above — the pre-flight heading
    // check, the header/bullet-line search, and computing `updatedContent`
    // — must succeed (or `error()` out, which never returns) before the new
    // phase's directory is created. A failing insert now leaves `.planning`
    // byte-identical.
    if (bracketId) {
      assertPhaseDirectoryDestinationSafe(path.dirname(dirPath), _dirName, 'create');
    }
    platformEnsureDir(dirPath);
    platformWriteSync(path.join(dirPath, '.gitkeep'), '');

    platformWriteSync(
      roadmapPath,
      updatedContent,
      bracketContext ? { preserveFencedMarkdownStructure: true } : undefined,
    );
    return { decimalPhase: _decimalPhase, dirName: _dirName };
  });

  const result = {
    phase_number: decimalPhase,
    after_phase: afterPhase,
    name: description,
    slug,
    directory: toPosixPath(
      path.join(path.relative(cwd, planningDir(cwd)), 'phases', dirName),
    ),
  };

  output(result, raw, decimalPhase);
  // #3227: unconditional here because `platformWriteSync(roadmapPath, updatedContent)`
  // above always rewrites ROADMAP.md with the inserted phase before this line is
  // reached; every refusal along the way (bad args, missing ROADMAP.md, unresolved
  // target bullet/header) exits via `error()`, which terminates the process.
  publishStateContract(cwd);
}

interface RenameDirInfo {
  dir: string;
  prefix: string;
  oldDecimal: number;
  slug: string;
}

interface RenameIntInfo {
  dir: string;
  oldInt: number;
  letter: string;
  decimal: number | null;
  slug: string;
}

function renameDecimalPhases(
  phasesDir: string,
  baseInt: number,
  removedDecimal: number,
): { renamedDirs: { from: string; to: string }[]; renamedFiles: { from: string; to: string }[] } {
  const renamedDirs: { from: string; to: string }[] = [];
  const renamedFiles: { from: string; to: string }[] = [];
  const decPattern = new RegExp(`^(0*${baseInt})\\.(\\d+)-(.+)$`);
  const dirs = readSubdirectories(phasesDir, true);
  const toRename: RenameDirInfo[] = dirs
    .map((dir) => {
      const m = dir.match(decPattern);
      return m
        ? { dir, prefix: m[1], oldDecimal: parseInt(m[2], 10), slug: m[3] }
        : null;
    })
    .filter((item): item is RenameDirInfo => item !== null && item.oldDecimal > removedDecimal)
    .sort((a, b) => b.oldDecimal - a.oldDecimal);

  for (const item of toRename) {
    const newDecimal = item.oldDecimal - 1;
    const oldPhaseId = `${baseInt}.${item.oldDecimal}`;
    const newPhaseId = `${baseInt}.${newDecimal}`;
    const newDirName = `${item.prefix}.${newDecimal}-${item.slug}`;
    retryRenameSync(path.join(phasesDir, item.dir), path.join(phasesDir, newDirName));
    renamedDirs.push({ from: item.dir, to: newDirName });
    for (const f of fs.readdirSync(path.join(phasesDir, newDirName))) {
      if (f.includes(oldPhaseId)) {
        const newFileName = f.replace(oldPhaseId, newPhaseId);
        retryRenameSync(
          path.join(phasesDir, newDirName, f),
          path.join(phasesDir, newDirName, newFileName),
        );
        renamedFiles.push({ from: f, to: newFileName });
      }
    }
  }
  return { renamedDirs, renamedFiles };
}

/**
 * Find a free name to move an occupying file aside to, on collision, so the
 * intended rename can proceed without destroying either file. Appends the
 * literal `.orphaned` suffix to the whole existing filename (never `.md`,
 * so no phase-directory scan predicate — all of which filter on
 * `.endsWith('.md')` / `.endsWith('-VERIFICATION.md')` etc — can ever pick
 * the displaced file back up as any phase's artifact). Falls back to a
 * numeric discriminator (`.orphaned.2`, `.orphaned.3`, ...) if `.orphaned`
 * itself is taken, bounded at 100 attempts so a pathological directory
 * cannot loop forever; returns null if no free name is found within that
 * bound, letting the caller fall back to skip-and-report.
 */
function findOrphanedDisplacementName(dir: string, fileName: string): string | null {
  const base = `${fileName}.orphaned`;
  if (!fs.existsSync(path.join(dir, base))) return base;
  for (let n = 2; n <= 100; n++) {
    const candidate = `${base}.${n}`;
    if (!fs.existsSync(path.join(dir, candidate))) return candidate;
  }
  return null;
}

function renameIntegerPhases(
  phasesDir: string,
  removedInt: number,
): {
  renamedDirs: { from: string; to: string }[];
  renamedFiles: { from: string; to: string }[];
  renamedFileCollisions: { from: string; to: string; displaced_to: string | null }[];
} {
  const renamedDirs: { from: string; to: string }[] = [];
  const renamedFiles: { from: string; to: string }[] = [];
  const renamedFileCollisions: { from: string; to: string; displaced_to: string | null }[] = [];
  const dirs = readSubdirectories(phasesDir, true);
  const toRename: RenameIntInfo[] = dirs
    .map((dir) => {
      const m = dir.match(/^(\d+)([A-Z])?(?:\.(\d+))?-(.+)$/i);
      if (!m) return null;
      const dirInt = parseInt(m[1], 10);
      // #3185: canonical sentinel predicate (SENTINEL_RANGES [0,999]) — this was a local 999-only literal that admitted Phase 0.
      return dirInt > removedInt && !isSentinelPhaseId(dirInt)
        ? {
            dir,
            oldInt: dirInt,
            letter: m[2] ? m[2].toUpperCase() : '',
            decimal: m[3] ? parseInt(m[3], 10) : null,
            slug: m[4],
          }
        : null;
    })
    .filter((item): item is RenameIntInfo => item !== null)
    .sort((a, b) =>
      a.oldInt !== b.oldInt ? b.oldInt - a.oldInt : (b.decimal || 0) - (a.decimal || 0),
    );

  for (const item of toRename) {
    const newInt = item.oldInt - 1;
    const newPadded = String(newInt).padStart(2, '0');
    const oldPadded = String(item.oldInt).padStart(2, '0');
    const letterSuffix = item.letter || '';
    const decimalSuffix = item.decimal !== null ? `.${item.decimal}` : '';
    const oldPrefix = `${oldPadded}${letterSuffix}${decimalSuffix}`;
    const newPrefix = `${newPadded}${letterSuffix}${decimalSuffix}`;
    const newDirName = `${newPrefix}-${item.slug}`;
    // WARNING-3 (#3511 review): the directory match above accepts an
    // UNPADDED leading number (`\d+`), so a supported rename can pair a
    // 2-padded dir with an unpadded-numbered artifact — dir `9-slug` holding
    // `9-VERIFICATION.md`. Renaming files by `f.startsWith(oldPrefix)` alone
    // (oldPrefix always 2-padded) misses that file: it becomes desynced from
    // its now-renamed directory and the phase reads `missing`. Try the
    // UNPADDED old-prefix form as a fallback so such an artifact renames
    // alongside its directory. A trailing-digit boundary check keeps the
    // unpadded form from over-matching a DIFFERENT phase's file (unpadded
    // prefix "1" must not match "10-…").
    const oldPrefixUnpadded = `${item.oldInt}${letterSuffix}${decimalSuffix}`;
    retryRenameSync(path.join(phasesDir, item.dir), path.join(phasesDir, newDirName));
    renamedDirs.push({ from: item.dir, to: newDirName });
    for (const f of fs.readdirSync(path.join(phasesDir, newDirName))) {
      let matchedPrefix: string | null = null;
      if (f.startsWith(oldPrefix)) {
        matchedPrefix = oldPrefix;
      } else if (
        oldPrefixUnpadded !== oldPrefix &&
        f.startsWith(oldPrefixUnpadded) &&
        // Token-boundary check: the character immediately after the unpadded
        // prefix must be a separator (`-`, `.`) or end-of-name, not any
        // non-digit. A bare `!/^\d/` test (prior form) let a LETTER through
        // too, so unpadded prefix "2" wrongly matched "2FA-notes.md" (a
        // wholly unrelated file whose name merely starts with the digit).
        (f.length === oldPrefixUnpadded.length || /^[-.]/.test(f.slice(oldPrefixUnpadded.length)))
      ) {
        matchedPrefix = oldPrefixUnpadded;
      }
      if (matchedPrefix) {
        const newFileName = newPrefix + f.slice(matchedPrefix.length);
        const destPath = path.join(phasesDir, newDirName, newFileName);
        // Collision guard: the padded and unpadded prefix forms can both
        // resolve to the SAME destination (e.g. `09-VERIFICATION.md` and
        // `9-VERIFICATION.md` in one directory both target
        // `08-VERIFICATION.md`), and a stray cross-phase file can already sit
        // at the destination name (e.g. a leftover `08-VERIFICATION.md`
        // belonging to a DIFFERENT phase, inside phase 9's directory).
        // Renaming blindly over an existing target silently destroys
        // whichever file loses; skipping the rename instead lets the stray
        // outrank the phase's own renamed artifact once it lands at the
        // canonical name. Neither is acceptable: move the OCCUPYING file
        // aside first (never overwrite, never skip the real rename), then
        // complete the intended rename so the phase's own artifact takes the
        // canonical name. This also handles a target that was already
        // claimed by an EARLIER file in this same pass, since that earlier
        // rename already created it on disk.
        if (fs.existsSync(destPath)) {
          const displacedName = findOrphanedDisplacementName(
            path.join(phasesDir, newDirName),
            newFileName,
          );
          if (displacedName === null) {
            // No free displacement name within the bounded search — fall
            // back to skip-and-report rather than looping or overwriting.
            renamedFileCollisions.push({ from: f, to: newFileName, displaced_to: null });
            continue;
          }
          retryRenameSync(destPath, path.join(phasesDir, newDirName, displacedName));
          retryRenameSync(path.join(phasesDir, newDirName, f), destPath);
          renamedFiles.push({ from: f, to: newFileName });
          renamedFileCollisions.push({ from: f, to: newFileName, displaced_to: displacedName });
          continue;
        }
        retryRenameSync(path.join(phasesDir, newDirName, f), destPath);
        renamedFiles.push({ from: f, to: newFileName });
      }
    }
  }
  return { renamedDirs, renamedFiles, renamedFileCollisions };
}

function decrementRoadmapPhaseNumber(raw: string, removedInt: number): string {
  const num = parseInt(raw, 10);
  // #3185: canonical sentinel predicate (SENTINEL_RANGES [0,999]) — this was a local 999-only literal that admitted Phase 0.
  if (!Number.isInteger(num) || num <= removedInt || isSentinelPhaseId(num)) return raw;
  return String(num - 1);
}

function decrementRoadmapPhaseToken(raw: string, removedInt: number): string {
  const match = String(raw).match(/^(\d+)(\.\d+)?$/);
  if (!match) return raw;
  const num = parseInt(match[1], 10);
  // #3185: canonical sentinel predicate (SENTINEL_RANGES [0,999]) — this was a local 999-only literal that admitted Phase 0.
  if (!Number.isInteger(num) || num <= removedInt || isSentinelPhaseId(num)) return raw;
  return `${num - 1}${match[2] || ''}`;
}

function decrementRoadmapPaddedPhaseNumber(raw: string, removedInt: number): string {
  const num = parseInt(raw, 10);
  // #3185: canonical sentinel predicate (SENTINEL_RANGES [0,999]) — this was a local 999-only literal that admitted Phase 0.
  if (!Number.isInteger(num) || num <= removedInt || isSentinelPhaseId(num)) return raw;
  return String(num - 1).padStart(raw.length, '0');
}

/**
 * Return the RAW text of the `dataRowIndex`-th data row line (0-based, in
 * file order — header and delimiter rows excluded) of the FIRST GFM table
 * found in `sectionText`, or `null` when the table or that row doesn't exist.
 *
 * F8 (#2245 review, nit) support helper: addresses a table row by its
 * STRUCTURAL position rather than by matching its (possibly non-unique)
 * trimmed cell content — see the Progress-ordinal renumber's padding-recovery
 * use below for why content-matching is unsafe here (two rows with identical
 * trimmed Phase text, or a row whose already-rewritten new value coincides
 * with another row's pre-edit text, would otherwise resolve to the wrong line).
 */
function findDataRowLine(sectionText: string, dataRowIndex: number): string | null {
  const lines = sectionText.split(/\r?\n/);
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('|') && trimmed.indexOf('|', 1) !== -1) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return null;

  let seen = -1;
  for (let i = headerIdx + 2; i < lines.length; i++) {
    if (!lines[i].trim().startsWith('|')) break;
    seen += 1;
    if (seen === dataRowIndex) return lines[i];
  }
  return null;
}

// #3685: mirror requirementsUpdated's diff-tracking contract — the caller
// (cmdPhaseRemove) used to report `roadmap_updated: true` unconditionally,
// hardcoded regardless of whether this transform actually changed
// ROADMAP.md's content. Returning a real before/after comparison here lets
// the caller report accurately, the same fix #3685 applied to
// `cmdPhaseComplete` and #2640/#2974 already applied to this same function's
// sibling `stateUpdated` flag a few lines below in `cmdPhaseRemove`.
function updateRoadmapAfterPhaseRemoval(
  roadmapPath: string,
  targetPhase: string,
  isDecimal: boolean,
  removedInt: number,
  cwd: string,
): boolean {
  return withPlanningLock(cwd, () => {
    const originalContent = fs.readFileSync(roadmapPath, 'utf-8');
    let content = originalContent;
    const escaped = escapeRegex(targetPhase);
    // #3572: ROADMAP headings and rows carry the normalized (zero-padded) form
    // of a decimal id — `phase insert 1` writes `### Phase 01.1:` while the
    // user's remove query is usually unpadded (`1.1`) — and integer headings
    // legitimately appear both padded (`02`) and unpadded (`2`). A `0*` prefix
    // makes the token padding-insensitive in both directions without widening
    // to other ids: the token stays anchored between `Phase\s+`/line-start and
    // `:`/whitespace/end, so `0*2` still never matches `Phase 12:`.
    const padTolerant = `0*${escaped}`;

    // SECTION-DELETION (not a section-body edit) — removes the phase's ENTIRE
    // detail section INCLUDING its own heading line. Migrated onto deleteSection
    // (ADR-2143 §4 / markdown-sectionizer T7): it locates the target heading via
    // tokenizeHeadings + this predicate, then splices out the range from that
    // heading's own start through the next heading of the SAME-OR-HIGHER level —
    // whatever that heading's text is. This fixes a data-loss bug in the prior
    // hand-rolled regex, whose lookahead only recognised ANOTHER "Phase N:"
    // heading as a stop boundary: removing the LAST phase in a roadmap left no
    // such heading to stop at, so the lazy `[\s\S]*?` scan ran to EOF and swept
    // away everything after it — including a trailing `## Progress` heading and
    // its tracking table.
    const phaseHeadingRe = new RegExp(
      `^Phase\\s+${padTolerant}${OPTIONAL_PHASE_TAG_SOURCE}\\s*:`,
      'i',
    );
    content = deleteSection(
      content,
      (h) => h.level >= 2 && h.level <= 4 && phaseHeadingRe.test(h.text),
    );
    content = content.replace(
      new RegExp(`\\n?-\\s*\\[[ x]\\]\\s*.*Phase\\s+${padTolerant}${OPTIONAL_PHASE_TAG_SOURCE}[:\\s][^\\n]*`, 'gi'),
      '',
    );
    // ROW-DELETION (not a cell update) — removes the WHOLE Progress-table row
    // for a removed phase via deleteTableRow (ADR-2143 §7 row-removal sibling
    // of updateTableCell). Scoped to the `## Progress` section — mirroring
    // deriveProgressFromRoadmap's read-side scoping (phase-lifecycle.cts) —
    // so a same-numbered row in an earlier, unrelated table (e.g. a
    // `| Phase | Requirements | Count |` table preceding `## Progress`,
    // #2012) is never touched. Matches the row by its FIRST cell only: for an
    // integer removal, a zero-pad-insensitive leading-integer comparison
    // (`01.`, `1.`, `1 `, bare `1` all match phase 1; a decimal sub-phase
    // cell like `2.5` never matches an integer removal); for a decimal
    // removal, the exact decimal token. This replaces the prior regex's
    // `\.?\s` requirement, which silently left a COMPACT unpadded row (e.g.
    // `|2|0/2|Planned|-|`) undeleted — its closing `|` follows the digit with
    // no whitespace to match (#2245 audit) — and which was also unscoped to
    // any particular table.
    const progressHeadingMatch = content.match(/^##[ \t]+Progress\b/im);
    if (progressHeadingMatch && progressHeadingMatch.index !== undefined) {
      const headingOffset = progressHeadingMatch.index;
      const before = content.slice(0, headingOffset);
      const fromHeading = content.slice(headingOffset);
      const nextHeadingOffset = fromHeading.search(/\n#{1,2}[ \t]/);
      const progressSection =
        nextHeadingOffset >= 0 ? fromHeading.slice(0, nextHeadingOffset) : fromHeading;
      const rest = nextHeadingOffset >= 0 ? fromHeading.slice(nextHeadingOffset) : '';

      const matchRemovedProgressRow = (row: Record<string, string>): boolean => {
        const firstCellRaw = (Object.values(row)[0] ?? '').trim();
        if (isDecimal) {
          return new RegExp(`^${padTolerant}\\.?(?:\\s|$)`, 'i').test(firstCellRaw);
        }
        const leadingMatch = firstCellRaw.match(/^0*(\d+)(\.\d+)?/);
        if (!leadingMatch || leadingMatch[2]) return false;
        return parseInt(leadingMatch[1], 10) === removedInt;
      };

      const deleteResult = deleteTableRow(progressSection, matchRemovedProgressRow);
      if (deleteResult.ok) {
        content = before + deleteResult.value + rest;
      }
    }

    if (!isDecimal) {
      // #1729: fold an optional pre-colon ( ) tag into the suffix capture so it
      // is re-emitted verbatim — a tagged later phase still gets renumbered.
      content = content.replace(
        /(#{2,4}\s*Phase\s+)(\d+(?:\.\d+)?)((?:\s*\([^)\r\n]{0,200}\))?\s*:)/gi,
        (_match, prefix: string, num: string, suffix: string) =>
          `${prefix}${decrementRoadmapPhaseToken(num, removedInt)}${suffix}`,
      );
      content = content.replace(
        /(-\s*\[[ x]\]\s*.*?Phase\s+)(\d+)(\s*:|\s+)/gi,
        (_match, prefix: string, num: string, suffix: string) =>
          `${prefix}${decrementRoadmapPhaseNumber(num, removedInt)}${suffix}`,
      );
      // ORDINAL-RENUMBER — CELL EDIT (not row-deletion) — migrated onto
      // updateTableCell (ADR-2143 §7, sibling of the deleteTableRow scoping
      // directly above). The prior whole-document regex
      // `/(\|\s*)(\d+)(\.\s)/g` rewrote ANY `| N. ` cell anywhere in the
      // file — including a same-shaped cell in an UNRELATED, earlier table
      // (e.g. a `| Phase | Requirements | Count |` table, or a decoy table,
      // preceding `## Progress`; #2245-class scoping defect, same family as
      // the row-delete fix above). Scoped here to the `## Progress` section
      // only, mirroring that same section-slice-then-splice-back pattern.
      //
      // Loops because updateTableCell only rewrites the FIRST matching row
      // per call. `processedOrdinalRows` tracks by row INDEX (stable across
      // iterations — this only edits cell content, it never inserts/deletes
      // rows) so an already-decremented row's new value — which may still
      // numerically exceed `removedInt` — is never re-selected and
      // decremented a second time (matching on the row's CURRENT value alone,
      // without this guard, would keep re-firing on each pass).
      //
      // `phaseCellShapeRe` is the exact digit+dot-space shape the old regex
      // required: a decimal sub-phase ordinal like `2.5` (no whitespace
      // between the dot and the next character) never matches it, so it is
      // left untouched — identical decimal-safety to the prior behaviour.
      //
      // updateTableCell hands the callback the TRIMMED, UNESCAPED cell value
      // only, so the row's original leading/trailing alignment padding is
      // recovered by a narrow, anchored lookup within that row's OWN raw
      // line — addressed by ROW INDEX (`matchedRowIndex`, via
      // `findDataRowLine`), not by searching the whole section for content
      // matching the trimmed value (F8 #2245 review: two rows with identical
      // trimmed Phase text, or a row whose already-rewritten new value
      // coincides with another row's pre-edit text, would otherwise resolve
      // to the WRONG row's padding — the first/leftmost content match found).
      // The lookup searches for `escapeCell(current)` (F3 #2245 review: the
      // ESCAPED form, e.g. `Foo \| Bar`) — the raw line always carries the
      // escaped form, so searching for the unescaped `current` would
      // silently fail to find an escaped-pipe cell's own line — preserving
      // every other byte of the row (ADR-2143 §7 byte-parity) while only the
      // digits actually change.
      const ordinalHeadingMatch = content.match(/^##[ \t]+Progress\b/im);
      if (ordinalHeadingMatch && ordinalHeadingMatch.index !== undefined) {
        const ordinalHeadingOffset = ordinalHeadingMatch.index;
        const ordinalBefore = content.slice(0, ordinalHeadingOffset);
        const ordinalFromHeading = content.slice(ordinalHeadingOffset);
        const ordinalNextHeadingOffset = ordinalFromHeading.search(/\n#{1,2}[ \t]/);
        let ordinalSection =
          ordinalNextHeadingOffset >= 0
            ? ordinalFromHeading.slice(0, ordinalNextHeadingOffset)
            : ordinalFromHeading;
        const ordinalRest =
          ordinalNextHeadingOffset >= 0 ? ordinalFromHeading.slice(ordinalNextHeadingOffset) : '';

        const phaseCellShapeRe = /^(\d+)(\.\s)/;
        const processedOrdinalRows = new Set<number>();
        let matchedRowIndex: number | null = null;

        for (;;) {
          matchedRowIndex = null;
          const cellResult = updateTableCell(
            ordinalSection,
            (row, index) => {
              if (processedOrdinalRows.has(index)) return false;
              const m = phaseCellShapeRe.exec(row['Phase'] ?? '');
              if (!m) return false;
              const num = parseInt(m[1], 10);
              // #3185: canonical sentinel predicate (SENTINEL_RANGES [0,999]) — this was a local 999-only literal that admitted Phase 0.
              if (!Number.isInteger(num) || num <= removedInt || isSentinelPhaseId(num)) return false;
              processedOrdinalRows.add(index);
              matchedRowIndex = index;
              return true;
            },
            'Phase',
            (current) => {
              const m = phaseCellShapeRe.exec(current);
              if (!m) return current;
              const decremented = decrementRoadmapPhaseNumber(m[1], removedInt);
              const newContent = `${decremented}${m[2]}${current.slice(m[0].length)}`;
              const targetLine =
                matchedRowIndex === null ? null : findDataRowLine(ordinalSection, matchedRowIndex);
              const padMatch = targetLine
                ? new RegExp(`^[ \\t]*\\|(\\s*)${escapeRegex(escapeCell(current))}(\\s*)\\|`).exec(targetLine)
                : null;
              const leadPad = padMatch ? padMatch[1] : ' ';
              const trailPad = padMatch ? padMatch[2] : ' ';
              return `${leadPad}${escapeCell(newContent)}${trailPad}`;
            },
          );
          if (!cellResult.ok) break;
          ordinalSection = cellResult.value;
        }

        content = ordinalBefore + ordinalSection + ordinalRest;
      }
      content = content.replace(
        /(?<![0-9-])(\d{2})-(\d{2})(?=(?:(?:-[A-Za-z][A-Za-z0-9-]*)?-(?:PLAN|SUMMARY)\.md)|(?![0-9-]))/g,
        (_match, phaseNum: string, planNum: string) =>
          `${decrementRoadmapPaddedPhaseNumber(phaseNum, removedInt)}-${planNum}`,
      );
      content = content.replace(
        /(\*\*Depends on\*\*\s*:\s*Phase\s+)(\d+(?:\.\d+)?)\b/gi,
        (_match, prefix: string, num: string) =>
          `${prefix}${decrementRoadmapPhaseToken(num, removedInt)}`,
      );
      content = content.replace(
        /(Depends on:\*\*\s*Phase\s+)(\d+(?:\.\d+)?)\b/gi,
        (_match, prefix: string, num: string) =>
          `${prefix}${decrementRoadmapPhaseToken(num, removedInt)}`,
      );
    }

    platformWriteSync(roadmapPath, content);
    // #3685 / #3691: compare NORMALIZED bytes (what platformWriteSync actually
    // persists), not the raw pre-normalize `content` string, against the raw
    // pre-mutation `originalContent` read above — a raw `!==` here reports a
    // false `true` whenever this transform's regenerated output takes a
    // different-but-equivalent shape than the already-normalized on-disk
    // original (same normalization-order artifact #3685 fixed at
    // cmdMilestoneComplete; see contentChangedAfterNormalize's own doc).
    return contentChangedAfterNormalize(roadmapPath, originalContent, content);
  });
}

interface PhaseRemoveOptions {
  force?: boolean;
}

/**
 * #3572: insert `fieldLine` at the start of STATE.md's BODY — immediately after
 * the leading frontmatter block's closing `---` fence — so a body field never
 * lands before the opening fence. The former whole-content prepend
 * (`field + content`) put the line ABOVE the opening `---`, and
 * syncStateFrontmatter then treated the scrambled fence structure as TWO
 * frontmatter blocks, rebuilding a derived one on top of the original
 * (milestone_name from a ROADMAP heading, total_phases counting the removed
 * phase, a stray 'Total Phases: 0' between fences). A file with no leading
 * frontmatter is all body: the field goes to content start, preserving the
 * former behavior for that shape.
 */
function insertStateBodyFieldAtTop(content: string, fieldLine: string): string {
  // Split AND join on bare '\n' so CRLF line endings stay attached to their
  // own lines — each '\r' remains the tail of the line it terminated, where
  // the trimmed fence compare still matches it. (#3572 review: splitting on
  // '\n' but re-joining on a detected '\r\n' doubled every carriage return.)
  const lines = content.split('\n');
  if ((lines[0] ?? '').trim() === '---') {
    const closeIdx = lines.findIndex((l: string, i: number) => i > 0 && l.trim() === '---');
    if (closeIdx !== -1) {
      lines.splice(closeIdx + 1, 0, '', fieldLine);
      return lines.join('\n');
    }
  }
  return fieldLine + '\n' + content;
}

function renameBracketArtifactFiles(
  phaseDir: string,
  oldId: { project: string; milestone: string; phase: string; subphase?: string },
  newId: { project: string; milestone: string; phase: string; subphase?: string },
  renamedFiles: { from: string; to: string }[],
  renamedFileCollisions: { from: string; to: string; displaced_to: string | null }[],
): void {
  const oldToken = bracketArtifactToken(oldId);
  const newToken = bracketArtifactToken(newId);
  for (const file of fs.readdirSync(phaseDir)) {
    if (!file.startsWith(oldToken) || !/^(?:[-.]|$)/.test(file.slice(oldToken.length))) continue;
    const newFileName = newToken + file.slice(oldToken.length);
    const source = path.join(phaseDir, file);
    const destination = path.join(phaseDir, newFileName);
    if (fs.existsSync(destination)) {
      const displaced = findOrphanedDisplacementName(phaseDir, newFileName);
      if (!displaced) {
        renamedFileCollisions.push({ from: file, to: newFileName, displaced_to: null });
        continue;
      }
      retryRenameSync(destination, path.join(phaseDir, displaced));
      renamedFileCollisions.push({ from: file, to: newFileName, displaced_to: displaced });
    }
    retryRenameSync(source, destination);
    renamedFiles.push({ from: file, to: newFileName });
  }
}

type BracketRoadmapPhaseId = ReturnType<typeof parsePhaseId>;
type BracketRenumberMapping = { oldId: BracketRoadmapPhaseId; newId: BracketRoadmapPhaseId };

/**
 * #4304 (B2): the ONE identity mapping shared by the disk rename
 * (renameBracketPhases, below) and the ROADMAP rewrite
 * (updateRoadmapAfterBracketPhaseRemoval) — disk and ROADMAP can never
 * disagree because both consume this same computation instead of each
 * deriving its own. Identities are collected from the same directory scan
 * renameBracketPhases uses to find rename candidates, unioned with every
 * heading/checklist/progress line inside the active milestone's own ranges
 * (primary + Phase Details): a phase can exist in ROADMAP with no directory
 * yet, or on disk with no matching ROADMAP line, and either source alone
 * can miss a decimal sub-phase identity. Integer removal maps every phase
 * N > removed to N-1 (a sub-phase's own number is unchanged); sub-phase
 * removal maps every sub-phase S > removed within the target phase to S-1.
 * The result is sorted with decimal (sub-phase-bearing) identities before
 * bare ones, then ascending by phase/subphase, so applying every entry to
 * the same line in sequence never re-matches a value an earlier entry just
 * wrote (a lower phase's new value is never a later entry's old value).
 */
function computeBracketRenumberMapping(
  phasesDir: string,
  roadmapContent: string,
  ranges: ReturnType<typeof currentMilestoneRawRanges>,
  context: BracketWriteContext,
  removedInt: number,
  removedSubphase: number | undefined,
): BracketRenumberMapping[] {
  const identities = new Map<string, { phase: number; subphase?: number }>();
  const record = (phase: number, subphase?: number): void => {
    identities.set(`${phase}.${subphase ?? ''}`, { phase, subphase });
  };

  for (const { id } of bracketIdsInContext(phasesDir, context)) {
    record(Number(id.phase), id.subphase === undefined ? undefined : Number(id.subphase));
  }
  const historicalLineStarts = archivedOrClosedMilestoneLineStarts(roadmapContent);
  const fencedLineNumbers = fencedRoadmapLineNumbers(roadmapContent);
  for (const line of splitRoadmapLineRecords(roadmapContent)) {
    if (!lineStartsInActiveMilestone(line.start, ranges)) continue;
    if (historicalLineStarts.has(line.start) || fencedLineNumbers.has(line.lineNumber)) continue;
    const { id } = classifyBracketOwnedLine(line.text);
    if (!id || id.project !== context.project || id.milestone !== context.milestone) continue;
    record(Number(id.phase), id.subphase === undefined ? undefined : Number(id.subphase));
  }

  const filtered = [...identities.values()].filter(({ phase, subphase }) => {
    if (removedSubphase !== undefined) {
      return phase === removedInt && subphase !== undefined && subphase > removedSubphase;
    }
    return phase > removedInt && !isSentinelPhaseId(phase);
  });

  filtered.sort((a, b) => {
    const aHasSub = a.subphase === undefined ? 0 : 1;
    const bHasSub = b.subphase === undefined ? 0 : 1;
    if (aHasSub !== bHasSub) return bHasSub - aHasSub;
    if (a.phase !== b.phase) return a.phase - b.phase;
    return (a.subphase ?? 0) - (b.subphase ?? 0);
  });

  return filtered.map(({ phase, subphase }) => ({
    oldId: bracketPhaseId(context, phase, subphase),
    newId: removedSubphase !== undefined
      ? bracketPhaseId(context, phase, (subphase as number) - 1)
      : bracketPhaseId(context, phase - 1, subphase),
  }));
}

/**
 * CommonMark fence exclusion shared by bracket removal's inventory and
 * pre-mutation ownership guard. A fenced heading/checklist is documentation,
 * never evidence about the live phase tree. Unclosed fences own through EOF.
 */
function fencedRoadmapLineNumbers(content: string): Set<number> {
  const fenced = new Set<number>();
  const rawLines = content.split('\n');
  for (const block of scanFencedBlocks(rawLines)) {
    const lastIndex = block.closeLineIdx === -1 ? rawLines.length - 1 : block.closeLineIdx;
    for (let index = block.openLineIdx; index <= lastIndex; index++) {
      fenced.add(index + 1);
    }
  }
  return fenced;
}

type RoadmapDetailsTag = {
  offset: number;
  end: number;
  lineStart: number;
  closing: boolean;
  depthBefore: number;
  depthAfter: number;
};

type RoadmapDetailsBlock = {
  start: number;
  end: number;
  startLine: number;
  endLine: number;
  text: string;
};

/**
 * #4304: single fence-aware details-container tracker for bracket writers.
 * Every real tag carries its nesting depth before and after the tag, and every
 * matched block spans its own opening through the corresponding close. A
 * nested close therefore cannot terminate its enclosing block. Unclosed
 * blocks still contribute depth to the tag stream so deletion stays bounded.
 */
function trackRoadmapDetails(content: string): {
  tags: RoadmapDetailsTag[];
  blocks: RoadmapDetailsBlock[];
} {
  const lines = splitRoadmapLineRecords(content);
  const fencedLineNumbers = fencedRoadmapLineNumbers(content);
  const tags: RoadmapDetailsTag[] = [];
  const blocks: RoadmapDetailsBlock[] = [];
  const stack: RoadmapDetailsTag[] = [];
  const detailsTagRe = /<\/?details\b[^>]*>/gi;
  let lineIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = detailsTagRe.exec(content)) !== null) {
    while (lineIndex + 1 < lines.length && lines[lineIndex + 1].start <= match.index) lineIndex += 1;
    const line = lines[lineIndex];
    if (!line || fencedLineNumbers.has(line.lineNumber)) continue;

    const closing = /^<\/details\b/i.test(match[0]);
    const depthBefore = stack.length;
    let opening: RoadmapDetailsTag | undefined;
    if (closing) opening = stack.pop();
    const tag: RoadmapDetailsTag = {
      offset: match.index,
      end: match.index + match[0].length,
      lineStart: line.start,
      closing,
      depthBefore,
      depthAfter: stack.length + (closing ? 0 : 1),
    };
    if (!closing) stack.push(tag);
    tags.push(tag);

    if (opening) {
      blocks.push({
        start: opening.offset,
        end: tag.end,
        startLine: opening.lineStart,
        endLine: tag.lineStart,
        text: content.slice(opening.offset, tag.end),
      });
    }
  }
  return { tags, blocks };
}

/**
 * #4304 (W2): does the bracket phase about to be removed (an
 * INTEGER phase, never a subphase itself — `phase remove NN.SS` is a
 * different, unaffected path) still have its own sub-phases?
 * `computeBracketRenumberMapping`'s own filter only ever maps
 * `phase > removedInt` — the removed phase's OWN sub-phases (`phase ===
 * removedInt`) are never mapped, deleted, or reported — so removing an
 * integer phase that still has sub-phases left them orphaned on disk and
 * in ROADMAP while the NEXT phase's sub-phases renumbered onto the SAME
 * identities, manufacturing duplicates. Scans the SAME two sources
 * computeBracketRenumberMapping unions (the directory scan, and every
 * heading/checklist/progress line outside CommonMark fences and inside the
 * active milestone's own ranges) so this refusal can never see a different
 * phase inventory than the rename/rewrite that would otherwise follow it.
 */
function bracketPhaseOwnSubphases(
  phasesDir: string,
  roadmapContent: string,
  ranges: ReturnType<typeof currentMilestoneRawRanges>,
  context: BracketWriteContext,
  targetInt: number,
): BracketRoadmapPhaseId[] {
  const bySubphase = new Map<number, BracketRoadmapPhaseId>();
  const record = (phase: number, subphase?: number): void => {
    if (phase === targetInt && subphase !== undefined) {
      bySubphase.set(subphase, bracketPhaseId(context, phase, subphase));
    }
  };
  for (const { id } of bracketIdsInContext(phasesDir, context)) {
    record(Number(id.phase), id.subphase === undefined ? undefined : Number(id.subphase));
  }
  const roadmapLines = splitRoadmapLineRecords(roadmapContent);
  const fencedLineNumbers = fencedRoadmapLineNumbers(roadmapContent);
  const historicalLineStarts = archivedOrClosedMilestoneLineStarts(roadmapContent);
  for (const line of roadmapLines) {
    if (!lineStartsInActiveMilestone(line.start, ranges)) continue;
    if (fencedLineNumbers.has(line.lineNumber) || historicalLineStarts.has(line.start)) continue;
    const { id } = classifyBracketOwnedLine(line.text);
    if (!id || id.project !== context.project || id.milestone !== context.milestone) continue;
    record(Number(id.phase), id.subphase === undefined ? undefined : Number(id.subphase));
  }
  return [...bySubphase.keys()].sort((a, b) => a - b).map((s) => bySubphase.get(s)!);
}

/**
 * #4304 (B1): identify ROADMAP lines owned by historical milestone sections.
 * A `<details>` block is historical only when the roadmap reader's own
 * closed-summary classifier says it is; an active collapsed phase list stays
 * live. Outside details, a reader-recognized CLOSED/ARCHIVED/SHIPPED milestone
 * heading owns the section through the next reader-recognized milestone
 * heading at the same or shallower level. Headings come from tokenizeHeadings,
 * so fenced examples are neither historical markers nor section resets.
 * Recognition is imported from the window locator's milestone-vs-phase
 * grammar before the marker predicate is applied, so an ordinary phase title
 * containing FAILED or ✅ never opens or resets a historical section.
 *
 * Details membership comes from the shared fence-aware depth tracker, so every
 * line remains archived while any enclosing details block is a closed
 * milestone archive. This classifier is consumed by both the active-window
 * safety guard and bracket removal's rewrite pass. Historical lines are
 * evidence of neither an active-window mismatch nor a reference that removal
 * may rewrite or delete.
 */
function archivedOrClosedMilestoneLineStarts(content: string): Set<number> {
  const historical = new Set<number>();
  const headingsByOffset = new Map(tokenizeHeadings(content).map((heading) => [heading.offset, heading]));
  const fencedLineNumbers = fencedRoadmapLineNumbers(content);
  const lines = splitRoadmapLineRecords(content);
  const details = trackRoadmapDetails(content);
  const historicalDetailsLineStarts = new Set<number>();
  for (const block of details.blocks) {
    if (!isClosedMilestoneDetails(block.text)) continue;
    for (const line of lines) {
      if (line.start >= block.startLine && line.start <= block.endLine) {
        historicalDetailsLineStarts.add(line.start);
      }
    }
  }
  const detailsTagsByLine = new Map<number, RoadmapDetailsTag[]>();
  for (const tag of details.tags) {
    const lineTags = detailsTagsByLine.get(tag.lineStart) ?? [];
    lineTags.push(tag);
    detailsTagsByLine.set(tag.lineStart, lineTags);
  }
  let detailsDepth = 0;
  let closedHeadingLevel = 0;
  for (const line of lines) {
    const fenced = fencedLineNumbers.has(line.lineNumber);
    const lineTags = detailsTagsByLine.get(line.start) ?? [];
    const insideDetails = detailsDepth > 0 || lineTags.some((tag) => !tag.closing);
    if (historicalDetailsLineStarts.has(line.start) || closedHeadingLevel > 0) historical.add(line.start);
    if (lineTags.length > 0) detailsDepth = lineTags[lineTags.length - 1].depthAfter;
    if (insideDetails) {
      continue;
    }
    if (fenced) {
      continue;
    }
    const heading = headingsByOffset.get(line.start);
    if (heading) {
      const level = heading.level;
      const milestoneHeading = isRecognizedMilestoneHeading(heading.text, level);
      if (milestoneHeading && closedHeadingLevel && level <= closedHeadingLevel) closedHeadingLevel = 0;
      if (!closedHeadingLevel && milestoneHeading && isClosedMilestoneHeading(heading.text)) {
        closedHeadingLevel = level;
      }
    }
    if (closedHeadingLevel > 0) historical.add(line.start);
  }
  return historical;
}

/**
 * #4304 (W2): a pre-mutation SAFETY CHECK, not a fix to the read
 * side's own window selection (mislocating the active window is PR-6 /
 * #4751 territory — this function does not touch that). When the read side
 * mislocates the active milestone window — a non-closed heading carrying
 * the active version token sits BEFORE the real milestone heading ("##
 * Goals for v2.0"), a document-level Progress heading placed before the
 * milestone heading, or no milestone heading exists at all — the checklist/
 * heading rewrite loop in `updateRoadmapAfterBracketPhaseRemoval` never
 * reaches the target's REAL heading/checklist lines, because they sit
 * outside `ranges`. Nothing downstream of that silently-empty rewrite stops
 * the destructive directory delete/rename that already ran by the time the
 * ROADMAP rewrite would have reported the mismatch, so the command "succeeds"
 * with an empty report while the target's heading and checklist survive
 * beside the sibling renumbered onto its old identity.
 *
 * Scans the WHOLE document outside CommonMark fences (not `ranges` — the
 * located window is exactly
 * what is in question) for the target's own heading/checklist lines via the
 * SAME classifier (`classifyBracketOwnedLine`) the rewrite loop uses. If at
 * least one is found and NONE of them fall inside the located `ranges`
 * (primary or details) — including when `ranges` is null, i.e. no milestone
 * window was located at all — the target is misplaced relative to what the
 * read side thinks is active, and the caller must refuse before touching
 * disk. A target correctly inside `ranges` (the overwhelmingly common case)
 * returns null immediately; this never widens or narrows behavior for a
 * correctly-located window.
 */
function bracketOwnedLineOutsideActiveWindow(
  content: string,
  targetId: BracketRoadmapPhaseId,
  ranges: ReturnType<typeof currentMilestoneRawRanges>,
): { lineNumber: number; text: string } | null {
  // Heading deletion (`deleteSection`, scoped to `preDeleteRanges`) and
  // checklist-row deletion (the per-line loop, gated on `active`) are two
  // INDEPENDENT scoped operations in `updateRoadmapAfterBracketPhaseRemoval`
  // — a degenerate window can legitimately contain one kind of owned line
  // while missing the other (p8: the version-less bracket-fallback
  // selects the first PHASE heading as if it were the milestone heading, so
  // the resulting window happens to span every later phase HEADING to EOF
  // while the checklist bullets — which sit ABOVE that heading — are still
  // entirely outside it). Finding the heading safely inside must never mask
  // a checklist row that is not, or vice versa: track each kind separately.
  let headingInside = false;
  let checklistInside = false;
  let firstOutsideHeading: { lineNumber: number; text: string } | null = null;
  let firstOutsideChecklist: { lineNumber: number; text: string } | null = null;
  // #4304: a line archived inside <details> or sitting under a CLOSED milestone
  // heading (isClosedMilestoneHeading — the SAME predicate
  // currentMilestoneRawRanges itself uses to skip a closed heading when
  // selecting the active one) is a SHIPPED milestone's own line — never
  // evidence the ACTIVE window is mislocated. Same-code point releases
  // (milestoneToken folds v2.0/v2.1 to one bracket id) legitimately carry
  // the same [CODE.MM] NN identity in both the shipped archive/section and
  // the active phase's heading-only entry (exactly what `phase add` writes,
  // with no checklist bullet of its own) — this never widens what counts as
  // OUTSIDE, only narrows which OUTSIDE lines count as evidence.
  const historicalLineStarts = archivedOrClosedMilestoneLineStarts(content);
  const fencedLineNumbers = fencedRoadmapLineNumbers(content);
  for (const line of splitRoadmapLineRecords(content)) {
    if (fencedLineNumbers.has(line.lineNumber)) continue;
    const owned = classifyBracketOwnedLine(line.text);
    if (!owned.id || (owned.kind !== 'heading' && owned.kind !== 'checklist')) continue;
    if (!sameBracketPhaseId(owned.id, targetId)) continue;
    const insideActive = Boolean(
      ranges
      && ((line.start >= ranges.primary.start && line.start < ranges.primary.end)
        || (ranges.details !== null
          && line.start >= ranges.details.start && line.start < ranges.details.end)),
    );
    if (!insideActive && historicalLineStarts.has(line.start)) continue;
    if (owned.kind === 'heading') {
      if (insideActive) headingInside = true;
      else if (!firstOutsideHeading) firstOutsideHeading = { lineNumber: line.lineNumber, text: line.text.trim() };
    } else {
      if (insideActive) checklistInside = true;
      else if (!firstOutsideChecklist) firstOutsideChecklist = { lineNumber: line.lineNumber, text: line.text.trim() };
    }
  }
  if (firstOutsideHeading && !headingInside) return firstOutsideHeading;
  if (firstOutsideChecklist && !checklistInside) return firstOutsideChecklist;
  return null;
}

type BracketRenameCandidate = {
  item: { dir: string; id: BracketRoadmapPhaseId; slug: string };
  newId: BracketRoadmapPhaseId;
  newDirName: string;
};

function bracketRenameCandidates(
  phasesDir: string,
  context: BracketWriteContext,
  mapping: BracketRenumberMapping[],
): BracketRenameCandidate[] {
  const mappingKey = (phase: unknown, subphase: unknown): string =>
    `${Number(phase)}.${subphase === undefined ? '' : Number(subphase)}`;
  const byKey = new Map<string, BracketRoadmapPhaseId>();
  for (const { oldId, newId } of mapping) byKey.set(mappingKey(oldId.phase, oldId.subphase), newId);

  return bracketIdsInContext(phasesDir, context)
    .filter(({ id }) => byKey.has(mappingKey(id.phase, id.subphase)))
    .sort((a, b) => {
      const phaseDelta = Number(a.id.phase) - Number(b.id.phase);
      return phaseDelta !== 0
        ? phaseDelta
        : Number(a.id.subphase ?? 0) - Number(b.id.subphase ?? 0);
    })
    .map((item) => {
      const newId = byKey.get(mappingKey(item.id.phase, item.id.subphase))!;
      return { item, newId, newDirName: toDir(newId, item.slug) };
    });
}

function assertBracketRenameDestinationsSafe(
  phasesDir: string,
  context: BracketWriteContext,
  mapping: BracketRenumberMapping[],
): void {
  for (const { newDirName } of bracketRenameCandidates(phasesDir, context, mapping)) {
    assertPhaseDirectoryDestinationSafe(phasesDir, newDirName, 'renumber into');
  }
}

function renameBracketPhases(
  phasesDir: string,
  context: BracketWriteContext,
  mapping: BracketRenumberMapping[],
): {
  renamedDirs: { from: string; to: string }[];
  renamedFiles: { from: string; to: string }[];
  renamedFileCollisions: { from: string; to: string; displaced_to: string | null }[];
} {
  const renamedDirs: { from: string; to: string }[] = [];
  const renamedFiles: { from: string; to: string }[] = [];
  const renamedFileCollisions: { from: string; to: string; displaced_to: string | null }[] = [];

  for (const { item, newId, newDirName } of bracketRenameCandidates(phasesDir, context, mapping)) {
    // Recheck immediately before the rename as well as cmdPhaseRemove's
    // pre-mutation pass, closing the validation-to-use gap within this loop.
    assertPhaseDirectoryDestinationSafe(phasesDir, newDirName, 'renumber into');
    retryRenameSync(path.join(phasesDir, item.dir), path.join(phasesDir, newDirName));
    renamedDirs.push({ from: item.dir, to: newDirName });
    renameBracketArtifactFiles(
      path.join(phasesDir, newDirName),
      item.id,
      newId,
      renamedFiles,
      renamedFileCollisions,
    );
  }

  return { renamedDirs, renamedFiles, renamedFileCollisions };
}

interface BracketRoadmapRewriteResult {
  updated: boolean;
  roadmapLinesRewritten: number;
  referencesLeftUntouched: number[];
}

interface RoadmapLineRecord {
  text: string;
  eol: string;
  start: number;
  lineNumber: number;
}

type BracketOwnedLine = {
  kind: 'heading' | 'checklist' | 'progress' | 'other';
  id: BracketRoadmapPhaseId | null;
};

const BRACKET_OWNED_PHASE_INTRO_SRC = phaseHeadingPrefixSrcFor(
  PHASE_HEADING_BASELINE.LABEL_ONLY,
  'bracket',
  true,
);
const BRACKET_OWNED_PHASE_TOKEN_CAPTURE_SRC = `(${PHASE_NUMBER_TOKEN_SOURCE})`;
const BRACKET_OWNED_TAG_SRC = '(?:[ \\t]*\\([^)\\r\\n]{0,200}\\))?';
// #4304 (B1): every reader compiles BRACKET_OWNED_PHASE_INTRO_SRC's
// own source (phaseHeadingPrefixSrcFor's bracket alternative) with the `i`
// flag — `BRACKET_PROJECT_CODE_SRC` is deliberately spelled `[A-Z]...` on the
// understanding that recognition folds case at compile time, never in the
// source. Round 6 derived the SOURCE correctly here but compiled the owned-line
// regular expressions with no flags at all, so `[ck.02] 02:`,
// `[CK.02] phase 02:` and `[CK.02] PHASE 02:` (case variants the read
// grammar and this PR's own `phase insert`/`phase add` already accept) never
// classified as owned lines here. Headings and progress cells still compile
// this source locally; checklist rows route through parsePhaseChecklistLine,
// the same semantic reader used by init manager.
const BRACKET_HEADING_LINE_RE = new RegExp(
  `^ {0,3}#{2,4}[ \\t]*${BRACKET_OWNED_PHASE_INTRO_SRC}`
  + `${BRACKET_OWNED_PHASE_TOKEN_CAPTURE_SRC}${BRACKET_OWNED_TAG_SRC}[ \\t]*:`,
  'i',
);
const BRACKET_CELL_ID_RE = new RegExp(
  `^${BRACKET_OWNED_PHASE_INTRO_SRC}${BRACKET_OWNED_PHASE_TOKEN_CAPTURE_SRC}`
  + `${BRACKET_OWNED_TAG_SRC}(?:[ \\t]*:|[ \\t]|$)`,
  'i',
);

function splitRoadmapLineRecords(content: string): RoadmapLineRecord[] {
  const records: RoadmapLineRecord[] = [];
  const lineRe = /([^\r\n]*)(\r\n|\n|$)/g;
  let match: RegExpExecArray | null;
  let lineNumber = 1;
  while ((match = lineRe.exec(content)) !== null) {
    if (match[0] === '') break;
    records.push({
      text: match[1],
      eol: match[2],
      start: match.index,
      lineNumber,
    });
    lineNumber += 1;
  }
  return records;
}

function phaseIdFromOwnedParts(
  bracketId: string | undefined,
  phaseNumber: string | undefined,
): BracketRoadmapPhaseId | null {
  if (!bracketId || !phaseNumber) return null;
  try {
    // #4304 (B1): parsePhaseId's own display-form regex requires an
    // uppercase project code and checks canonicality by requiring the
    // re-rendered id to be byte-equal to the input, so a lowercase capture
    // from the now-case-insensitive owned-line regexes above (`[ck.02]
    // 02:`) threw here and silently classified as "not owned" — exactly the
    // identity-recognition gap `foldBracketId`'s own doc comment in
    // phase-id.cts warns about ("fold before any identity operation; never
    // fold for display"). This is an identity operation.
    //
    // #4304 (B1): the captured NUMBER needs the exact same
    // treatment. BRACKET_OWNED_PHASE_TOKEN_CAPTURE_SRC is deliberately
    // TOLERANT (PHASE_NUMBER_TOKEN_SOURCE, the read side's own grammar) so it
    // captures "2", "002", and "02.1" — the same non-canonical spellings
    // `roadmap get-phase`/`analyze`/`validate` and this PR's own `phase
    // insert`/`phase add` already treat as real phases — but parsePhaseId's
    // canonicality check (render(parse(x)) === x) throws on every one of
    // them, so the line silently classified as 'other' before this line's
    // owning heading/checklist/progress row could ever be recognized.
    // Canonicalize through the SAME adapter the bare-token argument path
    // uses (phase-id-display's `phaseToken`, per-segment pad2) BEFORE
    // parsePhaseId, exactly as `canonicalizeBracketPhaseArgument` already
    // does for a CLI argument. A token phaseToken cannot canonicalize (a
    // legacy M-NN letter suffix) falls through unchanged, which still fails
    // parsePhaseId's own grammar precisely as before — this only widens
    // acceptance to spellings phaseToken itself accepts.
    const canonicalNumber = phaseToken(phaseNumber) ?? phaseNumber;
    return parsePhaseId(`[${foldBracketId(bracketId)}] ${canonicalNumber}`);
  } catch {
    return null;
  }
}

function phaseIdFromOwnedLineMatch(match: RegExpExecArray | null): BracketRoadmapPhaseId | null {
  return phaseIdFromOwnedParts(match?.[1], match?.[2]);
}

function classifyBracketOwnedLine(line: string): BracketOwnedLine {
  const headingId = phaseIdFromOwnedLineMatch(BRACKET_HEADING_LINE_RE.exec(line));
  if (headingId) return { kind: 'heading', id: headingId };

  const checklist = parsePhaseChecklistLine(line, 'bracket');
  const checklistId = phaseIdFromOwnedParts(checklist?.bracketId, checklist?.phaseToken);
  if (checklistId) return { kind: 'checklist', id: checklistId };

  if (/^[ \t]*\|/.test(line)) {
    const firstCell = splitTableRow(line)[0]?.replace(/^\*\*(.*)\*\*$/, '$1') ?? '';
    const progressId = phaseIdFromOwnedLineMatch(BRACKET_CELL_ID_RE.exec(firstCell));
    if (progressId) return { kind: 'progress', id: progressId };
  }

  return { kind: 'other', id: null };
}

function sameBracketPhaseId(a: BracketRoadmapPhaseId, b: BracketRoadmapPhaseId): boolean {
  return a.project === b.project
    && a.milestone === b.milestone
    && a.phase === b.phase
    && a.subphase === b.subphase;
}

type LegacyRemovalTargetEvidence = {
  directories: string[];
  headings: string[];
};

/**
 * A bracket removal may share the live tree with migration-window legacy
 * spellings, but it must never mutate that legacy identity indirectly by
 * renumbering later bracket phases onto it. Resolve both directory and heading
 * evidence before any write. `matchPhaseDirs` owns legacy directory selection;
 * `BRACKET_HEADING_LINE_RE` owns the reader-tolerant heading grammar and its
 * legacy `Phase N:` alternative. A real, non-historical bracket heading for the
 * target makes this an ordinary bracket removal even when legacy siblings are
 * also present.
 */
function legacyOnlyBracketRemovalTarget(
  subdirs: string[],
  roadmapContent: string,
  targetPhase: string,
  targetId: BracketRoadmapPhaseId,
  hasBracketDirectory: boolean,
): LegacyRemovalTargetEvidence | null {
  const legacyNormalized = normalizePhaseName(targetPhase);
  const legacyDirectories = matchPhaseDirs(subdirs, legacyNormalized).matches.filter((dir) => {
    try {
      parsePhaseId(dir);
      return false;
    } catch {
      return true;
    }
  });

  const historicalLineStarts = archivedOrClosedMilestoneLineStarts(roadmapContent);
  const legacyHeadings: string[] = [];
  let hasBracketHeading = false;
  for (const heading of tokenizeHeadings(roadmapContent)) {
    if (heading.level < 2 || heading.level > 4) continue;
    const headingLine = '#'.repeat(heading.level) + ' ' + heading.text;
    const owned = classifyBracketOwnedLine(headingLine);
    if (owned.kind === 'heading' && owned.id) {
      if (!historicalLineStarts.has(heading.offset) && sameBracketPhaseId(owned.id, targetId)) {
        hasBracketHeading = true;
      }
      continue;
    }

    // The shared bracket selector includes the legacy `Phase N:` alternative.
    // If classification did not yield a bracket id, capture that alternative's
    // numeric token and compare it through the same writer canonicalizer.
    const legacyMatch = BRACKET_HEADING_LINE_RE.exec(headingLine);
    const canonicalNumber = legacyMatch?.[2] ? phaseToken(legacyMatch[2]) : null;
    const targetNumber = targetId.subphase ? `${targetId.phase}.${targetId.subphase}` : targetId.phase;
    if (canonicalNumber === targetNumber) legacyHeadings.push(headingLine);
  }

  if (hasBracketDirectory || hasBracketHeading) return null;
  if (legacyDirectories.length === 0 && legacyHeadings.length === 0) return null;
  return { directories: legacyDirectories, headings: legacyHeadings };
}

/**
 * Classify a fence-excluded heading token through the roadmap reader's shared
 * bracket-plus-legacy phase-entry predicate, then decide whether it names a
 * phase other than the selected removal target. Bracket headings retain their
 * full project+milestone identity; a bare numeric `Phase NN:` heading is
 * compared in the active target context. A reader-recognized custom legacy id
 * cannot equal a numeric bracket target and is therefore distinct.
 */
function isDistinctReaderPhaseHeading(
  heading: ReturnType<typeof tokenizeHeadings>[number],
  targetId: BracketRoadmapPhaseId,
): boolean {
  if (heading.level < 2 || heading.level > 4) return false;
  if (!isPhaseEntryHeading(heading.text, 'bracket')) return false;

  const headingLine = '#'.repeat(heading.level) + ' ' + heading.text;
  const owned = classifyBracketOwnedLine(headingLine);
  if (owned.kind === 'heading' && owned.id) return !sameBracketPhaseId(owned.id, targetId);

  const numericMatch = BRACKET_HEADING_LINE_RE.exec(headingLine);
  const canonicalNumber = numericMatch?.[2] ? phaseToken(numericMatch[2]) : null;
  if (!canonicalNumber) return true;
  const [phase, subphase] = canonicalNumber.split('.');
  return phase !== targetId.phase || subphase !== targetId.subphase;
}

function dashBracketPhaseId(id: BracketRoadmapPhaseId): string {
  return `${id.project}.${id.milestone}-${id.phase}${id.subphase ? `.${id.subphase}` : ''}`;
}

/** The `PP[.SS][-LL]` tail of a rendered bracket phase id — renderPhaseId minus its milestone-bracket prefix. */
function bracketPhaseNumberSrc(id: BracketRoadmapPhaseId): string {
  return renderPhaseId(id).slice(renderMilestoneId(id).length + 1);
}

function replaceQualifiedBracketReference(
  line: string,
  oldId: BracketRoadmapPhaseId,
  newId: BracketRoadmapPhaseId,
): string {
  const boundary = 'A-Za-z0-9.-';
  const newNumber = bracketPhaseNumberSrc(newId);
  const oldDisplay = renderPhaseId(oldId);
  const qualified = tokenizePhaseDependencyReferences(line, 'bracket')
    .filter((token) => {
      if (token.kind !== 'qualified' || token.token !== oldDisplay) return false;
      const before = token.referenceStart === undefined ? '' : line[token.referenceStart - 1] ?? '';
      const after = line[token.end] ?? '';
      return !new RegExp(`[${boundary}]`).test(before) && !new RegExp(`[${boundary}]`).test(after);
    })
    .sort((a, b) => b.start - a.start);
  let rewritten = line;
  for (const token of qualified) {
    rewritten = rewritten.slice(0, token.start) + newNumber + rewritten.slice(token.end);
  }
  const oldDash = dashBracketPhaseId(oldId);
  const newDash = dashBracketPhaseId(newId);
  return rewritten.replace(
    new RegExp(`(?<![${boundary}])${escapeRegex(oldDash)}(?![${boundary}])`, 'g'),
    () => newDash,
  );
}

function replaceBareBracketArtifactReference(
  line: string,
  oldId: BracketRoadmapPhaseId,
  newId: BracketRoadmapPhaseId,
): string {
  const oldToken = bracketArtifactToken(oldId);
  const newToken = bracketArtifactToken(newId);
  const filename = `${escapeRegex(oldToken)}-\\d{2}`
    + '(?:-[A-Za-z][A-Za-z0-9-]*)?-(?:PLAN|SUMMARY)\\.md';
  return line.replace(
    new RegExp(`(?<![A-Za-z0-9_./-])${filename}(?![A-Za-z0-9_.-])`, 'g'),
    (match) => newToken + match.slice(oldToken.length),
  );
}

function lineStartsInActiveMilestone(
  lineStart: number,
  ranges: ReturnType<typeof currentMilestoneRawRanges>,
): boolean {
  if (!ranges) return false;
  return (lineStart >= ranges.primary.start && lineStart < ranges.primary.end)
    || Boolean(ranges.details && lineStart >= ranges.details.start && lineStart < ranges.details.end);
}

/**
 * #4304 (W1): a NARROWER boundary than currentMilestoneRawRanges'
 * own primary/details ranges. Those stop only at a RECOGNIZED bracket/
 * version-bearing milestone heading, by design (the read path's own
 * milestone-scanning use case treats an unrelated heading — a
 * `## Requirements Traceability`, a `## Notes` — as staying inside the
 * current milestone's content, not as a boundary). A pipe-table row has no
 * "this is my milestone's own table" marker beyond ordinary heading
 * nesting, so deciding whether a progress/table row belongs to THIS
 * milestone needs the plain Markdown rule instead: stop at the next
 * heading of any kind at or above the milestone heading's own level —
 * the SAME rule deleteSection/collectSection already apply elsewhere.
 */
function bracketMilestoneOwnTableEnd(
  content: string,
  sectionStart: number,
  headings: readonly HeadingToken[],
): number {
  const level = (content.slice(sectionStart).match(/^#{1,4}/) ?? ['#'])[0].length;
  for (const h of headings) {
    if (h.offset <= sectionStart) continue;
    if (h.level <= level) return h.offset;
  }
  return content.length;
}

/**
 * #4304 (W1): does `lineStart` fall inside the active milestone's
 * OWN progress/table content — its primary or details section, bounded by
 * `bracketMilestoneOwnTableEnd` rather than the wider currentMilestoneRawRanges
 * end?
 */
function lineStartsInMilestoneOwnTable(
  content: string,
  lineStart: number,
  ranges: ReturnType<typeof currentMilestoneRawRanges>,
  headings: readonly HeadingToken[],
): boolean {
  if (!ranges) return false;
  if (
    lineStart >= ranges.primary.start
    && lineStart < bracketMilestoneOwnTableEnd(content, ranges.primary.start, headings)
  ) {
    return true;
  }
  return Boolean(
    ranges.details
    && lineStart >= ranges.details.start
    && lineStart < bracketMilestoneOwnTableEnd(content, ranges.details.start, headings),
  );
}

// #4304 (W2): the ONE textual expression of "this heading is
// titled Progress" — the title starts with the word "Progress", any
// suffix admitted ("Progress", "Progress (v2.1)", "Progress — current"),
// case-insensitive. `bracketProgressSectionRange` below already tolerated a
// suffix at its own fixed level-2 anchor; `isProgressHeading` inside
// `bracketOwnProgressSectionRanges` required an EXACT "progress" match, so
// a suffixed OWN heading ("## Progress (v2.1)", "### Progress (v2.0)")
// never engaged the own-section scope even though the document-first scope
// already matched the same suffix. Both interpolate this one source now.
const BRACKET_PROGRESS_HEADING_TITLE_SRC = 'Progress\\b';
const BRACKET_PROGRESS_HEADING_TITLE_RE = new RegExp(`^${BRACKET_PROGRESS_HEADING_TITLE_SRC}`, 'i');

/**
 * #4304 (W1): the SAME `## Progress`-section scope legacy's
 * updateRoadmapAfterPhaseRemoval already uses (#2012, src/phase.cts:2482-2500)
 * — the first `## Progress` heading (case-insensitive) through the next
 * `#`/`##` heading or EOF. Lets a DOCUMENT-LEVEL Progress table that sits
 * textually outside the active milestone's own ranges (e.g. after a later
 * milestone's own section, the existing "global Progress table" shape) stay
 * in scope for the target row's own deletion, exactly as it already was.
 */
function bracketProgressSectionRange(content: string): { start: number; end: number } | null {
  const historicalLineStarts = archivedOrClosedMilestoneLineStarts(content);
  const headings = tokenizeHeadings(content);
  const headingIndex = headings.findIndex(
    (heading) => heading.level === 2
      && BRACKET_PROGRESS_HEADING_TITLE_RE.test(heading.text.trim())
      && !historicalLineStarts.has(heading.offset),
  );
  if (headingIndex === -1) return null;
  const start = headings[headingIndex].offset;
  const nextHeading = headings.slice(headingIndex + 1).find((heading) => heading.level <= 2);
  return { start, end: nextHeading?.offset ?? content.length };
}

/**
 * #4304 (W1) / (W1 fix): every distinct RECOGNIZED milestone
 * heading in the document, one representative offset per VERSION (one
 * carrying a version token — `listMilestoneHeadings`' own grammar, via the
 * SAME selection rule, `selectMilestoneHeading`, `currentMilestoneRawRanges`
 * already uses to pick "the" heading for a single version) PLUS one marker
 * per version-LESS bracket milestone heading recognized by the window
 * locator's own grammar (`isBracketMilestoneBoundary`,
 * src/roadmap-parser.cts — the SAME predicate `bracketAwareMilestoneSection`
 * uses to decide a candidate heading is a milestone boundary while walking
 * to find where the ACTIVE milestone's own section ends).
 *
 * Round 8 recognized ONLY version-token headings: a version-less ADR-612
 * canonical milestone heading (`## [CK.02] Shipped ✅`, no `vX.Y` anywhere)
 * produced no marker at all, even though the window locator itself
 * recognizes it as a milestone boundary when walking the document — so a
 * same-code shipped/active pair sharing no version token left the shipped
 * milestone's own `## Progress` heading invisible to the sandwich test, and
 * its own Complete row was deleted as if the table were shared/global.
 *
 * Deliberately NOT merged into one "one representative per identity" pass:
 * a shipped and active milestone commonly share the SAME bracket code
 * (`milestoneToken` folds `v2.0`/`v2.1` alike) while remaining two SEPARATE
 * heading positions that each open their own section — collapsing them by
 * id would silently drop one of the two boundaries the sandwich test needs.
 * Version-token headings keep their existing one-per-version selection
 * (unaffected, since every such heading already carries the distinguishing
 * signal); only headings the version grammar cannot see at all (no `vX.Y`
 * anywhere on the line) fall through to the boundary-predicate scan, so a
 * heading already represented by the version loop is never double-counted
 * merely for also being bracket-shaped (its own "(Phase Details)"
 * continuation heading carries the SAME version token and is excluded here
 * exactly as it always was — `selectMilestoneHeading` picks only the first
 * non-closed occurrence of that version, never the continuation).
 * `content[h.offset] === '#'` mirrors `bracketFallbackHeadingMatches`'s own
 * ATX-only guard (a `<summary>` line naming a milestone is never a heading).
 * Sorted ascending. Used to decide which milestone (if any) a document-first
 * `## Progress` heading sits immediately after, with nothing of its own kind
 * in between.
 */
function bracketRecognizedMilestoneMarkers(content: string): number[] {
  const headings = tokenizeHeadings(content);
  const versions = new Set(listMilestoneHeadings(content).map((h: { version: string }) => h.version));
  const markers: number[] = [];
  for (const version of versions) {
    const selected = selectMilestoneHeading(content, version);
    if (selected?.index !== undefined) markers.push(selected.index);
  }
  for (const h of headings) {
    if (h.level > 3 || content[h.offset] !== '#') continue;
    // Already represented above: this heading carries a version token the
    // first loop already enumerated (its own group's selected marker, or —
    // for a same-version continuation like "(Phase Details)" — the OTHER
    // occurrence `selectMilestoneHeading` picked instead). Mirrors
    // `extractMilestoneHeadingName`'s own no-`expectedVersion` grammar
    // (src/roadmap-parser.cts) literally rather than importing a private
    // helper across the module boundary for one boolean test.
    if (/v\d+(?:\.\d+)*(?:[-.][A-Za-z0-9]+)*/i.test(h.text)) continue;
    // #4304: a "(Phase Details)" heading is always a CONTINUATION of
    // whatever milestone opened before it (`currentMilestoneRawRanges`'s own
    // `detailsMatch` grammar, src/roadmap-parser.cts:2288-2294), never a
    // second, separate milestone marker in its own right — the version loop
    // above already skips a VERSIONED continuation for exactly this reason
    // (comment above); a version-LESS one (`## [CK.02] Current (Phase
    // Details)`) fell through to this boundary-predicate scan uncaught,
    // because `isBracketMilestoneBoundary` is called with `selectedBracketId`
    // `null` here and so cannot recognize it as a continuation of its own
    // milestone.
    if (/\(Phase\s+Details\)/i.test(h.text)) continue;
    if (!isBracketMilestoneBoundary(h.text, h.level, null)) continue;
    markers.push(h.offset);
  }
  return Array.from(new Set(markers)).sort((a: number, b: number) => a - b);
}

/**
 * #4304 (W1): does the DOCUMENT-FIRST
 * `## Progress` heading `bracketProgressSectionRange` found belong to a
 * DIFFERENT, non-active milestone's OWN dedicated section, rather than
 * being a genuinely document-level/shared table?
 *
 * An earlier version of this rule's answer — "the active milestone has a
 * Progress heading of its own, and this isn't it, so it must be someone
 * else's" — over-claims: a genuinely global `## Progress` that lists every
 * milestone's rows (before any milestone heading at all, r1b/s7; or trailing
 * after the LAST recognized milestone heading with nothing bounding it on
 * the far side, s4 shape d) is neither the active milestone's own nor any
 * OTHER milestone's dedicated section, yet that earlier rule called it
 * "owned elsewhere" merely because it wasn't the active one's.
 *
 * The fix asks a POSITIONAL question instead, over every recognized
 * milestone heading in the document (`bracketRecognizedMilestoneMarkers`),
 * not just the active one: is this Progress heading SANDWICHED strictly
 * between two recognized milestone headings — i.e. does it immediately
 * follow one specific milestone's own heading (nothing else of that kind in
 * between) AND does some other recognized milestone heading follow it
 * later in the document? Only then is it unambiguously that earlier
 * milestone's own trailing section (r1, r1c, the same-code two-versions
 * shape). A Progress heading with NOTHING preceding it (top of document) or
 * NOTHING following it (trailing after the last recognized milestone
 * heading) is open, shared territory — never "elsewhere" — because a
 * milestone's own dedicated section and a document-wide table that merely
 * happens to sit after the last milestone's content are textually
 * indistinguishable by position alone once nothing bounds the far side.
 */
function bracketProgressSectionOwnedByOtherMilestone(
  content: string,
  progressStart: number,
  activeRanges: ReturnType<typeof currentMilestoneRawRanges>,
  ownProgressSectionRanges: readonly { start: number; end: number }[],
): boolean {
  // Fast path: exactly one of the ACTIVE milestone's own recognized
  // Progress-titled headings (any level) is never "elsewhere".
  if (ownProgressSectionRanges.some((r) => r.start === progressStart)) return false;

  // #4304 (B1, regression from commit de31ccac0): the original rule's own
  // precondition — the ACTIVE milestone must own a Progress heading of its
  // own before a DIFFERENT Progress heading can be "someone else's" — was
  // dropped when de31ccac0 rewrote this as a purely positional question.
  // Without it, a document whose ACTIVE milestone has no dedicated Progress
  // heading of its own (the common single-shared-table layout: one global
  // `## Progress` table, no per-milestone one) had its shared table declared
  // another milestone's the moment ANY version-bearing heading — a
  // `## Backlog (v4.0 candidates)` line, a changelog entry — followed it in
  // the document, because the positional scan alone cannot distinguish "this
  // table is the NEXT milestone's own dedicated section" from "this table is
  // shared and a later milestone heading simply comes after it in the file".
  // With no own Progress heading at all, the active milestone has no OWN claim
  // any Progress heading could be "instead of", so
  // a shared table can never be misread as belonging to a different one.
  if (ownProgressSectionRanges.length === 0) return false;

  // #4304: drop any marker lying STRICTLY inside the ACTIVE milestone's
  // own ranges — a heading inside the active's own window (a same-id prose
  // sub-heading like "### [CK.02] Notes", admitted by the boundary-predicate
  // scan above because it is bracket-shaped and version-less) never opens a
  // DIFFERENT milestone's section; it is content the active milestone itself
  // owns. A marker AT the range's own start (the active's own primary/details
  // heading) is kept — that is the "sandwiched under the ACTIVE milestone's
  // own heading" case just below, not an interior heading. Same-code SHIPPED
  // headings are never inside the active's own ranges, so they stay markers.
  const markers = bracketRecognizedMilestoneMarkers(content).filter((offset) => {
    if (!activeRanges) return true;
    const insidePrimary = offset > activeRanges.primary.start && offset < activeRanges.primary.end;
    const insideDetails = activeRanges.details !== null
      && offset > activeRanges.details.start && offset < activeRanges.details.end;
    return !insidePrimary && !insideDetails;
  });
  let precedingIndex = -1;
  for (let i = 0; i < markers.length; i++) {
    if (markers[i] <= progressStart) precedingIndex = i;
    else break;
  }
  // Nothing precedes it (top-of-document global table): not owned by anyone.
  if (precedingIndex === -1) return false;

  // Sandwiched under the ACTIVE milestone's own heading: not "elsewhere".
  const precedingOffset = markers[precedingIndex];
  if (activeRanges && precedingOffset === activeRanges.primary.start) return false;

  // Owned by a DIFFERENT milestone only when something else recognized
  // follows it — a trailing section after the LAST recognized milestone
  // heading is open territory, never exclusively that last milestone's own.
  return precedingIndex < markers.length - 1;
}

/**
 * #4304 (W1) / (W2): the active milestone's OWN heading
 * titled "Progress" (`BRACKET_PROGRESS_HEADING_TITLE_RE` — any suffix, any
 * level, case-insensitive), found ANYWHERE inside its primary or details
 * ranges — regardless of what precedes it within those ranges.
 * `bracketMilestoneOwnTableEnd`/`lineStartsInMilestoneOwnTable` above anchor
 * ONLY at the milestone/details heading itself, so an intervening heading of
 * level <= the milestone's own — a `## Notes` aside (r8), or the
 * milestone's OWN `## Progress` heading when a shipped sibling sharing the
 * bracket code sorts its own `## Progress` first in the document (r1c) —
 * closed that "own table" window before ever reaching the table it was
 * meant to include. This is ADDITIVE, never a replacement for it: the
 * existing bare-table-directly-after-phase-headings scope still
 * independently keeps an unrelated `## Requirements Traceability` table
 * (q4, r1b) out of scope, because that heading is not titled "Progress".
 *
 * Round 7 required the heading text to be EXACTLY "progress", so a suffixed
 * title ("## Progress (v2.1)", "### Progress (v2.0)") never engaged this
 * scope even though the document-first `bracketProgressSectionRange` scope
 * already matched the same suffix — a same-code two-versions shipped/active
 * pair each titling their own table "Progress (vX.Y)" left the ACTIVE
 * milestone's own table unrecognized as its own.
 *
 * A second gap the same title-widening exposes: a LEVEL-2 own Progress
 * heading whose title EMBEDS the active milestone's own version token
 * ("## Progress (v2.1)", level 2, same level as the milestone heading
 * itself) is exactly what `currentMilestoneRawRanges`' own section-end scan
 * mistakes for a NEW milestone's heading (it stops at any heading matching
 * `v\d+\.\d+|✅|📋|🚧`, not just a real milestone one) — ending `ranges`
 * immediately BEFORE this heading, so it never falls inside
 * `ranges.primary`/`.details` even once titled "Progress". A heading is
 * never titled merely "Progress" AND is a different milestone's own
 * section-opening heading at once, so a Progress-titled heading sitting
 * EXACTLY at the wide range's own end boundary is still the active
 * milestone's own — the range ended there only because this heading's own
 * suffix looked like a marker, not because a real, different milestone
 * heading intervened.
 */
function bracketOwnProgressSectionRanges(
  content: string,
  ranges: ReturnType<typeof currentMilestoneRawRanges>,
  headings: readonly HeadingToken[],
): { start: number; end: number }[] {
  if (!ranges) return [];
  const isProgressHeading = (h: HeadingToken): boolean => BRACKET_PROGRESS_HEADING_TITLE_RE.test(h.text.trim());
  const withinActive = (offset: number): boolean =>
    (offset >= ranges.primary.start && offset < ranges.primary.end)
    || Boolean(ranges.details && offset >= ranges.details.start && offset < ranges.details.end)
    || offset === ranges.primary.end
    || Boolean(ranges.details && offset === ranges.details.end);
  const out: { start: number; end: number }[] = [];
  for (const h of headings) {
    if (!isProgressHeading(h) || !withinActive(h.offset)) continue;
    out.push({ start: h.offset, end: bracketMilestoneOwnTableEnd(content, h.offset, headings) });
  }
  return out;
}

// #4304 (B5): shared "tolerant" trailing boundary for the
// reporting-only detection regexes below. `(?!\d|\.\d)` blocks extending
// into more digits or a ".digit" continuation (so a bare identity never
// falsely matches inside a longer number or a different decimal sibling),
// but — unlike the rewrite functions' own boundary — permits a following
// '.', '-', letter, or end of line, so a genuinely stale mention survives
// detection even when it sits before sentence-final punctuation or is
// embedded in a directory-name suffix the rewriter deliberately declines
// to touch (detection must be allowed to find more than the rewriter is
// safe to fix).
const BRACKET_REPORT_TOLERANT_BOUNDARY_SRC = '(?!\\d|\\.\\d)';

function bracketQualifiedMentionedInLine(line: string, id: BracketRoadmapPhaseId): boolean {
  const targetDisplay = renderPhaseId(id);
  if (tokenizePhaseDependencyReferences(line, 'bracket')
    .some((token) => token.kind === 'qualified' && token.token === targetDisplay)) return true;
  const dash = dashBracketPhaseId(id);
  return new RegExp(`(?<![A-Za-z0-9.-])${escapeRegex(dash)}${BRACKET_REPORT_TOLERANT_BOUNDARY_SRC}`).test(line);
}

function bracketLegacyPhaseMentionedInLine(line: string, id: BracketRoadmapPhaseId): boolean {
  const token = bracketArtifactToken(id);
  return new RegExp(
    // #4304 (W3): a bracket-QUALIFIED, labeled mention
    // ("[CK.02] Phase 03") is handled completely by
    // replaceQualifiedBracketReference now — it is never "the legacy bare
    // 'Phase NN' spelling this detector exists for. Without the negative
    // lookbehind, the token search matched INSIDE that qualified mention
    // too (nothing distinguished "Phase 03" preceded by "[CK.02] " from a
    // genuinely unqualified "Phase 03:" heading), so a correctly-renumbered
    // labeled line was reported as a dangling reference to the OLD id it no
    // longer contains.
    `(?<!\\][ \\t]{0,10})\\bPhase[ \\t]+${escapeRegex(token)}${BRACKET_REPORT_TOLERANT_BOUNDARY_SRC}`,
    'i',
  ).test(line);
}

function bracketArtifactMentionedInLine(line: string, id: BracketRoadmapPhaseId): boolean {
  const token = bracketArtifactToken(id);
  const filename = `${escapeRegex(token)}-\\d{2}(?:-[A-Za-z][A-Za-z0-9-]*)?-(?:PLAN|SUMMARY)\\.md`;
  return new RegExp(`(?<![A-Za-z0-9_./-])${filename}(?![A-Za-z0-9_.-])`).test(line);
}

/**
 * #4304 (B5): computed from the ORIGINAL (pre-rewrite) line, never
 * the persisted content — re-searching the PERSISTED text for a
 * pre-renumber id is how the prior implementation produced false
 * positives whenever two or more phases shifted (a later phase's NEW
 * value collides textually with an earlier phase's OLD value).
 *
 * The removed identity is a dangling reference by construction wherever it
 * is mentioned — nothing ever rewrites a reference to a deleted phase — so
 * every spelling is checked directly with the tolerant boundary. A
 * renumbered (old -> new) identity is "left untouched" only if running the
 * SAME rewrite this line would actually receive still leaves a mention of
 * the old identity behind afterward: the qualified-reference and
 * bare-artifact rewriters have their own, stricter boundaries (e.g. they
 * decline to rewrite immediately before a sentence-final period, or a
 * bare token embedded in a directory-path segment), so a mention can be
 * real and still survive the rewrite. The legacy "Phase NN" spelling is
 * never rewritten by any bracket rewriter, so it is always checked
 * directly for a renumbered identity too.
 */
function lineContainsTrackedBracketIdentity(
  originalLine: string,
  removedId: BracketRoadmapPhaseId,
  mapping: BracketRenumberMapping[],
): boolean {
  if (
    bracketQualifiedMentionedInLine(originalLine, removedId)
    || bracketLegacyPhaseMentionedInLine(originalLine, removedId)
    || bracketArtifactMentionedInLine(originalLine, removedId)
  ) {
    return true;
  }

  for (const { oldId, newId } of mapping) {
    if (bracketLegacyPhaseMentionedInLine(originalLine, oldId)) return true;
    const afterQualified = replaceQualifiedBracketReference(originalLine, oldId, newId);
    if (bracketQualifiedMentionedInLine(afterQualified, oldId)) return true;
    const afterArtifact = replaceBareBracketArtifactReference(originalLine, oldId, newId);
    if (bracketArtifactMentionedInLine(afterArtifact, oldId)) return true;
  }
  return false;
}

/**
 * #4304: maximum deletion boundary for a selected bracket phase heading.
 * The active milestone range is the outer bound. Inside it, an HTML details
 * boundary wins sooner. The shared fence-aware depth tracker preserves the
 * closing tag of the exact container that encloses the target, or the opening
 * tag of a container that starts after an outside target. Nested details do
 * not count until their own close has restored the target's original depth.
 * The deletion extent also stops at the next distinct phase heading recognized
 * by the reader, whatever its heading depth; ordinary deeper subheadings remain
 * part of the target section.
 */
function bracketPhaseDeletionContainerBoundary(content: string, targetOffset: number): number | null {
  const tags = trackRoadmapDetails(content).tags;
  let targetDepth = 0;
  for (const tag of tags) {
    if (tag.offset >= targetOffset) break;
    targetDepth = tag.depthAfter;
  }
  for (const tag of tags) {
    if (tag.offset < targetOffset) continue;
    if (targetDepth === 0 && !tag.closing) return tag.lineStart;
    if (targetDepth > 0 && tag.closing && tag.depthBefore === targetDepth) return tag.lineStart;
  }
  return null;
}

/**
 * Remove the active bracket phase and renumber its later identities. Qualified
 * references are rewritten roadmap-wide, including global sections and other
 * project-code milestone sections, except for lines inside archived details or
 * closed milestone sections. Those historical lines are never rewritten or
 * deleted. Bare artifact references remain limited to the active milestone.
 */
function updateRoadmapAfterBracketPhaseRemoval(
  roadmapPath: string,
  removedInt: number,
  removedSubphase: number | undefined,
  context: BracketWriteContext,
  mapping: BracketRenumberMapping[],
  cwd: string,
): BracketRoadmapRewriteResult {
  return withPlanningLock(cwd, () => {
    const originalContent = fs.readFileSync(roadmapPath, 'utf-8');
    const targetId = bracketPhaseId(context, removedInt, removedSubphase);
    // #4304 (W2): scope the section deletion to the active
    // milestone's own ranges — the SAME primary+details discovery the
    // checklist-row deletion below already uses — computed from the
    // content BEFORE deletion. Without this, deleteSection removes the
    // FIRST matching heading in the whole document: a shipped milestone
    // and the active one sharing the same bracket code (milestoneToken
    // folds e.g. v2.0 and v2.1 to one [CK.02]) let the shipped section's
    // own detail heading be deleted while the active one survives.
    const preDeleteRanges = currentMilestoneRawRanges(originalContent, cwd, 'bracket');
    // #4304: historical protection applies while SELECTING the section, not
    // only during the later per-line rewrite. A closed details archive can
    // sit inside the raw active-milestone range and carry the same folded
    // bracket id as the live phase; choosing that heading first deletes
    // history and leaves the live target behind.
    const preDeleteHistoricalLineStarts = archivedOrClosedMilestoneLineStarts(originalContent);
    const isTargetHeading = (heading: ReturnType<typeof tokenizeHeadings>[number]): boolean => {
      // #4304 (W3): classify the heading through the SAME shared
      // owned-line grammar (classifyBracketOwnedLine / BRACKET_HEADING_LINE_RE)
      // the checklist/progress-row deletion below already uses, instead of
      // a literal `startsWith(targetDisplay)` — that comparison only ever
      // recognized the display spelling ("[CK.02] 02"), so the read-grammar-
      // admitted labeled spelling ("[CK.02] Phase 02:", pinned at
      // tests/adr-612-bracket-grammar.test.cjs:644) was never matched here
      // and its detail section survived a "removal" that deleted every
      // other owned line for the same identity.
      if (heading.level < 2 || heading.level > 4) return false;
      const headingLine = '#'.repeat(heading.level) + ' ' + heading.text;
      const owned = classifyBracketOwnedLine(headingLine);
      if (owned.kind !== 'heading' || !owned.id || !sameBracketPhaseId(owned.id, targetId)) {
        return false;
      }
      if (preDeleteHistoricalLineStarts.has(heading.offset)) return false;
      if (!preDeleteRanges) return true;
      return (
        (heading.offset >= preDeleteRanges.primary.start && heading.offset < preDeleteRanges.primary.end)
        || Boolean(
          preDeleteRanges.details
          && heading.offset >= preDeleteRanges.details.start
          && heading.offset < preDeleteRanges.details.end,
        )
      );
    };
    const selectedTargetHeading = tokenizeHeadings(originalContent).find(isTargetHeading);
    let deletionEndOffset: number | undefined;
    if (selectedTargetHeading) {
      const nextDistinctPhaseHeading = tokenizeHeadings(originalContent).find(
        (heading) => heading.offset > selectedTargetHeading.offset
          && isDistinctReaderPhaseHeading(heading, targetId),
      );
      const containingRange = preDeleteRanges
        ? [preDeleteRanges.primary, ...(preDeleteRanges.details ? [preDeleteRanges.details] : [])]
          .find((range) => selectedTargetHeading.offset >= range.start && selectedTargetHeading.offset < range.end)
        : null;
      const containerBoundary = bracketPhaseDeletionContainerBoundary(
        originalContent,
        selectedTargetHeading.offset,
      );
      const historicalBoundary = [...preDeleteHistoricalLineStarts]
        .filter((offset) => offset > selectedTargetHeading.offset)
        .sort((a, b) => a - b)[0];
      deletionEndOffset = Math.min(
        containingRange?.end ?? originalContent.length,
        containerBoundary ?? originalContent.length,
        historicalBoundary ?? originalContent.length,
        nextDistinctPhaseHeading?.offset ?? originalContent.length,
      );
    }
    let content = deleteSection(originalContent, isTargetHeading, { endOffset: deletionEndOffset });
    let roadmapLinesRewritten = content === originalContent ? 0 : 1;
    const ranges = currentMilestoneRawRanges(content, cwd, 'bracket');
    // #4304 (W1): progress/table-row deletion is
    // scoped to the active milestone's OWN table content
    // (bracketMilestoneOwnTableEnd — narrower than `ranges` itself, see its
    // own doc comment) plus its own "Progress"-titled heading found ANYWHERE
    // in its ranges (bracketOwnProgressSectionRanges — additive:
    // covers a `## Notes` aside or a per-milestone `## Progress` the plain
    // own-table-end closes over too early) plus a document-level
    // `## Progress` section that is not itself owned by a DIFFERENT
    // milestone (legacy's own #2012 scope, plus an ownership gate)
    // — never the whole document. Without this, a same-identity row in ANY
    // pipe table anywhere (a shipped milestone sharing the same bracket
    // code, an unrelated Requirements Traceability table) was deleted.
    const headingsForOwnTable = tokenizeHeadings(content);
    const progressSectionRange = bracketProgressSectionRange(content);
    const ownProgressSectionRanges = bracketOwnProgressSectionRanges(content, ranges, headingsForOwnTable);
    const progressSectionOwnedElsewhere = progressSectionRange
      ? bracketProgressSectionOwnedByOtherMilestone(content, progressSectionRange.start, ranges, ownProgressSectionRanges)
      : false;
    const historicalLineStarts = archivedOrClosedMilestoneLineStarts(content);
    const fencedLineNumbers = fencedRoadmapLineNumbers(content);

    // #4304 (B5): the referencesLeftUntouched report is computed
    // from each KEPT line's ORIGINAL (pre-rewrite) text, never the
    // persisted (already-rewritten) content — re-searching persisted text
    // for a pre-renumber id is how the prior implementation produced false
    // positives whenever two or more phases shifted (a later phase's NEW
    // value collides textually with an earlier phase's OLD value). A line
    // that gets DELETED here (the target's own owned heading/checklist/
    // progress row) can never be "left untouched" — it does not exist in
    // the output at all — so only kept lines are considered.
    const keptOriginalLines: { text: string; active: boolean }[] = [];

    const rewritten: string[] = [];
    for (const line of splitRoadmapLineRecords(content)) {
      const active = lineStartsInActiveMilestone(line.start, ranges);
      const historical = historicalLineStarts.has(line.start);
      const fenced = fencedLineNumbers.has(line.lineNumber);
      if (fenced) {
        rewritten.push(line.text + line.eol);
        keptOriginalLines.push({ text: line.text, active: false });
        continue;
      }
      const owned = classifyBracketOwnedLine(line.text);
      const inMilestoneOwnTable = owned.kind === 'progress'
        && (lineStartsInMilestoneOwnTable(content, line.start, ranges, headingsForOwnTable)
          || ownProgressSectionRanges.some((r) => line.start >= r.start && line.start < r.end));
      const inProgressSection = owned.kind === 'progress' && Boolean(
        progressSectionRange
        && !progressSectionOwnedElsewhere
        && line.start >= progressSectionRange.start
        && line.start < progressSectionRange.end,
      );
      if (!historical
        && owned.id
        && sameBracketPhaseId(owned.id, targetId)
        && ((active && owned.kind === 'checklist') || inMilestoneOwnTable || inProgressSection)) {
        roadmapLinesRewritten += 1;
        continue;
      }

      let next = line.text;
      if (!historical) {
        for (const { oldId, newId } of mapping) {
          next = replaceQualifiedBracketReference(next, oldId, newId);
          if (active) next = replaceBareBracketArtifactReference(next, oldId, newId);
        }
      }
      if (next !== line.text) roadmapLinesRewritten += 1;
      rewritten.push(next + line.eol);
      // A historical line can be physically inside the raw active milestone
      // range (closed details nested below the live milestone heading). It is
      // intentionally exempt from this mutation, so it is not an active
      // dangling reference for the removal report either.
      keptOriginalLines.push({ text: line.text, active: active && !historical });
    }
    content = rewritten.join('');

    const bracketNormalization = { preserveFencedMarkdownStructure: true } as const;
    platformWriteSync(roadmapPath, content, bracketNormalization);
    // platformWriteSync's own markdown normalization (_normalizeMd) inserts
    // blank lines around headings/fences/lists and collapses runs of 3+
    // blank lines, so a KEPT line's position here can shift from its
    // position in `keptOriginalLines`. Normalization only ever adds or
    // collapses BLANK lines — it never reorders or edits a non-blank
    // line's text — so the Nth non-blank kept (original) line always
    // corresponds to the Nth non-blank persisted line; blank kept lines
    // are skipped entirely since they can never contain a tracked identity.
    const persistedContent = fs.readFileSync(roadmapPath, 'utf-8');
    const persistedNonBlankLineNumbers = splitRoadmapLineRecords(persistedContent)
      .filter((line) => line.text.trim() !== '')
      .map((line) => line.lineNumber);

    const referencesLeftUntouched: number[] = [];
    let nonBlankIndex = 0;
    for (const { text, active } of keptOriginalLines) {
      if (text.trim() === '') continue;
      const persistedLineNumber = persistedNonBlankLineNumbers[nonBlankIndex];
      nonBlankIndex += 1;
      if (!active || persistedLineNumber === undefined) continue;
      if (lineContainsTrackedBracketIdentity(text, targetId, mapping)) {
        referencesLeftUntouched.push(persistedLineNumber);
      }
    }
    return {
      updated: contentChangedAfterNormalize(roadmapPath, originalContent, content, bracketNormalization),
      roadmapLinesRewritten,
      referencesLeftUntouched,
    };
  });
}

function cmdPhaseRemove(
  cwd: string,
  targetPhase: string,
  options: PhaseRemoveOptions,
  raw: boolean,
): void {
  if (!targetPhase) error('phase number required for phase remove');

  const roadmapPath = path.join(planningDir(cwd), 'ROADMAP.md');
  const phasesDir = path.join(planningDir(cwd), 'phases');

  if (!fs.existsSync(roadmapPath)) error('ROADMAP.md not found');

  const force = options.force || false;
  const removeConvention = resolvePhaseIdConvention(cwd);
  const removeContext = removeConvention === 'bracket'
    ? bracketWriteContext(cwd, loadConfig(cwd))
    : null;

  // #4304 / (I1): canonicalize every bracket argument before
  // directory matching or any write, through the SAME adapter `phase
  // insert` now uses (canonicalizeBracketPhaseArgument) — a bare token
  // through phase-id-display's `phaseToken`, a qualified/display token
  // through phase-id.cts's strict `parsePhaseId`. A rejected spelling has no
  // parseInt fallback, so it cannot partially name a real phase and reach
  // the destructive path.
  let normalized: string;
  let isDecimal: boolean;
  let removedInt: number;
  let removedSubphase: number | undefined;
  if (removeContext) {
    ({ normalized, isDecimal } = canonicalizeBracketPhaseArgument(removeContext, targetPhase, 'remove'));
    const [phasePart, subphasePart] = normalized.split('.');
    removedInt = Number(phasePart);
    removedSubphase = subphasePart === undefined ? undefined : Number(subphasePart);
  } else {
    // Legacy and milestone-prefixed paths retain their original permissive
    // normalization and parseInt behavior byte-for-byte.
    normalized = normalizePhaseName(targetPhase);
    isDecimal = targetPhase.includes('.');
    removedInt = parseInt(normalized, 10);
    removedSubphase = isDecimal ? parseInt(normalized.split('.')[1], 10) : undefined;
  }

  const subdirs = readSubdirectories(phasesDir, true);
  // #2237/#2528: every other resolution path refuses to choose between multiple
  // directories claiming one phase number. This one is the DESTRUCTIVE path, so
  // taking `matches[0]` silently is strictly worse than anywhere else: it turns
  // "resolve nothing" into "delete one of two candidates, unrecoverably, and
  // renumber every phase after it". Refuse before any file is touched.
  const candidateDirs = removeContext
    ? bracketIdsInContext(phasesDir, removeContext).map(({ dir }) => dir)
    : subdirs;
  const { matches: phaseDirMatches } = matchPhaseDirs(
    candidateDirs,
    normalized,
    removeConvention === 'bracket' ? 'bracket' : undefined,
  );
  if (phaseDirMatches.length > 1) {
    output(
      {
        removed: null,
        error:
          `Phase ${normalized} is ambiguous: ${phaseDirMatches.length} directories match `
          + `(${phaseDirMatches.map((m) => `"${m}"`).join(', ')}). Refusing to remove any of them. `
          + 'Set a distinct project_code in .planning/config.json, or pass the full directory name.',
        ambiguous_matches: phaseDirMatches,
        directory_deleted: null,
        renamed_directories: [],
        renamed_files: [],
        roadmap_updated: false,
        state_updated: false,
      },
      raw,
    );
    return;
  }
  const targetDir = phaseDirMatches[0] || null;

  const roadmapContentBeforeRemoval = removeContext ? fs.readFileSync(roadmapPath, 'utf-8') : null;
  if (removeContext) {
    const targetId = bracketPhaseId(removeContext, removedInt, removedSubphase);
    const legacyOnly = legacyOnlyBracketRemovalTarget(
      subdirs,
      roadmapContentBeforeRemoval!,
      targetPhase,
      targetId,
      targetDir !== null,
    );
    if (legacyOnly) {
      const evidence = [
        ...legacyOnly.directories.map((dir) => `directory ${JSON.stringify(dir)}`),
        ...legacyOnly.headings.map((heading) => `heading ${JSON.stringify(heading)}`),
      ].join('; ');
      error(
        `Cannot remove phase ${normalized} under the bracket convention: it resolves only to `
        + `legacy-spelled artifacts (${evidence}). Run roadmap upgrade --convention bracket `
        + 'before removing this phase.',
      );
    }
  }

  if (targetDir && !force) {
    // #3183: canonical summary set (root+nested) from the single owner —
    // a root-only readdirSync filter left nested (#3139 layout) summaries
    // invisible, letting a phase with completed nested work be deleted
    // without --force.
    const summaryCount = scanPhasePlans(path.join(phasesDir, targetDir)).summaryFiles.length;
    if (summaryCount > 0) {
      error(
        `Phase ${targetPhase} has ${summaryCount} executed plan(s). Use --force to remove anyway.`,
      );
    }
  }

  // #4304 (B2): compute the ONE renumber mapping shared by the disk
  // rename and the ROADMAP rewrite before either runs, from the roadmap
  // content as it stands right now (only the target directory is about to
  // be deleted below; deletion does not change which OTHER identities the
  // scan finds). Both consumers below apply this exact mapping so they
  // cannot independently diverge on a decimal sub-phase identity.
  const preRemovalRanges = roadmapContentBeforeRemoval
    ? currentMilestoneRawRanges(roadmapContentBeforeRemoval, cwd, 'bracket')
    : null;

  // #4304 (W2): refuse before any mutation when an INTEGER phase
  // still has its own sub-phases. Without this, computeBracketRenumberMapping's
  // filter (phase > removedInt only) never touches the removed phase's OWN
  // sub-phases: they stay orphaned on disk/ROADMAP while the NEXT phase's
  // sub-phases renumber onto the SAME identities, manufacturing duplicates
  // (legacy has the same defect on its own path — parity, not fixed there).
  if (removeContext && removedSubphase === undefined) {
    const ownSubphases = bracketPhaseOwnSubphases(
      phasesDir,
      roadmapContentBeforeRemoval!,
      preRemovalRanges,
      removeContext,
      removedInt,
    );
    if (ownSubphases.length > 0) {
      error(
        `Cannot remove phase ${normalized}: it still has sub-phase(s) `
        + `${ownSubphases.map((id) => renderPhaseId(id)).join(', ')}. `
        + 'Remove the sub-phase(s) first, then remove the phase.',
      );
    }
  }

  // #4304 (W2): refuse before any mutation when the target's own
  // heading/checklist line lives entirely OUTSIDE the milestone window the
  // read side located — a mislocated window (a decoy heading carrying the
  // active version token before the real milestone heading, a document-level
  // Progress heading placed before it, or no milestone heading at all)
  // otherwise lets the destructive delete/rename below proceed while the
  // ROADMAP rewrite silently never reaches the target's real lines. Does not
  // attempt to fix the window's own selection (PR-6 / #4751 territory) —
  // only refuses instead of half-applying.
  //
  // #4304: NOT additionally gated on `targetDir` — a ROADMAP-only
  // target (a phase `phase add` created with no directory materialized yet)
  // on a mislocated window still half-applied under the `targetDir` gate:
  // later directories renamed and their ROADMAP lines renumbered onto the
  // target's identity while the target's own heading/checklist survived,
  // with an empty report. The guard reads only ROADMAP content (never
  // `targetDir` itself), so gating it on a directory that may not exist
  // protected nothing; with no directory and no matching ROADMAP line the
  // guard already returns null.
  if (removeContext) {
    const guardTargetId = bracketPhaseId(removeContext, removedInt, removedSubphase);
    const outside = bracketOwnedLineOutsideActiveWindow(
      roadmapContentBeforeRemoval!,
      guardTargetId,
      preRemovalRanges,
    );
    if (outside) {
      const windowDescription = preRemovalRanges
        ? `the located milestone window starting at line ${
          roadmapContentBeforeRemoval!.slice(0, preRemovalRanges.primary.start).split('\n').length
        } (${
          roadmapContentBeforeRemoval!
            .slice(preRemovalRanges.primary.start, roadmapContentBeforeRemoval!.indexOf('\n', preRemovalRanges.primary.start))
            .trim()
        })`
        : 'no milestone heading at all';
      error(
        `Cannot remove phase ${normalized}: its own heading/checklist line `
        + `(ROADMAP.md line ${outside.lineNumber}: ${JSON.stringify(outside.text)}) `
        + `lies outside ${windowDescription}. ROADMAP.md's milestone heading was not `
        + 'found where expected; verify the ROADMAP.md structure before removing.',
      );
    }
  }

  const bracketMapping = removeContext
    ? computeBracketRenumberMapping(
      phasesDir,
      roadmapContentBeforeRemoval!,
      preRemovalRanges,
      removeContext,
      removedInt,
      removedSubphase,
    )
    : [];

  // Validate every bracket rename destination before deleting the target or
  // changing ROADMAP/STATE, so a planted symlink produces a clean refusal
  // with the planning tree untouched.
  if (removeContext) {
    assertBracketRenameDestinationsSafe(phasesDir, removeContext, bracketMapping);
  }

  if (targetDir) fs.rmSync(path.join(phasesDir, targetDir), { recursive: true, force: true });

  let renamedDirs: { from: string; to: string }[] = [];
  let renamedFiles: { from: string; to: string }[] = [];
  let renamedFileCollisions: { from: string; to: string; displaced_to: string | null }[] = [];
  try {
    if (removeContext) {
      // #4304 Blocker 1: reuse the SAME removedInt/removedSubphase validated
      // above (before deletion) instead of re-deriving from `normalized`,
      // which is NaN for a qualified id like `CK.02-02`.
      const renamed = renameBracketPhases(
        phasesDir,
        removeContext,
        bracketMapping,
      );
      renamedDirs = renamed.renamedDirs;
      renamedFiles = renamed.renamedFiles;
      renamedFileCollisions = renamed.renamedFileCollisions;
    } else if (isDecimal) {
      const renamed = renameDecimalPhases(
        phasesDir,
        parseInt(normalized.split('.')[0], 10),
        parseInt(normalized.split('.')[1], 10),
      );
      renamedDirs = renamed.renamedDirs;
      renamedFiles = renamed.renamedFiles;
    } else {
      const renamed = renameIntegerPhases(phasesDir, parseInt(normalized, 10));
      renamedDirs = renamed.renamedDirs;
      renamedFiles = renamed.renamedFiles;
      renamedFileCollisions = renamed.renamedFileCollisions;
    }
  } catch (e) {
    // #2245 audit (was ERROR-HIDING): renameDecimalPhases/renameIntegerPhases
    // rename subsequent phase directories ON DISK one at a time — a mid-loop
    // failure leaves SOME directories already renumbered and others not, with
    // no way to recover which (the callee's own renamedDirs/renamedFiles never
    // reach this scope when it throws). Silently swallowing this and falling
    // through to updateRoadmapAfterPhaseRemoval below used to rewrite
    // ROADMAP.md's phase numbers assuming the ENTIRE renumbering succeeded,
    // permanently desyncing ROADMAP.md from the actual (partially-renamed)
    // on-disk directory names. Surface loud instead of compounding it.
    const msg = e instanceof Error ? e.message : String(e);
    error(`Failed to renumber phase directories after removing phase ${targetPhase}: ${msg}`);
  }

  const bracketRoadmapRewrite = removeContext
    ? updateRoadmapAfterBracketPhaseRemoval(
      roadmapPath,
      removedInt,
      removedSubphase,
      removeContext,
      bracketMapping,
      cwd,
    )
    : null;
  const roadmapUpdated = bracketRoadmapRewrite
    ? bracketRoadmapRewrite.updated
    : updateRoadmapAfterPhaseRemoval(
      roadmapPath,
      targetPhase,
      isDecimal,
      parseInt(normalized, 10),
      cwd,
    );

  const statePath = path.join(planningDir(cwd), 'STATE.md');
  let stateUpdated = false;
  if (fs.existsSync(statePath)) {
    // #2640: report whether STATE.md content actually changed, not just file
    // existence (fs.existsSync was trivially true). Also ensure the body
    // transform produces a diff so readModifyWriteStateMd's no-op guard
    // (#948) doesn't skip the frontmatter resync — without that, the
    // progress.* frontmatter block stays stale when the body has no
    // 'Total Phases:' or 'of N' phrase.
    stateUpdated = readModifyWriteStateMd(
      statePath,
      (stateContent: string) => {
        let modified = stateContent;
        const totalRaw = stateExtractField(modified, 'Total Phases');
        if (totalRaw) {
          // #3572 review: clamp at 0 — a stale 'Total Phases: 0' (e.g. written by
          // an earlier remove whose dir-count was 0) must not decrement to -1 on
          // the next removal.
          modified =
            stateReplaceField(
              modified,
              'Total Phases',
              String(Math.max(0, parseInt(totalRaw, 10) - 1)),
            ) || modified;
        }
        const ofMatch = modified.match(/(\bof\s+)(\d+)(\s*(?:\(|phases?))/i);
        if (ofMatch) {
          modified = modified.replace(
            /(\bof\s+)(\d+)(\s*(?:\(|phases?))/i,
            `$1${Math.max(0, parseInt(ofMatch[2], 10) - 1)}$3`,
          );
        }
        // #2640: if neither body field was found, the transform is a no-op.
        // readModifyWriteStateMd's no-op guard (#948) would then skip the
        // frontmatter resync, leaving progress.* stale. Force a body diff
        // ONLY when a phase directory was actually removed (targetDir !== null)
        // so the guard passes and syncStateFrontmatter rebuilds the frontmatter
        // from the post-deletion disk/ROADMAP state. Without the targetDir gate,
        // a no-op removal (ROADMAP-only phase, no directory) would inject a
        // spurious 'Total Phases:' line into a body that intentionally lacked one.
        if (targetDir && modified === stateContent) {
          // subdirs was read before the deletion; excluding the removed target
          // gives the remaining count. Renumbering changes names but not count.
          //
          // #2528: exclude the directory that was ACTUALLY deleted, by identity,
          // rather than re-deriving "which dir was the target" from the query.
          // The two are not the same predicate here: `targetDir` comes from
          // `matchPhaseDirs`, whose bare-integer fallback resolves digit-leading
          // dirs (`05-80-20-cleanup` for query `5`) that `phaseTokenMatches`
          // reports as non-matching — so a token re-derivation would count the
          // just-deleted directory as still present and write a `Total Phases`
          // one too high. Identity is also what the comment above already
          // claims this filter does, and the block is gated on targetDir.
          // (#3572 note: this body field counts DIRECTORIES on disk; the
          // frontmatter progress.* block is rebuilt by syncStateFrontmatter
          // from the post-removal ROADMAP — the two counts legitimately differ
          // when phases exist in ROADMAP without directories.)
          const remainingPhases = Math.max(0, subdirs.filter((d) => d !== targetDir).length);
          if (totalRaw) {
            modified =
              stateReplaceField(modified, 'Total Phases', String(remainingPhases)) || modified;
          } else {
            // No 'Total Phases:' field in the body — insert one at the start of
            // the BODY so the no-op guard sees a diff. #3572: the former
            // whole-content prepend landed the line BEFORE the opening '---'
            // fence and corrupted STATE.md into two frontmatter blocks.
            // syncStateFrontmatter will still rebuild the frontmatter
            // progress.* block from the real disk/ROADMAP count.
            modified = insertStateBodyFieldAtTop(modified, `Total Phases: ${remainingPhases}`);
          }
        }
        return modified;
      },
      cwd,
    );
  }

  output(
    {
      removed: targetPhase,
      directory_deleted: targetDir,
      renamed_directories: renamedDirs,
      renamed_files: renamedFiles,
      renamed_file_collisions: renamedFileCollisions,
      // #3685: mirror requirementsUpdated's diff-tracking contract — true only
      // when updateRoadmapAfterPhaseRemoval's content diff detected a real
      // change, not hardcoded regardless of whether ROADMAP.md's content
      // actually changed.
      roadmap_updated: roadmapUpdated,
      ...(bracketRoadmapRewrite
        ? {
            roadmap_lines_rewritten: bracketRoadmapRewrite.roadmapLinesRewritten,
            references_left_untouched: bracketRoadmapRewrite.referencesLeftUntouched,
          }
        : {}),
      state_updated: stateUpdated,
    },
    raw,
  );
  // #3227: unconditional here because `updateRoadmapAfterPhaseRemoval` above
  // always rewrites ROADMAP.md before this line is reached; every refusal path
  // (bad target, missing ROADMAP.md, --force-required, renumber failure) exits
  // via `error()`, and the ambiguous-match case exits via an earlier `return`
  // before any file is touched.
  publishStateContract(cwd);
}

interface WriteSpec {
  filePath: string;
  before: string;
  after: string;
}

/**
 * #3227: returns the count of writes actually applied (entries whose
 * `before` differed from `after` and were therefore written to disk) — the
 * caller (`cmdPhaseComplete`) uses this as its publish-gate signal, since a
 * re-run against an already-completed phase can produce a `writes[]` array
 * where every entry is byte-identical to what's already on disk.
 */
function writePlanningFileSet(writes: WriteSpec[]): number {
  const applied: WriteSpec[] = [];
  try {
    for (const write of writes) {
      if (write.before === write.after) continue;
      platformWriteSync(write.filePath, write.after);
      applied.push(write);
    }
  } catch (err) {
    for (const write of applied.reverse()) {
      try {
        platformWriteSync(write.filePath, write.before);
      } catch (rollbackErr) {
        const errObj = err as Error & { rollbackError?: unknown };
        errObj.rollbackError = rollbackErr;
        const rollbackMsg =
          rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
        errObj.message +=
          `\nWARNING: rollback failed while restoring ${write.filePath} ` +
          `(${rollbackMsg}). Planning files under .planning/ may be left in an ` +
          `inconsistent, partially rolled back state. Inspect ROADMAP.md / REQUIREMENTS.md / ` +
          `STATE.md before re-running phase complete.`;
        break;
      }
    }
    throw err;
  }
  return applied.length;
}

function phaseDisplayNameFromRoadmap(roadmapContent: string | null, phaseNum: string | null): string | null {
  if (!roadmapContent || !phaseNum) return null;
  const phaseEscaped = phaseMarkdownRegexSource(phaseNum);
  const heading = roadmapContent.match(new RegExp(`^#{2,4}\\s*Phase\\s+${phaseEscaped}${OPTIONAL_PHASE_TAG_SOURCE}\\s*:\\s*([^\\n]+)`, 'im'));
  if (!heading) return null;
  const name = heading[1].replace(/\(INSERTED\)/i, '').trim();
  return name || null;
}

function phaseDisplayNameFromSlug(slug: string | null): string | null {
  if (!slug) return null;
  const name = slug.replace(/-/g, ' ').trim();
  return name || null;
}

// ─── #3697: the `**Requirements**:` line under-selection detector ────────────
//
// EXTRACTED from cmdPhaseComplete (round 3, review finding Blocker 1). The
// detection logic below is a parser, so `RULESET.TESTS.property-based-testing`
// requires at least one fast-check property test over it — and that is not
// reachable while the logic is a closure inside a command that only a
// subprocess can invoke (every #3697 test spawns the CLI; 100 fc runs cannot).
// Extraction is therefore load-bearing, not tidying: it is what makes the
// property test and the 2048-boundary fixtures (Blocker 2) expressible at all.
//
// BEHAVIOUR IS UNCHANGED BY THE MOVE. The two tokenizations below stay
// deliberately DIFFERENT and are co-located so they cannot drift apart:
//   * the SELECTOR strips `[` and `]` only, then splits on `[,\s]+`. Its output
//     IS `citedReqIds` — the ledger-writing set — so widening it would change
//     what phase-complete marks, which #3697 explicitly does not do.
//   * the DETECTOR additionally shaves brackets/quotes/emphasis and trailing
//     sentence punctuation, so it can see an operator or an ID that the
//     selector's stricter shape filter rejects.
// The gap between them is not a defect: it is why `ADR-7)` is not selected
// while `ADR-7` is still nameable in a warning.
//
// The `**Requirements**: TBD` placeholder is what phase.add / -batch / -insert
// seed (three sites in this file — locate them by the literal
// `Requirements**: TBD`, never by line number: an earlier revision of this
// comment cited 833/920/1078, which had drifted to 1132/1237/1413 by round 3).
// The shipped comma-list template is `gsd-core/templates/roadmap.md:32`.
type RequirementsLineAnalysis = {
  /** The ledger-writing set — byte-identical to the pre-extraction selector. */
  citedReqIds: string[];
  /** The detector's shaved tokens (see the tokenization note above). */
  tokens: string[];
  /** R1 — tokens that are THEMSELVES a range (`RANGE-01..RANGE-05`). */
  rangeTokens: string[];
  /** R2 — a bare operator with a selected, interior-implying ID either side. */
  hasSpacedRange: boolean;
  /** R2' — an operator GLUED to one endpoint (`RANGE-01 -RANGE-05`). */
  hasGluedRangeFragment: boolean;
  /** R3 — zero selection on a non-placeholder line, with ID-shaped residue. */
  inertIdShaped: string[];
  /**
   * R3b — zero selection on a non-placeholder line that carries ANY content.
   *
   * This is #3697's AC-1b/AC-4 verbatim ("warn when `citedReqIds.length === 0`
   * while the raw capture is non-empty and not `TBD`"), and it is deliberately
   * NOT gated on ID-shaped residue the way R3 is. Round 4 measured the reason:
   * every one of the fifteen #2334/#2339 negative-space fixtures is held
   * silent by non-zero SELECTION or by `placeholderLed`, and not one of them by
   * the ID-shape gate — so the gate was buying no negative space while costing
   * the acceptance criterion. `Deferred`, `N/A`, `Pending`, `TBA` and `-` were
   * silent because of it, while the docs, this census and the advice string all
   * said they warned.
   */
  zeroSelectionInert: boolean;
  /**
   * R4 — REQ-IDs the SELECTOR dropped because a delimiter was glued to them.
   *
   * `REQ-01; REQ-02` selects only `REQ-02`: the selector splits on `[,\s]+`,
   * so `REQ-01;` keeps its semicolon and fails the anchored ID shape. This is
   * #3697's own half-success failure mode — `requirements_updated: true` with
   * a silently unmarked requirement — reached by one wrong delimiter.
   *
   * Round 4 review called this indistinguishable from a parenthesised
   * citation, because `(ADR-7)` also shaves to a bare ID. At the RAW token
   * level they are not: `REQ-01;` is shaved of a trailing DELIMITER,
   * `ADR-7)` of a citation wrapper. This rule keys on that shave class and
   * requires the token to sit outside any parenthetical, which is what keeps
   * `(see ADR-7: section 3)` silent.
   */
  delimiterDroppedIds: string[];
  /** Tokens past the scan cap that could carry an ID — reported, never dropped. */
  oversizedTokens: string[];
  /** ID-shaped tokens the selector did not take. Reported as a fact; never routes. */
  unselectedIdShaped: string[];
  /** The line leads with `TBD` / `None`. */
  placeholderLed: boolean;
  /** R2's hits, as `[left, right]` endpoint pairs, so the channel below can ask
   *  about the endpoints the rule actually fired on. */
  spacedRangePairs: Array<[string, string]>;
  /**
   * Nothing on the line was DEMONSTRABLY dropped: no rule that names a specific
   * unselected ID fired, and any spaced range fired on endpoints the selector
   * actually took.
   *
   * This is the shared precondition of both NON-assertive voices — the
   * ambiguous range reading and the over-cap "not classified" report — and it
   * is named once because they had drifted apart. Round 7 review, Minor 1:
   * `rangeReadingOnly` carried the conjunction inline and omitted the cap,
   * while the over-cap channel carried its own copy that excluded a spaced
   * range wholesale. A line with a clean, fully-selected range beside an
   * unexamined over-cap token satisfied neither guard as intended and reached
   * the ambiguous voice.
   */
  nothingDemonstrablyDropped: boolean;
  /**
   * The round-3 channel discriminator (review finding Major 3). True when the
   * ONLY thing to report is a range *reading*: R2 fired, no other rule did, and
   * every endpoint R2 fired on was actually selected. Nothing was dropped, so
   * the line did not fail to parse and the warning must not claim it did.
   *
   * This is deliberately RULE-SCOPED rather than line-global. A line-global
   * "was anything ID-shaped left unselected?" test reads correctly on the
   * motivating example and misroutes as soon as the line carries an unrelated
   * parenthesised citation: `RANGE-01, RANGE-02 — RANGE-05 deferred per
   * (ADR-7)` has `(ADR-7)` outside the selector's bracket strip, so a global
   * test calls it a drop and sends the line back to the assertive channel —
   * reinstating exactly the false "could not be parsed" claim Major 3 is
   * about, and contradicting #3697-4, which pins a parenthetical citation as
   * NOT unparsed residue. Only the rules that fired may speak.
   */
  rangeReadingOnly: boolean;
  /** Any rule fired — the line warrants a warning. */
  warn: boolean;
};

// A range operator, enumerated. CENSUS (round 3): the domain is "separator
// spellings an author can put between two REQ-IDs", which is open, so the
// enumeration draws a boundary rather than covering it. Reached: ASCII `..`+,
// the seven Unicode dashes that are the SAME operator at different codepoints
// (U+2010 hyphen, U+2011 non-breaking hyphen, U+2012 figure dash, U+2013 en,
// U+2014 em, U+2015 horizontal bar, U+2212 minus) plus ASCII `-`, U+2026
// ellipsis, and the words `to`/`thru`/`through`. NOT reached, and the
// consequence is a silent under-selection — #3697's own defect — for that
// spelling: `→`, `~`, `..=`, `..<`, `until`, and `up to` (two tokens, so it
// cannot be one operator token at all). Those stay out deliberately: each is a
// symbol or word with an independent non-range use between two IDs, which is
// the over-warning class #2334 cost three rounds. The Unicode dashes DO carry
// the ASCII hyphen's date/sub-number collision — an earlier round-3 commit
// claimed they did not, and was wrong — so they take the strict arm with it;
// see the rule below.
const REQ_RANGE_DASHES = '\\u2010\\u2011\\u2012\\u2013\\u2014\\u2015\\u2212';
// EVERY DASH IS STRICT — one rule, whatever the codepoint. `PREFIX-\d+ <dash>
// \d+` is also a date (`FY-2026-08`) and a sub-numbered ID (`API-2-01`), and
// that ambiguity is a property of the SHAPE, not of which dash key was pressed.
// The design already chose strictness for ASCII `-` on exactly this trade: a
// bare-hyphen tight range must carry a full ID on BOTH sides. Until round 3 the
// other dashes sat in the loose arm, so `RANGE-01 (target FY-2026<en-dash>08)`
// warned while its all-ASCII twin — pinned silent by #3697-4 — did not. That
// inconsistency predates this PR for U+2013/U+2014; round 3 briefly widened it
// to five more codepoints before this commit closed it for all seven.
// The cost is symmetric and already accepted: `RANGE-01, RANGE-02<dash>05`
// goes silent, exactly as `RANGE-01, RANGE-02-05` already does today. A bare
// `RANGE-02<dash>05` still warns — it selects nothing, so R3 catches it.
// LOOSE stays loose: `..`, `…` and the word operators have no date or
// sub-number reading between two numbers, so they keep the numeric endpoint.
const REQ_RANGE_OP = `(?:\\.{2,}|\\u2026|[${REQ_RANGE_DASHES}]|-|to|thru|through)`;
const REQ_RANGE_OP_LOOSE = `(?:\\.{2,}|\\u2026|to|thru|through)`;
const REQ_RANGE_OP_SYMBOL = `(?:\\.{2,}|\\u2026|[${REQ_RANGE_DASHES}]|-)`;
const REQ_RANGE_TOKEN_RE = new RegExp(
  `^([A-Z][A-Z0-9]*)-(?:\\d+)\\s*(?:${REQ_RANGE_OP_LOOSE}\\s*(?:\\1-)?|[-${REQ_RANGE_DASHES}]\\s*\\1-)\\d+$`,
  'i',
);
const REQ_PURE_RANGE_OP_RE = new RegExp(`^${REQ_RANGE_OP}$`, 'i');
const REQ_GLUED_RANGE_LEAD_RE = new RegExp(`^${REQ_RANGE_OP_SYMBOL}([A-Z][A-Z0-9]*-\\d+)$`, 'i');
const REQ_GLUED_RANGE_TRAIL_RE = new RegExp(`^([A-Z][A-Z0-9]*-\\d+)${REQ_RANGE_OP}$`, 'i');
const REQ_ID_SUBSTRING_RE = /[A-Z][A-Z0-9]*-\d+/i;
const REQ_ID_SHAPE_RE = /^[A-Z][A-Z0-9]*-\d+$/i;
const REQ_ID_PARTS_RE = /^([A-Z][A-Z0-9]*)-(\d+)$/i;
// `LETTERS-\d+-\d+` — a date (`FY-2026-08`) or a sub-numbered ID (`API-2-01`).
// REQ_RANGE_TOKEN_RE's strict-dash arm exists precisely to keep this shape
// silent, because nothing at token level can tell the three readings apart.
// Round 4 review Minor 2: the skipped-text rider re-reported it through the
// side door — `REQ_ID_SUBSTRING_RE` is unanchored, so `FY-2026-08` matches as
// `FY-2026` and landed in `unselectedIdShaped`. Whenever any OTHER rule fired
// on a line carrying a date annotation, the warning then told the author to
// "check whether any of it is a requirement" about a date. Not a false
// warning — the line was warning anyway — but false CONTENT, and it is the
// #2334 voice.
// `PREFIX-<digits>-<digits>` — the shape the strict-dash range rule refuses to
// act on because it is equally a date (`FY-2026-08`) and a sub-numbered id
// (`API-2-01`). NO regex separates those: `API-2026-08` is a legal requirement
// id and `FY-26-08` is a date, and both filters that tried scored a miss in
// each direction under the pre-push review's continuation.
//
// So the rider stops adjudicating and starts DISCLOSING. Round 4 Minor 2's
// real complaint was that the rider told the author to check whether a DATE
// was a requirement; the fix is to name the ambiguity rather than to guess at
// it — which is the same thing the two warning voices already do about a
// range separator.
const REQ_AMBIGUOUS_NUMERIC_RE = /^[A-Z][A-Z0-9]*(?:-\d+){2,}$/i;

// The token-length cap. It bounds REQ_ID_SUBSTRING_RE, the one UNANCHORED
// regex here, which backtracks quadratically on a pathological token. Round 3
// review Nit 6 objected that the anchored regexes were left uncapped on the
// strength of a comment asserting they scan linearly; they are applied through
// the same cap now, so the claim is enforced rather than asserted. No real
// REQ-ID-carrying token approaches this bound.
const REQ_TOKEN_SCAN_LIMIT = 2048;

/**
 * The Requirements-line warning KINDS, as a stable machine vocabulary (round 4
 * review Major 3).
 *
 * Before this, the kind existed only in the prose of the message, so every
 * consumer and every test had to regex an English sentence — and rewording a
 * message silently un-asserted the tests that pinned it. The repo already had
 * the settled seam for exactly these semantics: `diffLiveConfig` emits
 * `kind:'unverified'` for a truncated scan (`CONTEXT.md`), and
 * `WAVE_CLEANUP_WARNING` carries codes in `src/worktree-safety.cts`.
 *
 * Carried ALONGSIDE the prose, never instead of it. `warnings[]` is a
 * documented `string[]` in `phase complete`'s JSON output, rendered by
 * execute-phase.md's "If has_warnings is true" step, so changing its element
 * shape would be a breaking output-contract change for a shipped command. The
 * code is emitted as its own additive `requirements_line_warning` field.
 */
const REQ_LINE_WARNING_CODE = {
  /** ID-shaped content was demonstrably not selected — the line failed to parse. */
  misparse: 'req-line-misparse',
  /** A range READING is at stake; every endpoint the rule fired on was selected. */
  rangeReading: 'req-line-range-reading',
  /** A token past the scan cap means the line was not classified — never that it is clean. */
  unverified: 'req-line-unverified',
} as const;

type ReqLineWarningCode = (typeof REQ_LINE_WARNING_CODE)[keyof typeof REQ_LINE_WARNING_CODE];

/** The formatter's result. `null` still means CLEAN, which is a value, not a failure. */
type ReqLineWarning = { code: ReqLineWarningCode; message: string };

// R4 — a full ID with a trailing statement delimiter glued to it. ANCHORED on
// both ends, so it is linear and needs no cap of its own beyond the token
// length guard its caller applies.
// Zero-width, bidi-control, joiner and variation-selector codepoints. INVISIBLE
// to the author, and the pre-push review's continuation drove the consequence
// from both sides: a line of only these warned with nothing on screen to
// explain it, AND stripping them wholesale from the detector made
// `REQ-01<ZWSP>, REQ-02` go SILENT while the selector really did drop REQ-01 —
// #3697's own defect, introduced by the fix for its mirror image. So they are
// never stripped from the line: they are DECORATION on a token (R4 below) and
// absence-of-content for the empty test (visibleContent), which are two
// different questions about the same character.
const REQ_INVISIBLE_RE = /[\u00AD\u200B-\u200F\u2060-\u2064\u2066-\u2069\uFE0F\uFEFF]/g;
// The wrappers R4 shaves. Emphasis, quotes and backticks, because the SELECTOR
// shaves none of them — `**REQ-01**` is genuinely not selected and is a real,
// silent drop.
//
// PARENTHESES ARE DELIBERATELY ABSENT, and this is load-bearing. A parenthesis
// is this rule's citation MARKER, not decoration to shave: `(REQ-02)` and
// `(ADR-7)` are the same shape and the rule declines both. Including them here
// made `REQ-01, (REQ-02), REQ-03 — REQ-05` report a glued delimiter that was
// never there, and broke #3697-9d's channel routing with it — caught by the
// suite immediately after the widening.
const REQ_WRAPPER_RE = /^["'`*_~“”‘’]+|["'`*_~“”‘’]+$/g;
// An id with a list delimiter glued to EITHER end, once styling is removed.
// The capture is the bare id; a match means the delimiter was ADJACENT to it.
const REQ_DELIMITED_ID_RE = /^[;:]*([A-Z][A-Z0-9]*-\d+)[;:]*$/i;



/**
 * CENSUS (round 4): the domain is "separators an author writes between two
 * REQ-IDs INSTEAD of a comma" — distinct from the range-operator domain
 * censused above, and it had no census at all before this round.
 *
 * ROUND 4'S CENSUS WAS WRONG, AND THE WAY IT WAS WRONG IS THE LESSON. It swept
 * 26 spellings and concluded "exactly two — `; ` and `: `". It reached that
 * answer because it swept the ONE-SIDED form (`REQ-01; REQ-02`) for the
 * semicolon and colon, and only the BARE and SYMMETRIC forms (`|`, ` | `) for
 * every other separator. Different members of the domain were tested in
 * different shapes, so the conclusion could not have come out any other way.
 *
 * Re-swept round 5, fully crossed: 21 separators x {bare, trailing-space,
 * leading-space, both-spaces} = 84 combinations, driven through the built
 * artifact. 26 select both IDs, 24 under-select and already warn, and
 * 34 UNDER-SELECT SILENTLY. All 34 are the same shape — a separator glued to
 * exactly ONE of the two IDs, e.g. `REQ-01/ REQ-02` or `REQ-01 /REQ-02` — for
 * every punctuation except `,` (the real delimiter) and `;` / `:` (R4).
 * Measured silent: | / + & \ > . ! ? • · ؛ ； ， － ~ and the word operators
 * `and` / `plus` in trailing-space form.
 *
 * So the honest statement is that R4 covers TWO CHARACTERS of a domain that is
 * wide open, not that the domain has two members. The round-4 review
 * hand-listed the semicolon; the colon is its sibling and fails identically;
 * everything else in that list is disclosed here and NOT caught. Widening the
 * delimiter class is a small change and deliberately not made at the end of a
 * round: three successive cuts of this rule fired on a citation.
 *
 * THE GATE IS ADJACENCY, and it is the part to read. Styling is stripped, then
 * the delimiter must be touching the id: `REQ-01;`, `;REQ-02`, `**REQ-01;**`
 * and the backticked form all qualify. `**REQ-01**;` does NOT — outside the
 * styling a `;` is sentence punctuation, which is why `REQ-01, see **REQ-7**;
 * next topic` is a citation and not a drop. An INVISIBLE anywhere in the token
 * qualifies without an adjacency test, because nobody types one on purpose, so
 * it is corruption rather than intent.
 *
 * Markdown styling on its own is NOT a trigger and NOT reported. It reaches
 * the skipped-text rider, which names the id without asserting a drop — but a
 * rider only exists inside a MESSAGE, and a message only exists when some rule
 * set `warn`. On a line where nothing else fires, `REQ-01, **REQ-02**` is
 * wholly silent. Saying it is "left to the rider" reads as coverage and is
 * not; #3697-19m pins the silence so this comment cannot drift back.
 *
 * NOT reached, stated rather than fixed, and the second member is WIDER than
 * this comment first claimed:
 *   - anything inside a parenthetical. A parenthesis is this rule's citation
 *     MARKER, never decoration to shave — `(REQ-02)` and `(ADR-7)` are the
 *     same shape and the rule declines both.
 *   - a decorated id whose prefix is on NO selected id: `REQ-01, FOO-02: x`
 *     stays silent even when FOO-02 is real. Prefix agreement is what
 *     separates a drop from a bare citation — `REQ-01, see ADR-7: section 3`
 *     carries `ADR-7:` in exactly `REQ-01;`'s shape — and it is the module's
 *     own idiom, not a new heuristic (reqEndpointsImplyInterior already
 *     requires an agreeing prefix). The gate is NOT complete: a citation that
 *     DOES share a selected prefix (`ADR-01, see ADR-7: sec 3`) still fires,
 *     and nothing at token level separates that from a real drop. Saying so is
 *     the honest position; a prose heuristic on "see" is exactly the free-text
 *     detector this module exists to avoid.
 * The trade, plainly: an under-report on a rare shape over an over-report on a
 * common one — the same call the strict-dash rule makes.
 */
function reqDelimiterDroppedIds(rawLine: string, selected: Set<string>, cap: number): string[] {
  // MATCHED parenthetical spans are removed OUTRIGHT, not tracked as a depth.
  //
  // Two bugs died here. A running depth counter let an unbalanced `(` stay open
  // to end-of-line and swallow every real drop after it. Promoting a whole
  // token to immune because it CONTAINED a matched character then leaked the
  // other way: `REQ-01, REQ-02;(note) REQ-03` is one whitespace token, so the
  // parenthetical conferred immunity on the `REQ-02;` sitting outside it.
  // Deleting the span states what is actually meant — for this rule a citation
  // is not on the line — while an UNMATCHED paren is a typo and confers
  // nothing.
  //
  // Square brackets go too, exactly as the SELECTOR strips them: `[REQ-01;
  // REQ-02]` is the documented form and was silently dropping REQ-01.
  //
  // INVISIBLES STAY. They are the evidence this rule reads; the tokenizer
  // strips them for the classification rules, and the two sites answer two
  // different questions about the same character.
  const chars = [...String(rawLine).replace(/<!--[\s\S]*?-->/g, ' ')];
  const openStack: number[] = [];
  for (let i = 0; i < chars.length; i += 1) {
    if (chars[i] === '(') openStack.push(i);
    else if (chars[i] === ')' && openStack.length > 0) {
      const open = openStack.pop() as number;
      for (let j = open; j <= i; j += 1) chars[j] = ' ';
    }
  }
  const line = chars.join('').replace(/[[\]]/g, '');

  // The prefixes actually SELECTED on this line. A dropped id must agree with
  // one of them — that is what separates a delimiter typo from a citation,
  // since `REQ-01, see ADR-7: sec 3` carries `ADR-7:` in exactly `REQ-01;`'s
  // shape. Same-prefix agreement is the module's own idiom, not a new
  // heuristic (see reqEndpointsImplyInterior).
  const selectedPrefixes = new Set<string>();
  for (const id of selected) {
    const m = REQ_ID_PARTS_RE.exec(id);
    if (m) selectedPrefixes.add(m[1].toUpperCase());
  }

  const hits: string[] = [];
  for (const raw of line.split(/[,\s]+/)) {
    if (!raw || raw.length > cap) continue;
    // Strip STYLING only. What survives is the id plus whatever was glued
    // directly to it.
    const core = raw.replace(REQ_INVISIBLE_RE, '').replace(REQ_WRAPPER_RE, '');
    const m = REQ_DELIMITED_ID_RE.exec(core);
    if (!m) continue;
    const bare = m[1];
    // ADJACENCY IS THE WHOLE RULE. A `;`/`:` touching the id is a list
    // separator someone meant; the same character OUTSIDE the styling is
    // sentence punctuation — `see **REQ-7**; next topic` cites a requirement
    // while `**REQ-01;** REQ-02` fails to list one, and only the delimiter's
    // POSITION separates them. An INVISIBLE needs no adjacency test: nobody
    // types one on purpose, so anywhere in the token it is corruption rather
    // than intent.
    const hadAdjacentDelimiter = core !== bare;
    REQ_INVISIBLE_RE.lastIndex = 0;
    const hadInvisible = REQ_INVISIBLE_RE.test(raw);
    REQ_INVISIBLE_RE.lastIndex = 0;
    if (!hadAdjacentDelimiter && !hadInvisible) continue;
    if (selected.has(bare.toUpperCase())) continue;
    const parts = REQ_ID_PARTS_RE.exec(bare);
    if (parts && selectedPrefixes.has(parts[1].toUpperCase())) hits.push(bare);
  }
  return [...new Set(hits)];
}

/** Endpoints imply a dropped interior only on an AGREEING prefix and a gap > 1. */
function reqEndpointsImplyInterior(a: string, b: string): boolean {
  const ma = REQ_ID_PARTS_RE.exec(a);
  const mb = REQ_ID_PARTS_RE.exec(b);
  if (!ma || !mb) return false;
  if (ma[1].toUpperCase() !== mb[1].toUpperCase()) return false;
  // BigInt keeps the gap exact for numbers past 2^53.
  const gap = BigInt(mb[2]) - BigInt(ma[2]);
  return gap > 1n || gap < -1n;
}

function analyzeRequirementsLine(rawLine: string): RequirementsLineAnalysis {
  const line = typeof rawLine === 'string' ? rawLine : '';
  // SELECTOR — byte-identical to the pre-extraction expression.
  const citedReqIds = line
    .replace(/[\[\]]/g, '')
    .split(/[,\s]+/)
    .map((r) => r.trim())
    .filter(Boolean)
    .filter((r) => REQ_ID_SHAPE_RE.test(r));

  // DETECTOR tokenization. A token with NO alphanumerics is shaved of brackets
  // ONLY, so `(..)` surfaces its operator while a bare `..` is not shaved to
  // nothing by the punctuation classes. A trailing run of 2+ dots is a glued
  // range operator (`REQ-01.. REQ-05`), not sentence punctuation — keep it.
  const tokens = line
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // Invisibles are removed HERE, for the classification rules — an operator
    // spelled `<ZWSP>..<ZWSP>` is still the range operator, and a line of only
    // invisibles yields no tokens at all. R4 works on the RAW line and does
    // NOT strip them, because there they are the evidence of a dropped id.
    // Removing them in both places is what made `REQ-01<ZWSP>, REQ-02` silent;
    // removing them in neither is what made `REQ-01 <ZWSP>..<ZWSP> REQ-05`
    // silent. The two questions have two different answers.
    .replace(REQ_INVISIBLE_RE, '')
    .split(/[,\s]+/)
    .map((t) => {
      const trimmed = t.trim();
      if (!/[A-Za-z0-9]/.test(trimmed)) {
        return trimmed.replace(/^[[({]+/, '').replace(/[\])}]+$/, '');
      }
      if (/\.{2,}$/.test(trimmed)) {
        return trimmed.replace(/^[[({"'`*_~“”‘’]+/, '');
      }
      return trimmed.replace(/^[[({"'`*_~“”‘’]+/, '').replace(/[\])}.;:"'`*_~“”‘’]+$/, '');
    })
    .filter(Boolean);

  // Every predicate below is applied through the scan limit (Nit 6): a token
  // past the bound is not classified at all rather than classified expensively.
  const short = (t: string): boolean => t.length <= REQ_TOKEN_SCAN_LIMIT;
  const rangeTokens = tokens.filter((t) => short(t) && REQ_RANGE_TOKEN_RE.test(t));
  const spacedRangePairs: Array<[string, string]> = [];
  tokens.forEach((t, i) => {
    const left = tokens[i - 1] ?? '';
    const right = tokens[i + 1] ?? '';
    if (
      // EVERY participant is capped, not just the operator. Capping the operator
      // alone left `<2049-char ID> .. <2049-char ID>` running REQ_ID_SHAPE_RE and
      // BigInt over both neighbours unbounded — the cap read as uniform and was
      // not (found by the round's pre-push review).
      short(t) &&
      short(left) &&
      short(right) &&
      REQ_PURE_RANGE_OP_RE.test(t) &&
      i > 0 &&
      i < tokens.length - 1 &&
      REQ_ID_SHAPE_RE.test(left) &&
      REQ_ID_SHAPE_RE.test(right) &&
      reqEndpointsImplyInterior(left, right)
    ) {
      spacedRangePairs.push([left, right]);
    }
  });
  const hasSpacedRange = spacedRangePairs.length > 0;
  // A half-spaced range splits at the tokenizer, so R1's own `\s*` never sees
  // it. SYMBOL operators only on the LEAD arm: a word operator glued to an ID
  // is an ID — `TORANGE-05` is a valid prefix-agnostic REQ-ID. The TRAIL arm
  // keeps the word operators, because a valid ID must end in digits, so
  // `REQ-01through` can only be a glued typo.
  const hasGluedRangeFragment = tokens.some((t, i) => {
    // Neighbours capped for the same reason as R2 above.
    if (!short(t)) return false;
    const before = tokens[i - 1] ?? '';
    const after = tokens[i + 1] ?? '';
    const lead = REQ_GLUED_RANGE_LEAD_RE.exec(t);
    if (
      lead &&
      i > 0 &&
      short(before) &&
      REQ_ID_SHAPE_RE.test(before) &&
      reqEndpointsImplyInterior(before, lead[1])
    ) {
      return true;
    }
    const trail = REQ_GLUED_RANGE_TRAIL_RE.exec(t);
    return Boolean(
      trail &&
        i < tokens.length - 1 &&
        short(after) &&
        REQ_ID_SHAPE_RE.test(after) &&
        reqEndpointsImplyInterior(trail[1], after),
    );
  });
  const leadToken = (tokens[0] ?? '').toUpperCase();
  // CENSUS (round 3, review finding Minor 4): the placeholder domain is what
  // GSD itself seeds plus what an author writes for "deliberately empty".
  // Reached: `TBD` — the ONLY machine-written seed, at the three phase.add /
  // -batch / -insert sites — and `None`, the author convention. NOT reached:
  // `N/A`, `Deferred`, `Pending`, `TBA`, `-`. Consequence, and it is now
  // ENFORCED rather than asserted: such a line selects zero IDs and warns
  // through R3b below, which is what #3697's acceptance criterion asks for
  // ("when it selects zero IDs from a line that is non-empty and is not the
  // `TBD` placeholder"). Round 3 shipped this same paragraph while R3's
  // ID-shape gate made it false for all five words — bare `Deferred` was
  // silent, `Deferred (see ADR-7)` warned — and the claim sat in three
  // artifacts with no test in either direction. Inferring placeholder-ness
  // from arbitrary prose is still the free-text heuristic this detector
  // avoids: R3b keys on the SELECTION being empty, never on what the prose
  // means.
  const placeholderLed = leadToken === 'TBD' || leadToken === 'NONE';
  const inertIdShaped =
    citedReqIds.length === 0 && !placeholderLed
      ? tokens.filter((t) => short(t) && t.includes('-') && REQ_ID_SUBSTRING_RE.test(t))
      : [];
  // R3b — the acceptance criterion's own narrow form. `tokens.length > 0` is
  // what keeps an empty line and a comment-only line silent: the tokenizer
  // strips `<!-- ... -->` before splitting, so `<!-- fill in -->` yields no
  // tokens and cannot reach this rule. Every other zero-selection,
  // non-placeholder line warns.
  const zeroSelectionInert = citedReqIds.length === 0 && !placeholderLed && tokens.length > 0;

  // R2 is the ONLY ambiguous rule — a tight range, a glued fragment and R3
  // residue each implicate ID-shaped text the selector demonstrably did not
  // take, so any of them means the line really did fail to parse. R2 is
  // ambiguous only when its OWN endpoints were selected: the detector shaves
  // brackets and the selector does not, so R2 can fire on a `(RANGE-02)` that
  // was never selected — a real drop, and the assertive channel is right there.
  // A token past the cap is NOT classified — and must therefore not be
  // silently discarded. Round 3's first cut of the uniform cap did exactly
  // that: a 2049-char range token warned before the round and went silent
  // after it, which is #3697's own defect introduced by the fix for a nit
  // (found by the round's pre-push review). The cap bounds the WORK, not the
  // warning — so an over-cap token that could carry an ID is reported as
  // unclassified. The test is `includes('-')`, a linear scan, never the
  // unanchored regex the cap exists to keep off these tokens.
  // ANY over-cap token, not just one carrying `-`. The first cut filtered on
  // `includes('-')` and therefore missed an over-cap OPERATOR:
  // `REQ-01 <2049 dots> REQ-05` warned before this round (R2 was uncapped) and
  // went silent after it. A token we could not examine makes the line
  // unverified whatever characters it happens to contain. Computed below,
  // where the selected set is available.

  // ID-shaped tokens the selector did not take, ANYWHERE on the line. This is
  // reported as a fact, never used to pick the channel: `(ADR-7)` and
  // `(REQ-02)` are indistinguishable by shape, so routing on it would put the
  // false "could not be parsed" claim back on a line carrying a citation.
  // Naming them lets the author see what the tokenizer skipped without the
  // warning asserting a verdict it cannot support in either direction.
  const selected = new Set(citedReqIds.map((id) => id.toUpperCase()));
  // A token the SELECTOR took has had its own SELECTION verified — the selector
  // is uncapped and anchored, so it examined the whole token. That is not the
  // same as "no rule was suppressed by it", and conflating the two was the
  // second continuation review's CLAIM J/K: two over-cap valid IDs either side
  // of `..` are both selected, both exempted, and R2 is capped — so a line that
  // warned before this round went silent, which is the very regression the
  // field exists to close, arriving through the fix for its own over-report.
  //
  // The exemption therefore applies only when nothing could have been
  // suppressed: an over-cap token that was selected AND has no neighbour that
  // could pair with it into a range. Everything else is unexaminable and is
  // reported as such.
  const couldPairIntoRange = (i: number): boolean => {
    for (const n of [tokens[i - 1], tokens[i + 1]]) {
      if (n === undefined) continue;
      if (!short(n)) return true;
      if (REQ_PURE_RANGE_OP_RE.test(n)) return true;
      if (REQ_GLUED_RANGE_LEAD_RE.test(n) || REQ_GLUED_RANGE_TRAIL_RE.test(n)) return true;
    }
    return false;
  };
  const oversizedTokens = tokens.filter(
    (t, i) => !short(t) && (!selected.has(t.toUpperCase()) || couldPairIntoRange(i)),
  );
  const unselectedIdShaped = tokens.filter(
    (t) => short(t) && REQ_ID_SUBSTRING_RE.test(t) && !selected.has(t.toUpperCase()),
  );
  // R4 runs on the RAW line, not on `tokens`: the shave that makes `REQ-01;`
  // look like a clean `REQ-01` is exactly the evidence this rule needs, so it
  // has to see the character the tokenizer removed.
  const delimiterDroppedIds = reqDelimiterDroppedIds(rawLine, selected, REQ_TOKEN_SCAN_LIMIT);
  const nothingDemonstrablyDropped =
    rangeTokens.length === 0 &&
    !hasGluedRangeFragment &&
    inertIdShaped.length === 0 &&
    // R4 is a DEMONSTRATED drop, so neither non-assertive voice — one claiming
    // nothing was dropped, the other that nothing could be checked — may speak
    // for a line carrying one.
    delimiterDroppedIds.length === 0 &&
    // R2 firing on an endpoint the selector did NOT take is itself a
    // demonstrated drop, and the assertive channel is right there. Vacuously
    // true when no spaced range fired, which is what makes this a strict
    // superset of the `!hasSpacedRange` guard the over-cap channel used to
    // carry — that channel's behaviour on a line with no spaced range is
    // unchanged, byte for byte.
    spacedRangePairs.every(([a, b]) => selected.has(a.toUpperCase()) && selected.has(b.toUpperCase()));
  const rangeReadingOnly =
    hasSpacedRange &&
    nothingDemonstrablyDropped &&
    // The cap bounds the WORK, never the warning. An over-cap token is not
    // classified by ANY rule (R1-R4 all skip it), so the voice whose entire
    // claim is that nothing was dropped has no basis to speak for this line.
    // It falls to the over-cap channel below instead — `unverified`, because
    // the line was not CHECKED; not `misparse`, because nothing on it
    // demonstrably failed to parse either. Round 7 review, Minor 1.
    oversizedTokens.length === 0;

  // Named rather than inlined into the return literal (round 3 review Minor 3):
  // this disjunction is the module's single most important predicate, and in
  // the literal a later edit that reordered a local below the `return` would be
  // a TDZ ReferenceError at runtime rather than an error at the reader's eye
  // level. R3b joins it here — see its field docs above for why it is not
  // gated on ID shape.
  const warn =
    rangeTokens.length > 0 ||
    hasSpacedRange ||
    hasGluedRangeFragment ||
    inertIdShaped.length > 0 ||
    zeroSelectionInert ||
    delimiterDroppedIds.length > 0 ||
    oversizedTokens.length > 0;

  return {
    citedReqIds,
    tokens,
    rangeTokens,
    hasSpacedRange,
    hasGluedRangeFragment,
    inertIdShaped,
    zeroSelectionInert,
    placeholderLed,
    spacedRangePairs,
    nothingDemonstrablyDropped,
    rangeReadingOnly,
    delimiterDroppedIds,
    oversizedTokens,
    unselectedIdShaped,
    warn,
  };
}

/**
 * Render the warning, or null when the line is clean.
 *
 * TWO CHANNELS, and the split is round 3's fix for review finding Major 3. The
 * detector cannot distinguish `RANGE-02 — RANGE-05` meaning a range from the
 * same text meaning an annotation separator; they are textually identical and
 * no token-level rule separates them. What the old single-channel message did
 * was resolve that ambiguity by ASSERTION — it told the author the line "could
 * not be parsed" and to rewrite it, on a line where every ID present had in
 * fact been selected and nothing had been dropped. That is a false statement
 * under the annotation reading and the #2334 over-warning class.
 *
 * Going silent instead is not available: the range reading is equally live, and
 * staying quiet on it re-opens the exact silent under-selection #3697 is about.
 * So the ambiguity is DISCLOSED rather than decided —
 *
 *   * any rule other than R2 fired, or R2 fired on an endpoint that was not
 *     selected → something ID-shaped was demonstrably NOT taken. The line did
 *     fail to parse; say so plainly, as before.
 *   * R2 alone fired and both its endpoints were selected → nothing was
 *     dropped. State both readings and let the author pick; never claim a parse
 *     failure that did not occur.
 */
function formatRequirementsLineWarning(
  phaseNum: string,
  rawLine: string,
  analysis: RequirementsLineAnalysis,
): ReqLineWarning | null {
  if (!analysis.warn) return null;
  const shown = String(rawLine).trim();
  const rangeRuleFired =
    analysis.rangeTokens.length > 0 || analysis.hasSpacedRange || analysis.hasGluedRangeFragment;

  // Tokens the selector skipped, stated as a fact in EITHER channel. `(ADR-7)`
  // and `(REQ-02)` are the same shape, so no rule can say which one matters —
  // but the author can, and only if the warning tells them. Round 3's first
  // cut instead let this drive the channel, which put the false "could not be
  // parsed" claim back on a line carrying a citation.
  // Names only what the rule-specific clauses did NOT already name, so the
  // assertive voice can carry it too without repeating itself.
  const alreadyNamed = new Set(
    [...analysis.rangeTokens, ...analysis.inertIdShaped, ...analysis.delimiterDroppedIds].map((t) =>
      t.toUpperCase(),
    ),
  );
  const skippedNames = analysis.unselectedIdShaped.filter((t) => !alreadyNamed.has(t.toUpperCase()));
  // Named, then qualified. The `PREFIX-N-N` shape is the one the range rules
  // deliberately decline to act on, so the rider says WHY it might not be a
  // requirement instead of silently deciding it is not.
  const ambiguousNamed = skippedNames.filter((t) => REQ_AMBIGUOUS_NUMERIC_RE.test(t));
  const skipped =
    skippedNames.length > 0
      ? ` ID-shaped text on the line that was NOT selected: ${skippedNames.join(', ')}` +
        ` (parentheses are not stripped, unlike square brackets) — check whether any of it is a` +
        ` requirement.` +
        (ambiguousNamed.length > 0
          ? ` ${ambiguousNamed.join(', ')} may equally be a date or a sub-numbered id, which is` +
            ` why the range rules do not act on that shape.`
          : '')
      : '';
  // R4's clause. Named separately from the generic skipped-text rider because
  // this one is not a "check whether any of it is a requirement" hedge — the
  // token IS an ID, the selector demonstrably did not take it, and the cause
  // is nameable.
  const delimiterDropped =
    analysis.delimiterDroppedIds.length > 0
      ? ` ${analysis.delimiterDroppedIds.join(', ')} ${analysis.delimiterDroppedIds.length === 1 ? 'was' : 'were'}` +
        ` NOT selected: a \`;\` or \`:\` is glued to the ID, or it carries an invisible character, and` +
        ` the line is split on commas and whitespace only. Write each requirement as a bare ID` +
        ` separated by a comma.`
      : '';
  const oversized =
    analysis.oversizedTokens.length > 0
      ? ` One or more tokens exceed the ${REQ_TOKEN_SCAN_LIMIT}-character scan limit and were NOT` +
        ` classified, so this line may carry more than is reported here.`
      : '';

  if (analysis.rangeReadingOnly) {
    // AMBIGUOUS channel — the RANGE reading is what is at stake, not a parse
    // failure: every endpoint the range rule fired on was selected.
    //
    // What this voice must NOT do is claim the whole LINE is correct. It has
    // no basis for that: an unrelated `(REQ-02)` elsewhere on the line is
    // dropped by the selector and invisible to every rule, so "nothing needs
    // to change" is an affirmative false statement on exactly the input the
    // rule-scoped discriminator was built to reach. It speaks about the
    // SEPARATOR, and defers the rest to the skipped-text clause above.
    return {
      code: REQ_LINE_WARNING_CODE.rangeReading,
      message:
      `ROADMAP Phase ${phaseNum} **Requirements** line (\`${shown}\`) contains what reads as a range ` +
      `between two cited REQ-IDs. Range forms are not expanded, so no interior IDs were selected; ` +
      `the line selected: ${analysis.citedReqIds.join(', ')}. If a range was intended, rewrite it ` +
      `naming every requirement explicitly (e.g. \`REQ-01, REQ-02, REQ-03\`); if that separator is ` +
      `an annotation rather than a range, it selected nothing to expand and needs no change.` +
      delimiterDropped +
      skipped +
      oversized,
    };
  }

  if (analysis.oversizedTokens.length > 0 && analysis.nothingDemonstrablyDropped) {
    // A DEMONSTRATED drop outranks this voice, whose whole claim is that
    // NOTHING could be checked — both cannot be true at once. `REQ-01,
    // REQ-02: <over-cap token>` names REQ-02 in `delimiterDroppedIds` and
    // then reported `req-line-unverified`, whose message never mentions it:
    // the concrete, actionable finding masked by the token beside it. That
    // exclusion now lives in `nothingDemonstrablyDropped`, shared verbatim
    // with `rangeReadingOnly` above rather than duplicated here — the
    // duplication is what let the two drift (round 7 review, Minor 1). The
    // assertive channel already appends the over-cap rider, so routing a
    // demonstrated drop there loses nothing about the cap.
    // OVER-CAP channel — no rule could run, so no rule may be diagnosed. Say
    // exactly that: the line was not classified, rather than not a problem.
    return {
      code: REQ_LINE_WARNING_CODE.unverified,
      message:
      `ROADMAP Phase ${phaseNum} **Requirements** line (\`${shown.slice(0, 200)}…\`) could not be ` +
      `checked: one or more tokens exceed the ${REQ_TOKEN_SCAN_LIMIT}-character scan limit, so the ` +
      `REQ-ID selection on this line is unverified. Rewrite it as a comma-separated list ` +
      `(e.g. \`REQ-01, REQ-02, REQ-03\`).`,
    };
  }

  // ASSERTIVE channel — ID-shaped content was demonstrably not selected.
  // Deliberately says "selected", NOT "marked complete": a range whose
  // endpoints are themselves unregistered selects them and marks nothing, and a
  // warning that overclaims the write is a warning the reader learns to
  // distrust.
  const selectedDesc =
    analysis.citedReqIds.length > 0
      ? `the only REQ-ID(s) selected from it were: ${analysis.citedReqIds.join(', ')}`
      : 'it selected NO REQ-IDs at all, so nothing was marked';
  const unparsed = [...new Set([...analysis.rangeTokens, ...analysis.inertIdShaped])];
  // Only diagnose "range" when a range rule actually fired — an R3 warning on
  // non-range ID text must not claim one was written. And on the R3 path the
  // residue is ID-SHAPED TEXT, which is not the same claim as "a requirement we
  // failed to parse" (round 3 review finding Minor 4: `Deferred (see ADR-7)`
  // reported `ADR-7` as missed requirement content when it is a citation). Name
  // what it is, and name the placeholder escape the author actually has.
  const advice = rangeRuleFired
    ? ' Range forms are not expanded; rewrite the line naming every requirement explicitly ' +
      '(e.g. `REQ-01, REQ-02, REQ-03`).'
    : ' If these are requirements, name them explicitly (e.g. `REQ-01, REQ-02, REQ-03`); if the line ' +
      'is deliberately empty, write `TBD` or `None` — any other wording selects nothing and warns.';
  return {
    code: REQ_LINE_WARNING_CODE.misparse,
    message:
    `ROADMAP Phase ${phaseNum} **Requirements** line could not be parsed as a comma-separated REQ-ID list ` +
    `(\`${shown}\`) - ${selectedDesc}.` +
    (unparsed.length > 0
      ? rangeRuleFired
        ? ` Unparsed text: ${unparsed.join(', ')}.`
        : ` ID-shaped text that was not selected: ${unparsed.join(', ')}.`
      : '') +
    advice +
    delimiterDropped +
    skipped +
    oversized,
  };
}

function cmdPhaseComplete(cwd: string, phaseNum: string, raw: boolean): void {
  if (!phaseNum) {
    error('phase number required for phase complete');
  }

  // #2028: fail safe in workstream mode with no active workstream. With no active
  // workstream and no --ws, planningDir(cwd) resolves to root .planning, so
  // phase.complete would write STATE.md/ROADMAP.md (and mislabel milestone status)
  // into the shared root that other workstreams read. Mirror the #1912 guard that
  // init.progress got (resolution: GSD_WORKSTREAM env > stored active pointer; an
  // explicit --ws sets GSD_WORKSTREAM upstream and satisfies the check).
  const availableWorkstreams = listAvailableWorkstreams(cwd);
  // #3579 root-cause fix: this is a check, not a consuming read — use the
  // non-mutating peek so an unresolvable pointer isn't self-healed (cleared)
  // here and then found "absent" by diagnoseUnresolvedActiveWorkstream below,
  // which would misreport a present-but-bad marker as no marker at all.
  const resolvedWorkstream = resolveEnvWorkstream() ?? peekActiveWorkstream(cwd);
  if (availableWorkstreams.length > 0 && !resolvedWorkstream) {
    // #3579: getActiveWorkstream now inherits a pointer-less session's read
    // from the shared .planning/active-workstream marker, so reaching this
    // branch with a marker actually present means the marker EXISTED but
    // didn't resolve (invalid name, or its workstream dir is gone) — a
    // materially different situation from "nothing was ever set" and one
    // that deserves its own diagnostic instead of the generic message below.
    const diagnosis = diagnoseUnresolvedActiveWorkstream(cwd);
    if (diagnosis.present) {
      error(
        `phase.complete requires a workstream in workstream mode — the active-workstream marker names '${diagnosis.value}', but it did not resolve: ${describeUnresolvedWorkstreamReason(diagnosis.reason)}. Root STATE.md/ROADMAP.md (likely stale) would be written otherwise. ` +
          `Pass --ws <name> or run ${formatGsdSlash('workstream set', resolveRuntime(cwd)) as string} to point it at an existing workstream. ` +
          `Available workstreams: ${availableWorkstreams.join(', ')}`,
        ERROR_REASON.WORKSTREAM_MODE_MARKER_UNRESOLVED,
        { marker_value: diagnosis.value, marker_reason: diagnosis.reason },
      );
    }
    error(
      `phase.complete requires a workstream in workstream mode — no active workstream is set, so root STATE.md/ROADMAP.md (likely stale) would be written. ` +
        `Pass --ws <name> or run ${formatGsdSlash('workstream set', resolveRuntime(cwd)) as string} first. ` +
        `Available workstreams: ${availableWorkstreams.join(', ')}`,
      ERROR_REASON.WORKSTREAM_MODE_NONE_ACTIVE,
    );
  }

  const roadmapPath = path.join(planningDir(cwd), 'ROADMAP.md');
  const statePath = path.join(planningDir(cwd), 'STATE.md');
  const phasesDir = path.join(planningDir(cwd), 'phases');
  const today = realClock.localToday();

  const phaseInfoRaw = findPhaseInternal(cwd, phaseNum);
  if (!phaseInfoRaw) {
    error(`Phase ${phaseNum} not found`);
  }
  const phaseInfo = phaseInfoRaw as unknown as Record<string, unknown>;

  const planCount: number = phaseInfo['plans']
    ? (phaseInfo['plans'] as string[]).length
    : 0;
  const summaryCount: number = phaseInfo['summaries']
    ? (phaseInfo['summaries'] as string[]).length
    : 0;
  let requirementsUpdated = false;
  // #3685: mirror requirementsUpdated's diff-tracking contract at the
  // writes.push({filePath, before, after}) sites below, rather than
  // reporting via fs.existsSync (which is true whenever the file merely
  // exists, not when the transaction actually wrote a change).
  let roadmapUpdated = false;
  let stateUpdated = false;

  const warnings: string[] = [];
  // The machine kind of the Requirements-line warning, carried out to the JSON
  // result as its own field (round 4 review Major 3). Declared HERE, in the
  // same scope as `warnings[]`, because the assignment happens inside
  // withPlanningLock and the emission happens after it.
  let reqLineWarningCode: ReqLineWarningCode | undefined;
  // ADR-3408 §8.5 / D2 (#3374): "liberal but visible" — when the write-seam
  // composition's preservation stage restores a curated frontmatter value
  // over a disagreeing derived one, that divergence is surfaced here rather
  // than silently absorbed. Structured (field + reason), not prose, so a
  // caller can assert on the value rather than regex a rendered message.
  // Named `preservation_warnings`, NOT `warnings`: `warnings` above is
  // already a prose `string[]` on this exact command — reusing it for a
  // structured `{field, reason}[]` shape would be the "Generative Fix
  // Divergence" anti-pattern (two sibling fields, same name, different
  // element types). Mirrors `cmdMilestoneComplete`'s identical field
  // (milestone.cts).
  const preservationWarnings: Array<{ field: string; reason: string }> = [];
  // #3057 B3: mirrors `verification_stale_check_indeterminate` on init.cts /
  // roadmap.cts / uat-predicate.cts's outputs — set on the non-blocking path
  // below (inside withPlanningLock) alongside the warnings[] entry, so a
  // caller can assert on the typed field instead of the warning's prose.
  let staleCheckIndeterminate = false;
  const phaseFullDir = path.join(cwd, phaseInfo['directory'] as string);

  // #2648: fail-closed plan-coverage gate. phase.complete used to gate ONLY on a
  // single *-VERIFICATION.md status, so a phase could close "complete" while an
  // arbitrary number of its plans — including plans a lock/recovery decision
  // silently dropped — had no completion record (a confirmed production incident
  // closed a phase with 6/30 plans unexecuted, including its entire final UI
  // scope, with every tool-reported signal green). Now refuse completion when any
  // plan lacks a matching *-SUMMARY.md, UNLESS that plan is explicitly retired
  // via machine-readable `status: superseded` frontmatter (the #2349 marker).
  //
  // scanPhasePlans is the superseded-AWARE counter (it drops status: superseded
  // plans from planFiles before returning), so a deliberately-retired plan never
  // appears in the unsummarized set and never blocks completion — closing the
  // Goodhart hole (delete a SUMMARY to raise the %) without regressing the
  // legitimate lock/recovery pattern (retire a plan instead of executing it).
  // This is evaluated BEFORE the verification-gate transaction below so a
  // plan-coverage refusal fails fast without mutating ROADMAP/STATE. The count
  // path (cmdPhaseComplete's own planCount/summaryCount above) is NOT superseded-
  // aware (it comes from findPhaseInternal/phase-locator.cts); that is fine for
  // DISPLAY (the X/Y cell) but must not be the gate — the gate needs the
  // superseded-adjusted set so retired plans don't re-block the very phases the
  // marker exists to unblock. Matches roadmap.cts's already-correct-but-unenforced
  // `summaryCount >= planCount` predicate, now enforced at the completion seam.
  const coverageScan = scanPhasePlans(phaseFullDir);
  // #2648 security: fail CLOSED when the phase directory cannot be read.
  // scanPhasePlans deliberately swallows readdirSync errors and returns an empty
  // plan set ({planFiles: []}), which is indistinguishable from a readable empty
  // phase. For a COVERAGE gate that is the wrong posture: "I could not read the
  // plans" must mean "I cannot prove coverage," not "all plans are summarized" —
  // otherwise any I/O failure (permissions, ENOTDIR, EBUSY on Windows, a dir
  // present in ROADMAP.md but missing/unreadable on disk) silently re-opens the
  // exact hole this gate exists to close. Distinguish the two: a readable
  // directory with zero plans is a legitimately complete empty phase; an
  // UNREADABLE directory is a fail-closed refusal. Mirrors cmdPhaseInsert's own
  // readdirSync-fail-closed posture (a swallow there used to risk writing a
  // colliding phase number).
  try {
    fs.readdirSync(phaseFullDir);
  } catch (readErr) {
    error(
      `Phase ${phaseNum} cannot be completed: its plan directory is unreadable (${phaseInfo['directory'] as string}: ${(readErr as NodeJS.ErrnoException).code || (readErr as Error).message}), so plan coverage cannot be verified. Restore read access and retry — a coverage gate that passes when it cannot read the plans is no gate at all (#2648).`,
      ERROR_REASON.PHASE_PLAN_COVERAGE_INCOMPLETE,
    );
  }
  const unsummarizedPlans = findUnsummarizedPlans(
    coverageScan.planFiles,
    coverageScan.summaryFiles,
  );
  if (unsummarizedPlans.length > 0) {
    // Sanitize plan filenames before interpolation: they come raw from
    // readdirSync and could carry C0 control chars / DEL (a committable filename
    // could spoof the terminal in plain-error mode). Strip them so the message is
    // safe to print regardless of --json-errors. Path traversal sequences are not
    // a code-execution vector here (printed only, never reopened from the message).
    const sanitize = (name: string): string => name.replace(/[\u0000-\u001f\u007f]/g, '?');
    const listed = unsummarizedPlans.slice(0, 20).map(sanitize).join(', ');
    const more = unsummarizedPlans.length > 20 ? ` (and ${unsummarizedPlans.length - 20} more)` : '';
    // Audit surface (#2648 review M1): name how many plans were excluded as
    // superseded so a reviewer can see WHICH work was declared retired, not just
    // that some plans are missing summaries. The status: superseded marker is a
    // committable, review-time-trusted bypass; surfacing its count keeps that
    // bypass visible rather than silent.
    const phaseInfoPlanCount = Array.isArray(phaseInfo['plans']) ? (phaseInfo['plans'] as string[]).length : 0;
    const supersededCount =
      coverageScan.planFiles.length === 0 ? 0 : Math.max(0, phaseInfoPlanCount - coverageScan.planFiles.length);
    const supersededNote = supersededCount > 0
      ? ` ${supersededCount} plan(s) excluded as status: superseded (retired).`
      : '';
    error(
      `Phase ${phaseNum} cannot be completed: ${unsummarizedPlans.length} plan(s) have no completion record (*-SUMMARY.md): ${listed}${more}.` +
        supersededNote +
        ` Execute the plans and write their summaries, or retire a plan with machine-readable \`status: superseded\` frontmatter (#2349) if it was deliberately dropped — a retired plan is excluded from this gate. ` +
        `Completing a phase with unexecuted plans is what lost an entire promised deliverable silently (#2648).`,
      ERROR_REASON.PHASE_PLAN_COVERAGE_INCOMPLETE,
    );
  }

  try {
    const phaseFiles = fs.readdirSync(phaseFullDir);
    // #3511: scope this advisory pre-scan to THIS phase's own token so a
    // stray, cross-phase, or ad-hoc file cannot name a warning against a
    // phase it does not belong to.
    const phaseFullDirBaseName = path.basename(phaseFullDir);

    for (const file of scopeToPhase(
      phaseFiles.filter((f) => f.includes('-UAT') && f.endsWith('.md')),
      phaseFullDirBaseName,
    )) {
      const content = fs.readFileSync(path.join(phaseFullDir, file), 'utf-8');
      if (/result: pending/.test(content)) warnings.push(`${file}: has pending tests`);
      if (/result: blocked/.test(content)) warnings.push(`${file}: has blocked tests`);
      if (/status: partial/.test(content)) warnings.push(`${file}: testing incomplete (partial)`);
      if (/status: diagnosed/.test(content)) warnings.push(`${file}: has diagnosed gaps`);
    }

    for (const file of scopeToPhase(
      phaseFiles.filter((f) => f.includes('-VERIFICATION') && f.endsWith('.md')),
      phaseFullDirBaseName,
    )) {
      const verificationFilePath = path.join(phaseFullDir, file);
      // #3707-CR follow-up MINOR: normalize line endings at this read boundary
      // (same fix as src/verification.cts's readVerificationStatus) so a
      // lone-CR VERIFICATION.md's `---\r...\r---` frontmatter fence still
      // matches extractFrontmatter's byte-0 check instead of silently
      // dropping the human_needed/gaps_found advisory warning below.
      const content = normalizeLineEndings(fs.readFileSync(verificationFilePath, 'utf-8'));
      // #1159 (Defect A): read ONLY the frontmatter `status` key to avoid false positives
      // from historical metadata in the file body (e.g. `previous_status: gaps_found`).
      // A full-text regex like /status: gaps_found/ matches the substring inside
      // `previous_status: gaps_found`, producing spurious warnings even when the
      // current frontmatter status is `passed`.
      const verFm = extractFrontmatter(content, verificationFilePath) as Record<string, unknown>;
      // Normalise to lower-case so `status: Passed` (title-case) is not missed.
      const verStatus = typeof verFm['status'] === 'string' ? verFm['status'].trim().toLowerCase() : '';
      if (verStatus === 'human_needed') warnings.push(`${file}: needs human verification`);
      if (verStatus === 'gaps_found') warnings.push(`${file}: has unresolved gaps`);
    }
  } catch {
    /* best-effort (#2245 audit): this is an ADVISORY pre-scan of UAT/
     * VERIFICATION files for `warnings` in the phase-complete output — the
     * actual completion GATE is readVerificationStatus below (a separate
     * mechanism). A readdirSync/readFileSync failure here just means fewer
     * warnings are surfaced this run, not a blocked or corrupted completion. */
  }

  // #2572: artifact↔disk advisory for the SUMMARYs of the phase being completed.
  //
  // A SUMMARY asserts "I created these files". Nothing checked that claim for
  // phase summaries — the `verify-summary` verb has existed since the beginning
  // but was only ever pointed at `.planning/research/SUMMARY.md`. An interrupted
  // or over-reported phase therefore counted toward 100% silently.
  //
  // Joins the same ADVISORY channel as the pre-scan above: findings land in
  // `warnings[]` (rendered by execute-phase.md's "If has_warnings is true"
  // step), never in the completion GATE (readVerificationStatus below).
  // Completion is never blocked.
  //
  // `checkCommits: false` — only the file-existence half is surfaced here, so
  // the `git cat-file` probes would be spawned and their result discarded. The
  // hash pattern is a loose `\b[0-9a-f]{7,40}\b` that matches any hex-shaped
  // token in prose, too noisy to put in front of a user even as a warning.
  //
  // `Infinity` — report every referenced file, not the CLI verb's default first
  // two, so a phase that lists twelve files and landed three says so. The verb
  // keeps its 2-file default; only this caller opts out of the cap.
  try {
    const phaseDirRel = phaseInfo['directory'] as string;
    // `summaries` arrives pre-sorted from the phase locator, so warning order is
    // deterministic across platforms rather than readdir-dependent.
    const summaryNames = (phaseInfo['summaries'] as string[] | undefined) || [];
    for (const summaryName of summaryNames) {
      const v = verifyMod.verifySummaryCore(
        cwd,
        `${phaseDirRel}/${summaryName}`,
        Infinity,
        { checkCommits: false },
      );
      const missing = v.checks.files_created.missing;
      if (missing.length > 0) {
        warnings.push(
          `${summaryName}: references ${missing.length} file(s) not on disk: ${missing.join(', ')}`,
        );
      }
    }
  } catch {
    /* best-effort, same posture as the #2245 pre-scan above: an unreadable
     * SUMMARY means one fewer advisory this run, never a blocked completion. */
  }

  let nextPhaseNum: string | null = null;
  let nextPhaseName: string | null = null;
  let isLastPhase = true;

  // #3311: typed conflict descriptor surfaced on the result JSON alongside the
  // warnings[] entry below (same parity pattern as
  // verification_stale_check_indeterminate).
  let milestoneConflict: milestoneLockMod.MilestoneConflict | null = null;

  // #3227: set inside `runPhaseCompleteTransaction` below from
  // `writePlanningFileSet`'s applied-count return — the transaction always
  // RUNS (verification passed, the lock was taken, `writes[]` was built),
  // but a re-run against a phase whose ROADMAP/STATE bytes already reflect
  // completion produces a `writes[]` where every entry is byte-identical to
  // disk, so `writePlanningFileSet` applies none of them. That must not
  // still refresh state.json's `updated_at` (design doc §40 row 26).
  let anyPlanningWrite = false;

  const verificationBlocked = withPlanningLock(cwd, () => {
    // #3311: completing a phase while a live milestone claim (phase + session)
    // holds a DIFFERENT phase means two sessions are working two phases against
    // the single Current Position slot. Warn via the established warnings[]
    // channel (rendered by execute-phase.md's "If has_warnings is true" step)
    // rather than blocking — the claim may simply be stale-but-live.
    milestoneConflict = milestoneLockMod.checkMilestoneConflictForPhase(cwd, phaseNum);
    if (milestoneConflict) {
      const holder = milestoneConflict.locked_session ?? 'an unknown (headless) session';
      const actor = milestoneConflict.session ?? 'an unknown (headless) session';
      warnings.push(
        `milestone lock conflict (#3311): ${holder} holds the milestone claim for phase ` +
          `${milestoneConflict.locked_phase}, but ${actor} is completing phase ${phaseNum} — ` +
          `STATE.md's Current Position is a single slot; verify it before trusting it`,
      );
      milestoneLockMod.warnMilestoneConflict(milestoneConflict, `phase.complete ${phaseNum}`);
    }
    // #2617: pass the project's runtime so the blocked-completion error below
    // suggests the command surface this runtime actually installs
    // ($gsd-… on Codex) rather than a hard-coded Claude-style string.
    const verificationStatus = readVerificationStatus(phaseFullDir, {
      runtime: resolveRuntime(cwd),
      convention: resolvePhaseIdConvention(cwd),
    });
    // #3057 B3: the staleness check inside readVerificationStatus can itself
    // fail (fs / scanPhasePlans / clock error), in which case `status` above
    // was routed as if nothing were stale (unchanged fail-open routing) — but
    // that must not be silently identical to a check that actually ran and
    // found nothing stale. Join the SAME advisory channel the UAT/VERIFICATION
    // pre-scan above already uses (`warnings[]`, rendered by execute-phase.md's
    // "If has_warnings is true" step) rather than inventing a new one. This
    // only fires on the non-blocking path (status resolves to 'passed' despite
    // the indeterminate check) — the blocked path below carries its own note.
    if (verificationStatus.staleCheckIndeterminate) {
      staleCheckIndeterminate = true;
      warnings.push(
        `verification staleness check could not complete for phase ${phaseNum} — routed as not-stale, but this was not actually verified (#3057)`,
      );
    }
    if (verificationStatus.status !== 'passed') {
      return verificationStatus;
    }

    const runPhaseCompleteTransaction = () => {
      const writes: WriteSpec[] = [];
      let roadmapContent: string | null = null;

      if (fs.existsSync(roadmapPath)) {
        const originalRoadmapContent = fs.readFileSync(roadmapPath, 'utf-8');
        roadmapContent = originalRoadmapContent;

        const phaseEscaped = phaseMarkdownRegexSource(phaseNum);
        // #2067: the gap between `]` and `Phase N` must allow only whitespace /
        // markdown bold emphasis — NOT greedy `.*`. A greedy gap matched a later
        // phase whose description merely mentioned the completed phase number,
        // so completing an already-checked phase (idempotent re-run) checked the
        // wrong phase's box. Mirrors the tight pattern used by phase-insert
        // (`]\\s*(?:\\*\\*)?Phase`).
        // #2067/#2200: line-anchored (^, optional leading indent) so an
        // inline / backticked prose literal cannot match. Milestone-scoped below
        // (mutateMilestonePhase) so a Backlog entry or a same-numbered shipped-
        // milestone phase cannot be flipped either.
        // ADR-2143 §4 note / #2245 audit: this is the phase-LIST checkbox — it
        // lives in the milestone's `- [ ] Phase N: …` checklist, OUTSIDE any
        // `### Phase N` detail section, so there is no section for
        // withPhaseSection to bind to. Migrated onto the sectionizer's
        // `updateBullet` bullet-write seam: the pattern itself is unchanged,
        // only the "find the right line, splice it back" plumbing moved off a
        // whole-slice `.replace()` onto the seam. Applied per single physical
        // line by updateBullet, so the pattern no longer needs the `m` flag
        // (it never sees more than one line at a time); see
        // writePlansField below for the sites that were migrated onto
        // withPhaseSection instead.
        //
        // #2245 review Fix 6: this is behaviour-preserving for GSD-GENERATED
        // inputs (the only shape ROADMAP.md ever actually has), NOT byte-parity
        // across every conceivable input. `updateBullet` is fence-aware — a
        // checkbox-shaped line inside a fenced (``` / ~~~) code block is never
        // offered to `match`/`transform` — whereas the retired whole-slice
        // `.replace()` had no such fence tracking and would have flipped a
        // bullet-shaped line inside a fence too. That divergence has no live
        // bug because a GSD-authored ROADMAP.md milestone checklist never puts
        // its own `- [ ] Phase N: …` entries inside a fenced code block, but it
        // is a real (and correct) behavioural difference on pathological input.
        const checkboxPattern = new RegExp(
          `^[ \\t]*(-\\s*\\[)[ ](\\]\\s*(?:\\*\\*)?\\s*Phase\\s+${phaseEscaped}${OPTIONAL_PHASE_TAG_SOURCE}[:\\s][^\\n]*)`,
          'i',
        );

        // Progress table row: update Plans Complete/Status/Completed columns BY
        // COLUMN NAME (handles 4- or 5-column RoadmapProgress tables) via the
        // markdown-table seam (ADR-2143 §7) — supersedes the prior ordinal
        // cells[]-index regex. Applied inside mutateMilestonePhase below (per
        // milestone window), further scoped to the ## Progress heading within
        // that window so the row lookup doesn't bind to an earlier table (e.g.
        // | Phase | Requirements | Count |) whose rows also start with the
        // phase number (#2012).
        // #2245 Blocker 4: optional dot must be followed by whitespace-or-end,
        // not dot-OR-whitespace-OR-end as alternatives — the prior form let a
        // bare "." satisfy the whole lookahead, so completing phase "2"
        // over-matched a decimal sub-phase row like "2.5 Extra". Matches "2",
        // "2.", "2 Alpha"; rejects "2.5 Extra".
        const phaseCellRe = new RegExp(`^${phaseEscaped}\\.?(?:\\s|$)`, 'i');
        const rowMatch = (row: Record<string, string>): boolean => phaseCellRe.test((row['Phase'] ?? '').trim());
        const dateShape = /^\d{4}-\d{2}-\d{2}$/;

        /**
         * Within `text` (already scoped to one milestone window by the
         * caller), scope further to the `## Progress` heading section (up to
         * the next `#`/`##` heading) when present, run `edit` against just
         * that slice, and splice the result back — falling back to the whole
         * `text` when no `## Progress` heading exists (mirrors phase-
         * lifecycle.cjs's deriveProgressFromRoadmap read-side scoping).
         */
        const editProgressHeadingSlice = (text: string, edit: (scoped: string) => string): string => {
          const progressMatch = text.match(/^##[ \t]+Progress\b/im);
          if (!progressMatch || progressMatch.index === undefined) {
            return edit(text);
          }
          const headingOffset = progressMatch.index;
          const beforeHeading = text.slice(0, headingOffset);
          const fromHeading = text.slice(headingOffset);
          const nextHeading = fromHeading.search(/\n#{1,2}[ \t]/);
          const scoped = nextHeading >= 0 ? fromHeading.slice(0, nextHeading) : fromHeading;
          const after = nextHeading >= 0 ? fromHeading.slice(nextHeading) : '';
          return beforeHeading + edit(scoped) + after;
        };

        // ADR-2143 §4: the plan-count write is now routed through
        // withPhaseSection (see mutateMilestonePhase below), which hands this
        // seam call ONLY phase N's own detail-section body — the section
        // boundary itself confines the write (the #2067/#2200 boundary-
        // crossing class is structurally impossible for this site).
        //
        // #4906 Phase 2 (#4917/ADR-4910): migrated off the one-capture-group
        // regex that replaced to end of line, dropping any hand-written
        // trailing prose after the count (#4852) — onto the PlanningDoc
        // `boldField` write seam, whose `valueSpan`/`trailingSpan` split
        // never touches the trailing annotation.
        const writePlansField = (body: string): string => {
          const parsed = parsePlanningDoc(body, 'ROADMAP.md');
          if (!parsed.ok) {
            preservationWarnings.push({ field: 'Plans', reason: parsed.reason });
            return body;
          }
          const fieldId = findField(parsed.value, 'Plans');
          if (!fieldId) {
            // #4906 regression (#1163 parity, caught by gsd-test against
            // roadmap.cts's sibling site): a hand-edited or pre-template
            // ROADMAP.md may carry a PLAIN (non-bold) `Plans:` line rather
            // than the canonical `**Plans**:`/`**Plans:**` bold field.
            // BOLD_FIELD_RE stays bold-only (widening it would register
            // ordinary prose as a spurious field seam-wide) — this fallback
            // mirrors roadmap.cts's identical one, kept in parity per
            // Decision 2 rather than letting the two sites diverge on which
            // legacy shapes they tolerate.
            const plainMatch = body.match(/^([ \t]*)Plans:([ \t]*)([^\r\n]*)$/m);
            if (!plainMatch) {
              // No `**Plans:**`/`**Plans**:`/plain `Plans:` line in this
              // phase's section — nothing to write; not a failure (mirrors
              // the old regex's silent no-match no-op).
              return body;
            }
            const [whole, indent, spacing, plainValue] = plainMatch;
            const plainCountPrefixMatch = plainValue.match(
              /^(?:\d+\s*\/\s*\d+\s+plans(?:\s+(?:complete|executed))?|\d+\s+plans?)/i,
            );
            const plainIsTemplatePlaceholder = /^\[\s*Number of plans\b[\s\S]*\]$/i.test(plainValue.trim());
            if (!plainCountPrefixMatch && !plainIsTemplatePlaceholder) {
              // Arm 3: freeform prose, TBD, a bracketed human annotation, or
              // an empty value — leave the field exactly as it was.
              return body;
            }
            const plainNewCountText = `${summaryCount}/${planCount} plans complete`;
            const plainSuffix = plainCountPrefixMatch ? plainValue.slice(plainCountPrefixMatch[0].length) : '';
            const newPlainLine = `${indent}Plans:${spacing}${plainNewCountText}${plainSuffix}`;
            const start = plainMatch.index ?? body.indexOf(whole);
            return body.slice(0, start) + newPlainLine + body.slice(start + whole.length);
          }
          // #4906 regression fix: PREFIX-match the existing value's count
          // token and re-glue whatever follows it VERBATIM — a glued-on
          // annotation with no ` — ` separator (e.g. a parenthetical like
          // `0/1 plans executed (11-16 are gap closure from VERIFICATION)`)
          // lives entirely inside `value` (`TRAILING_SEPARATOR_RE` in
          // planning-document.cts only splits on ` — `, unchanged/correct),
          // so overwriting `value` outright previously destroyed it.
          //
          // #4906 review finding (isolated adversarial pass): the prior
          // version of this migration preserved this site's OLD
          // unconditional-overwrite behavior for the no-count-prefix case,
          // which clobbers arm 3 (freeform prose / TBD / a bracketed human
          // annotation like `[Deferred pending re-scope]`) — a real
          // regression against the design doc's own Behavior table row 4,
          // not an accepted trade-off. Fixed here by adopting the SAME
          // template-placeholder / arm-3-untouched classification
          // roadmap.cts's sibling site already uses (isTemplatePlaceholder +
          // "no count prefix and not a placeholder => leave untouched"),
          // rather than letting the two migrated sites diverge on this.
          const newCountText = `${summaryCount}/${planCount} plans complete`;
          const current = readNode(parsed.value, fieldId);
          if (!current.ok) {
            return body;
          }
          const currentValue = current.value;
          const countPrefixMatch = currentValue.match(
            /^(?:\d+\s*\/\s*\d+\s+plans(?:\s+(?:complete|executed))?|\d+\s+plans?)/i,
          );
          const isTemplatePlaceholder = /^\[\s*Number of plans\b[\s\S]*\]$/i.test(currentValue.trim());
          if (!countPrefixMatch && !isTemplatePlaceholder) {
            // Arm 3: freeform prose, TBD, a bracketed human annotation, or an
            // empty value — leave the field exactly as it was.
            return body;
          }
          const newValueToWrite = countPrefixMatch
            ? newCountText + currentValue.slice(countPrefixMatch[0].length)
            : newCountText;
          const staged = setFieldValue(parsed.value, fieldId, newValueToWrite);
          if (!staged.ok) {
            preservationWarnings.push({ field: 'Plans', reason: staged.reason });
            return body;
          }
          const out = serialize(staged.value);
          if (!out.ok) {
            // `hasUnreadableNodes` refusal (ADR-4910 amendment) — a ragged
            // SIBLING node elsewhere in this same section refuses the whole
            // splice. Never throw / crash the phase-complete transaction over
            // a node unrelated to this write; surface it and leave `body`
            // unchanged, same as any other preservation warning.
            preservationWarnings.push({ field: 'Plans', reason: out.reason });
            return body;
          }
          return out.value;
        };

        const phaseInfoSummaries = phaseInfo['summaries'] as string[];

        // #2200: apply the phase-checkbox flip, the plan-count write, and the
        // per-plan checkbox flips ONLY within the current milestone's region(s)
        // (primary section + optional Phase Details section). A bullet/heading in
        // a shipped milestone, a Backlog section, or a backticked prose literal is
        // outside the window and stays untouched. With no versioned active
        // milestone, fall back to whole-content mutation (prior behaviour).
        const mutateMilestonePhase = (slice: string): string => {
          let s = slice;
          s = updateBullet(
            s,
            (_bulletText, rawLine) => checkboxPattern.test(rawLine),
            (rawLine) => rawLine.replace(checkboxPattern, `$1x$2 (completed ${today})`),
          );

          s = editProgressHeadingSlice(s, (scoped) => {
            let text = scoped;

            const plansResult = updateTableCell(text, rowMatch, 'Plans Complete', ` ${summaryCount}/${planCount} `);
            if (plansResult.ok) text = plansResult.value;

            const statusResult = updateTableCell(text, rowMatch, 'Status', ' Complete    ');
            if (statusResult.ok) text = statusResult.value;

            // Preserve only a valid ISO date (#1161: idempotent; self-heal
            // garbage). Ragged-tolerant (#2245 Blocker 2): decide via the
            // CURRENT Completed cell inside a single updateTableCell callback
            // (its own tolerant row scan) rather than gating on
            // findTableWithColumns (which requires the WHOLE table to parse —
            // a ragged SIBLING row elsewhere used to silently no-op this
            // row's date stamp too).
            const completedResult = updateTableCell(text, rowMatch, 'Completed', (current) =>
              dateShape.test(current.trim()) ? current : ` ${today} `);
            if (completedResult.ok) text = completedResult.value;

            return text;
          });

          // ADR-2143 §4: the plan-count write and the per-plan checkbox flips
          // are both scoped to phase N's OWN detail section via
          // withPhaseSection — the edit callback below only ever sees that
          // section's body, so neither regex can escape into a sibling
          // phase's section, a shipped milestone, or a Backlog entry.
          s = withPhaseSection(s, phaseNum, (body) => {
            let b = writePlansField(body);
            for (const summaryFile of phaseInfoSummaries) {
              const planId = summaryFile.replace('-SUMMARY.md', '').replace('SUMMARY.md', '');
              if (!planId) continue;
              const planEscaped = escapeRegex(planId);
              const planCheckboxPattern = new RegExp(
                `(-\\s*\\[) (\\]\\s*(?:\\*\\*)?${planEscaped}(?:\\*\\*)?)`,
                'i',
              );
              b = b.replace(planCheckboxPattern, '$1x$2');
            }
            return b;
          });
          return s;
        };

        const milestoneRanges = currentMilestoneRawRanges(roadmapContent, cwd);
        if (milestoneRanges) {
          // Splice later windows first so an earlier window's offsets are not
          // shifted by a length-changing mutation in a later window.
          const windows = [milestoneRanges.details, milestoneRanges.primary]
            .filter((w): w is { start: number; end: number } => w !== null)
            .sort((a, b) => b.start - a.start);
          for (const w of windows) {
            roadmapContent =
              roadmapContent.slice(0, w.start)
              + mutateMilestonePhase(roadmapContent.slice(w.start, w.end))
              + roadmapContent.slice(w.end);
          }
        } else {
          roadmapContent = mutateMilestonePhase(roadmapContent);
        }

        writes.push({
          filePath: roadmapPath,
          before: originalRoadmapContent,
          after: roadmapContent,
        });
        // #3685 / #3691: normalize both sides before comparing — see
        // contentChangedAfterNormalize's doc (shell-command-projection.cts).
        // A raw `!==` here false-positives whenever this phase-complete
        // roadmap mutation regenerates a section in a different-but-
        // equivalent raw shape than the already-normalized on-disk original.
        roadmapUpdated = contentChangedAfterNormalize(roadmapPath, originalRoadmapContent, roadmapContent);

        const reqPath = path.join(planningDir(cwd), 'REQUIREMENTS.md');
        if (fs.existsSync(reqPath)) {
          const phaseEsc = phaseMarkdownRegexSource(phaseNum);
          const currentMilestoneRoadmap = extractCurrentMilestone(roadmapContent, cwd);
          const phaseSectionMatch = currentMilestoneRoadmap.match(
            new RegExp(
              `(#{2,4}\\s*Phase\\s+${phaseEsc}${OPTIONAL_PHASE_TAG_SOURCE}[:\\s][\\s\\S]*?)(?=#{2,4}\\s*Phase\\s+|$)`,
              'i',
            ),
          );

          const sectionText = phaseSectionMatch ? phaseSectionMatch[1] : '';
          // #4731: multiline-aware — hard-wrapped Requirements read past the
          // line break before the ID scan. The shared extractor also stops at
          // headings and table rows, so a Requirements field followed by the
          // Traceability table cannot bleed other phases' REQ-IDs into the
          // citation scan (isolated-review MEDIUM on the inline lookahead,
          // whose lazy capture swallowed everything to section end).
          const reqLine = sectionText
            ? roadmapParserMod.extractPhaseFieldMultiline(sectionText, 'Requirements')
            : null;

          const originalReqContent = fs.readFileSync(reqPath, 'utf-8');
          let reqContent = originalReqContent;

          // #2316: `citedReqIds` — the REQ-IDs ROADMAP's own **Requirements:**
          // line for this phase actually cites — is hoisted out of the
          // `if (reqLine)` block (previously scoped only inside it) so the
          // ghost-ID cross-check below (~#2316-1) can consult it. `TBD` is the
          // literal placeholder `phase.add`/`-batch`/`-insert` seed
          // (`**Requirements**: TBD`, src/phase.cts:833,920,1078) — never a
          // real REQ-ID, so it is filtered out wherever a cited-ID list feeds
          // a warning (#2316-7 boundary).
          const isPlaceholderReqId = (id: string): boolean => id.toUpperCase() === 'TBD';
          let citedReqIds: string[] = [];
          // #2316-1: Traceability-row writes that matched NO row (ghost or
          // otherwise) — the `if (reqUpdate.ok)` below previously had no
          // `else`, discarding this fact silently instead of surfacing it.
          const traceabilityWriteMisses: string[] = [];

          if (reqLine) {
            // #2334 HIGH 3 + #3697: selection and under-selection detection both
            // live in `analyzeRequirementsLine` (module scope, above), extracted in
            // round 3 so the parser is directly testable — a closure in here is
            // reachable only by spawning the CLI, which no fast-check property test
            // can do. `citedReqIds` is byte-identical to the expression that stood
            // here; nothing about what phase-complete MARKS has changed.
            const reqLineAnalysis = analyzeRequirementsLine(reqLine);
            citedReqIds = reqLineAnalysis.citedReqIds;
            const reqLineWarning = formatRequirementsLineWarning(
              phaseNum,
              reqLine,
              reqLineAnalysis,
            );
            if (reqLineWarning) {
              warnings.push(reqLineWarning.message);
              // Carried out to the JSON result as its own field — see
              // REQ_LINE_WARNING_CODE for why it is not folded into
              // `warnings[]`.
              reqLineWarningCode = reqLineWarning.code;
            }

            for (const reqId of citedReqIds) {
              const reqEscaped = escapeRegex(reqId);
              // Surface 1 — the checkbox: - [ ] **REQ-ID** → - [x] **REQ-ID**.
              // #2945: the flip is CONDITIONAL (porting #2788 defect-2's rollback from
              // cmdRequirementsMarkComplete). Capture the pre-flip content; if a
              // traceability row EXISTS for this ID below but its Status write is rejected
              // (Out/Deferred/Blocked), the checkbox is rolled back so the two surfaces
              // cannot silently diverge. A requirement recorded as deferred must not read
              // as shipped.
              const checkboxRe = new RegExp(`(-\\s*\\[)[ ](\\]\\s*\\*\\*${reqEscaped}\\*\\*)`, 'gi');
              const beforeCheckbox = reqContent;
              reqContent = reqContent.replace(checkboxRe, '$1x$2');
              const checkboxFlipped = reqContent !== beforeCheckbox;

              // Traceability row: | <REQ-ID> | Phase N | Pending|In Progress | ->
              // ... Complete | via the markdown-table seam (ADR-2143 §7). Match the
              // row by its FIRST cell's value (the requirement-ID column) regardless
              // of that column's HEADER name — real tables head it `REQ-ID`, others
              // `Requirement` (#2769/#2203); this mirrors the prior regex's first-cell
              // `\|\s*<id>\s*\|` anchor, not a by-name lookup. Object.values(row) is in
              // header order, so [0] is the first column. Case-insensitive.
              const reqRowMatch = (row: Record<string, string>): boolean =>
                (Object.values(row)[0] ?? '').trim().toLowerCase() === reqId.toLowerCase();
              // Ragged-tolerant (#2245 Blocker 2): drive the write purely off
              // updateTableCell's own tolerant row scan — a DIFFERENT
              // requirement's row elsewhere in the same table having a
              // mismatched cell count must never silently no-op THIS
              // requirement's write. The "only flip Pending/In Progress ->
              // Complete" gate is folded into the newValue callback so one
              // updateTableCell call both probes and writes.
              // #2945: track tableHit (did the callback actually CHANGE the value?) so the
              // checkbox rollback below can distinguish "row existed and accepted" from
              // "row existed and rejected".
              let tableHit = false;
              const reqUpdate = updateTraceabilityCell(reqContent, reqRowMatch, 'Status', (current) => {
                // #2788: accept `Gaps Found` too so a phase stranded by revert-phase (the
                // gaps_found response) can complete without hand-editing the table.
                if (/^(?:pending|in progress|gaps found)$/i.test(current.trim())) {
                  tableHit = true;
                  return ' Complete ';
                }
                return current;
              });
              if (reqUpdate.ok) {
                reqContent = reqUpdate.value;
              } else if (!isPlaceholderReqId(reqId)) {
                traceabilityWriteMisses.push(reqId);
              }

              // #2945 defect-2 (port of milestone.cts:200-210): if a row EXISTS for this
              // ID but its Status write was rejected (row reads Out/Deferred/Blocked,
              // which the callback returned unchanged), roll the checkbox back so the
              // checkbox and the row cannot silently diverge. reqUpdate.ok === a row
              // matched (existence probe); !tableHit === the callback did not advance it.
              if (checkboxFlipped && reqUpdate.ok && !tableHit) {
                reqContent = beforeCheckbox;
              }
            }
          }

          // #1159 (Defect B): collect requirement IDs only from ACTIVE sections.
          // Requirements under headings whose text contains "deferred", "backlog",
          // "future", or an OFF-milestone `v<N>` (case-insensitive) are explicitly
          // out of current scope and must not be flagged as missing from the
          // Traceability table.
          //
          // Strategy: walk lines, track heading depth, and toggle a "deferred" flag
          // when a heading matching the pattern is encountered.  A sub-heading (higher
          // depth) that is ITSELF in a deferred parent remains deferred unless it
          // opens a same-or-shallower heading that does NOT match the pattern.
          // Lines inside fenced code blocks (``` or ~~~) are treated as content, not
          // headings, to avoid false deferred-section detection from code examples.
          //
          // #2334 BLOCKER fix (regresses closed bug #1159 against GSD's OWN
          // shipped template): #2316-4a dropped the bare `v\d+` alternative
          // entirely to stop it over-matching an ACTIVE heading like "## v1
          // Requirements" — but the shipped `templates/requirements.md:35`
          // scaffold ships `## v2 Requirements` / "Deferred to future release"
          // as its ONLY deferred marker, and `v\d+` was the ONLY alternative
          // that ever matched a bare version heading (the deferred-ness lives
          // in body prose, not the heading text). Dropping it regressed #1159
          // for every project scaffolded from the shipped template.
          //
          // Fix: make the `v<N>` alternative MILESTONE-AWARE instead of
          // deleting it. A `## v<N> ...` heading is deferred ONLY when `<N>`
          // (MAJOR version only — "v1" vs milestone "v1.3" is the SAME major
          // version) does not match the CURRENT milestone's major version,
          // resolved via `stateExtractField` against STATE.md's `milestone:`
          // frontmatter field (the same seam `getMilestoneInfo`/state.cts's
          // frontmatter builder already use — no bespoke frontmatter parsing).
          // "## v1 Requirements" while the milestone is v1.x is the ACTIVE
          // milestone's own section (#2316's original ask) and must NOT be
          // swallowed; "## v2 Requirements" while the milestone is v1.x is a
          // genuinely future milestone (#1159's ask, and the literal shipped-
          // template shape) and MUST stay suppressed. `deferred`/`backlog`/
          // `future` are unaffected by milestone resolution — a genuinely
          // deferred heading always spells one of those words too (see
          // #2316-5 regression guard: "## Deferred v2 Requirements", "##
          // Future Backlog", "## Deferred", "## Backlog", "## Future").
          //
          // Fail-safe: when the milestone version cannot be resolved at all
          // (no STATE.md, or no `milestone:` field), fall back to the OLD
          // pre-#2316-4a behavior and treat every `v\d+` heading as deferred.
          // A false "deferred" here only ever SUPPRESSES a warning — strictly
          // safer than spamming a warning on every v\d+-headed scaffold when
          // we cannot tell whether it names the active milestone.
          const DEFERRED_KEYWORD_RE = /\b(?:deferred|backlog|future)\b/i;
          const HEADING_VERSION_RE = /\bv(\d+)(?:\.\d+)*\b/i;
          const stateRawForMilestone = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf-8') : null;
          const currentMilestoneRaw = stateRawForMilestone
            ? stateExtractField(stateRawForMilestone, 'milestone')
            : null;
          const currentMilestoneMajor = currentMilestoneRaw ? extractMajorVersion(currentMilestoneRaw) : null;
          const bodyReqIds: string[] = [];
          // deferredDepth: the heading level that opened the current deferred block,
          // or 0 when we are in an active section.
          let deferredDepth = 0;
          let inFence = false;
          for (const line of reqContent.split(/\r?\n/)) {
            // Track fenced code blocks (``` or ~~~).
            if (/^\s*(?:```|~~~)/.test(line)) {
              inFence = !inFence;
              continue;
            }
            if (inFence) continue; // ignore content inside a code fence

            const headingM = line.match(/^(#{1,6})\s+(.*)/);
            if (headingM) {
              const depth = headingM[1].length;
              const text = headingM[2];
              if (deferredDepth > 0 && depth > deferredDepth) {
                // Sub-heading inside a deferred block: stays deferred regardless of name.
                continue;
              }
              // Heading at same level or shallower than current deferred opener,
              // or no active deferred block yet.
              if (DEFERRED_KEYWORD_RE.test(text)) {
                deferredDepth = depth; // enter a deferred block
              } else {
                const versionMatch = text.match(HEADING_VERSION_RE);
                if (versionMatch) {
                  const headingMajor = versionMatch[1];
                  deferredDepth =
                    currentMilestoneMajor === null || headingMajor !== currentMilestoneMajor
                      ? depth // unresolved milestone (fail-safe) or off-milestone version -> deferred
                      : 0; // same major version as the current milestone -> active
                } else {
                  deferredDepth = 0; // back in an active section
                }
              }
              continue;
            }

            if (deferredDepth > 0) continue; // skip content in deferred sections

            // Collect bold REQ-ID patterns from active-section lines.
            const reqPat = /\*\*([A-Z][A-Z0-9]*-\d+)\*\*/g;
            let bodyMatch: RegExpExecArray | null;
            while ((bodyMatch = reqPat.exec(line)) !== null) {
              const id = bodyMatch[1];
              if (!bodyReqIds.includes(id)) bodyReqIds.push(id);
            }
          }

          const traceabilityHeadingMatch = reqContent.match(/^#{1,6}\s+Traceability\b/im);
          const traceabilitySection = traceabilityHeadingMatch
            ? reqContent.slice(traceabilityHeadingMatch.index)
            : '';
          const tableReqIds = new Set<string>();
          // #2203: match REQ-IDs in any pipe-delimited cell (not just the first
          // column) so a traceability table that leads with a status column (e.g.
          // | ☐ | REQ-01 | …) is parsed correctly instead of reporting every row
          // as missing.
          const tableRowPat = /\|\s*([A-Z][A-Z0-9]*-\d+)\s*\|/g;
          let tableMatch: RegExpExecArray | null;
          while ((tableMatch = tableRowPat.exec(traceabilitySection)) !== null) {
            tableReqIds.add(tableMatch[1]);
          }

          const unregistered = bodyReqIds.filter((id) => !tableReqIds.has(id));
          if (unregistered.length > 0) {
            warnings.push(
              `REQUIREMENTS.md: ${unregistered.length} REQ-ID(s) found in body but missing from Traceability table: ${unregistered.join(', ')} — add them manually to keep traceability in sync`,
            );
          }

          // #2316-1: ghost REQ-IDs — cited by ROADMAP's own **Requirements:**
          // line for this phase, but registered NOWHERE in REQUIREMENTS.md
          // (neither its body nor its Traceability table). The `unregistered`
          // check above only ever compares REQUIREMENTS.md's own body against
          // its own Traceability table; it never consults `citedReqIds`, so an
          // ID that ROADMAP cites but REQUIREMENTS.md never defines at all was
          // previously invisible to every guard. `TBD` (the phase.add/-batch/
          // -insert placeholder) is excluded — see #2316-7 boundary.
          //
          // #2334 HIGH 2: classify "ghost" by PROBING THE ACTUAL WRITE
          // SURFACES this same function just wrote to (:1947 checkbox,
          // :1967 Traceability row) — case-insensitively — mirroring
          // milestone.cts's `notFound`/`hasRow`/`doneCheckbox` classification
          // (src/milestone.cts:117-141,209-215), instead of set-differencing
          // `bodyReqIds` (deferred-filtered, case-sensitive, bold-only) and
          // `tableReqIds` (case-sensitive) against `citedReqIds`. Those two
          // indexes can disagree with the writes: an ID under a `##
          // Deferred` heading gets its checkbox ticked by the write loop
          // above but is deliberately EXCLUDED from `bodyReqIds` by the
          // deferred-heading filter (#1159), so the old set-diff reported it
          // as an unregistered ghost in the SAME response that just ticked
          // its checkbox; a case-mismatched citation (`known-01` vs
          // `**KNOWN-01**`) lands its write via the writes' case-insensitive
          // regexes but failed the old set-diff's case-SENSITIVE
          // `Array.includes`/`Set.has`. An ID whose checkbox OR Traceability
          // row actually matched is registered — not a ghost — regardless of
          // which section (deferred or not) it lives under.
          const reqIsRegisteredAnywhere = (id: string): boolean => {
            const reqEscaped = escapeRegex(id);
            // Surface 1 — checkbox, EITHER state (`[ ]` or `[x]`), case-
            // insensitive: existence check, not the write's space-only match.
            if (new RegExp(`-\\s*\\[[ xX]\\]\\s*\\*\\*${reqEscaped}\\*\\*`, 'i').test(reqContent)) {
              return true;
            }
            // Surface 2 — Traceability row exists at all (any Status value),
            // via the SAME no-op-probe-through-updateTraceabilityCell
            // technique milestone.cts's `hasRow` uses (:210-214): a case-
            // insensitive first-cell match, regardless of current Status.
            const rowProbeMatch = (row: Record<string, string>): boolean =>
              (Object.values(row)[0] ?? '').trim().toLowerCase() === id.toLowerCase();
            return updateTraceabilityCell(reqContent, rowProbeMatch, 'Status', (current) => current).ok;
          };
          const ghostReqIds = citedReqIds.filter(
            (id) => !isPlaceholderReqId(id) && !reqIsRegisteredAnywhere(id),
          );
          if (ghostReqIds.length > 0) {
            warnings.push(
              `ROADMAP Phase ${phaseNum} cites REQ-ID(s) not registered anywhere in REQUIREMENTS.md (neither body nor Traceability table): ${ghostReqIds.join(', ')} — add them to REQUIREMENTS.md or correct the ROADMAP citation`,
            );
          }

          // #2316-1 cont.: a cited ID whose Traceability-row write matched no
          // row for a reason OTHER than being a ghost (e.g. a malformed table)
          // still deserves a warning instead of a silent discard — but skip
          // IDs already reported above as ghosts to avoid a duplicate message
          // for the same root cause.
          const traceabilityWriteFailures = traceabilityWriteMisses.filter(
            (id) => !ghostReqIds.includes(id),
          );
          if (traceabilityWriteFailures.length > 0) {
            warnings.push(
              `REQUIREMENTS.md: Traceability row write skipped for REQ-ID(s) cited by ROADMAP (no matching row found): ${traceabilityWriteFailures.join(', ')}`,
            );
          }

          writes.push({ filePath: reqPath, before: originalReqContent, after: reqContent });
          // #2316-3: `requirements_updated` must reflect whether REQUIREMENTS.md
          // content actually CHANGED, not merely that the file existed in the
          // transaction — mirrors the `writes.push({filePath,before,after})`
          // diff-tracking pattern used for the ROADMAP write above. A phase
          // whose citations match nothing (ghost REQ-IDs only) must report
          // `false`, not a bare "the file was present" `true`.
          // #3685 / #3691: normalize both sides before comparing — same
          // false-positive shape as the sibling roadmapUpdated/stateUpdated
          // flags in this same transaction; all three must agree by
          // construction (see contentChangedAfterNormalize's doc).
          requirementsUpdated = contentChangedAfterNormalize(reqPath, originalReqContent, reqContent);
        }
      }

      // #3701 — the ROADMAP decides WHICH phase is next; the disk decides only HOW it
      // is spelled. Both scans select the numerically lowest phase above N.
      //
      // Both scans below are unchanged in what they match; what changed is that
      // the roadmap is no longer gated behind "the disk found nothing". It used
      // to be (`if (isLastPhase && roadmapContent !== null)`), which made a wrong
      // disk answer uncorrectable: phase directories are created lazily, but
      // `phase insert` scaffolds an inserted phase's directory immediately, so an
      // inserted decimal is routinely the ONLY directory above N and outranked
      // every phase preceding it in the roadmap. Observed: roadmap `1, 2, 02.1,
      // 3` with directories for 01 and 02.1 only reported `next_phase: "02.1"`
      // after completing 1 — and PERSISTED it to STATE.md — while
      // `roadmap.analyze` correctly said `2`.
      //
      // #3581 fixed exactly this at `init.progress` and named the rule: "the
      // frontier is ROADMAP ORDER, not artifact presence". This call site was not
      // in that change's scope.
      //
      // Why the disk scan survives, rather than being replaced:
      //   1. It is the only resolver when there is no ROADMAP.md, or when its
      //      phase rows do not parse.
      //   2. When both agree, it carries the SPELLING the output has always used
      //      — the zero-padded directory token and the on-disk slug (`02`/`beta`),
      //      where the roadmap would give `2` and a slugified title. Promoting the
      //      roadmap without this would silently change the reported value on
      //      every aligned project, which is the majority case.
      let diskNextNum: string | null = null;
      let diskNextName: string | null = null;
      let roadmapNextNum: string | null = null;
      let roadmapNextName: string | null = null;

      // #4699: a phase whose roadmap checkbox is `[x]` is already complete and
      // must never be selected as next_phase — out-of-order completion (a
      // reopened phase finished after later phases shipped) otherwise persists
      // the already-done phase as STATE.md current_phase. Collected from the
      // same milestone-scoped text the roadmap scan walks; membership is
      // comparePhaseNum-based so `02` and `2` dedupe. With no ROADMAP.md (or no
      // parseable rows) the set is empty and the scans behave exactly as
      // before.
      const roadmapCompleteNums: string[] = [];
      if (roadmapContent !== null) {
        try {
          const milestoneForComplete = extractCurrentMilestone(roadmapContent, cwd);
          const completePattern = new RegExp(
            `-\\s*\\[[xX]\\]\\s*(?:\\*\\*|__)?\\s*Phase\\s+(${PHASE_NUMBER_TOKEN_SOURCE})`,
            'gi'
          );
          let cm: RegExpExecArray | null;
          while ((cm = completePattern.exec(milestoneForComplete)) !== null) {
            if (isSentinelPhaseId(cm[1])) continue;
            if (!roadmapCompleteNums.some((n) => comparePhaseNum(cm![1], n) === 0)) {
              roadmapCompleteNums.push(cm[1]);
            }
          }
        } catch {
          /* best-effort: an unreadable milestone section leaves the complete
           * set empty — the scans then behave exactly as they did pre-#4699. */
        }
      }
      const isCompletePhaseNum = (num: string): boolean =>
        roadmapCompleteNums.some((n) => comparePhaseNum(num, n) === 0);

      try {
        // #3185 (ADR-3180 Decision 1): "which phase directories belong to
        // the CURRENT milestone" — routed through the canonical owner
        // instead of a hand-rolled readdirSync + isDirInMilestone filter
        // (which also never excluded sentinels on its own, unlike the
        // owner; the per-directory isSentinelPhaseId check below stays as a
        // defensive second check against the REGEX-EXTRACTED token, which
        // is not necessarily identical to the raw directory name).
        const dirs = listMilestonePhaseDirs(phasesDir, { cwd }).value;

        for (const dir of dirs) {
          const dm = dir.match(new RegExp(`^(${PHASE_NUMBER_TOKEN_SOURCE})-?(.*)`, 'i'));
          if (dm) {
            // #3185: canonical sentinel predicate (SENTINEL_RANGES [0,999]) — this was a local 999-only literal that admitted Phase 0.
            if (isSentinelPhaseId(dm[1])) continue;
            // #4699: an already-complete phase (roadmap checkbox [x]) is never
            // a next_phase candidate — out-of-order completion must skip it.
            if (roadmapContent !== null && isCompletePhaseNum(dm[1])) continue;
            // Numeric MINIMUM above N, not "first encountered". `listMilestonePhaseDirs`
            // does sort by `comparePhaseNum`, so a `break` on the first hit happens to be
            // correct today — but that makes this scan's correctness depend on an
            // upstream sort nothing here states. Selecting the minimum explicitly costs
            // one comparison and removes the hidden coupling.
            if (comparePhaseNum(dm[1], phaseNum) > 0
              && (diskNextNum === null || comparePhaseNum(dm[1], diskNextNum) < 0)) {
              diskNextNum = dm[1];
              diskNextName = dm[2] || null;
            }
          }
        }
      } catch {
        /* best-effort (#2245 audit): stage 1 of a deliberate 3-stage
         * cascading fallback for locating the next phase (disk dirs → roadmap
         * headings/checkboxes → lowest-outstanding-checkbox override, #2028
         * below). A disk-scan failure here is indistinguishable from "found
         * nothing on disk" and correctly falls through to stage 2, which
         * derives the same information independently from ROADMAP.md content
         * — not a silent data-loss path. */
      }

      if (roadmapContent !== null) {
        try {
          const roadmapForPhases = extractCurrentMilestone(roadmapContent, cwd);
          // #1591: match BOTH heading-style phases (`### Phase N:`) AND
          // checkbox-list items, INCLUDING the canonical bold form the roadmap
          // template emits (`- [ ] **Phase N: Name**`). When the active
          // milestone's checklist is `- [ ]` items inside a <details> block
          // (and the next phase has no directory yet, so the disk-based
          // resolver finds nothing), this roadmap-enumeration fallback is the
          // only path that can find the next phase. The prior heading-only
          // pattern missed checkbox items, and a checkbox-only broadening still
          // missed the bold template rows → is_last_phase=true on a mid-milestone
          // phase. Allow optional `**`/`__` emphasis after the marker and stop
          // the name capture at emphasis so bold names slug cleanly; the number
          // capture is unchanged.
          // #1729: `(?:\s*\([^)\n]{0,200}\))?` after the number tolerates a pre-colon
          // ( ) tag (literal mirror of OPTIONAL_PHASE_TAG_SOURCE) so
          // `### Phase N (Cluster B): X` resolves. Captures are unchanged.
          //
          // #4078: the checkbox branch's separator is no longer colon-only. The
          // canonical phase lookup has accepted the bullet-house dash grammar
          // (`- [ ] **Phase N — Name**`, em/en-dash/hyphen/colon) since #2199
          // (`BULLET_PHASE_LINE_PATTERN`, roadmap-parser.cjs), but this scan still
          // required `:`, so on a roadmap whose original rows use the dash grammar
          // the ONLY parseable row above N was typically a later phase.add-ingested
          // colon-form phase — positionally last — and it won the numeric-minimum
          // vote it should never have been alone in (observed: 18 of 18 selected,
          // phases 2–17 skipped). The heading branch stays colon-only, mirroring
          // `findRoadmapPhaseInContent`'s heading grammar exactly; only the
          // checkbox branch widens, and only to the separators #2199 already
          // accepts. The two branches keep separate capture groups, normalized
          // just below the loop.
          const phasePattern = new RegExp(
            `(?:#{2,4}\\s*(?:\\*\\*|__)?\\s*Phase\\s+(${PHASE_NUMBER_TOKEN_SOURCE})(?:\\s*\\([^)\\n]{0,200}\\))?\\s*:\\s*([^\\n*]+)` +
            `|-\\s*\\[[ xX]\\]\\s*(?:\\*\\*|__)?\\s*Phase\\s+(${PHASE_NUMBER_TOKEN_SOURCE})(?:\\s*\\([^)\\n]{0,200}\\))?\\s*[—–:\\-]\\s*([^\\n*]+))`,
            'gi'
          );
          let pm: RegExpExecArray | null;
          while ((pm = phasePattern.exec(roadmapForPhases)) !== null) {
            // #4078: normalize the two alternation branches' captures (heading
            // branch → groups 1/2, widened checkbox branch → groups 3/4).
            const pmNum = pm[1] ?? pm[3];
            const pmName = pm[2] ?? pm[4];
            // #2786: skip sentinel phase ids (999.x backlog, 0.x drafts) — stage 1
            // already skips sentinel dirs on disk via isSentinelPhaseId (#3185);
            // stage 2's heading scan must not advance into backlog headings either.
            if (isSentinelPhaseId(pmNum)) continue;
            // #4699: skip complete phases — a `[x]` checkbox row and the
            // `## Phase Details` heading of an already-done phase both name a
            // phase that must never be next_phase.
            if (roadmapContent !== null && isCompletePhaseNum(pmNum)) continue;
            // #3701 review: the numeric MINIMUM above N, not the first row above N in
            // DOCUMENT order. This scan walks raw roadmap text, and one global regex
            // sweeps both the `## Phases` checklist and the `## Phase Details`
            // headings, so "first match" is a statement about where a line sits in the
            // file — not about which phase comes next.
            //
            // It mattered only once this scan started deciding the answer. Before, it
            // ran solely when the disk scan found nothing; now it outranks the disk, so
            // a roadmap listing rows out of numeric sequence (`1, 3, 2`) reported
            // `next_phase: 3` and PERSISTED it, skipping Phase 2 — on an input the
            // pre-#3701 code got right, because the disk scan is numerically sorted.
            // Phase NUMBERS define sequence here, exactly as `comparePhaseNum` does for
            // the disk scan and for #2028's lowest-outstanding override; the roadmap
            // defines which phases EXIST and which milestone they belong to.
            if (comparePhaseNum(pmNum, phaseNum) > 0
              && (roadmapNextNum === null || comparePhaseNum(pmNum, roadmapNextNum) < 0)) {
              roadmapNextNum = pmNum;
              roadmapNextName = pmName
                .replace(/\(INSERTED\)/i, '')
                .trim()
                .toLowerCase()
                .replace(/\s+/g, '-');
            }
          }
        } catch {
          /* best-effort (#2245 audit): stage 2 of the next-phase cascade
           * (see stage 1's comment above) — a failure here just leaves
           * isLastPhase as stage 1 left it; stage 3 (#2028) below runs next
           * regardless and provides a further, independent override. */
        }
      }


      // Resolve. The roadmap wins on identity; the disk wins on spelling when it
      // is talking about the same phase.
      if (roadmapNextNum !== null) {
        // Same comparator both scans already use to order phases, so "the disk
        // and the roadmap mean the same phase" cannot drift from "N is above the
        // one just completed". `02` and `2` compare equal, which is the whole
        // point — they are the same phase spelled two ways.
        const diskAgrees = diskNextNum !== null && comparePhaseNum(diskNextNum, roadmapNextNum) === 0;
        nextPhaseNum = diskAgrees ? diskNextNum : roadmapNextNum;
        nextPhaseName = diskAgrees ? diskNextName : roadmapNextName;
        isLastPhase = false;
      } else if (diskNextNum !== null) {
        // No usable roadmap (absent, unreadable, or no parseable phase rows) —
        // the disk is all there is. Unchanged from the pre-#3701 behaviour.
        nextPhaseNum = diskNextNum;
        nextPhaseName = diskNextName;
        isLastPhase = false;
      }

      // #2028: don't stamp "All phases complete" when a LOWER-numbered phase is
      // still outstanding. The two blocks above only clear isLastPhase when a
      // HIGHER-numbered phase exists, so completing the numerically-highest phase
      // out of order (e.g. Phase 10 before Phase 9) wrongly read as milestone-end.
      // A phase is complete iff its roadmap checkbox is `[x]` (phase.complete sets
      // this on completion — including the one just marked above); any earlier
      // phase in this milestone whose checkbox is still `[ ]` means the milestone
      // is not done, and the LOWEST such phase is the real next actionable item —
      // point next_phase at it so STATE.md advances to the gap rather than parking
      // on the just-completed phase. Roadmaps without phase checkboxes (heading-
      // only) retain the prior behavior — there is nothing to scan. The checkbox
      // pattern mirrors the sibling phasePattern's anchoring (only whitespace/bold
      // between the box and "Phase", a required `:`) so unrelated checklist lines
      // that merely mention "Phase N" don't match.
      // #3350: this stage answers a DIFFERENT question than stages 1-2 ("what is
      // the next actionable phase?" vs "is this the last phase?"), so it must not
      // be gated on their answer. Gating on isLastPhase let a merely-positionally
      // next higher heading (stage 2) permanently mask a genuinely-outstanding
      // lower phase — stage 2 cleared isLastPhase and this scan never ran. The
      // scan already refuses anything not strictly lower than the completed phase
      // (plus sentinels, #2949), so running it unconditionally cannot manufacture
      // a wrong answer: when no lower phase is outstanding it finds nothing and
      // stages 1-2's pick stands unchanged; in the masking case isLastPhase is
      // already false, so the last-phase signal has no reachable regression.
      if (roadmapContent !== null) {
        try {
          const milestoneScope = extractCurrentMilestone(roadmapContent, cwd);
          // #4078: the separator class here mirrors stage 2's widened checkbox
          // branch (and #2199's BULLET_PHASE_LINE_PATTERN): em/en-dash/hyphen/colon.
          // Without it, this lowest-outstanding override was blind to dash-grammar
          // rows and could not correct an out-of-order completion on the same
          // mixed-grammar roadmaps that broke stage 2.
          const cbPattern = new RegExp(
            `-\\s*\\[(x| )\\]\\s*(?:\\*\\*|__)?\\s*Phase\\s+(${PHASE_NUMBER_TOKEN_SOURCE})(?:\\s*\\([^)\\n]{0,200}\\))?\\s*[—–:\\-]\\s*([^\\n*]+)`,
            'gi'
          );
          let cbm: RegExpExecArray | null;
          let lowestOutstanding: { num: string; name: string } | null = null;
          while ((cbm = cbPattern.exec(milestoneScope)) !== null) {
            const isChecked = cbm[1].toLowerCase() === 'x';
            // #2949: exclude sentinel-range phase ids (0.x backlog, 999.x) from candidacy.
            // comparePhaseNum("0.1","12") === -12, so without this guard an unchecked 0.x
            // backlog row sorts below every real phase and is wrongly selected as next_phase,
            // corrupting STATE.md and desyncing current_phase from current_phase_name.
            // isSentinelPhaseId covers both sentinel ranges (SENTINEL_RANGES = [0, 999]); a
            // real lower-numbered outstanding phase (e.g. Phase 9) is NOT a sentinel and is
            // still selected, preserving #2028's out-of-order-completion behavior.
            if (!isChecked && !isSentinelPhaseId(cbm[2]) && comparePhaseNum(cbm[2], phaseNum) < 0) {
              if (lowestOutstanding === null || comparePhaseNum(cbm[2], lowestOutstanding.num) < 0) {
                lowestOutstanding = {
                  num: cbm[2],
                  name: cbm[3].replace(/\(INSERTED\)/i, '').trim().toLowerCase().replace(/\s+/g, '-'),
                };
              }
            }
          }
          if (lowestOutstanding !== null) {
            isLastPhase = false;
            nextPhaseNum = lowestOutstanding.num;
            nextPhaseName = lowestOutstanding.name;
          }
        } catch {
          /* best-effort (#2245 audit): stage 3 (#2028) of the next-phase
           * cascade — a failure here simply leaves isLastPhase/nextPhaseNum
           * as stages 1-2 already determined them; this stage only ever
           * overrides toward "not last" when it finds a genuinely lower
           * outstanding phase, never the reverse. */
        }
      }

      if (fs.existsSync(statePath)) {
        const originalStateContent = platformReadSync(statePath) || '';
        let stateContent = originalStateContent;

        // ADR-1769 Phase 3: the STATE.md field-update policy (Current Phase
        // shape/name, Status, Current Plan, Last Activity + Description, and
        // the Completed/Total Phases + Progress percent block) now dispatches
        // to the STATE.md Transition Module. The ~90-line inline RMW callback
        // that lived here is the pure `completePhaseCore` in
        // src/state-transition.cts, backed by the field-classification table.
        // `updatePerformanceMetricsSection` stays in this adapter: it is a
        // section-table / disk-scan concern, not a classified field. The
        // sync + post-sync preservation this transaction needs runs via the
        // single write-seam composition, `syncAndPreserveStateMd` (it does
        // NOT go through readModifyWriteStateMd because STATE.md is
        // committed atomically with ROADMAP/REQUIREMENTS, ADR-3408 §8.3 /
        // #3374 / #3469).
        const nextPhaseDisplayName =
          phaseDisplayNameFromRoadmap(roadmapContent, nextPhaseNum) ??
          phaseDisplayNameFromSlug(nextPhaseName);
        const completeResult = transitionCore(
          stateContent,
          {
            kind: 'completePhase',
            phaseNum,
            nextPhaseNum,
            nextPhaseName: nextPhaseDisplayName,
            isLastPhase,
            planCount,
            summaryCount,
          },
          {
            clock: realClock,
            roadmapProvider: () => roadmapContent,
            sourcePath: statePath,
          },
        );
        stateContent = completeResult.content;

        stateContent = updatePerformanceMetricsSection(
          stateContent,
          cwd,
          phaseNum,
          planCount,
          summaryCount,
        );
        // #2736: the transition holds the next phase's exact display name in
        // the intent; pass it as authoritative so the sync's prose
        // re-derivation cannot rewrite current_phase_name to the name's own
        // parenthetical (`Closer-ruling measurement (D1a)` → `D1a`).
        // #3350: PAIR the override. When STATE.md's body carries no Current
        // Phase / Phase field to re-derive from (narrative prose), the #905
        // preserve guard in syncStateFrontmatter keeps the OLD frontmatter
        // current_phase while the authoritative current_phase_name advances —
        // leaving the two fields describing different phases. Pin BOTH to the
        // resolved next phase in that case. When the body DOES carry the field
        // (completePhaseCore just rewrote it), stay name-only so the body's
        // richer `N of T (name)` derived shape survives the sync.
        const fmBody = frontmatterMod.stripFrontmatter(stateContent);
        const bodyHasPhaseField =
          stateExtractField(fmBody, 'Current Phase') != null ||
          stateExtractField(fmBody, 'Phase') != null;
        // #4129: the POST-completion progress counters, derived from the very
        // ROADMAP this transaction just mutated (still in memory — it hits disk
        // only at writePlanningFileSet, AFTER this content was assembled).
        // buildStateFrontmatter's disk scan inside syncAndPreserveStateMd
        // reads the PRE-completion ROADMAP (and any stale-dated sibling
        // verification), so without this intent the persisted counter failed
        // to increment on the completing phase's own transaction. Routed
        // through the #2736 authoritativeFm seam's object direction: the
        // pre-preservation merge makes it the derived truth the ratchet
        // compares, and the post-preservation re-assert (completedOnlyRaise)
        // is a floor no preservation branch can drop below. clampPercent is
        // completePhaseCore's own percent formula (state-transition.cts),
        // reused so the frontmatter and the body `Progress:` line agree.
        const postCompletionRoadmapScope = roadmapContent !== null
          ? extractCurrentMilestone(roadmapContent, cwd)
          : null;
        const postCompletionRoadmapProgress = postCompletionRoadmapScope !== null
          ? deriveProgressFromRoadmapForIntent(postCompletionRoadmapScope)
          : null;
        const authoritativeProgress: Record<string, number> | undefined =
          postCompletionRoadmapProgress && postCompletionRoadmapProgress.completedPhases !== null
            ? postCompletionRoadmapProgress.totalPhases !== null && postCompletionRoadmapProgress.totalPhases > 0
              ? {
                  completed_phases: postCompletionRoadmapProgress.completedPhases,
                  percent: clampPercentForIntent(
                    postCompletionRoadmapProgress.completedPhases,
                    postCompletionRoadmapProgress.totalPhases,
                  ),
                }
              : { completed_phases: postCompletionRoadmapProgress.completedPhases }
            : undefined;
        const authoritativeFm: Record<string, unknown> | undefined = authoritativeProgress
          ? {
              ...(nextPhaseDisplayName
                ? bodyHasPhaseField || !nextPhaseNum
                  ? { current_phase_name: nextPhaseDisplayName }
                  : {
                      current_phase: String(nextPhaseNum),
                      current_phase_name: nextPhaseDisplayName,
                    }
                : {}),
              progress: authoritativeProgress,
            }
          : nextPhaseDisplayName
            ? bodyHasPhaseField || !nextPhaseNum
              ? { current_phase_name: nextPhaseDisplayName }
              : {
                  current_phase: String(nextPhaseNum),
                  current_phase_name: nextPhaseDisplayName,
                }
            : undefined;
        // ADR-3408 §8.3 / #3469: this deliberately bypasses
        // readModifyWriteStateMd (STATE.md is committed atomically with
        // ROADMAP/REQUIREMENTS), so it calls the single write-seam
        // composition (`syncAndPreserveStateMd`) directly instead of
        // assembling `syncStateFrontmatter` + `applyPostSyncPreservation`
        // itself — a call site re-assembling the pair, even with every step
        // calling an owner, is the exact re-derivation §8.3 forbids by name
        // (Phase 2 found this shape live here). The composition runs
        // snapshots from the on-disk pre-image (originalStateContent) and
        // the transformed content, table-driven applyStatePreservation, then
        // the #2736 authoritative re-assert (which restores the #3350
        // pairing override the preserve-always restore may have reverted).
        // resync=true is the lifecycle-transition posture (progress
        // recomputed from disk; only the preserve-when-unchanged deltas
        // apply). Fields the transition legitimately rewrote (Status, Phase,
        // Stopped At via completePhaseCore's #3374 continuity line) have
        // changed body sources, so their deltas do not fire.
        // ADR-3408 §8.5 / D2 (#3374): thread `divergedFields` through so this
        // command reports what it preserved, following `cmdMilestoneComplete`'s
        // shape (milestone.cts) — the same composition, the same out-param,
        // the same visibility contract.
        const divergedFields: string[] = [];
        stateContent = syncAndPreserveStateMd(
          originalStateContent,
          stateContent,
          statePath,
          cwd,
          {
            resync: true,
            authoritativeFm,
            divergedFields,
          },
        );
        for (const field of divergedFields) {
          preservationWarnings.push({ field, reason: 'preserved-over-disagreeing-derived' });
        }

        writes.push({ filePath: statePath, before: originalStateContent, after: stateContent });
        // #3685 / #3691: normalize both sides before comparing (same
        // transitionCore-regenerated-section artifact cmdMilestoneComplete
        // hit — see contentChangedAfterNormalize's doc). Reported "not
        // exposed" by a previous agent; the reviewer disproved that by
        // inspection and this branch closes it.
        stateUpdated = contentChangedAfterNormalize(statePath, originalStateContent, stateContent);
      }

      anyPlanningWrite = writePlanningFileSet(writes) > 0;
    };

    if (fs.existsSync(statePath)) {
      withStateLock(statePath, runPhaseCompleteTransaction);
    } else {
      runPhaseCompleteTransaction();
    }
    // #3311: a successful completion of the CLAIMED phase releases the
    // milestone claim — regardless of which session completes it (an
    // orchestrator cleaning up after a dead session must not be blocked by the
    // dead session's own claim). No-ops when the claim names another phase.
    milestoneLockMod.releaseMilestonePhase(cwd, phaseNum);
    return null;
  });

  if (verificationBlocked) {
    const nextStep = verificationBlocked.next_command
      ? ` Next: ${verificationBlocked.next_command}`
      : '';
    // #3057 B3: purely additive to the message text — does not change WHETHER
    // this blocks (verificationBlocked was already truthy) or the
    // ERROR_REASON, only whether the operator can see the staleness check
    // itself did not complete. The same fact is also attached as a typed
    // field (`verification_stale_check_indeterminate`) on the JSON-error-mode
    // payload so a test can assert on it by value instead of regexing this
    // human-readable note.
    const staleCheckIndeterminate = verificationBlocked.staleCheckIndeterminate === true;
    const indeterminateNote = staleCheckIndeterminate
      ? ' (staleness check could not complete — see #3057)'
      : '';
    error(
      `Phase ${phaseNum} verification is incomplete: ${verificationBlocked.next_action}${nextStep}${indeterminateNote}`,
      ERROR_REASON.PHASE_VERIFICATION_INCOMPLETE,
      { verification_stale_check_indeterminate: staleCheckIndeterminate },
    );
  }

  let autoPruned = false;
  try {
    const configPath = path.join(planningDir(cwd), 'config.json');
    if (fs.existsSync(configPath)) {
      const rawConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      const workflow = rawConfig['workflow'] as Record<string, unknown> | undefined;
      const autoPruneEnabled = workflow && workflow['auto_prune_state'] === true;
      if (autoPruneEnabled && fs.existsSync(statePath)) {
        // Non-hoisted: load-order matters (stateMod must be fully resolved first).
        const { cmdStatePrune } = stateMod;
        cmdStatePrune(cwd, { keepRecent: '3', dryRun: false, silent: true }, true);
        autoPruned = true;
      }
    }
  } catch {
    /* intentionally empty — auto-prune is best-effort */
  }

  const result = {
    completed_phase: phaseNum,
    phase_name: phaseInfo['phase_name'],
    plans_executed: `${summaryCount}/${planCount}`,
    next_phase: nextPhaseNum,
    next_phase_name: nextPhaseName,
    is_last_phase: isLastPhase,
    date: today,
    roadmap_updated: roadmapUpdated,
    state_updated: stateUpdated,
    requirements_updated: requirementsUpdated,
    auto_pruned: autoPruned,
    warnings,
    has_warnings: warnings.length > 0,
    // ADDITIVE, never a change to `warnings[]`'s element shape — that array is
    // a documented string[] consumed by execute-phase.md, so re-typing it
    // would break a shipped output contract. Absent when the line is clean.
    ...(reqLineWarningCode ? { requirements_line_warning: { code: reqLineWarningCode } } : {}),
    verification_stale_check_indeterminate: staleCheckIndeterminate,
    milestone_conflict: milestoneConflict,
    preservation_warnings: preservationWarnings,
  };

  output(result, raw);
  // #3227: gate on `anyPlanningWrite` (whether `writePlanningFileSet`
  // actually wrote anything), not on reaching this line — reaching here only
  // means verification passed and the transaction ran, not that ROADMAP.md
  // or STATE.md bytes changed (see the `anyPlanningWrite` declaration above).
  if (anyPlanningWrite) publishStateContract(cwd);
}

function cmdPhaseUatPassed(
  cwd: string,
  phaseNum: string | undefined,
  raw: boolean,
  opts: { policy?: { requireVerification?: boolean; uatOnly?: boolean } } = {},
): void {
  if (!phaseNum) {
    error('phase number required for phase uat-passed');
  }

  const phaseInfoRaw = findPhaseInternal(cwd, phaseNum!);
  if (!phaseInfoRaw) {
    error(`Phase ${phaseNum} not found`);
  }
  const phaseInfo = phaseInfoRaw as unknown as Record<string, unknown>;
  const phaseFullDir = path.join(cwd, phaseInfo['directory'] as string);

  const report = evaluateUatPassed(phaseFullDir, { policy: opts.policy });

  output({ phase: phaseNum, ...report }, raw);
}

// #1437 — phase.list-plans: list plan files for a given phase number.
// Returns the full scan result from scanPhasePlans so callers can read plan
// paths without re-discovering the phase directory themselves.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- plan-scan.cjs is an export= CommonJS module
import planScanMod = require('./plan-scan.cjs');
const { scanPhasePlans, isCanonicalPlanFile } = planScanMod;

function cmdPhaseListPlans(cwd: string, phaseNum: string | undefined, raw: boolean): void {
  if (!phaseNum) {
    error('phase number required for phase list-plans');
  }

  const phaseInfo = findPhaseInternal(cwd, phaseNum!);
  if (!phaseInfo) {
    output({ phase: phaseNum, plan_count: 0, has_plans: false, plans: [], phase_dir: null }, raw);
    return;
  }

  const phaseDir = path.join(cwd, (phaseInfo as unknown as Record<string, unknown>)['directory'] as string);
  const scan = scanPhasePlans(phaseDir);
  const phaseRel = (phaseInfo as unknown as Record<string, unknown>)['directory'] as string;

  // Build absolute-usable relative paths for each plan file.
  const plans = scan.planFiles.map((f: string) => toPosixPath(path.join(phaseRel, f)));

  output({
    phase: phaseNum,
    phase_dir: phaseRel,
    plan_count: scan.planCount,
    has_plans: scan.planCount > 0,
    plans,
  }, raw);
}

export = {
  cmdPhasesList,
  cmdPhaseNextDecimal,
  cmdFindPhase,
  cmdPhasePlanIndex,
  cmdPhaseAdd,
  cmdPhaseAddBatch,
  cmdPhaseMvpMode,
  cmdPhaseTddApplicable,
  cmdPhaseInsert,
  cmdPhaseRemove,
  cmdPhaseComplete,
  analyzeRequirementsLine,
  formatRequirementsLineWarning,
  REQ_LINE_WARNING_CODE,
  cmdPhaseUatPassed,
  cmdPhaseListPlans,
  computeDependencyLevels,
  buildShortFormToId,
};
