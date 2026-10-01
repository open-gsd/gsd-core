/**
 * Decision-coverage support — the shared reading/matching helpers of the two decision-coverage
 * gates (#5139, epic #5056, ADR-5057 §4 first bullet, design D3/D4).
 *
 * Moved verbatim (behaviour preserved) from `check-command-router.cts`, with the raw-content
 * parsers replaced by their owning seams:
 *   - the frontmatter `must_haves` / `truths` / `objective` blocks are read through the
 *     Frontmatter Module (`frontmatterKeyBlockText`, the moved `extractYamlBlock`: raw text off
 *     the one fence owner's block, so frontmatter the YAML parser refuses is still scanned), and
 *     the SUMMARY `files_modified` list through its parsed reader (`rawFrontmatterField`), not a
 *     `files_modified:` regex;
 *   - the XML-tag body extraction lives in `markdown-sectionizer.cts` (`extractXmlTagBodies`).
 *
 * The router-facing gate modules (`gate-decision-coverage-plan.cts`,
 * `gate-decision-coverage-verify.cts`) import from here. This module imports no io module and
 * performs no direct console/stdout/stderr write (ESLint-enforced).
 */

import path from 'node:path';
import { extractDecisions } from './decisions.cjs';
import type { Decision } from './decisions.cjs';
import { locateFrontmatterFence } from './frontmatter-fence.cjs';
import { stripFencedCode, collectSections, extractXmlTagBodies } from './markdown-sectionizer.cjs';
import { tryWithinRoot, PathAcceptance } from './security.cjs';
import { readDirEvidence, readTextEvidence } from './gate-evidence.cjs';
import type { Evidence, Observed } from './gate-evidence.cjs';
import { resolveEvaluationScope } from './gate-evaluation-scope.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import frontmatterMod = require('./frontmatter.cjs');
const { rawFrontmatterField, frontmatterKeyBlockText } = frontmatterMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planScanMod = require('./plan-scan.cjs');
const { scanPhasePlans } = planScanMod;

// ─── Decision matching ────────────────────────────────────────────────────────

function normalizePhrase(text: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const SOFT_PHRASE_MIN_WORDS = 6;

function softPhrase(text: unknown): string {
  const words = normalizePhrase(text).split(' ').filter(Boolean);
  if (words.length < SOFT_PHRASE_MIN_WORDS) return '';
  return words.slice(0, SOFT_PHRASE_MIN_WORDS).join(' ');
}

export function decisionMentioned(haystack: string | null | undefined, decision: Decision): boolean {
  if (!haystack) return false;
  if (new RegExp(`\\b${decision.id}\\b`).test(haystack)) return true;
  const phrase = softPhrase(decision.text);
  return phrase ? normalizePhrase(haystack).includes(phrase) : false;
}

// ─── File reading ─────────────────────────────────────────────────────────────

/**
 * The contents of the phase files `pick` selects (#5170, ADR-5057 §4). An ABSENT phase directory
 * is "no files" (`found []`); a directory or file that exists but cannot be read is `unreadable` —
 * a gate must not take "could not read the plan" for "the plan does not cite the decision".
 */
function readPhaseFiles(phaseDir: string, pick: (scan: ReturnType<typeof scanPhasePlans>) => string[]): Observed<string[]> {
  const entries = readDirEvidence(phaseDir);
  if (entries.kind === 'none') return { kind: 'found', value: [] };
  if (entries.kind === 'unreadable') return entries;
  const contents: string[] = [];
  // #3183 (lint-plan-count-drift): source live plan/summary files from the single
  // owner (scanPhasePlans) instead of a local readdirSync filter — picks up bare PLAN.md and
  // nested plans/, and excludes plans marked `status: superseded`.
  for (const entry of pick(scanPhasePlans(phaseDir))) {
    const read = readTextEvidence(path.join(phaseDir, entry));
    if (read.kind === 'unreadable') return read;
    if (read.kind === 'found') contents.push(read.value);
  }
  return { kind: 'found', value: contents };
}

export function loadPlanContents(phaseDir: string): Observed<string[]> {
  return readPhaseFiles(phaseDir, (scan) => scan.planFiles);
}

/**
 * #3183 (lint-plan-count-drift): same single-owner sourcing as `loadPlanContents` —
 * scanPhasePlans's summaryFiles instead of a local `-SUMMARY.md` readdirSync filter.
 */
export function loadSummaryContents(phaseDir: string): Observed<string[]> {
  return readPhaseFiles(phaseDir, (scan) => scan.summaryFiles);
}

export interface DecisionExtraction {
  trackable: Decision[];
  outcome: 'parsed' | 'none-present' | 'could-not-parse';
  unreadableIds: string[];
}

/**
 * The decisions of `CONTEXT.md`. `none` is an absent file (the caller's legitimate "nothing to
 * check"); `unreadable` is a file that exists but could not be read — it must never be extracted as
 * empty text, which would certify "no trackable decisions".
 */
export function loadDecisionExtraction(contextPath: string): Evidence<DecisionExtraction> {
  const read = readTextEvidence(contextPath);
  if (read.kind !== 'found') return read;
  const extraction = extractDecisions(read.value);
  return {
    kind: 'found',
    value: {
      trackable: extraction.decisions.filter((d) => d.trackable),
      outcome: extraction.outcome,
      unreadableIds: extraction.unreadableIds ?? [],
    },
  };
}

// ─── Plan surfaces scanned for a decision citation ────────────────────────────

const DESIGNATED_HEADINGS_RE = /^#{1,6}\s+(?:must[_ ]haves?|truths?|tasks?|objective)\b/i;

function stripCommentsAndFences(text: string): string {
  // HTML-comment stripping stays caller-side (the seam does not strip HTML comments).
  // Stop-at-next-open body (ReDoS-safe, #2128); an UNCLOSED `<!--` does not match,
  // so downstream tags are preserved (unlike a `(?:-->|$)` fallback, which would
  // wipe to EOF and fail-close the decision-coverage gate).
  const htmlStripped = text.replace(/<!--(?:(?!<!--)[\s\S])*?-->/g, ' ');
  // Fenced-code stripping: delegate to the canonical CommonMark-correct seam.
  // replaces the prior independent regex copy (```` ``` ``` ````  + `~~~ ~~~`).
  return stripFencedCode(htmlStripped).text;
}

export function extractPlanDesignatedSections(planContent: string | null | undefined): string {
  if (!planContent) return '';
  const cleaned = stripCommentsAndFences(planContent);
  // The block is the one the one fence owner finds; the body starts after the closing fence
  // line's line ending.
  const fence = locateFrontmatterFence(cleaned);
  const body = fence?.closed ? cleaned.slice(fence.closingFenceEnd).replace(/^\r?\n/, '') : cleaned;

  const parts: string[] = [];
  for (const key of ['must_haves', 'truths', 'objective']) {
    const block = frontmatterKeyBlockText(cleaned, key);
    if (block) parts.push(block);
  }

  // Replace hand-rolled split(/\r?\n/) + heading walk with the seam's collectSections.
  // stopPredicate fires on EVERY heading (collectSections needs to start a section at
  // each heading), then we filter to designated ones — same semantics as the prior
  // inDesignated flag: emit the heading line + body only when DESIGNATED_HEADINGS_RE matches.
  const sections = collectSections(body, () => true);
  const bodyParts: string[] = [];
  for (const section of sections) {
    const headingLine = '#'.repeat(section.heading.level) + ' ' + section.heading.text;
    if (DESIGNATED_HEADINGS_RE.test(headingLine)) {
      bodyParts.push(headingLine);
      if (section.body) bodyParts.push(section.body);
    }
  }
  parts.push(bodyParts.join('\n'));
  parts.push(extractXmlTagBodies(cleaned));
  return parts.join('\n\n');
}

// ─── Messages ─────────────────────────────────────────────────────────────────

export interface UncoveredItem {
  id: string;
  text: string;
  category: string;
}

export function buildPlanMessage(uncovered: UncoveredItem[]): string {
  if (uncovered.length === 0) return 'All trackable CONTEXT.md decisions are covered by plans.';
  return [
    '## Decision Coverage Gap',
    '',
    `${uncovered.length} CONTEXT.md decision(s) are not covered by any plan:`,
    '',
    ...uncovered.map((item) => `- **${item.id}** (${item.category || 'uncategorized'}): ${item.text}`),
    '',
    'Resolve by citing `D-NN:` in any of the scanned plan surfaces: front-matter',
    '`must_haves`/`truths`/`objective`, a `## must_haves`/`truths`/`tasks`/`objective`',
    'heading, or an `<objective>`/`<tasks>`/`<task>`/`<action>`/`<read_first>`/`<behavior>`/`<verify>`/`<acceptance_criteria>`/`<done>`',
    'tag body. Other locations (prose outside those headings, comments, other XML tags) are not scanned.',
    'OR move the decision to `### Claude\'s Discretion` / tag it `[informational]` if it should not be tracked.',
  ].join('\n');
}

export function buildVerifyMessage(notHonored: UncoveredItem[]): string {
  if (notHonored.length === 0) return 'All trackable CONTEXT.md decisions are honored by shipped artifacts.';
  return [
    '### Decision Coverage (warning)',
    '',
    `${notHonored.length} decision(s) not found in shipped artifacts:`,
    '',
    ...notHonored.map((item) => `- **${item.id}** (${item.category || 'uncategorized'}): ${item.text}`),
    '',
    'This is a soft warning - verification status is unchanged.',
  ].join('\n');
}

// ─── Shipped-artifact haystack (verify gate) ──────────────────────────────────

/**
 * The subjects and bodies of the PHASE'S OWN commits (#5164, ADR-5057 §4) — the evaluation-scope
 * resolver's commit set for `phaseDir`, not the last 200 commits of whatever branch is checked
 * out. A phase with no recorded task commits widens to the commits in its directory range (the
 * resolver says so); an unreadable phase or repository yields '' ("could not look"), and a git
 * failure on a non-git project dir writes nothing to the terminal.
 */
export function phaseCommitMessages(projectDir: string, phaseDir: string): string {
  const scope = resolveEvaluationScope(
    projectDir,
    { kind: 'phase', phase: '', phaseDir },
    { includeBody: true, includeFiles: false },
  );
  return scope.commits.map((c) => `${c.subject}\n${c.body ?? ''}`).join('\n');
}

/** Cap on files read across all SUMMARYs, and on bytes read per file. */
const MODIFIED_FILES_MAX_COUNT = 50;
const MODIFIED_FILES_MAX_BYTES = 256 * 1024;

/**
 * The contents of every file the SUMMARYs list under frontmatter `files_modified`, contained to
 * `projectDir` and capped at `MODIFIED_FILES_MAX_COUNT` files / `MODIFIED_FILES_MAX_BYTES` each.
 */
export function readModifiedFilesContent(projectDir: string, summaries: string[]): Observed<string> {
  const out: string[] = [];
  let total = 0;
  for (const summary of summaries) {
    if (!summary) continue;
    if (total >= MODIFIED_FILES_MAX_COUNT) break;
    const field = rawFrontmatterField(summary, 'files_modified');
    const listed: unknown[] = field && Array.isArray(field.value) ? field.value : [];
    for (const entry of listed) {
      if (total >= MODIFIED_FILES_MAX_COUNT) break;
      if (typeof entry !== 'string') continue;
      const file = entry.trim();
      if (!file) continue;
      // Migrated off the hand-rolled prefix check (ADR-4650): resolve+contain in one
      // step via the canonical realpath predicate — the eventual read below follows
      // symlinks, so containment must be decided on the resolved target, not a lexical
      // prefix. Read the value the predicate RETURNED; do not re-derive the path.
      const candidate = path.isAbsolute(file) ? file : path.join(projectDir, file);
      const contained = tryWithinRoot(candidate, projectDir, PathAcceptance.AbsoluteInsideRoot);
      if (contained === null) continue;
      // An absent listed file contributes nothing readable (`''`); one that exists but cannot be
      // read is `unreadable` — the decision it may cite was never seen (#5170).
      const read = readTextEvidence(contained);
      if (read.kind === 'unreadable') return read;
      const content = read.kind === 'found' ? read.value : '';
      out.push(content.length > MODIFIED_FILES_MAX_BYTES ? content.slice(0, MODIFIED_FILES_MAX_BYTES) : content);
      total++;
    }
  }
  return { kind: 'found', value: out.join('\n\n') };
}
