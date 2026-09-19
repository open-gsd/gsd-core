/**
 * Roadmap Upgrade — Migration tool for converting legacy 'Phase N' phase IDs
 * to milestone-prefixed 'Phase M-NN', or legacy/M-NN IDs to bracket form.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/roadmap-upgrade.cjs collapsed
 * to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only types are added.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { retryRenameSync } from './shell-command-projection.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspace = require('./planning-workspace.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseIdMod = require('./phase-id.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseLocatorMod = require('./phase-locator.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningScopeMod = require('./planning-scope.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import frontmatterMod = require('./frontmatter.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import roadmapParserMod = require('./roadmap-parser.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseMod = require('./phase.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import coreUtilsMod = require('./core-utils.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import markdownSectionizerMod = require('./markdown-sectionizer.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planScanMod = require('./plan-scan.cjs');
const { planningDir } = planningWorkspace;
const { listAllPhaseDirs } = phaseLocatorMod;
const { SCOPE } = planningScopeMod;
// #4698 Blocker 1 (round 2): reuse the shared frontmatter reader/writer
// (src/frontmatter.cts) rather than a bespoke YAML touch — `spliceFrontmatter`
// already solves "change exactly one key, preserve every other key's raw text
// byte-for-byte", which is exactly the contract a `depends_on` rewrite needs.
const { extractFrontmatter, spliceFrontmatter } = frontmatterMod;
const { milestoneSections, isPhaseHeadingText } = roadmapParserMod;
const { normalizeDependencyToken } = phaseMod;
// #4144 round 5 Blocker 3: the single owner of the canonical short-alias
// derivation the real resolver's own canonicalToId map is built from
// (src/phase.cts) — reused here rather than re-derived.
const { extractCanonicalPlanId } = coreUtilsMod;
// #4144 round 5 Blocker 4: the readers' own fence-scanning engine
// (tokenizeHeadings is built on this same seam) — reused here instead of a
// third independent fence parser.
const { scanFencedBlocks } = markdownSectionizerMod;
// #4144 round 5 follow-up (lint-plan-count-drift): the plan-scan owner's own
// root-plan-file predicate (src/plan-scan.cts) — reused in
// computeDependsOnRewrites instead of a private `/-PLAN\.md$/i` filename
// re-derivation of the same membership test.
const { isRootPlanFile } = planScanMod;
const {
  BRACKET_ID_SRC,
  BRACKET_PROJECT_CODE_SRC,
  isBracketPhaseTokenRepresentable,
  isSentinelPhaseId,
  normalizePhaseName,
  OPTIONAL_PHASE_TAG_SOURCE,
  PHASE_HEADING_BASELINE,
  phaseHeadingPrefixSrcFor,
  PHASE_NUMBER_TOKEN_SOURCE,
  phaseArtifactTokenSpan,
  stripProjectCodePrefix,
  toDir,
} = phaseIdMod;

// ─── Regex helpers ────────────────────────────────────────────────────────────

// Matches legacy phase headings: ### Phase N: Name  (also decimal: Phase 2.1:)
// Captures: (hashes)(spaces)(phase-number)(rest-of-line)
const LEGACY_PHASE_HEADING_RE = new RegExp(
  `^(#{2,4})\\s*(?:\\[[^\\]]{1,200}\\]\\s*)?Phase\\s+(${PHASE_NUMBER_TOKEN_SOURCE})\\s*:(.*)`,
  'i'
);

// Matches already-migrated phase headings: ### Phase M-NN: Name
const MIGRATED_PHASE_HEADING_RE = /^#{2,4}\s*(?:\[[^\]]{1,200}\]\s*)?Phase\s+\d+-\d{2}\s*:/i;

// Matches milestone section headings: ## v1.0, ## Roadmap v2.0, ## ✅ v1.0, ## [GSD] v1.0, etc.
// The optional bracket-token prefix (e.g., [GSD]) must be tested before the emoji group.
const MILESTONE_HEADING_RE = /^##\s+(?:\[[^\]]{1,200}\]\s+|Roadmap\s+|[✅🚧]\s*)?v(\d+)\.(\d+)(?:\s|:)/iu;

// Bracket headings are terminal migration targets. Both the bracket identity
// and the following phase token come from the phase-id owner (#2128).
// #4698 Blocker 3 (round 2): widened with (uncaptured) OPTIONAL_PHASE_TAG_SOURCE
// so an ALREADY-migrated bracket heading that carries a tag
// (`### [GSD.02] 05 (Cluster B): Name`) is still recognized as migrated —
// this constant is exclusively bracket-owned (no shared consumer whose group
// indices this would disturb), so it is safe to widen in place.
const BRACKET_PHASE_HEADING_RE = new RegExp(
  `^#{2,4}\\s*\\[${BRACKET_ID_SRC}\\][ \\t]*(?:Phase\\s+)?${PHASE_NUMBER_TOKEN_SOURCE}${OPTIONAL_PHASE_TAG_SOURCE}\\s*:`,
  'i',
);

// phase-id-owner: ADR-612 PR-3 exclusively owns the deprecated M-NN source grammar during the migration window.
// M-NN has exactly one consumer (parseBracketSourcePhases, via
// MNN_PHASE_HEADING_BRACKET_RE below) — the historical milestone-prefixed
// target never recognizes M-NN input at all — so only the shared token
// source lives here; the heading regex itself is bracket-path-owned.
const MNN_SOURCE_TOKEN_SOURCE = '\\d+-\\d+(?:-\\d+)?';
const PROJECT_CODE_RE = new RegExp(`^${BRACKET_PROJECT_CODE_SRC}$`);

// #4698 Blocker 3 (round 2): bracket-source-parsing-OWNED copies of the
// legacy/M-NN heading grammars above, widened with a CAPTURED
// `OPTIONAL_PHASE_TAG_SOURCE` so a heading the runtime already supports —
// `### Phase 2 (Cluster B): Beta`, the optional parenthetical tag between the
// phase number and the colon (src/phase-id.cts, #1729) — is recognized here
// too, instead of failing every grammar and vanishing from the plan silently
// (the exact reported defect). `src/roadmap.cts`'s real bracket readers
// compose the phaseHeadingPrefixSrcFor selector's result with
// PHASE_NUMBER_TOKEN_SOURCE + OPTIONAL_PHASE_TAG_SOURCE + ':' for BOTH the
// bracket and label-only intros (e.g. `src/roadmap.cts:184`) — so the
// bracket heading grammar DOES have a tag slot, in this exact position, and
// this migrator must emit into it rather than drop the tag or refuse it.
// (Named here only for the reader tracing the claim, never called: this file
// does not consume that convention-gated selector, so scripts/lint-phase-id-
// drift.cjs's closed selector-consumer census must not, and does not, count
// it as one — see tests/adr-612-bracket-heading-selection.test.cjs.)
//
// LEGACY_PHASE_HEADING_BRACKET_RE is a SEPARATE constant from
// LEGACY_PHASE_HEADING_RE (used by the historical milestone-prefixed
// target's OWN parseRoadmapPhases and its own separate heading-rewrite regex
// in computeMigrationPlan, both with an established, untouched group-index
// contract) rather than widening that shared regex in place: widening
// recognition there alone would newly COUNT a tagged heading that target's
// own rewrite regex still cannot rewrite (a different, unfixed regex),
// trading a silent skip for a silent half-migration. M-NN needs no such
// pairing — it has exactly one consumer (this bracket-only source parser),
// per MNN_SOURCE_TOKEN_SOURCE's own comment above.
// #4144 round 6 (W-CRLF): the trailing capture is `(.*\r?)`, not `(.*)`. JS
// `.` never matches `\r` (it is its own LineTerminator, ECMA-262), so a CRLF
// roadmap's `\r` sat just past the `(.*)` group's end — present in the LINE
// but absent from `headingTail`, which the heading rebuild below is built
// from. Since `applyRoadmapEdits` replaces a touched line's FULL text with
// the rebuilt one, every converted heading silently lost its `\r` while
// every untouched line (and every checklist bullet, whose rewrite instead
// slices the line's own remainder rather than reassembling captured groups)
// kept it — a mixed-EOL file despite this function's own "preserve every
// terminator" contract. The explicit `\r?` re-admits it into the SAME group
// `headingTail` is read from, so the rebuilt line carries it forward.
const LEGACY_PHASE_HEADING_BRACKET_RE = new RegExp(
  `^(#{2,4})\\s*(?:\\[[^\\]]{1,200}\\]\\s*)?Phase\\s+(${PHASE_NUMBER_TOKEN_SOURCE})(${OPTIONAL_PHASE_TAG_SOURCE})\\s*:(.*\\r?)`,
  'i',
);
const MNN_PHASE_HEADING_BRACKET_RE = new RegExp(
  `^(#{2,4})\\s*(?:\\[[^\\]]{1,200}\\]\\s*)?Phase\\s+(${MNN_SOURCE_TOKEN_SOURCE})(${OPTIONAL_PHASE_TAG_SOURCE})\\s*:(.*\\r?)`,
  'i',
);

// #4698 Blocker 3 (round 2), part (b): a line that STARTS like a phase
// heading, or like a bracket-shaped heading, but is parsed by NONE of the
// three recognized grammars above must never be silently skipped — that is
// exactly how a tagged/malformed heading went unmigrated while the roadmap
// still got stamped with the target convention (the reported defect's root
// cause: partial conversion read as "done"). `computeBracketPlan` refuses
// before any write when either check below matches a line that none of
// BRACKET_PHASE_HEADING_RE / MNN_PHASE_HEADING_BRACKET_RE /
// LEGACY_PHASE_HEADING_BRACKET_RE accepted.
//
// #4144 round 5 Blocker 1 (regression from round 3): the "phase-like" half
// of that refusal used to be a bare `/^#{2,4}\s*Phase\b/i` — anything
// starting with the word "Phase" — which also caught
// gsd-core/templates/roadmap.md's own shipped `## Phase Details` section
// heading (no phase number, no colon) and aborted migration of every
// roadmap built from that template. The refusal may only fire for a heading
// the READERS' OWN phase-heading grammar (roadmap-parser.cts's
// hasPhaseEntries, exported as `isPhaseHeadingText`) would itself treat as a
// phase heading — reusing that single owner rather than a second, looser
// grammar here. `isPhaseLikeHeadingLine` strips the `#{2,4}` markers a raw
// source line still carries (tokenizeHeadings' own `h.text` already has
// them stripped; a source line handed to this scanner does not) before
// testing.
const HEADING_HASH_PREFIX_RE = /^#{2,4}[ \t]*/;
const isPhaseLikeHeadingLine = (line: string): boolean => {
  const match = HEADING_HASH_PREFIX_RE.exec(line);
  if (!match) return false;
  return isPhaseHeadingText(line.slice(match[0].length));
};
const BRACKET_HEADING_LIKE_RE = /^#{2,4}\s*\[[^\]]{1,200}\]/;

// ─── Types ────────────────────────────────────────────────────────────────────

interface ParsedPhaseEntry {
  lineIndex: number;
  headingLine: string;
  alreadyMigrated: boolean;
  milestoneInt?: number | null;
  legacyPhaseNum?: string;
  phaseName?: string;
  hashes?: string;
}

interface AssignedMapping {
  newId: string;
  milestoneInt: number;
  subIndex: number;
  legacyPhaseNum: string;
}

/**
 * #4698 Blocker 3: a phase-qualified artifact filename inside a renamed
 * directory, mapped from its pre-migration name to its bracket-token name.
 * Populated only by the bracket target (`computeBracketPlan`) — the
 * historical milestone-prefixed target is unaffected and simply omits this
 * field on its own `PhaseRename` entries.
 */
interface ArtifactRename {
  oldName: string;
  newName: string;
}

/**
 * #4698 Blocker 1 (round 2): a `depends_on` frontmatter rewrite inside one
 * `*-PLAN.md` file of a renamed directory. `oldName` is the file's
 * PRE-migration name (the key `applyMigration` snapshots against, so
 * rollback restores it at the exact path it returns to once every rename in
 * `performedRenames` — including this same directory's own — has been
 * reversed); `finalName` is the name the SAME file carries once
 * `computeArtifactRenames` has run for this directory (identical to
 * `oldName` when this particular file's own name did not change). `from`/
 * `to` are the full, byte-exact file contents before and after the rewrite —
 * the same "whole value, not a diff" shape `RoadmapEdit` already uses for its
 * `from`/`to` line text, so the dry-run JSON plan previews this rewrite the
 * same way it previews a ROADMAP.md line edit.
 */
interface DependsOnRewrite {
  oldName: string;
  finalName: string;
  from: string;
  to: string;
}

interface PhaseRename {
  oldId: string;
  newId: string;
  oldDir: string;
  newDir: string;
  fileRenames?: ArtifactRename[];
  dependsOnRewrites?: DependsOnRewrite[];
}

interface RoadmapEdit {
  lineIndex: number;
  from: string;
  to: string;
}

interface CrossRefEdit {
  file: string;
  from: string;
  to: string;
}

interface MigrationPlan {
  alreadyMigrated: boolean;
  phases: PhaseRename[];
  roadmapEdits: RoadmapEdit[];
  crossRefEdits: CrossRefEdit[];
  targetConvention?: 'milestone-prefixed' | 'bracket';
}

interface ApplyMigrationResult {
  applied?: boolean;
  alreadyMigrated?: boolean;
  dryRun?: boolean;
  renamedDirs?: string[];
  editedFiles?: string[];
}

// ─── Pure computation helpers ─────────────────────────────────────────────────

/**
 * Parse the ROADMAP.md content and build a list of phase entries with their
 * enclosing milestone major version.
 *
 * Returns an array of:
 *   { lineIndex, headingLine, milestoneInt, legacyPhaseNum, phaseName }
 */
function parseRoadmapPhases(lines: string[]): ParsedPhaseEntry[] {
  const results: ParsedPhaseEntry[] = [];
  let currentMilestoneInt: number | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const milestoneMatch = line.match(MILESTONE_HEADING_RE);
    if (milestoneMatch) {
      currentMilestoneInt = parseInt(milestoneMatch[1], 10);
      continue;
    }

    if (MIGRATED_PHASE_HEADING_RE.test(line)) {
      // Already-migrated heading found — caller will detect this
      results.push({ lineIndex: i, headingLine: line, alreadyMigrated: true });
      continue;
    }

    const phaseMatch = line.match(LEGACY_PHASE_HEADING_RE);
    if (phaseMatch) {
      results.push({
        lineIndex: i,
        headingLine: line,
        milestoneInt: currentMilestoneInt,
        legacyPhaseNum: phaseMatch[2],
        phaseName: phaseMatch[3].trim(),
        hashes: phaseMatch[1],
        alreadyMigrated: false,
      });
    }
  }

  return results;
}

/**
 * Assign sub-indices within each milestone, building a per-entry mapping.
 *
 * Input: array from parseRoadmapPhases (non-migrated entries only).
 * Returns: Map<lineIndex, { newId, milestoneInt, subIndex }>
 *
 * Keyed by `lineIndex` (the unique position of the heading line in ROADMAP.md)
 * so that identical legacy phase numbers in different milestones (e.g., two
 * `Phase 1` headings in v1.0 and v2.0) each get their own correct M-NN ID
 * instead of the later milestone's mapping overwriting the earlier one.
 *
 * Sub-indices are 1-based and sequential within each milestone.
 */
function assignSubIndices(phaseEntries: ParsedPhaseEntry[]): Map<number, AssignedMapping> {
  const milestoneCounters = new Map<number, number>(); // milestoneInt → counter
  const mapping = new Map<number, AssignedMapping>(); // lineIndex → { newId, milestoneInt, subIndex }

  for (const entry of phaseEntries) {
    if (entry.alreadyMigrated) continue;
    const m = entry.milestoneInt;
    if (m === null || m === undefined) continue;

    const counter = (milestoneCounters.get(m) || 0) + 1;
    milestoneCounters.set(m, counter);

    const subIndex = String(counter).padStart(2, '0');
    const newId = `${m}-${subIndex}`;

    mapping.set(entry.lineIndex, { newId, milestoneInt: m, subIndex: counter, legacyPhaseNum: entry.legacyPhaseNum! });
  }

  return mapping;
}

/**
 * Read a phase directory name and return its numeric token (stripping project_code prefix).
 * e.g. "GSD-01-setup" → "01", "01-setup" → "01", "02-implement" → "02", "02.1-hotfix" → "02.1"
 */
function extractPhaseNumFromDir(dirName: string): string | null {
  // Strip optional project_code prefix: "GSD-01-setup" → "01-setup"
  const stripped = stripProjectCodePrefix(dirName);
  // Matches: digits + optional letter + optional decimal suffix, followed by '-' or end.
  // e.g. "02.1-hotfix" → "02.1", "01-setup" → "01"
  const m = stripped.match(new RegExp(`^(${PHASE_NUMBER_TOKEN_SOURCE})(?:-|$)`, 'i'));
  return m ? m[1] : null;
}


/**
 * Build the new directory name from old name and new phase ID.
 * old: "01-setup"         newId: "1-02"  projectCode: "GSD"  → "GSD-01-02-setup"
 * old: "01-setup"         newId: "1-02"  projectCode: null   → "01-02-setup"
 * old: "GSD-01-setup"     newId: "1-02"  projectCode: "GSD"  → "GSD-01-02-setup"
 */
function buildNewDirName(oldDirName: string, newId: string, projectCode: string | null): string {
  // Strip existing project_code prefix
  const stripped = stripProjectCodePrefix(oldDirName);

  // Extract slug: everything after "NN-" (the old phase num, including decimal like 02.1)
  const slugMatch = stripped.match(new RegExp(`^${PHASE_NUMBER_TOKEN_SOURCE}-(.*)`, 'i'));
  const slug = slugMatch ? slugMatch[1] : stripped;

  // Build M-NN prefix (zero-pad both parts)
  const [milestoneStr, subStr] = newId.split('-');
  const milestoneInt = parseInt(milestoneStr, 10);
  const paddedMilestone = String(milestoneInt).padStart(2, '0');
  const newBase = slug ? `${paddedMilestone}-${subStr}-${slug}` : `${paddedMilestone}-${subStr}`;

  return projectCode ? `${projectCode}-${newBase}` : newBase;
}

// ─── Bracket-convention computation (ADR-612 PR-3) ──────────────────────────

interface BracketSourceEntry {
  lineIndex: number;
  alreadyMigrated: boolean;
  source?: 'legacy' | 'mnn';
  milestoneInt?: number | null;
  sourceToken?: string;
  /**
   * #4698 Blocker 3 (round 2): the verbatim optional parenthetical tag text
   * (e.g. `" (Cluster B)"`, including its own leading whitespace), or `''`
   * when the heading carried none. Re-inserted before the colon when the
   * bracket heading is emitted, in the exact slot the real bracket heading
   * grammar accepts one (see LEGACY_PHASE_HEADING_BRACKET_RE's docblock).
   */
  headingTag?: string;
  headingTail?: string;
  hashes?: string;
  /**
   * #4144 round 6 B2: the exact `milestoneSections` range this legacy entry
   * was attributed to (never just its `milestoneInt` — two sections can
   * share the same leading major integer, e.g. `## v2.0` and `## v2.1`, and
   * still be DIFFERENT sections with their own independent legacy
   * numbering). `null`/absent means no section attributed it (single-section
   * or STATE.md-fallback repositories).
   */
  attributedSection?: { start: number; end: number; milestoneInt: number | null } | null;
}

interface BracketMapping {
  lineIndex: number;
  milestoneInt: number;
  token: string;
  source: 'legacy' | 'mnn';
  sourceToken: string;
  /**
   * #4144 round 6 B3: the heading's own display name (`headingTail`, minus
   * its leading colon-separator whitespace), carried through so a directory
   * that structurally matches more than one candidate mapping can be
   * disambiguated by comparing its slug against each candidate's OWN name —
   * never by which candidate happened to be encountered first.
   */
  phaseName: string;
}

const pad2 = (value: number): string => String(value).padStart(2, '0');

/**
 * #4144 round 6 B2/B3: the section-keyed maps below (`sectionLegacyMap`) key
 * on a `milestoneSections` range's own `start` offset, which is always >= 0
 * for a real section. This sentinel covers legacy entries with NO attributed
 * section at all (single-section / STATE.md-fallback repositories), where
 * there is only one bucket to begin with.
 */
const GLOBAL_SECTION_KEY = -1;

/**
 * #4144 round 5 Blocker 4 (Warn): the line indices `parseBracketSourcePhases`
 * must never classify as a heading of any kind because a fenced code block
 * covers them — mirrors the READERS' own fence-awareness (tokenizeHeadings,
 * markdown-sectionizer.cts, used at roadmap-parser.cts:689) via the SAME
 * `scanFencedBlocks` engine, rather than a third fence parser. Both fence
 * delimiter lines themselves are included (harmless: neither is a phase
 * heading), and an unterminated trailing fence covers to the end of the
 * document, matching `scanFencedBlocks`' own EOF-still-open semantics.
 */
function fencedLineIndices(lines: string[]): Set<number> {
  const fenced = new Set<number>();
  for (const block of scanFencedBlocks(lines)) {
    const end = block.closeLineIdx === -1 ? lines.length - 1 : block.closeLineIdx;
    for (let i = block.openLineIdx; i <= end; i++) fenced.add(i);
  }
  return fenced;
}

function parseBracketSourcePhases(lines: string[]): { entries: BracketSourceEntry[]; unparsed: string[] } {
  const results: BracketSourceEntry[] = [];
  // #4698 Blocker 3 (round 2), part (b): every phase-like/bracket-like line
  // this loop could not place into any of the three recognized grammars.
  const unparsed: string[] = [];
  let currentMilestoneInt: number | null = null;
  const fenced = fencedLineIndices(lines);

  for (let i = 0; i < lines.length; i++) {
    if (fenced.has(i)) continue;
    const line = lines[i];
    const milestoneMatch = line.match(MILESTONE_HEADING_RE);
    if (milestoneMatch) {
      currentMilestoneInt = parseInt(milestoneMatch[1], 10);
      continue;
    }

    if (BRACKET_PHASE_HEADING_RE.test(line)) {
      results.push({ lineIndex: i, alreadyMigrated: true });
      continue;
    }

    // M-NN must be tested before legacy. It is a convertible source under
    // bracket, not the terminal convention it is for the legacy migrator.
    const mnnMatch = line.match(MNN_PHASE_HEADING_BRACKET_RE);
    if (mnnMatch) {
      const segments = mnnMatch[2].split('-');
      results.push({
        lineIndex: i,
        alreadyMigrated: false,
        source: 'mnn',
        milestoneInt: parseInt(segments[0], 10),
        sourceToken: mnnMatch[2],
        headingTag: mnnMatch[3] ?? '',
        headingTail: mnnMatch[4],
        hashes: mnnMatch[1],
      });
      continue;
    }

    const legacyMatch = line.match(LEGACY_PHASE_HEADING_BRACKET_RE);
    if (legacyMatch) {
      results.push({
        lineIndex: i,
        alreadyMigrated: false,
        source: 'legacy',
        milestoneInt: currentMilestoneInt,
        sourceToken: legacyMatch[2],
        headingTag: legacyMatch[3] ?? '',
        headingTail: legacyMatch[4],
        hashes: legacyMatch[1],
      });
      continue;
    }

    if (isPhaseLikeHeadingLine(line) || BRACKET_HEADING_LIKE_RE.test(line)) {
      unparsed.push(line);
    }
  }

  return { entries: results, unparsed };
}

/**
 * Resolve bracket target tokens. M-NN sources preserve their integer
 * identity while moving the milestone into the bracket: `2-01` → `01`;
 * `2-04-01` → `04.01`. Legacy phases receive a deterministic per-milestone
 * counter — but #4144 round 5 Blocker 2: a preserved M-NN token is NEVER
 * reassignable, so it must RESERVE its own leading integer segment against
 * that same milestone's legacy counter before any legacy phase is numbered,
 * or the two axes can silently collide (`2-01` preserved as `01` and a
 * later legacy `Phase 3` also counter-assigned `01`, under the same
 * milestone). `lines` is the raw ROADMAP.md source, used only to name each
 * colliding heading verbatim in the refusal below — never to re-derive
 * identity.
 *
 * Two passes, in `entries`' own document order (never re-sorted):
 *   1. Every preserved M-NN entry gets its own deterministic token AND
 *      reserves that token's leading integer segment for its milestone.
 *   2. Every legacy entry gets the next per-milestone counter value pass 1
 *      did not reserve.
 * A generic post-pass then refuses, before any write, if two entries under
 * the same milestone still resolved to the same final token — covering both
 * "two preserved M-NN spellings of the same integer" (`2-01` and `2-1`, both
 * `01`) and any other collision pass 1/2 failed to keep disjoint.
 */
function assignBracketTokens(entries: BracketSourceEntry[], lines: string[]): Map<number, BracketMapping> {
  const mappings = new Map<number, BracketMapping>();

  // Pass 1: preserved M-NN tokens.
  const reservedByMilestone = new Map<number, Set<number>>();
  for (const entry of entries) {
    if (entry.alreadyMigrated || entry.source !== 'mnn') continue;
    if (entry.milestoneInt === null || entry.milestoneInt === undefined) continue;

    const segments = entry.sourceToken!.split('-');
    const token = segments.slice(1).map((segment) => pad2(parseInt(segment, 10))).join('.');
    const leadingReserved = parseInt(segments[1], 10);
    if (!reservedByMilestone.has(entry.milestoneInt)) {
      reservedByMilestone.set(entry.milestoneInt, new Set<number>());
    }
    reservedByMilestone.get(entry.milestoneInt)!.add(leadingReserved);

    mappings.set(entry.lineIndex, {
      lineIndex: entry.lineIndex,
      milestoneInt: entry.milestoneInt,
      token,
      source: 'mnn',
      sourceToken: entry.sourceToken!,
      phaseName: (entry.headingTail ?? '').trim(),
    });
  }

  // Pass 2: legacy phases, walking the next per-milestone counter value that
  // pass 1 did not reserve.
  const nextCandidateByMilestone = new Map<number, number>();
  for (const entry of entries) {
    if (entry.alreadyMigrated || entry.source !== 'legacy') continue;
    if (entry.milestoneInt === null || entry.milestoneInt === undefined) continue;

    const reserved = reservedByMilestone.get(entry.milestoneInt) ?? new Set<number>();
    let candidate = nextCandidateByMilestone.get(entry.milestoneInt) ?? 1;
    while (reserved.has(candidate)) candidate++;
    nextCandidateByMilestone.set(entry.milestoneInt, candidate + 1);

    mappings.set(entry.lineIndex, {
      lineIndex: entry.lineIndex,
      milestoneInt: entry.milestoneInt,
      token: pad2(candidate),
      source: 'legacy',
      sourceToken: entry.sourceToken!,
      phaseName: (entry.headingTail ?? '').trim(),
    });
  }

  const byMilestoneToken = new Map<string, BracketMapping[]>();
  for (const mapping of mappings.values()) {
    const key = `${mapping.milestoneInt}::${mapping.token}`;
    if (!byMilestoneToken.has(key)) byMilestoneToken.set(key, []);
    byMilestoneToken.get(key)!.push(mapping);
  }
  const colliding = [...byMilestoneToken.values()]
    .filter((group) => group.length > 1)
    .flat()
    .sort((a, b) => a.lineIndex - b.lineIndex);
  if (colliding.length > 0) {
    throw new Error(
      'Cannot safely migrate ROADMAP.md to the bracket convention: two phase headings under the same '
      + 'milestone would resolve to the same bracket token. Refusing rather than colliding distinct phase '
      + 'identities:\n'
      + colliding.map((mapping) => `  ${lines[mapping.lineIndex]}`).join('\n'),
    );
  }

  return mappings;
}

/**
 * #4144 round 6 B1: a legacy phase token (raw, as spelled in a `### Phase N:`
 * heading) that the readers' own sentinel classifier (`isSentinelPhaseId`,
 * legacy/bare-leading-int branch — the SAME rule `listAllPhaseDirs` and every
 * phase count already exclude `999.x`/`0.x` sentinels through) treats as a
 * sentinel. Returns the sentinel's own bracket MILESTONE integer (0 or 999)
 * so the caller can attribute the phase to that milestone directly, bypassing
 * whatever `## vN.M` section happens to enclose the heading on disk — under
 * bracket, a sentinel's identity IS the sentinel milestone (`[CODE.999]` /
 * `[CODE.00]`), never the real milestone section it was filed under.
 */
function legacySentinelMilestone(sourceToken: string): number | null {
  if (!isSentinelPhaseId(sourceToken)) return null;
  const match = stripProjectCodePrefix(sourceToken).match(/^0*(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

function asciiInteger(segment: string): number | null {
  if (segment.length === 0) return null;
  for (const character of segment) {
    if (character < '0' || character > '9') return null;
  }
  return parseInt(segment, 10);
}

function legacyLookupKey(token: string): string {
  return String(normalizePhaseName(token)).toLowerCase();
}

/**
 * Return the old directory's slug when it belongs to a mapping, otherwise
 * null. M-NN matching consumes exactly the expected number of numeric fields,
 * so a digit-leading slug remains a slug instead of becoming another identity
 * segment (the ambiguity the bracket convention removes).
 *
 * `matchedToken` is the identity segment(s) exactly AS SPELLED on disk (e.g.
 * "02-04" or "02.1"), distinct from `mapping.sourceToken` (the ROADMAP
 * heading's own spelling, which can differ in zero-padding). #4698 Blocker 3
 * needs this exact on-disk spelling to locate and rename the phase's
 * artifact files, whose filenames are written to match the DIRECTORY, not
 * the heading.
 */
function matchBracketSourceDir(dirName: string, mapping: BracketMapping): { slug: string; matchedToken: string } | null {
  const stripped = stripProjectCodePrefix(dirName);

  if (mapping.source === 'mnn') {
    const expected = mapping.sourceToken.split('-').map((segment) => parseInt(segment, 10));
    const parts = stripped.split('-');
    if (parts.length < expected.length) return null;
    for (let i = 0; i < expected.length; i++) {
      const actual = asciiInteger(parts[i]);
      if (actual === null || actual !== expected[i]) return null;
    }
    return {
      slug: parts.slice(expected.length).join('-'),
      matchedToken: parts.slice(0, expected.length).join('-'),
    };
  }

  const legacyDirMatch = stripped.match(
    new RegExp(`^(${PHASE_NUMBER_TOKEN_SOURCE})(?:-(.*))?$`, 'i'),
  );
  if (!legacyDirMatch) return null;
  if (legacyLookupKey(legacyDirMatch[1]) !== legacyLookupKey(mapping.sourceToken)) return null;
  return { slug: legacyDirMatch[2] ?? '', matchedToken: legacyDirMatch[1] };
}

/**
 * #4698 Blocker 3: a directory rename changes the phase's on-disk token, but
 * the phase-qualified artifact FILENAMES inside it (`03-VERIFICATION.md`,
 * `03-01-PLAN.md`, `03-CONTEXT.md`, `03-RESEARCH.md`, ...) keep spelling the
 * OLD token unless renamed too. `isPhaseArtifact`'s bracket branch
 * (src/phase-id.cts) compares the new bracket directory's own qualified/bare
 * token against each candidate filename and excludes anything that
 * disagrees — so a stale-prefixed artifact silently drops out of
 * bracket-convention reads (verification, plan/summary scans) the moment its
 * directory is renamed. Fix: ask `phaseArtifactTokenSpan`, the reader-owned
 * membership seam, for the exact token span of every ROOT-LEVEL file (never
 * anything inside a nested `plans/` subdirectory — see the docblock note
 * below), then replace exactly that span with the new bracket artifact token
 * while keeping the rest of the filename unchanged.
 *
 * NESTED `plans/` ARTIFACTS ARE OUT OF SCOPE: the #3139 nested layout writes
 * `plans/PLAN-<n>.md` / `plans/SUMMARY-<n>.md` with NO phase-token prefix at
 * all (phase.cts: "pairs a nested `plans/PLAN-01.md`... layout-agnostic" —
 * the phase identity comes from the CONTAINING directory alone). There is
 * nothing to rename there, so this function only ever reads the phase
 * directory's own root entries (`fs.readdirSync` is not recursive), which
 * naturally excludes the `plans/` subdirectory itself (a directory, not a
 * file) without any extra filtering.
 *
 * Collisions are refused HERE, before `computeBracketPlan` returns — the
 * same "refuse before any write" contract every other hard-refusal in this
 * file already follows, so a colliding fixture is caught on dry-run too, not
 * just on apply.
 */
function computeArtifactRenames(
  dirName: string,
  oldDirPath: string,
  sourceToken: string,
  targetToken: string,
): ArtifactRename[] {
  if (!sourceToken || sourceToken === targetToken) return [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(oldDirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const fileNames = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  const renames: ArtifactRename[] = [];
  for (const fileName of fileNames) {
    const tokenSpan = phaseArtifactTokenSpan(fileName, dirName);
    if (tokenSpan === null) continue;
    const newName = fileName.slice(0, tokenSpan.start) + targetToken + fileName.slice(tokenSpan.end);
    if (newName === fileName) continue;
    renames.push({ oldName: fileName, newName });
  }
  if (renames.length === 0) return renames;

  // Refuse before any write: a renamed target must not collide with a file
  // that already has that name and is not itself being renamed away.
  const renamedAway = new Set(renames.map((r) => r.oldName));
  const staticNames = new Set(fileNames.filter((f) => !renamedAway.has(f)));
  const producerByTarget = new Map<string, string>();
  for (const rename of renames) {
    if (staticNames.has(rename.newName)) {
      throw new Error(
        `Cannot rename artifact ${JSON.stringify(rename.oldName)} to ${JSON.stringify(rename.newName)} `
        + `in phase directory ${JSON.stringify(dirName)}: a different file already has that name.`,
      );
    }
    const producer = producerByTarget.get(rename.newName);
    if (producer) {
      throw new Error(
        `Cannot migrate phase artifacts in ${JSON.stringify(dirName)}: both ${JSON.stringify(producer)} `
        + `and ${JSON.stringify(rename.oldName)} would rename to ${JSON.stringify(rename.newName)}.`,
      );
    }
    producerByTarget.set(rename.newName, rename.oldName);
  }

  return renames;
}

/**
 * #4698 Blocker 1 (round 2): a directory rename changes the phase's on-disk
 * token, and `computeArtifactRenames` (above) renames that directory's own
 * artifact FILENAMES to match — but a SIBLING plan file's `depends_on`
 * frontmatter that names one of those renamed files by its OLD
 * phase-qualified id (`depends_on: ["03-01"]`, naming `03-01-PLAN.md`) keeps
 * spelling the OLD token. The real dependency resolver
 * (`computeDependencyLevels`, src/phase.cts) resolves `depends_on` tokens
 * against `RawPlan.id`s derived from THIS SAME PHASE DIRECTORY's own
 * filenames only (`cmdPhasePlanIndex` scans one phase directory at a time) —
 * so once the sibling's filename changes, the stale token matches no plan id
 * in the directory at all, the edge is dropped as "unresolved" (#3427), and
 * the dependent plan fails readiness (`missingEvidence`) even after its
 * predecessor completes — reproducing the reported defect exactly.
 *
 * Fix: derive the old and new plan IDs from the exact artifact-renames plan,
 * then compare each `depends_on` value through `normalizeDependencyToken`,
 * the real resolver's exported case-folding seam. This means the migration
 * rewrites exactly those tokens the resolver considers equal to a renamed
 * plan ID. Bare in-phase short forms and tokens naming other plans remain
 * untouched.
 *
 * `depends_on` is the only frontmatter field THIS function rewrites. It is
 * the only field the real DEPENDENCY resolver reads for cross-plan identity:
 * `parsePlanDocument` (src/plan-document.cts) reads `phase`/`plan` as scalar
 * display fields, never assembling a `<phase>-<NN>` token from them, and a
 * `*-SUMMARY.md`'s own `requires:` block is prose (a human-readable "what
 * this phase needed" list) that `computeDependencyLevels` never parses —
 * rewriting either would touch bytes THAT resolver does not read. `phase:`
 * is a different story for a DIFFERENT reader: `history-digest`
 * (src/commands.cts, `cmdHistoryDigest`) keys phases and decisions by that
 * exact scalar, so a stale `phase:` left at the old token after a
 * renumbering migration files a phase's decisions under a different phase's
 * new identity. `computePhaseFrontmatterRewrites` below is the one that
 * corrects it, on the reader-owned `phaseArtifactTokenSpan` membership this
 * function's own `fileRenames` parameter is built from.
 *
 * NESTED `plans/` ARTIFACTS ARE OUT OF SCOPE, for the identical reason
 * `computeArtifactRenames` excludes them (see that function's docblock): a
 * plain, non-recursive `readdirSync` of the phase directory's root already
 * excludes `plans/`'s contents.
 */
function computeDependsOnRewrites(
  oldDirPath: string,
  sourceToken: string,
  targetToken: string,
  fileRenames: ArtifactRename[],
): DependsOnRewrite[] {
  if (!sourceToken || sourceToken === targetToken) return [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(oldDirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const renameByOldName = new Map(fileRenames.map((r) => [r.oldName, r.newName]));
  const renamedPlanIdByToken = new Map<string, string>();
  const registerDependencyAlias = (oldAlias: string, newAlias: string): void => {
    const comparisonToken = normalizeDependencyToken(oldAlias);
    const existing = renamedPlanIdByToken.get(comparisonToken);
    if (existing !== undefined && existing !== newAlias) {
      throw new Error(
        `Cannot migrate depends_on references in ${JSON.stringify(path.basename(oldDirPath))}: `
        + `renamed plan IDs collide when compared by the dependency resolver.`,
      );
    }
    renamedPlanIdByToken.set(comparisonToken, newAlias);
  };
  for (const rename of fileRenames) {
    // #4144 round 5 follow-up: the plan-scan owner's own root-plan-file test
    // (src/plan-scan.cts), not a private re-derivation of the `-PLAN.md`
    // filename filter — the owner also accepts bare `PLAN.md` and the
    // legacy delimited slug form (`3-PLAN-01-setup.md`), which the old
    // inline `/-PLAN\.md$/i` regex rejected outright, silently skipping any
    // depends_on alias registration for such a plan.
    if (!isRootPlanFile(rename.oldName) || !isRootPlanFile(rename.newName)) continue;
    const oldPlanId = rename.oldName.replace(/-PLAN\.md$/i, '');
    const newPlanId = rename.newName.replace(/-PLAN\.md$/i, '');
    registerDependencyAlias(oldPlanId, newPlanId);

    // #4144 round 5 Blocker 3: the real resolver (computeDependencyLevels /
    // resolveDependencyId, src/phase.cts) also resolves a depends_on token
    // against extractCanonicalPlanId's shorter alias (core-utils.cts) — a
    // plan slugged as `03-01-setup-PLAN.md` is reachable as `03-01` as well
    // as its full id. Index that alias too, mapped to the SAME alias of the
    // renamed file — reusing extractCanonicalPlanId rather than re-deriving
    // it — or a depends_on naming a renamed plan by its canonical alias
    // (instead of its full slugged id) silently stops resolving after the
    // rename.
    registerDependencyAlias(
      extractCanonicalPlanId(rename.oldName),
      extractCanonicalPlanId(rename.newName),
    );
  }

  const rewrites: DependsOnRewrite[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !isRootPlanFile(entry.name)) continue;

    const filePath = path.join(oldDirPath, entry.name);
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }

    let fm: Record<string, unknown>;
    try {
      fm = extractFrontmatter(content, filePath);
    } catch {
      continue;
    }

    // Mirrors parsePlanDocument's own depends_on normalization exactly
    // (src/plan-document.cts) — an array of strings, a single non-empty
    // string coerced to a one-element array, or nothing.
    const rawDeps = fm['depends_on'];
    const deps: string[] | null = Array.isArray(rawDeps)
      ? rawDeps.map(String)
      : typeof rawDeps === 'string' && rawDeps.trim() !== ''
        ? [rawDeps]
        : null;
    if (!deps || deps.length === 0) continue;

    let changed = false;
    const newDeps = deps.map((dep) => {
      const replacement = renamedPlanIdByToken.get(normalizeDependencyToken(dep));
      if (replacement === undefined) return dep;
      changed = true;
      return replacement;
    });
    if (!changed) continue;

    let newContent: string;
    try {
      newContent = spliceFrontmatter(content, { ...fm, depends_on: newDeps });
    } catch (err) {
      // A depends_on value the shared writer cannot faithfully re-serialize
      // must never be silently dropped — refuse before any write, the same
      // contract every other unrepresentable case in this file already
      // follows (e.g. computeArtifactRenames' collision refusal above).
      throw new Error(
        `Cannot rewrite depends_on in ${JSON.stringify(entry.name)} for phase token change `
        + `${JSON.stringify(sourceToken)} -> ${JSON.stringify(targetToken)}: ${(err as Error).message}`,
      );
    }

    rewrites.push({
      oldName: entry.name,
      finalName: renameByOldName.get(entry.name) ?? entry.name,
      from: content,
      to: newContent,
    });
  }

  return rewrites;
}

/**
 * #4144 round 6 (W-phase): a renamed artifact's `phase:` frontmatter scalar
 * keeps spelling the OLD legacy/M-NN token, and `history-digest`
 * (src/commands.cts:547, `const phaseNum = fm['phase'] || dir.split('-')[0]`)
 * keys phases and decisions by that exact field — the field IS used as
 * identity by that reader, contrary to `computeDependsOnRewrites`' own
 * docblock claim above (corrected there). After a renumbering migration, a
 * phase's decisions were filed under whatever OTHER phase's new token
 * happened to collide with its own stale value.
 *
 * Scoped to phase-QUALIFIED artifacts (`phaseArtifactTokenSpan`, the same
 * reader-owned membership predicate `computeArtifactRenames` uses), not
 * every file in the directory — a `phase:` value matching `sourceToken` in
 * ANY spelling the readers accept (`03`, `3`, `02.1` — compared through
 * `legacyLookupKey`, the same equivalence `matchBracketSourceDir` already
 * uses) is rewritten to the phase's own new bracket token, via the same
 * `extractFrontmatter`/`spliceFrontmatter` pair every other frontmatter
 * rewrite in this file uses.
 *
 * `dependsOnRewrites` (already computed for this same directory) is reused
 * rather than re-read: a file needing BOTH a depends_on rewrite and a phase
 * rewrite gets its existing entry's `.to` spliced again in place — one
 * combined write — instead of two independent passes racing to overwrite
 * each other's change at apply time. A file needing only the phase rewrite
 * gets a new entry appended. Returns the merged array in the exact shape
 * `PhaseRename.dependsOnRewrites` already carries, so `applyMigration`'s
 * existing apply/rollback loop needs no changes to consume it.
 */
function computePhaseFrontmatterRewrites(
  oldDirPath: string,
  dirName: string,
  sourceToken: string,
  targetToken: string,
  fileRenames: ArtifactRename[],
  dependsOnRewrites: DependsOnRewrite[],
): DependsOnRewrite[] {
  if (!sourceToken || sourceToken === targetToken) return dependsOnRewrites;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(oldDirPath, { withFileTypes: true });
  } catch {
    return dependsOnRewrites;
  }

  const renameByOldName = new Map(fileRenames.map((r) => [r.oldName, r.newName]));
  const byOldName = new Map(dependsOnRewrites.map((r) => [r.oldName, r]));
  const sourceKey = legacyLookupKey(sourceToken);
  const result = [...dependsOnRewrites];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (phaseArtifactTokenSpan(entry.name, dirName) === null) continue;

    const existing = byOldName.get(entry.name);
    const filePath = path.join(oldDirPath, entry.name);
    let originalContent: string;
    let baseContent: string;
    if (existing) {
      originalContent = existing.from;
      baseContent = existing.to;
    } else {
      try {
        originalContent = fs.readFileSync(filePath, 'utf8');
      } catch {
        continue;
      }
      baseContent = originalContent;
    }

    let fm: Record<string, unknown>;
    try {
      fm = extractFrontmatter(originalContent, filePath);
    } catch {
      continue;
    }
    const rawPhase = fm['phase'];
    if (typeof rawPhase !== 'string' && typeof rawPhase !== 'number') continue;
    if (legacyLookupKey(String(rawPhase)) !== sourceKey) continue;

    let baseFm: Record<string, unknown>;
    try {
      baseFm = extractFrontmatter(baseContent, filePath);
    } catch {
      continue;
    }

    let newContent: string;
    try {
      newContent = spliceFrontmatter(baseContent, { ...baseFm, phase: targetToken });
    } catch (err) {
      // Same refuse-before-any-write contract every other unrepresentable
      // frontmatter rewrite in this file already follows.
      throw new Error(
        `Cannot rewrite phase frontmatter in ${JSON.stringify(entry.name)} for phase token change `
        + `${JSON.stringify(sourceToken)} -> ${JSON.stringify(targetToken)}: ${(err as Error).message}`,
      );
    }

    const finalName = renameByOldName.get(entry.name) ?? entry.name;
    if (existing) {
      existing.to = newContent;
    } else {
      const rewrite: DependsOnRewrite = { oldName: entry.name, finalName, from: originalContent, to: newContent };
      result.push(rewrite);
      byOldName.set(entry.name, rewrite);
    }
  }

  return result;
}

/**
 * #4698 Blocker 2: how many integer identity segments THIS mapping requires
 * a directory to match. An M-NN mapping with more segments (`2-04-01`, a
 * child) is strictly more specific than one with fewer (`2-04`, its parent)
 * — the parent's own match is a textual PREFIX of the child's, so a
 * directory satisfying both must resolve to the more specific (longer)
 * identity, never whichever candidate the resolution loop reaches first.
 * A legacy token is always matched exactly (see `matchBracketSourceDir`'s
 * legacy branch: equality against ONE specific normalized token, never a
 * prefix of another legacy token), so it has no competing specificity of its
 * own to rank — treated as a single segment.
 */
function bracketMappingSpecificity(mapping: BracketMapping): number {
  return mapping.source === 'mnn' ? mapping.sourceToken.split('-').length : 1;
}

function buildBracketDirName(
  projectCode: string,
  mapping: BracketMapping,
  slug: string,
  sourceDir: string,
): string {
  const milestone = pad2(mapping.milestoneInt);
  const [phase, subphase] = mapping.token.split('.');
  if (!slug) return `${projectCode}.${milestone}-${mapping.token}`;
  try {
    return toDir(
      {
        project: projectCode,
        milestone,
        phase,
        ...(subphase ? { subphase } : {}),
      },
      slug,
    );
  } catch (err) {
    throw new Error(
      `Cannot build bracket directory for phase ${JSON.stringify(mapping.sourceToken)} `
      + `from source directory ${JSON.stringify(sourceDir)}: ${(err as Error).message}`,
    );
  }
}

function computeBracketPlan(cwd: string): MigrationPlan {
  const pDir = planningDir(cwd);
  const roadmapPath = path.join(pDir, 'ROADMAP.md');
  const configPath = path.join(pDir, 'config.json');
  const phasesDir = path.join(pDir, 'phases');
  const done: MigrationPlan = {
    alreadyMigrated: true,
    phases: [],
    roadmapEdits: [],
    crossRefEdits: [],
    targetConvention: 'bracket',
  };

  let configData: Record<string, unknown> = {};
  try {
    configData = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  } catch { /* config may not exist */ }

  const projectCode = typeof configData['project_code'] === 'string' && configData['project_code'].length > 0
    ? configData['project_code']
    : null;

  let roadmapContent: string;
  try {
    roadmapContent = fs.readFileSync(roadmapPath, 'utf8');
  } catch {
    throw new Error(`ROADMAP.md not found at ${roadmapPath}`);
  }

  const lines = roadmapContent.split('\n');
  const { entries: parsed, unparsed } = parseBracketSourcePhases(lines);

  // #4698 Blocker 3 (round 2), part (b): a heading that starts like a phase
  // heading (or a bracket-shaped heading) but matched none of the three
  // recognized grammars is never silently skipped — refuse before any write
  // and list every offender verbatim, exactly like refuseMixedRoadmap below
  // does for a textual mix. Checked before the "zero recognized headings"
  // guard: a roadmap with some genuinely recognized headings AND one
  // unparseable phase-like heading is the reported defect's exact shape, and
  // this message is the more actionable of the two for that case.
  if (unparsed.length > 0) {
    throw new Error(
      'Cannot safely migrate ROADMAP.md to the bracket convention: found heading(s) that start like a '
      + 'phase heading but do not match any recognized grammar (legacy "### Phase N: Name", M-NN '
      + '"### Phase M-NN: Name", or bracket "### [CODE.MM] NN: Name" — each optionally followed by a '
      + '"(Tag)" before the colon). Refusing rather than silently skipping them. Unrecognized heading(s):\n'
      + unparsed.map((l) => `  ${l}`).join('\n'),
    );
  }

  // #4698 Blocker 2: an unrecognized or partially-migrated roadmap must
  // refuse outright, never silently return a "successful" empty/partial plan.
  // Bracket is the terminal convention — once config says "bracket", the
  // guard below (`unconverted.length === 0`) short-circuits every later run,
  // so a roadmap this planner failed to fully convert can never be revisited
  // by a corrected re-run unless it is refused now, before any write.
  const alreadyBracket = parsed.filter((entry) => entry.alreadyMigrated);
  const unconverted = parsed.filter((entry) => !entry.alreadyMigrated);

  if (parsed.length === 0) {
    throw new Error(
      'No recognized phase headings found in ROADMAP.md. The bracket migrator recognizes exactly '
      + 'three phase heading shapes: bracket ("### [CODE.MM] NN: Name"), M-NN ("### Phase M-NN: Name"), '
      + 'or legacy ("### Phase N: Name"). Add at least one recognized phase heading, then re-run.',
    );
  }

  const refuseMixedRoadmap = (): never => {
    throw new Error(
      'Cannot safely migrate ROADMAP.md to the bracket convention: it still has unconverted phase '
      + 'headings. Refusing to guess at a partial migration. Unconverted headings:\n'
      + unconverted.map((entry) => `  ${lines[entry.lineIndex]}`).join('\n'),
    );
  };

  // A textual mix (some headings already bracket, others not) is never safe
  // to resume automatically.
  if (alreadyBracket.length > 0 && unconverted.length > 0) refuseMixedRoadmap();

  // Every recognized heading is already bracket text: nothing left to
  // convert, regardless of what config.json's own phase_id_convention says.
  if (unconverted.length === 0) return done;

  // From here, unconverted.length > 0. If config already claims "bracket",
  // it disagrees with the roadmap's own text — the same refusal as the
  // textual mix above, never `done`: a stale/incorrect config value must
  // never hide un-migrated content or make it permanently unreachable.
  if (configData['phase_id_convention'] === 'bracket') refuseMixedRoadmap();

  if (!projectCode) {
    throw new Error(
      'Cannot migrate to the bracket convention without a project_code in .planning/config.json '
      + '(bracket phase IDs are [CODE.MM] NN). Set "project_code" first, then re-run.',
    );
  }
  if (!PROJECT_CODE_RE.test(projectCode)) {
    throw new Error(`Cannot migrate to the bracket convention with invalid project_code ${JSON.stringify(projectCode)}.`);
  }
  const code = projectCode;

  const sourcePhases = unconverted;

  const unrepresentableLegacy = sourcePhases.filter(
    (entry) => entry.source === 'legacy' && !isBracketPhaseTokenRepresentable(entry.sourceToken!),
  );
  if (unrepresentableLegacy.length > 0) {
    throw new Error(
      'Cannot migrate source phase token(s) whose identity axis the bracket grammar cannot represent. '
      + 'Refusing rather than collapsing distinct phase identities:\n'
      + unrepresentableLegacy.map((entry) => `  Phase ${entry.sourceToken}`).join('\n'),
    );
  }

  const lineOffsets: number[] = [];
  let nextLineOffset = 0;
  for (const line of lines) {
    lineOffsets.push(nextLineOffset);
    nextLineOffset += line.length + 1;
  }
  const sections = milestoneSections(roadmapContent) as Array<{
    start: number;
    end: number;
    milestoneInt: number | null;
  }>;
  const sectionsForOffset = (offset: number): typeof sections => sections
    .filter((section) => section.start <= offset && offset < section.end)
    .sort((a, b) => (a.end - a.start) - (b.end - b.start));
  const phaseBearingSections = new Set(
    sourcePhases.flatMap((entry) => sectionsForOffset(lineOffsets[entry.lineIndex] ?? -1)),
  );

  const unattributedLegacy: BracketSourceEntry[] = [];
  for (const entry of sourcePhases) {
    if (entry.source !== 'legacy') continue;
    // #4144 round 6 B1: a legacy sentinel (999.x icebox / 0.x backlog) is
    // NEVER attributed to the enclosing `## vN.M` section — it belongs to
    // its own sentinel milestone regardless of which real milestone section
    // it happens to be filed under on disk.
    const sentinelMilestone = legacySentinelMilestone(entry.sourceToken!);
    if (sentinelMilestone !== null) {
      entry.milestoneInt = sentinelMilestone;
      continue;
    }
    const containing = sectionsForOffset(lineOffsets[entry.lineIndex] ?? -1);
    const attributed = containing.find((section) => section.milestoneInt !== null);
    if (attributed?.milestoneInt !== null && attributed?.milestoneInt !== undefined) {
      entry.milestoneInt = attributed.milestoneInt;
      entry.attributedSection = attributed;
    } else if (phaseBearingSections.size > 1) {
      unattributedLegacy.push(entry);
    }
  }
  if (unattributedLegacy.length > 0) {
    throw new Error(
      'Cannot attribute legacy phase heading(s) to a readable milestone section in a multi-milestone '
      + 'ROADMAP. Refusing rather than applying the current STATE milestone to ambiguous history:\n'
      + unattributedLegacy.map((entry) => `  Phase ${entry.sourceToken}`).join('\n'),
    );
  }

  // Real single-milestone repositories may omit a `## vN.M` heading while
  // carrying project-prefixed phase directories. Resolve those legacy entries
  // from STATE.md instead of silently producing an empty migration plan.
  if (
    phaseBearingSections.size <= 1
    && sourcePhases.some((entry) => entry.source === 'legacy' && entry.milestoneInt == null)
  ) {
    let fallbackMilestone: number | null = null;
    try {
      const state = fs.readFileSync(path.join(pDir, 'STATE.md'), 'utf8');
      const stateMilestone = state.match(/^milestone:\s*v?(\d+)/im);
      if (stateMilestone) fallbackMilestone = parseInt(stateMilestone[1], 10);
    } catch { /* STATE.md may not exist */ }
    if (fallbackMilestone !== null) {
      for (const entry of sourcePhases) {
        if (entry.source === 'legacy' && entry.milestoneInt == null) {
          entry.milestoneInt = fallbackMilestone;
        }
      }
    }
  }

  const unresolvedLegacy = sourcePhases.filter(
    (entry) => entry.source === 'legacy' && entry.milestoneInt == null,
  );
  if (unresolvedLegacy.length > 0) {
    throw new Error(
      'Cannot determine a milestone for legacy phase headings. Add a ## vN.M roadmap heading '
      + 'or a milestone field in .planning/STATE.md, then re-run.',
    );
  }

  // #4144 round 6 B3: the same legacy phase number appearing TWICE within
  // one milestone SECTION (the same granularity B2's checklist attribution
  // uses) is a duplicate identity, not two phases — `assignBracketTokens`'s
  // own per-milestone counter would otherwise silently invent a phantom
  // phase for the second heading (a distinct bracket token backed by no
  // second directory). Refuse before any write rather than guess.
  const legacyBySectionToken = new Map<string, BracketSourceEntry[]>();
  for (const entry of sourcePhases) {
    if (entry.source !== 'legacy') continue;
    if (legacySentinelMilestone(entry.sourceToken!) !== null) continue;
    const sectionKey = entry.attributedSection ? entry.attributedSection.start : GLOBAL_SECTION_KEY;
    const dedupeKey = `${sectionKey}::${legacyLookupKey(entry.sourceToken!)}`;
    if (!legacyBySectionToken.has(dedupeKey)) legacyBySectionToken.set(dedupeKey, []);
    legacyBySectionToken.get(dedupeKey)!.push(entry);
  }
  const duplicateLegacy = [...legacyBySectionToken.values()].filter((group) => group.length > 1).flat();
  if (duplicateLegacy.length > 0) {
    throw new Error(
      'Cannot safely migrate ROADMAP.md to the bracket convention: the same legacy phase number appears '
      + 'more than once in one milestone section. Refusing rather than inventing a phantom phase:\n'
      + duplicateLegacy.map((entry) => `  ${lines[entry.lineIndex]}`).join('\n'),
    );
  }

  const idMapping = assignBracketTokens(sourcePhases, lines);

  // #4144 round 6 B2: keyed by SECTION identity (a section's own `start`
  // offset via `milestoneSections` — the SAME attribution headings use, set
  // on `entry.attributedSection` above), never by `milestoneInt` alone. Two
  // sections can share the same leading major integer (`## v2.0`, `## v2.1`)
  // while each restarts its own legacy phase numbering; a milestoneInt-only
  // key let the later section's token silently overwrite the earlier
  // section's in this same map. `GLOBAL_SECTION_KEY` covers legacy entries
  // with no attributed section at all (single-section / STATE.md-fallback
  // repositories), where there is only one bucket to begin with.
  const sectionLegacyMap = new Map<number, Map<string, { token: string; milestoneInt: number }>>();
  for (const entry of sourcePhases) {
    if (entry.source !== 'legacy') continue;
    const mapping = idMapping.get(entry.lineIndex);
    if (!mapping) continue;
    const sectionKey = entry.attributedSection ? entry.attributedSection.start : GLOBAL_SECTION_KEY;
    if (!sectionLegacyMap.has(sectionKey)) sectionLegacyMap.set(sectionKey, new Map());
    sectionLegacyMap.get(sectionKey)!.set(
      legacyLookupKey(mapping.sourceToken),
      { token: mapping.token, milestoneInt: mapping.milestoneInt },
    );
  }

  const phaseDirListing = listAllPhaseDirs(phasesDir, { includeSentinels: true });
  if (phaseDirListing.scope === SCOPE.UNREADABLE) {
    throw new Error(`Cannot read phase directories at ${phasesDir}`);
  }
  const existingDirs = phaseDirListing.value;

  // #4144 round 7 W1: derive the comparison slug the EXACT way the harness
  // derives a DIRECTORY's own slug — never a bespoke unlimited-length
  // slugify. `phase insert` writes "(INSERTED)" into the HEADING text
  // (phase.cts) but never into the directory it creates (its slug comes
  // from the bare `description`, which never carries the marker) — the
  // same marker `roadmap.cts:494` strips before slugifying a heading name
  // for its own comparisons. And `init`/`phase add` truncate at
  // `generateSlugInternal`'s own default maxLen (60 — init.cts:1190/:2284),
  // never `null` (unlimited). Comparing under a DIFFERENT rule than the one
  // that created the directory refused two-milestone roadmaps the
  // tooling's own commands produced.
  const slugify = (text: string): string => (
    coreUtilsMod.generateSlugInternal(text.replace(/\(INSERTED\)/i, '').trim()) ?? ''
  );

  // #4144 round 7 W2, corrected round 8 B1: a plan-level ambiguity check
  // that runs BEFORE the resolution loop below and never touches its
  // (unmodified, round-6) algorithm. For every directory that structurally
  // ties with more than one candidate at its own best specificity, group
  // directories by the EXACT set of candidates they tie with — two
  // directories tying with the identical candidate set are contesting the
  // identical pool — and refuse ONLY when that group's directory count
  // EXCEEDS its candidate count. A stale duplicate-number directory sorting
  // between two real ones (e.g. `01-gamma`, `01-gamma-old`, `01-zeta`, all
  // three tying with {Zeta, Gamma}) is exactly this: 3 directories for 2
  // candidates. Left unchecked, the resolution loop's own "only one
  // candidate left" shortcut (used when a directory's tie has already
  // shrunk to a single remaining candidate) accepts whichever directory is
  // visited LAST in that group WITHOUT ever verifying its slug — silently
  // dropping the true match for the other leftover directory from the plan.
  //
  // round 8 B1: the round-7 condition (`dirs.length !== mappingLines.length`)
  // over-refused — it also caught the far MORE common shape where a tie
  // group has FEWER directories than candidates: a later milestone that
  // reuses a legacy number but is only planned (no directory yet), an
  // archived `<details>` milestone whose directory was already cleaned up,
  // or a decimal insert whose sibling milestone has no directory at all.
  // That shape is never the silent-drop hazard above: the depletion loop
  // below only ever drops a directory WITHOUT a slug check when a tie group
  // has MORE directories than unused candidates (a directory visited with no
  // unused candidate left just falls through its own `if (tied.length === 0)
  // continue`, below). With fewer (or equal) directories than candidates,
  // every directory the loop below visits is either resolved by its own
  // slug comparison or refused loudly on its own — a BALANCED group (equal
  // counts — e.g. exactly `01-gamma`/`01-zeta` tying with {Zeta, Gamma}) is
  // one instance of this and is left entirely to the resolution loop below,
  // unchanged: that loop's own slug-driven, elimination-assisted pairing
  // already resolves a balanced group correctly (round 6 B3), including a
  // directory whose own slug is a paraphrase of its phase's name rather than
  // an exact match. So the safe pre-check condition is `dirs > candidates`,
  // never `dirs !== candidates` — this check only catches a genuine
  // directory-count SURPLUS, never a deficit and never re-litigates a
  // balanced pairing.
  // #4144 round 8 W2: for every directory that was ever part of a
  // multi-directory tie group (2+ directories structurally contesting the
  // identical candidate set — a duplicate/stale legacy-number directory
  // sharing the tree with the real one), record the group's directory
  // count here. The resolution loop below consults this to decide whether
  // its own "single remaining candidate" shortcut may skip the slug check:
  // it may only do so for a directory that was NEVER part of such a group
  // (group size 1 — an ordinary, unambiguous structural match, including one
  // whose own slug paraphrases its phase's name rather than matching it
  // exactly, round 6 B3's r4e case). A directory that WAS part of a
  // multi-directory group must still pass the slug check even once
  // elimination has narrowed it down to a single remaining candidate,
  // because elimination alone cannot tell a stale duplicate from the real
  // directory (see W2 below).
  const dirTieGroupSize = new Map<string, number>();
  {
    const allMappings = [...idMapping.values()];
    const ambiguityGroups = new Map<string, { dirs: string[]; mappingLines: number[] }>();
    for (const dirName of existingDirs) {
      let bestSpecificity = -1;
      let tied: BracketMapping[] = [];
      for (const mapping of allMappings) {
        if (!matchBracketSourceDir(dirName, mapping)) continue;
        const specificity = bracketMappingSpecificity(mapping);
        if (specificity > bestSpecificity) {
          bestSpecificity = specificity;
          tied = [mapping];
        } else if (specificity === bestSpecificity) {
          tied.push(mapping);
        }
      }
      if (tied.length <= 1) continue;
      const groupKey = tied.map((mapping) => mapping.lineIndex).sort((a, b) => a - b).join(',');
      if (!ambiguityGroups.has(groupKey)) {
        ambiguityGroups.set(groupKey, { dirs: [], mappingLines: tied.map((mapping) => mapping.lineIndex) });
      }
      ambiguityGroups.get(groupKey)!.dirs.push(dirName);
    }
    for (const group of ambiguityGroups.values()) {
      // round 8 B1: only a directory SURPLUS is the silent-drop hazard this
      // check exists for; fewer (or exactly as many) directories than
      // candidates is left to the slug-driven resolution loop below.
      if (group.dirs.length > group.mappingLines.length) {
        throw new Error(
          'Cannot safely migrate ROADMAP.md to the bracket convention: '
          + `${group.dirs.length} phase director${group.dirs.length === 1 ? 'y' : 'ies'} `
          + `(${group.dirs.map((dir) => JSON.stringify(dir)).join(', ')}) tie with the same `
          + `${group.mappingLines.length} candidate phase heading(s) — an unresolvable count mismatch. `
          + 'Refusing rather than silently dropping a real directory from the plan:\n'
          + group.mappingLines.map((lineIndex) => `  ${lines[lineIndex]}`).join('\n'),
        );
      }
      for (const dir of group.dirs) dirTieGroupSize.set(dir, group.dirs.length);
    }
  }

  const orderedMappings = [...idMapping.values()].map((mapping) => ({ mapping, used: false }));
  const phases: PhaseRename[] = [];
  for (const dirName of existingDirs) {
    // #4698 Blocker 2: scan EVERY still-unused candidate and keep the MOST
    // SPECIFIC match (the one requiring the most integer segments), rather
    // than stopping at the first one found. A parent M-NN mapping is a
    // prefix of its own child's mapping and matches the child's directory
    // just as readily as the child's own mapping does — resolving on
    // encounter order let a parent heading that happens to precede its
    // child's heading claim the child's directory, leaving the true parent
    // unmapped. Specificity is independent of both roadmap-heading order and
    // directory-listing order, so this resolves correctly regardless of
    // which directory this loop visits first.
    //
    // #4144 round 6 B3: more than one candidate can tie at the SAME best
    // specificity — e.g. the identical legacy number "1" under two different
    // milestones (`## v1.0` Zeta, `## v2.0` Gamma) both structurally match a
    // directory named after either one, since `matchBracketSourceDir`'s
    // legacy branch does not know about milestones. Collect every tie rather
    // than keeping only the first-encountered one, then disambiguate by
    // comparing the directory's OWN slug against each candidate's phase name
    // slugified the same way `toDir` sanitizes one; exactly one match wins.
    //
    // #4144 round 7 W2, corrected round 8 W2: the plan-level check above
    // already refuses a genuine cardinality mismatch (more directories than
    // candidates in a shared tie group), so by the time this loop runs, any
    // directory whose tie shrinks to exactly one still-unused candidate
    // belongs to a group with dirs <= candidates. That is NOT the same as
    // saying the remaining candidate is automatically correct: in a
    // BALANCED group (dirs === candidates, e.g. exactly two real
    // directories for two real phases) it usually is, because every
    // directory in that group is claimed by its own true match in turn —
    // but when a stale duplicate-number directory is among them (`01-alpha`
    // / `01-alpha-old` both tying with {Alpha, Beta}), the real directory
    // claims its own phase by slug first and the stale leftover would
    // otherwise be handed the other phase by elimination alone, with no
    // slug agreement ever checked. See `dirTieGroupSize` below: a directory
    // that was never part of a multi-directory tie group may still skip
    // straight to its sole match with no check at all (there is no sibling
    // to confuse it with); one that WAS still gets a (prefix-tolerant, not
    // exact) sanity check against the sole remaining candidate.
    let bestSpecificity = -1;
    let tied: Array<{ candidate: (typeof orderedMappings)[number]; match: { slug: string; matchedToken: string } }> = [];
    for (const candidate of orderedMappings) {
      if (candidate.used) continue;
      const match = matchBracketSourceDir(dirName, candidate.mapping);
      if (!match) continue;
      const specificity = bracketMappingSpecificity(candidate.mapping);
      if (specificity > bestSpecificity) {
        bestSpecificity = specificity;
        tied = [{ candidate, match }];
      } else if (specificity === bestSpecificity) {
        tied.push({ candidate, match });
      }
    }
    if (tied.length === 0) continue;

    let winner = tied[0];
    if (tied.length > 1) {
      const dirSlug = slugify(tied[0].match.slug);
      const bySlug = tied.filter((entry) => slugify(entry.candidate.mapping.phaseName) === dirSlug);
      if (bySlug.length !== 1) {
        throw new Error(
          `Cannot resolve phase directory ${JSON.stringify(dirName)}: it matches ${tied.length} candidate `
          + `phase heading(s) with the same specificity and ${bySlug.length === 0 ? 'none of them' : 'more than one of them'} `
          + 'share its slug. Refusing rather than guessing which phase it identifies:\n'
          + tied.map((entry) => `  ${lines[entry.candidate.mapping.lineIndex]}`).join('\n'),
        );
      }
      winner = bySlug[0];
    } else if ((dirTieGroupSize.get(dirName) ?? 1) > 1) {
      // #4144 round 8 W2: exactly one unused candidate remains for this
      // directory, but it was reached by ELIMINATION out of a
      // multi-directory tie group (another directory shares its legacy
      // number) — the round-6 depletion loop accepted whichever directory
      // is visited LAST in such a group without ever checking its slug,
      // which is exactly how a stale duplicate-number directory (`01-alpha`
      // / `01-alpha-old`, both tying with {Alpha, Beta}) ends up claiming
      // the OTHER real phase once the real directory has already claimed
      // its own. A directory's own slug is often an abbreviation of the
      // full phase name rather than an exact match (round 6 B3's r4e: dir
      // `01-zeta` for phase "Zeta - the return"), so this check is
      // prefix-tolerant in either direction rather than requiring exact
      // equality — but a slug that shares NO relation at all to the sole
      // remaining candidate (c2: "alpha-old" vs "beta") is refused rather
      // than silently handed a phase it never named.
      const dirSlug = slugify(tied[0].match.slug);
      const candidateSlug = slugify(tied[0].candidate.mapping.phaseName);
      const agrees = candidateSlug.startsWith(dirSlug) || dirSlug.startsWith(candidateSlug);
      if (!agrees) {
        throw new Error(
          `Cannot resolve phase directory ${JSON.stringify(dirName)}: another directory sharing its legacy `
          + 'number already claimed a different phase, and this directory\'s own slug shares no relation to '
          + 'the one remaining candidate phase heading. Refusing rather than guessing which phase it '
          + 'identifies:\n'
          + `  ${lines[tied[0].candidate.mapping.lineIndex]}`,
        );
      }
    }
    winner.candidate.used = true;
    const hit = winner.candidate;
    const matchedSlug = winner.match.slug;
    const matchedToken = winner.match.matchedToken;

    const newDir = buildBracketDirName(code, hit.mapping, matchedSlug, dirName);
    if (newDir !== dirName) {
      const oldDirPath = path.join(phasesDir, dirName);
      // #4698 Blocker 3: rename this directory's own phase-qualified
      // artifacts (computed against the OLD path — nothing has moved yet,
      // this is still plan computation) so they keep matching their
      // phase's new bracket token after the directory itself is renamed.
      const fileRenames = computeArtifactRenames(dirName, oldDirPath, matchedToken, hit.mapping.token);
      // #4698 Blocker 1 (round 2): rewrite depends_on references (in this
      // same directory's own *-PLAN.md files) that name a sibling by the
      // OLD token — see computeDependsOnRewrites' docblock. Also computed
      // against the OLD path; nothing has moved yet.
      const dependsOnRewrites = computeDependsOnRewrites(oldDirPath, matchedToken, hit.mapping.token, fileRenames);
      phases.push({
        oldId: hit.mapping.sourceToken,
        newId: `${code}.${pad2(hit.mapping.milestoneInt)}-${hit.mapping.token}`,
        oldDir: dirName,
        newDir,
        fileRenames,
        // #4144 round 6 (W-phase): also rewrite any renamed artifact's
        // `phase:` frontmatter scalar that still spells the OLD token — see
        // computePhaseFrontmatterRewrites' docblock. Combined with the
        // depends_on rewrites above (not a second independent write) so a
        // file needing both never has one silently clobber the other.
        dependsOnRewrites: computePhaseFrontmatterRewrites(
          oldDirPath, dirName, matchedToken, hit.mapping.token, fileRenames, dependsOnRewrites,
        ),
      });
    }
  }

  // #4144 round 6 (W-collision): the plan never checked that a TARGET
  // directory name was free, so a dry-run reported a clean plan `apply`
  // could not perform (a pre-existing NON-EMPTY target fails mid-apply with
  // ENOTEMPTY, rollback restores) or silently REPLACED (a pre-existing EMPTY
  // target — POSIX rename semantics). Every other collision class in this
  // file (artifact renames above, token collisions in assignBracketTokens,
  // depends_on aliases) is refused at PLAN time; this closes the one
  // remaining seam left to apply. A target occupied by another directory
  // THIS SAME PLAN is also renaming away is not a collision — that directory
  // vacates the name as part of this same migration.
  const renamedOldDirs = new Set(phases.map((rename) => rename.oldDir));
  for (const rename of phases) {
    if (renamedOldDirs.has(rename.newDir)) continue;
    if (fs.existsSync(path.join(phasesDir, rename.newDir))) {
      throw new Error(
        `Cannot migrate phase directory ${JSON.stringify(rename.oldDir)} to ${JSON.stringify(rename.newDir)}: `
        + 'a directory already exists at that path and is not itself part of this migration. Refusing '
        + 'rather than overwriting or colliding with it at apply time.',
      );
    }
  }

  const roadmapEdits: RoadmapEdit[] = [];
  for (const entry of sourcePhases) {
    const mapping = idMapping.get(entry.lineIndex);
    if (!mapping) continue;
    const oldLine = lines[entry.lineIndex];
    // #4698 Blocker 3 (round 2): the tag (if any) is re-inserted right after
    // the phase token and before the colon — the exact slot the real bracket
    // heading grammar accepts one in (see LEGACY_PHASE_HEADING_BRACKET_RE's
    // docblock).
    const heading = `${entry.hashes} [${code}.${pad2(mapping.milestoneInt)}] ${mapping.token}${entry.headingTag ?? ''}:`;
    const newLine = heading + (entry.headingTail ?? '');
    if (newLine !== oldLine) {
      roadmapEdits.push({ lineIndex: entry.lineIndex, from: oldLine, to: newLine });
    }
  }

  // #4144 round 6 B4: the READERS' own checklist grammar
  // (`src/roadmap.cts`'s `cmdRoadmapAnalyze checklistPattern`, the exact
  // scan `missing_phase_details` is computed from) requires a bold `**`
  // immediately before the `Phase` label and — unlike the previous regex
  // here — never requires a colon anywhere after the token:
  // `- [ ] **Phase 7** - Eta` and `- [x] **Phase 8**: Theta` are both real
  // phase references to it. A colon-requiring copy left such bullets
  // byte-identical while their headings converted, so a "done" migration
  // reported them missing (`missing_phase_details`). This migrator keeps its
  // own long-standing OPTIONAL-bold tolerance (`\*{0,2}` — a plain,
  // non-bold `- [x] Phase 3: Gamma` has converted since round 1 and must
  // keep doing so), so the actual fix is dropping the colon requirement, not
  // narrowing to bold-only: the "Phase " intro comes from the shared
  // `phaseHeadingPrefixSrcFor` selector (never a second copy of that text),
  // and the bullet/checkbox/bold-open prefix is its own capture group
  // (group 1) — the "Phase " intro text itself is matched but deliberately
  // left OUT of any group, since the bracket form drops the word "Phase"
  // entirely. The token and optional tag are captured here, and the REST OF
  // THE LINE — bold close, tag, separator, colon, whatever follows — is
  // preserved verbatim via `line.slice(match[0].length)` below, never
  // reconstructed.
  // #4144 round 7 W3: `[-*]`, not a literal `-` — the same list-marker class
  // `BULLET_PHASE_LINE_PATTERN` (roadmap-parser.cts:1446, the scanner
  // `scanMilestonePhaseIds` uses) already accepts. A `* [ ] **Phase 1: …**`
  // bullet stayed legacy after an otherwise-done migration, so the
  // bracket-mode milestone id set carried the stale legacy token alongside
  // the bracket ones.
  const CHECKLIST_BULLET_PREFIX_SRC = '[-*]\\s*\\[[ x]\\]\\s*\\*{0,2}';
  const CHECKLIST_PHASE_INTRO_SRC = phaseHeadingPrefixSrcFor(PHASE_HEADING_BASELINE.LABEL_ONLY, undefined, true);
  const mnnChecklistRe = new RegExp(
    `^(\\s*${CHECKLIST_BULLET_PREFIX_SRC})${CHECKLIST_PHASE_INTRO_SRC}(${MNN_SOURCE_TOKEN_SOURCE})(${OPTIONAL_PHASE_TAG_SOURCE})`,
    'i',
  );
  const legacyChecklistRe = new RegExp(
    `^(\\s*${CHECKLIST_BULLET_PREFIX_SRC})${CHECKLIST_PHASE_INTRO_SRC}(${PHASE_NUMBER_TOKEN_SOURCE})(${OPTIONAL_PHASE_TAG_SOURCE})`,
    'i',
  );

  // #4144 round 8 I1: `legacyChecklistRe` above requires nothing at all
  // after the number/tag — deliberately, since Tier 1 (reader-recognized,
  // `isReaderRecognizedBullet` below) must match exactly what the readers'
  // own grammar matches, and neither `roadmap.cts:770`'s checklistPattern
  // nor `phase.cts`'s heading branch require a boundary there either (a
  // bold `**Phase 1-on-1 meetings**` is read by every reader as naming
  // phase 1, trailing text and all — narrowing the MATCH itself would
  // silently un-recognize exactly the reader-recognized bullets round 6 B4
  // exists to keep converting). Tier 2 (this migrator's own wider,
  // non-bold tolerance) has no such reader grammar to mirror, so it applies
  // its own separate, narrower boundary check below: mirroring
  // `phase.cts:4358-4361`'s checkbox-branch separator (colon/em-dash/
  // en-dash/hyphen) and `BULLET_PHASE_LINE_PATTERN`'s dash family rather
  // than inventing a fourth grammar, plus the ordinary "end of a plain
  // word" case a bare-prose to-do bullet needs (`Phase 2 retrospective`).
  // Without it, Tier 2 renumbered prose that merely STARTS WITH a phase
  // number and continues as a hyphenated compound word, e.g. `Phase
  // 1-on-1 meetings` -> `[GSD.01] 01-on-1 meetings` — the hyphen glued
  // directly onto the number with no separating whitespace is the one shape
  // every boundary alternative below rejects; a colon/dash preceded by
  // whitespace (or attached directly, for colon/em-dash/en-dash only, the
  // same tolerance the heading and bullet-line grammars already give those
  // three), a bold-close `**`, end of line, or whitespace before an
  // ordinary (non-hyphen) word all still pass.
  const TIER2_TOKEN_BOUNDARY_RE = /^(?:\s*[:—–]|\s+-|\*\*|$|\s+[^\s-])/;

  // #4144 round 6 (C-fence): fence handling was heading-only —
  // parseBracketSourcePhases skips fenced lines via `fencedLineIndices`
  // (round 5 W4), but this checklist loop walked raw `lines` with no fence
  // awareness at all, so a checklist bullet inside a fenced EXAMPLE block
  // was still rewritten. Same engine, same "never a phase heading/bullet of
  // any kind inside a fence" rule the heading parse already follows.
  const fencedChecklistLines = fencedLineIndices(lines);

  for (let i = 0; i < lines.length; i++) {
    if (fencedChecklistLines.has(i)) continue;
    const line = lines[i];
    if (MILESTONE_HEADING_RE.test(line)) continue;
    if (roadmapEdits.some((edit) => edit.lineIndex === i)) continue;

    const mnnChecklist = line.match(mnnChecklistRe);
    if (mnnChecklist) {
      const segments = mnnChecklist[2].split('-');
      const milestone = parseInt(segments[0], 10);
      const token = segments.slice(1).map((segment) => pad2(parseInt(segment, 10))).join('.');
      const replacement = `${mnnChecklist[1]}[${code}.${pad2(milestone)}] ${token}${mnnChecklist[3]}`;
      roadmapEdits.push({
        lineIndex: i,
        from: line,
        to: replacement + line.slice(mnnChecklist[0].length),
      });
      continue;
    }

    const legacyChecklist = line.match(legacyChecklistRe);
    if (!legacyChecklist) continue;
    const key = legacyLookupKey(legacyChecklist[2]);
    // #4144 round 7 B2: the READERS' own checklist grammar
    // (`src/roadmap.cts` checklistPattern, the exact scan
    // `missing_phase_details` is computed from) requires an EXACT bold `**`
    // immediately before the `Phase` label. This migrator's own
    // long-standing tolerance additionally accepts 0 or 1 asterisks
    // (`\*{0,2}` in CHECKLIST_BULLET_PREFIX_SRC above) — captured group 1
    // therefore ends in `**` if and only if the bullet is the exact shape a
    // reader recognizes. A bullet the readers recognize that cannot be
    // attributed to any converted phase is a genuine partial-conversion
    // hazard and must refuse; a bullet only THIS migrator's wider tolerance
    // matches is not a phase reference to any reader — converted when it
    // resolves (keeps the long-standing non-bold conversion case green),
    // left byte-identical rather than refused when it does not.
    const isReaderRecognizedBullet = /\*\*$/.test(legacyChecklist[1]);
    // #4144 round 8 I1: Tier 2 additionally requires a token boundary right
    // after the number/tag (see `TIER2_TOKEN_BOUNDARY_RE` above) — Tier 1
    // never does, since narrowing the shared match itself would silently
    // un-recognize a bold bullet the readers' own ungated grammar still
    // reads as naming that phase. A Tier-2 bullet that fails the boundary
    // (`- [ ] Phase 1-on-1 meetings`) is treated exactly like one no reader
    // recognizes at all: left byte-identical, never resolved or refused.
    if (!isReaderRecognizedBullet && !TIER2_TOKEN_BOUNDARY_RE.test(line.slice(legacyChecklist[0].length))) {
      continue;
    }
    let resolved: { token: string; milestoneInt: number } | undefined;
    // #4144 round 7 B1: a checklist bullet naming a SENTINEL phase (999.x
    // icebox / 0.x backlog) bypasses section attribution entirely — the same
    // rule the HEADING side already applies via `legacySentinelMilestone`
    // (consulted before `entry.attributedSection` is ever set, above).
    // Sentinel entries are always filed under GLOBAL_SECTION_KEY (never
    // `attributedSection`, since the milestone-attribution loop `continue`s
    // past that assignment for a sentinel), so a sentinel bullet must be
    // looked up there directly — never in whichever real `## vN.M` section
    // its own line happens to sit inside on disk (nothing stops an author
    // from listing an icebox item next to the real phases it is scheduled
    // near).
    const bulletSentinelMilestone = legacySentinelMilestone(legacyChecklist[2]);
    if (bulletSentinelMilestone !== null) {
      resolved = sectionLegacyMap.get(GLOBAL_SECTION_KEY)?.get(key);
    } else {
      // #4144 round 6 B2: a bullet INSIDE a specific milestone section is
      // attributed to THAT section alone — never a different section that
      // happens to share the same leading major integer.
      const bulletSection = sectionsForOffset(lineOffsets[i] ?? -1)
        .find((section) => section.milestoneInt !== null) ?? null;
      if (bulletSection) {
        resolved = sectionLegacyMap.get(bulletSection.start)?.get(key);
      } else {
        // #4144 round 8 B2 (was round 7 B2): outside every section, a
        // checklist bullet resolves the way round 6 did, for EITHER tier —
        // first against the no-section bucket itself (an exact,
        // unambiguous per-key lookup: entries with no attributed section,
        // such as an entire roadmap derived from a single STATE.md fallback
        // milestone with no `## vN.M` headings at all, are filed here), and
        // only when that bucket does not define the token, against the
        // unique candidate across every bucket. Round 7 gated this whole
        // lookup on `isReaderRecognizedBullet`, so a non-bold (Tier 2)
        // bullet outside every section was never resolved at all — on the
        // committed project-prefixed-single-milestone fixture (no sections,
        // everything filed under the no-section bucket) that left
        // `- [ ] Phase 1: Intake` / `- [ ] Phase 2: Delivery` legacy after
        // an otherwise-"done" migration.
        resolved = sectionLegacyMap.get(GLOBAL_SECTION_KEY)?.get(key);
        if (!resolved) {
          const candidates: Array<{ token: string; milestoneInt: number }> = [];
          for (const lookup of sectionLegacyMap.values()) {
            const candidate = lookup.get(key);
            if (candidate) candidates.push(candidate);
          }
          if (candidates.length > 1) {
            // #4144 round 8 B2: only a bullet the readers themselves
            // recognize as a phase reference can turn this ambiguity into a
            // refusal — Tier 2's own wider tolerance leaves it byte-identical
            // instead (the `!resolved` branch below), never guessing and
            // never blocking the whole migration over a to-do bullet no
            // reader was ever going to check.
            if (isReaderRecognizedBullet) {
              throw new Error(
                'Cannot safely migrate ROADMAP.md to the bracket convention: a checklist bullet outside every '
                + 'milestone section names a legacy phase number that more than one milestone section defines. '
                + 'Refusing rather than guessing which phase it means:\n'
                + `  ${line}`,
              );
            }
          } else {
            resolved = candidates[0];
          }
        }
      }
    }
    if (!resolved) {
      if (bulletSentinelMilestone !== null) {
        // #4144 round 8 W1: a sentinel bullet (999.x icebox / 0.x backlog)
        // with no converted sentinel phase to resolve to — e.g. an icebox
        // item with no matching `### Phase 999.x:` heading anywhere — is
        // left byte-identical rather than refused. `roadmap analyze`
        // deliberately excludes sentinel checklist entries from
        // `missing_phase_details` (roadmap.cts:795-798, `!isSentinelPhase`),
        // so the "a reader would report it missing" rationale the Tier-1
        // refusal below exists for does not apply here: every reader still
        // classifies the unconverted line as sentinel under bracket too
        // (its checklist grammar captures no bracket id, and
        // `isSentinelPhaseId` falls back to the same bare-999/0.x rule
        // whether or not the line converted).
        continue;
      }
      if (!isReaderRecognizedBullet) {
        // #4144 round 7 B2: no reader treats this bullet as a phase
        // reference (roadmap.cts:770 requires bold, roadmap-parser.cts:1446
        // requires `**Phase`, phase.cts's checkbox branch requires a
        // separator after the token) — there is nothing for a "done"
        // migration to have missed. Left byte-identical, never refused.
        continue;
      }
      // #4144 round 6 B4: the readers' own grammar recognizes this bullet as
      // a phase reference (mnnChecklistRe/legacyChecklistRe just matched
      // it), but this migrator could not attribute it to any converted
      // phase. Leaving it byte-identical would stamp the migration done
      // while a reader-recognized checklist entry stays unconverted —
      // refuse before any write instead, naming the bullet.
      throw new Error(
        'Cannot safely migrate ROADMAP.md to the bracket convention: a checklist bullet the readers '
        + 'recognize as a phase reference could not be attributed to any converted phase. Refusing rather '
        + 'than leaving it unconverted in an otherwise-migrated roadmap:\n'
        + `  ${line}`,
      );
    }
    const replacement = `${legacyChecklist[1]}[${code}.${pad2(resolved.milestoneInt)}] ${resolved.token}`
      + `${legacyChecklist[3]}`;
    roadmapEdits.push({
      lineIndex: i,
      from: line,
      to: replacement + line.slice(legacyChecklist[0].length),
    });
  }

  // Bare STATE.md / PROJECT.md `Phase N` prose carries no milestone context in
  // multi-milestone repositories. That emit concern remains deferred; guessing
  // here would recreate the ambiguity this migration removes.
  const crossRefEdits: CrossRefEdit[] = [];

  return {
    alreadyMigrated: false,
    phases,
    roadmapEdits,
    crossRefEdits,
    targetConvention: 'bracket',
  };
}

// ─── computeMigrationPlan ─────────────────────────────────────────────────────

/**
 * Compute a migration plan without touching the filesystem.
 */
function computeMigrationPlan(cwd: string, options: Record<string, unknown> = {}): MigrationPlan {
  if (options['convention'] === 'bracket') return computeBracketPlan(cwd);
  const pDir = planningDir(cwd);
  const roadmapPath = path.join(pDir, 'ROADMAP.md');
  const configPath = path.join(pDir, 'config.json');
  const phasesDir = path.join(pDir, 'phases');

  // ── Check config for existing convention ─────────────────────────────────
  let configData: Record<string, unknown> = {};
  try {
    configData = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  } catch { /* config may not exist */ }

  if (configData['phase_id_convention'] === 'milestone-prefixed') {
    return { alreadyMigrated: true, phases: [], roadmapEdits: [], crossRefEdits: [] };
  }

  const projectCode = typeof configData['project_code'] === 'string' ? configData['project_code'] : null;

  // ── Read ROADMAP.md ───────────────────────────────────────────────────────
  let roadmapContent = '';
  try {
    roadmapContent = fs.readFileSync(roadmapPath, 'utf8');
  } catch {
    throw new Error(`ROADMAP.md not found at ${roadmapPath}`);
  }

  const lines = roadmapContent.split('\n');
  const parsedPhases = parseRoadmapPhases(lines);

  // Check for any already-migrated headings
  const hasAnyMigrated = parsedPhases.some(e => e.alreadyMigrated);
  if (hasAnyMigrated) {
    return { alreadyMigrated: true, phases: [], roadmapEdits: [], crossRefEdits: [] };
  }

  const legacyPhases = parsedPhases.filter(e => !e.alreadyMigrated);
  const idMapping = assignSubIndices(legacyPhases);

  // Secondary lookup: (milestoneInt, normalizedLegacyNum) → newId
  // Used for directory renames and checklist rewrites where line position is unknown.
  // For simplicity, each milestone gets its own Map from legacy num → newId.
  const milestoneIdMap = new Map<number, Map<string, string>>(); // milestoneInt → Map<normalizedLegacyNum, newId>
  for (const [, entry] of idMapping) {
    if (!milestoneIdMap.has(entry.milestoneInt)) {
      milestoneIdMap.set(entry.milestoneInt, new Map<string, string>());
    }
    const mMap = milestoneIdMap.get(entry.milestoneInt)!;
    const legacyNum = entry.legacyPhaseNum;
    // Register integer forms (covers plain numeric and letter-suffix IDs)
    const intPart = parseInt(legacyNum, 10);
    const paddedLegacy = String(intPart).padStart(2, '0');
    const unpaddedLegacy = String(intPart);
    mMap.set(paddedLegacy, entry.newId);
    mMap.set(unpaddedLegacy, entry.newId);
    // Also register the original form and padded-integer+decimal form
    // so decimal IDs like "2.1" / "02.1" round-trip correctly.
    mMap.set(legacyNum, entry.newId);
    const dotIdx = legacyNum.indexOf('.');
    if (dotIdx !== -1) {
      const decimalSuffix = legacyNum.slice(dotIdx); // e.g. ".1"
      mMap.set(paddedLegacy + decimalSuffix, entry.newId);
      mMap.set(unpaddedLegacy + decimalSuffix, entry.newId);
    }
  }

  // ── Read existing phase directories ───────────────────────────────────────
  let existingDirs: string[] = [];
  try {
    existingDirs = fs.readdirSync(phasesDir).filter(d => {
      try {
        return fs.statSync(path.join(phasesDir, d)).isDirectory();
      } catch { return false; }
    });
  } catch { /* phases dir may not exist */ }

  // ── Build phase rename pairs ───────────────────────────────────────────────
  // Flat ordered list of (legacyPhaseNum, newId) in ROADMAP order, for dir matching.
  const orderedMappings = [...idMapping.values()].map(e => ({
    legacyPhaseNum: e.legacyPhaseNum,
    newId: e.newId,
    milestoneInt: e.milestoneInt,
    _used: false,
  }));

  // Note: if the same legacy phase number appears in multiple milestones (the exact legacy
  // ambiguity this tool is designed to resolve), directories are matched in ROADMAP document
  // order — the first ROADMAP occurrence of a given number claims the first matching disk dir.
  // This is the only unambiguous assignment strategy for flat dirs that carry no milestone
  // context. The dry-run output shows the complete rename plan so users can review before
  // applying with --apply.

  const phases: PhaseRename[] = [];
  for (const dirName of existingDirs) {
    const phaseNum = extractPhaseNumFromDir(dirName);
    if (!phaseNum) continue;

    const intPart = parseInt(phaseNum, 10);
    const paddedPhaseNum = String(intPart).padStart(2, '0');
    const unpaddedPhaseNum = String(intPart);
    // For decimal IDs like "02.1", also try "2.1"
    const dotIdx = phaseNum.indexOf('.');
    const decimalUnpadded = dotIdx !== -1 ? unpaddedPhaseNum + phaseNum.slice(dotIdx) : null;

    // Find the first unused mapping whose legacy number matches (exact, padded, unpadded, or decimal)
    const found = orderedMappings.find(m => !m._used && (
      m.legacyPhaseNum === phaseNum ||
      m.legacyPhaseNum === paddedPhaseNum ||
      m.legacyPhaseNum === unpaddedPhaseNum ||
      (decimalUnpadded && m.legacyPhaseNum === decimalUnpadded)
    ));
    if (!found) continue;
    found._used = true;

    const newDirName = buildNewDirName(dirName, found.newId, projectCode);
    if (newDirName !== dirName) {
      phases.push({
        oldId: phaseNum,
        newId: found.newId,
        oldDir: dirName,
        newDir: newDirName,
      });
    }
  }

  // ── Build ROADMAP.md line edits ────────────────────────────────────────────
  const roadmapEdits: RoadmapEdit[] = [];

  for (const entry of legacyPhases) {
    // Use lineIndex as the canonical key (not legacyPhaseNum, which may collide across milestones)
    const mapping = idMapping.get(entry.lineIndex);
    if (!mapping) continue;

    // Rewrite heading line: "### Phase N: Name" → "### Phase M-NN: Name"
    const oldLine = lines[entry.lineIndex];
    const newLine = oldLine.replace(
      new RegExp(`^(#{2,4}\\s*(?:\\[[^\\]]{1,200}\\]\\s*)?Phase\\s+)${PHASE_NUMBER_TOKEN_SOURCE}(\\s*:)`, 'i'),
      `$1${mapping.newId}$2`
    );
    if (newLine !== oldLine) {
      roadmapEdits.push({ lineIndex: entry.lineIndex, from: oldLine, to: newLine });
    }
  }

  // Rewrite checklist lines in ROADMAP.md — use milestone context to resolve collisions.
  let currentChecklistMilestone: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track enclosing milestone section for context-aware lookup
    const milestoneHeadingMatch = line.match(MILESTONE_HEADING_RE);
    if (milestoneHeadingMatch) {
      currentChecklistMilestone = parseInt(milestoneHeadingMatch[1], 10);
    }

    // Already in roadmapEdits? skip
    if (roadmapEdits.some(e => e.lineIndex === i)) continue;

    // Match checklist items: "- [ ] **Phase N:**" or "- [x] Phase N:"  (also decimal)
    const checklistMatch = line.match(
      new RegExp(`^(\\s*-\\s*\\[[ x]\\]\\s*\\*{0,2}Phase\\s+)(${PHASE_NUMBER_TOKEN_SOURCE})(\\s*[:\\s*])`, 'i')
    );
    if (checklistMatch) {
      const legacyNum = checklistMatch[2];
      const cIntPart = parseInt(legacyNum, 10);
      const paddedLegacy = String(cIntPart).padStart(2, '0');
      const unpaddedLegacy = String(cIntPart);
      const cDotIdx = legacyNum.indexOf('.');
      const paddedLegacyDecimal = cDotIdx !== -1 ? paddedLegacy + legacyNum.slice(cDotIdx) : null;

      // Prefer milestone-context lookup (avoids collision across milestones)
      let newId: string | undefined;
      if (currentChecklistMilestone !== null && milestoneIdMap.has(currentChecklistMilestone)) {
        const mMap = milestoneIdMap.get(currentChecklistMilestone)!;
        newId = mMap.get(legacyNum) || mMap.get(paddedLegacy) || mMap.get(unpaddedLegacy);
        if (!newId && paddedLegacyDecimal) newId = mMap.get(paddedLegacyDecimal);
      }
      if (!newId) {
        // Fallback: use ordered flat list (no milestone collision in this roadmap)
        const found = orderedMappings.find(m =>
          m.legacyPhaseNum === legacyNum ||
          m.legacyPhaseNum === paddedLegacy ||
          m.legacyPhaseNum === unpaddedLegacy ||
          (paddedLegacyDecimal && m.legacyPhaseNum === paddedLegacyDecimal)
        );
        if (found) newId = found.newId;
      }

      if (newId) {
        const newLine = line.replace(
          new RegExp(`^(\\s*-\\s*\\[[ x]\\]\\s*\\*{0,2}Phase\\s+)${PHASE_NUMBER_TOKEN_SOURCE}(\\s*[:\\s*])`, 'i'),
          `$1${newId}$2`
        );
        if (newLine !== line) {
          roadmapEdits.push({ lineIndex: i, from: line, to: newLine });
        }
      }
    }
  }

  // ── Build cross-ref edits for STATE.md and PROJECT.md ────────────────────
  const crossRefEdits: CrossRefEdit[] = [];
  const crossRefFiles = ['STATE.md', 'PROJECT.md'];

  for (const fileName of crossRefFiles) {
    const filePath = path.join(pDir, fileName);
    if (!fs.existsSync(filePath)) continue;

    const fileContent = fs.readFileSync(filePath, 'utf8');

    // Iterate using orderedMappings (ROADMAP order) — idMapping is now keyed by lineIndex.
    for (const m of orderedMappings) {
      const legacyNum = m.legacyPhaseNum;
      const xIntPart = parseInt(legacyNum, 10);
      const paddedNum = String(xIntPart).padStart(2, '0');
      const unpaddedNum = String(xIntPart);
      // Decimal suffix (e.g. ".1" from "2.1") — preserve in cross-ref patterns
      const xDotIdx = legacyNum.indexOf('.');
      const decimalSuffix = xDotIdx !== -1 ? legacyNum.slice(xDotIdx) : '';

      // Rewrite project_code-prefixed references: "GSD-01-" → "GSD-01-02-"
      if (projectCode) {
        const [milestoneStr, subStr] = m.newId.split('-');
        const paddedMilestone = String(parseInt(milestoneStr, 10)).padStart(2, '0');
        const prefixedNew = `${projectCode}-${paddedMilestone}-${subStr}-`;
        // Try both padded and original forms as old prefix
        for (const oldNum of new Set([paddedNum + decimalSuffix, unpaddedNum + decimalSuffix, paddedNum, unpaddedNum])) {
          const prefixedOld = `${projectCode}-${oldNum}-`;
          if (fileContent.includes(prefixedOld)) {
            crossRefEdits.push({ file: fileName, from: prefixedOld, to: prefixedNew });
          }
        }
      }

      // Rewrite prose references: "Phase 1:" → "Phase 1-01:", "Phase 2.1:" → "Phase 1-02:"
      const proseOldPatterns = new Set([
        `Phase ${unpaddedNum}${decimalSuffix}:`,
        `Phase ${paddedNum}${decimalSuffix}:`,
        `Phase ${legacyNum}:`,
      ]);
      for (const proseOld of proseOldPatterns) {
        if (fileContent.includes(proseOld)) {
          const proseNew = `Phase ${m.newId}:`;
          crossRefEdits.push({ file: fileName, from: proseOld, to: proseNew });
        }
      }
    }
  }

  return {
    alreadyMigrated: false,
    phases,
    roadmapEdits,
    crossRefEdits,
  };
}

/**
 * Apply roadmap line edits via character-offset splicing against the
 * ORIGINAL content string — never a full split/rejoin (#3413). `lineIndex`
 * boundaries are found by scanning for the next bare `\n`, exactly matching
 * how computeMigrationPlan() itself indexes lines (`roadmapContent.split('\n')`)
 * — both sides must agree on line indexing for `lineText === edit.from` to
 * match, and this keeps a `\r` that precedes a `\n` as part of the LINE text
 * rather than a separately-normalized terminator. Only a line whose text
 * exactly equals an edit's `from` is replaced; every other character —
 * including every line's own terminator, touched or not — is copied
 * byte-for-byte from the original, so a mixed-EOL ROADMAP.md never has its
 * untouched lines silently flattened to one dominant style.
 */
function applyRoadmapEdits(content: string, edits: RoadmapEdit[]): string {
  const editByLine = new Map<number, RoadmapEdit>();
  for (const edit of edits) editByLine.set(edit.lineIndex, edit);

  let result = '';
  let pos = 0;
  let lineIndex = 0;

  for (;;) {
    const nlIdx = content.indexOf('\n', pos);
    const lineEnd = nlIdx === -1 ? content.length : nlIdx;
    const lineText = content.slice(pos, lineEnd);
    const edit = editByLine.get(lineIndex);
    result += edit && lineText === edit.from ? edit.to : lineText;
    if (nlIdx === -1) break;
    result += '\n';
    pos = nlIdx + 1;
    lineIndex++;
  }

  return result;
}

// ─── applyMigration ───────────────────────────────────────────────────────────

/**
 * Apply the migration plan computed by computeMigrationPlan().
 *
 * @param cwd
 * @param plan
 * @param options
 * @param options.dryRun - Print plan and exit without mutating. (default true)
 */
function applyMigration(cwd: string, plan: MigrationPlan, options: { dryRun?: boolean } = {}): ApplyMigrationResult {
  const dryRun = options.dryRun !== false; // default true

  if (plan.alreadyMigrated) {
    return { alreadyMigrated: true };
  }

  if (dryRun) {
    process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
    return { dryRun: true };
  }

  // ── Real run: verify clean working tree ───────────────────────────────────
  let gitStatus: string;
  try {
    gitStatus = execSync('git status --porcelain', { cwd, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  } catch (err) {
    throw new Error(`git status failed: ${(err as Error).message}`);
  }
  if (gitStatus.trim().length > 0) {
    throw new Error('Working tree is dirty. Commit or stash changes before migrating.');
  }

  const pDir = planningDir(cwd);
  const phasesDir = path.join(pDir, 'phases');
  const roadmapPath = path.join(pDir, 'ROADMAP.md');
  const configPath = path.join(pDir, 'config.json');

  const renamedDirs: string[] = [];
  const editedFiles: string[] = [];

  // Surgical, git-independent rollback state (#1542). A `git reset --hard` +
  // `git clean` rollback restores NOTHING for a gitignored `.planning/`
  // (commit_docs:false — the default) and is a whole-repo operation besides.
  // Instead, record the exact renames performed and snapshot each file before
  // rewriting it, then undo precisely those on failure — correct whether
  // `.planning/` is git-tracked or ignored.
  const performedRenames: Array<{ oldPath: string; newPath: string }> = [];
  const fileBackups = new Map<string, { existed: boolean; content: string }>();
  const snapshotFile = (filePath: string): void => {
    if (fileBackups.has(filePath)) return;
    try {
      fileBackups.set(filePath, { existed: true, content: fs.readFileSync(filePath, 'utf8') });
    } catch {
      fileBackups.set(filePath, { existed: false, content: '' });
    }
  };

  try {
    // 1. Rename phase directories, then (#4698 Blocker 3) any phase-qualified
    // artifact filenames inside them whose names still spell the
    // pre-migration phase token. File renames are recorded onto the SAME
    // `performedRenames` list, immediately after their own directory's
    // entry — rollback below walks this list newest-first, so a file rename
    // is always reversed before the directory rename that contains it, which
    // is the only order that can succeed.
    for (const phaseEntry of plan.phases) {
      const oldPath = path.join(phasesDir, phaseEntry.oldDir);
      const newPath = path.join(phasesDir, phaseEntry.newDir);
      if (fs.existsSync(oldPath)) {
        retryRenameSync(oldPath, newPath);
        performedRenames.push({ oldPath, newPath });
        renamedDirs.push(`${phaseEntry.oldDir} → ${phaseEntry.newDir}`);

        for (const fileRename of phaseEntry.fileRenames ?? []) {
          const oldFilePath = path.join(newPath, fileRename.oldName);
          const newFilePath = path.join(newPath, fileRename.newName);
          if (fs.existsSync(oldFilePath)) {
            retryRenameSync(oldFilePath, newFilePath);
            performedRenames.push({ oldPath: oldFilePath, newPath: newFilePath });
          }
        }

        // #4698 Blocker 1 (round 2): rewrite depends_on references, AFTER
        // the artifact renames above so `rewrite.finalName` already exists
        // on disk at its final name. The backup is keyed by the file's
        // ORIGINAL pre-migration absolute path (`oldPath`, this directory's
        // own pre-rename path — still a valid STRING even though nothing
        // lives there right now) rather than its current path: the rollback
        // below reverses every entry in `performedRenames` (this directory's
        // rename AND its file renames) BEFORE it ever consults
        // `fileBackups`, so by the time that restore runs, this exact file
        // is already back at `oldPath`/`rewrite.oldName` — which is the only
        // path the backup can be keyed by for the restore to land correctly.
        // Content, unlike a path, is never touched by the rename reversal,
        // so keying by the post-rollback path is the only order that works.
        for (const rewrite of phaseEntry.dependsOnRewrites ?? []) {
          const currentPath = path.join(newPath, rewrite.finalName);
          if (fs.existsSync(currentPath)) {
            const originalPath = path.join(oldPath, rewrite.oldName);
            if (!fileBackups.has(originalPath)) {
              fileBackups.set(originalPath, { existed: true, content: rewrite.from });
            }
            fs.writeFileSync(currentPath, rewrite.to, 'utf8');
            editedFiles.push(path.join('phases', phaseEntry.newDir, rewrite.finalName));
          }
        }
      }
    }

    // 2. Rewrite ROADMAP.md phase headings
    if (plan.roadmapEdits.length > 0) {
      const roadmapContent = fs.readFileSync(roadmapPath, 'utf8');
      const newRoadmapContent = applyRoadmapEdits(roadmapContent, plan.roadmapEdits);

      snapshotFile(roadmapPath);
      fs.writeFileSync(roadmapPath, newRoadmapContent, 'utf8');
      editedFiles.push('ROADMAP.md');
    }

    // 3. Rewrite cross-refs in STATE.md and PROJECT.md
    const crossRefsByFile = new Map<string, CrossRefEdit[]>();
    for (const edit of plan.crossRefEdits) {
      if (!crossRefsByFile.has(edit.file)) {
        crossRefsByFile.set(edit.file, []);
      }
      crossRefsByFile.get(edit.file)!.push(edit);
    }

    for (const [fileName, edits] of crossRefsByFile) {
      const filePath = path.join(pDir, fileName);
      if (!fs.existsSync(filePath)) continue;

      let content = fs.readFileSync(filePath, 'utf8');
      let changed = false;

      for (const edit of edits) {
        if (content.includes(edit.from)) {
          // Replace all occurrences
          content = content.split(edit.from).join(edit.to);
          changed = true;
        }
      }

      if (changed) {
        snapshotFile(filePath);
        fs.writeFileSync(filePath, content, 'utf8');
        editedFiles.push(fileName);
      }
    }

    // 4. Update config.json to the convention named by this plan — but only
    // when the plan actually converted at least one IDENTITY (#4698 Blocker
    // 1/2). `plan.phases` holds DIRECTORY renames, not converted HEADINGS —
    // gating on `phases.length` alone left a roadmap with recognizable
    // headings but zero phase directories on disk (nothing to rename) with
    // its ROADMAP.md already rewritten to the target convention's text while
    // config stayed unset, and Blocker 2's own mixed/partial guard then
    // permanently refuses every retry (headings already read as the target
    // convention, config does not). An empty plan (e.g. a roadmap this
    // migrator failed to recognize) must still never stamp
    // phase_id_convention: computeBracketPlan's own idempotency guard treats
    // that stamp as proof the migration already finished, so a write here
    // with nothing converted would make the correct re-run (once the roadmap
    // is fixed) permanently unreachable. Applies identically to both targets
    // — legacy (milestone-prefixed) plans omit targetConvention and retain
    // the historical default.
    if (plan.phases.length > 0 || plan.roadmapEdits.length > 0) {
      let configData: Record<string, unknown> = {};
      try {
        configData = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
      } catch { /* config may not exist yet */ }

      configData['phase_id_convention'] = plan.targetConvention ?? 'milestone-prefixed';
      snapshotFile(configPath);
      try {
        fs.writeFileSync(configPath, JSON.stringify(configData, null, 2) + '\n', 'utf8');
      } catch (err) {
        throw new Error(`config.json write phase failed: ${(err as Error).message}`);
      }
      editedFiles.push('config.json');
    }

  } catch (err) {
    // Surgical rollback: reverse the renames (newest first) and restore every
    // file we snapshotted (deleting files that did not previously exist). This
    // actually restores `.planning/` regardless of git tracking — so the
    // "rolled back" claim is truthful — and never touches anything else.
    for (let i = performedRenames.length - 1; i >= 0; i--) {
      const { oldPath, newPath } = performedRenames[i];
      try {
        if (fs.existsSync(newPath)) retryRenameSync(newPath, oldPath);
      } catch { /* best-effort */ }
    }
    for (const [filePath, backup] of fileBackups) {
      try {
        if (backup.existed) fs.writeFileSync(filePath, backup.content, 'utf8');
        else if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch { /* best-effort */ }
    }
    throw new Error(`Migration failed and rolled back: ${(err as Error).message}`);
  }

  return { applied: true, renamedDirs, editedFiles };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

export = {
  computeMigrationPlan,
  applyMigration,
  computeDependsOnRewrites,
};
