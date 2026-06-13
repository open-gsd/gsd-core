/**
 * Check subcommand router — auto-mode, decision-coverage-plan, decision-coverage-verify.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/check-command-router.cjs collapsed
 * to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only strict types are added.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import core = require('./core.cjs');
const { output, error, ERROR_REASON } = core;
import { parseDecisions } from './decisions.cjs';
import type { Decision } from './decisions.cjs';
import { checkUiPresence } from './ui-safety-gate.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import verifyModule = require('./verify.cjs');
const { cmdVerifySchemaDrift, cmdVerifyCodebaseDrift } = verifyModule;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import roadmapModule = require('./roadmap.cjs');
const { getRoadmapPhaseWithFallback } = roadmapModule;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import gapCheckerModule = require('./gap-checker.cjs');
const { runGapAnalysis } = gapCheckerModule;

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

function decisionMentioned(haystack: string | null | undefined, decision: Decision): boolean {
  if (!haystack) return false;
  if (new RegExp(`\\b${decision.id}\\b`).test(haystack)) return true;
  const phrase = softPhrase(decision.text);
  return phrase ? normalizePhrase(haystack).includes(phrase) : false;
}

function readIfExists(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}

function resolvePath(inputPath: string, projectDir: string): string {
  return path.isAbsolute(inputPath) ? inputPath : path.join(projectDir, inputPath);
}

interface WorkflowConfig {
  auto_advance?: boolean;
  _auto_chain_active?: boolean;
  context_coverage_gate?: boolean | string;
}

function readWorkflowConfig(projectDir: string): WorkflowConfig {
  const configPath = path.join(projectDir, '.planning', 'config.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    const wf = (parsed['workflow'] as Record<string, unknown> | undefined) || {};
    return {
      ...wf,
      auto_advance: (wf['auto_advance'] ?? parsed['auto_advance']) as boolean | undefined,
      _auto_chain_active: (wf['_auto_chain_active'] ?? parsed['_auto_chain_active']) as boolean | undefined,
      context_coverage_gate: (wf['context_coverage_gate'] ?? parsed['context_coverage_gate']) as boolean | string | undefined,
    };
  } catch {
    return {};
  }
}

function cmdAutoMode(projectDir: string, raw: boolean): void {
  const workflow = readWorkflowConfig(projectDir);
  const autoAdvance = Boolean(workflow.auto_advance ?? false);
  const autoChainActive = Boolean(workflow._auto_chain_active ?? false);
  let source = 'none';
  if (autoChainActive && autoAdvance) source = 'both';
  else if (autoChainActive) source = 'auto_chain';
  else if (autoAdvance) source = 'auto_advance';

  output({
    active: autoChainActive || autoAdvance,
    source,
    auto_chain_active: autoChainActive,
    auto_advance: autoAdvance,
  }, raw, undefined);
}

function gateEnabled(projectDir: string): boolean {
  const value = readWorkflowConfig(projectDir).context_coverage_gate;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lower = value.toLowerCase();
    if (lower === 'false' || lower === 'true') return lower !== 'false';
  }
  return true;
}

function loadPlanContents(phaseDir: string): string[] {
  if (!fs.existsSync(phaseDir)) return [];
  try {
    return fs.readdirSync(phaseDir)
      .filter((entry) => /-PLAN\.md$/.test(entry))
      .map((entry) => readIfExists(path.join(phaseDir, entry)));
  } catch {
    return [];
  }
}

const DESIGNATED_HEADINGS_RE = /^#{1,6}\s+(?:must[_ ]haves?|truths?|tasks?|objective)\b/i;
const XML_DECISION_TAGS_RE = /<(?:objective|tasks?|action)(?:\s[^>]*)?>([\s\S]*?)<\/(?:objective|tasks?|action)>/gi;

function stripCommentsAndFences(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ');
}

function extractYamlBlock(frontmatter: string, key: string): string {
  const match = frontmatter.match(new RegExp(`^${key}\\s*:(.*)$`, 'm'));
  if (!match) return '';
  const startIdx = (match.index || 0) + match[0].length;
  const rest = frontmatter.slice(startIdx + 1).split(/\r?\n/);
  const block = [match[1] || ''];
  for (const line of rest) {
    if (line === '' || /^\s/.test(line)) block.push(line);
    else break;
  }
  return block.join('\n');
}

function extractXmlTagBodies(text: string): string {
  const parts: string[] = [];
  for (const match of text.matchAll(XML_DECISION_TAGS_RE)) {
    if (match[1]) parts.push(match[1]);
  }
  return parts.join('\n');
}

function extractPlanDesignatedSections(planContent: string | null | undefined): string {
  if (!planContent) return '';
  const cleaned = stripCommentsAndFences(planContent);
  const fmMatch = cleaned.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const frontmatter = fmMatch ? fmMatch[1] : '';
  const body = fmMatch ? fmMatch[2] : cleaned;

  const parts: string[] = [];
  for (const key of ['must_haves', 'truths', 'objective']) {
    const block = extractYamlBlock(frontmatter, key);
    if (block) parts.push(block);
  }

  const bodyParts: string[] = [];
  let inDesignated = false;
  for (const line of body.split(/\r?\n/)) {
    const heading = /^#{1,6}\s+/.test(line);
    if (heading) {
      inDesignated = DESIGNATED_HEADINGS_RE.test(line);
      if (inDesignated) bodyParts.push(line);
      continue;
    }
    if (inDesignated) bodyParts.push(line);
  }
  parts.push(bodyParts.join('\n'));
  parts.push(extractXmlTagBodies(cleaned));
  return parts.join('\n\n');
}

interface UncoveredItem {
  id: string;
  text: string;
  category: string;
}

function buildPlanMessage(uncovered: UncoveredItem[]): string {
  if (uncovered.length === 0) return 'All trackable CONTEXT.md decisions are covered by plans.';
  return [
    '## Decision Coverage Gap',
    '',
    `${uncovered.length} CONTEXT.md decision(s) are not covered by any plan:`,
    '',
    ...uncovered.map((item) => `- **${item.id}** (${item.category || 'uncategorized'}): ${item.text}`),
    '',
    'Resolve by citing `D-NN:` in a relevant plan\'s `must_haves`/`truths` (or body),',
    'OR move the decision to `### Claude\'s Discretion` / tag it `[informational]` if it should not be tracked.',
  ].join('\n');
}

function buildVerifyMessage(notHonored: UncoveredItem[]): string {
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

function loadTrackableDecisions(contextPath: string): Decision[] {
  return parseDecisions(readIfExists(contextPath)).filter((decision) => decision.trackable);
}

function cmdDecisionCoveragePlan(projectDir: string, args: string[], raw: boolean): void {
  const phaseDir = args[2] ? resolvePath(args[2], projectDir) : '';
  const contextPath = args[3] ? resolvePath(args[3], projectDir) : '';

  if (!gateEnabled(projectDir)) {
    output({ passed: true, skipped: true, reason: 'workflow.context_coverage_gate is false', total: 0, covered: 0, uncovered: [], message: 'Decision coverage gate disabled by config.' }, raw, undefined);
    return;
  }
  if (!contextPath || !fs.existsSync(contextPath)) {
    output({ passed: true, skipped: true, reason: 'CONTEXT.md missing', total: 0, covered: 0, uncovered: [], message: 'No CONTEXT.md - nothing to check.' }, raw, undefined);
    return;
  }

  const decisions = loadTrackableDecisions(contextPath);
  if (decisions.length === 0) {
    output({ passed: true, skipped: true, reason: 'no trackable decisions', total: 0, covered: 0, uncovered: [], message: 'No trackable decisions in CONTEXT.md.' }, raw, undefined);
    return;
  }

  const sections = loadPlanContents(phaseDir).map(extractPlanDesignatedSections);
  const uncovered: UncoveredItem[] = [];
  let covered = 0;
  for (const decision of decisions) {
    if (sections.some((section) => decisionMentioned(section, decision))) covered++;
    else uncovered.push({ id: decision.id, text: decision.text, category: decision.category });
  }

  output({
    passed: uncovered.length === 0,
    skipped: false,
    total: decisions.length,
    covered,
    uncovered,
    message: buildPlanMessage(uncovered),
  }, raw, undefined);
}

function recentCommitMessages(projectDir: string): string {
  try {
    return execFileSync('git', ['log', '-n', '200', '--pretty=%s%n%b'], {
      cwd: projectDir,
      encoding: 'utf-8',
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
  } catch {
    return '';
  }
}

function isInsideRoot(candidatePath: string, rootDir: string): boolean {
  const root = path.resolve(rootDir);
  const target = path.resolve(root, candidatePath);
  return target === root || target.startsWith(`${root}${path.sep}`);
}

function readModifiedFilesContent(projectDir: string, summaries: string[]): string {
  const out: string[] = [];
  let total = 0;
  for (const summary of summaries) {
    if (!summary) continue;
    for (const blockMatch of summary.matchAll(/files_modified:\s*\n((?:[ \t]*-\s+.+\n?)+)/g)) {
      const files = [...(blockMatch[1] || '').matchAll(/-\s+(.+)/g)]
        .map((match) => match[1].trim().replace(/^["']|["']$/g, ''));
      for (const file of files) {
        if (total >= 50) break;
        if (!file || !isInsideRoot(file, projectDir)) continue;
        const raw = readIfExists(resolvePath(file, projectDir));
        out.push(raw.length > 256 * 1024 ? raw.slice(0, 256 * 1024) : raw);
        total++;
      }
      if (total >= 50) break;
    }
    if (total >= 50) break;
  }
  return out.join('\n\n');
}

function cmdDecisionCoverageVerify(projectDir: string, args: string[], raw: boolean): void {
  const phaseDir = args[2] ? resolvePath(args[2], projectDir) : '';
  const contextPath = args[3] ? resolvePath(args[3], projectDir) : '';

  if (!gateEnabled(projectDir)) {
    output({ skipped: true, blocking: false, reason: 'workflow.context_coverage_gate is false', total: 0, honored: 0, not_honored: [], message: 'Decision coverage gate disabled by config.' }, raw, undefined);
    return;
  }
  if (!contextPath || !fs.existsSync(contextPath)) {
    output({ skipped: true, blocking: false, reason: 'CONTEXT.md missing', total: 0, honored: 0, not_honored: [], message: 'No CONTEXT.md - nothing to check.' }, raw, undefined);
    return;
  }

  const decisions = loadTrackableDecisions(contextPath);
  if (decisions.length === 0) {
    output({ skipped: true, blocking: false, reason: 'no trackable decisions', total: 0, honored: 0, not_honored: [], message: 'No trackable decisions in CONTEXT.md.' }, raw, undefined);
    return;
  }

  const planContents = loadPlanContents(phaseDir);
  const summaryParts = fs.existsSync(phaseDir)
    ? fs.readdirSync(phaseDir).filter((entry) => /-SUMMARY\.md$/.test(entry)).map((entry) => readIfExists(path.join(phaseDir, entry)))
    : [];
  const haystack = [
    planContents.join('\n\n'),
    summaryParts.join('\n\n'),
    readModifiedFilesContent(projectDir, summaryParts),
    recentCommitMessages(projectDir),
  ].join('\n\n');

  const notHonored: UncoveredItem[] = [];
  let honored = 0;
  for (const decision of decisions) {
    if (decisionMentioned(haystack, decision)) honored++;
    else notHonored.push({ id: decision.id, text: decision.text, category: decision.category });
  }

  output({
    skipped: false,
    blocking: false,
    total: decisions.length,
    honored,
    not_honored: notHonored,
    message: buildVerifyMessage(notHonored),
  }, raw, undefined);
}

// ─── ui-plan-gate ─────────────────────────────────────────────────────────────

/**
 * ui-plan-gate: given a phase number, checks whether the phase has frontend
 * indicators and whether a *-UI-SPEC.md already exists in the phase directory.
 *
 * Returns JSON: { frontend: boolean, hasUiSpec: boolean, block: boolean }
 *   block = frontend && !hasUiSpec (gate fires when UI work is detected but no spec exists)
 *
 * Invocable as: gsd_run check ui-plan-gate <phase>
 *
 * Uses checkUiPresence from ui-safety-gate.cjs — does NOT reimplement frontend detection.
 * Uses getRoadmapPhaseInternal + findPhaseInternal from core.cjs for phase data.
 */
function findUiSpecInDir(phaseDir: string): string {
  if (!phaseDir || !fs.existsSync(phaseDir)) return '';
  try {
    const files = fs.readdirSync(phaseDir);
    const found = files.find((f) => /-UI-SPEC\.md$/.test(f));
    return found ? path.join(phaseDir, found) : '';
  } catch {
    return '';
  }
}

/**
 * Pure logic for ui-plan-gate — exposed for direct behavioral testing.
 *
 * Given a projectDir and phase number:
 *   (a) Reads the phase section from ROADMAP.md via getRoadmapPhaseWithFallback —
 *       same two-pass lookup (current milestone → full roadmap) as `roadmap.get-phase`
 *       (cmdRoadmapGetPhase). Cross-milestone / older frontend phases resolve correctly.
 *       If ROADMAP.md is missing, phaseSection is '' (ROADMAP.md not present = project
 *       has no roadmap = cannot be frontend). If the phase truly can't be found after
 *       both passes, phaseSection is '' and phaseLookupFailed is set so callers can
 *       surface the miss — we do NOT silently degrade to frontend:false if the roadmap
 *       exists but the phase header is absent.
 *   (b) Runs checkUiPresence (frontend detection) — no reimplementation.
 *   (c) Resolves the phase directory via core.findPhaseInternal; checks for *-UI-SPEC.md.
 *
 * Returns: { frontend, hasUiSpec, block, uiSpecPath, phaseLookupFailed }
 *   block = frontend && !hasUiSpec
 *   phaseLookupFailed = ROADMAP.md present but phase header not found (surfaced for
 *                       onError:halt gates so a missing phase doesn't silently bypass)
 */
function computeUiPlanGate(projectDir: string, phase: string): {
  frontend: boolean;
  hasUiSpec: boolean;
  block: boolean;
  uiSpecPath: string | null;
  phaseLookupFailed?: boolean;
} {
  // (a) Read the phase section text using the same two-pass lookup as roadmap.get-phase.
  // getRoadmapPhaseWithFallback: current-milestone first, then stripShippedMilestones
  // fallback — mirrors cmdRoadmapGetPhase exactly.
  let phaseSection = '';
  let phaseLookupFailed: boolean | undefined;
  try {
    const section = getRoadmapPhaseWithFallback(projectDir, phase);
    if (section === null) {
      // Distinguish: ROADMAP.md missing (no-roadmap project) vs phase not found in ROADMAP.
      // core.planningDir(cwd) resolves the .planning/ root for workstream-aware paths.
      const planDir: string = typeof (core as unknown as Record<string, unknown>)['planningDir'] === 'function'
        ? (core as unknown as Record<string, (cwd: string) => string>)['planningDir'](projectDir)
        : path.join(projectDir, '.planning');
      const roadmapPath = path.join(planDir, 'ROADMAP.md');
      if (fs.existsSync(roadmapPath)) {
        // ROADMAP.md exists but phase was not found → surface the miss
        phaseLookupFailed = true;
      }
      // phaseSection stays ''
    } else {
      phaseSection = section;
    }
  } catch { /* roadmap read failure → treat as empty (non-frontend) */ }

  // (b) Run checkUiPresence (frontend detection) — reuse existing helper; no reimplementation
  const presenceResult = checkUiPresence(phaseSection);
  const frontend = presenceResult.hasUI;

  // (c) Resolve phase directory via findPhaseInternal and check for *-UI-SPEC.md
  const coreModule = core as unknown as Record<string, unknown>;
  let phaseDir = '';
  try {
    const findPhase = coreModule['findPhaseInternal'] as ((cwd: string, phase: string) => Record<string, unknown> | string | null) | undefined;
    if (typeof findPhase === 'function') {
      const result = findPhase(projectDir, phase);
      if (result && typeof result === 'object') {
        // findPhaseInternal returns { directory: '<relative-posix-path>', ... }
        // directory is relative to cwd — resolve it to absolute.
        const relDir = typeof result['directory'] === 'string' ? result['directory'] : '';
        if (relDir) {
          phaseDir = path.resolve(projectDir, relDir);
        }
      } else if (typeof result === 'string') {
        phaseDir = result;
      }
    }
  } catch { /* phase dir lookup failure → hasUiSpec=false */ }

  const uiSpecPath = findUiSpecInDir(phaseDir);
  const hasUiSpec = uiSpecPath !== '';

  // block = frontend phase with no UI-SPEC
  const block = frontend && !hasUiSpec;

  const result: { frontend: boolean; hasUiSpec: boolean; block: boolean; uiSpecPath: string | null; phaseLookupFailed?: boolean } = {
    frontend, hasUiSpec, block, uiSpecPath: hasUiSpec ? uiSpecPath : null,
  };
  if (phaseLookupFailed) result.phaseLookupFailed = true;
  return result;
}

function cmdUiPlanGate(projectDir: string, args: string[], raw: boolean): void {
  // args[0] = 'check', args[1] = 'ui-plan-gate', args[2] = phase
  const phase = args[2] || '';
  if (!phase) {
    error('ui-plan-gate requires a phase argument: check ui-plan-gate <phase>', ERROR_REASON.SDK_MISSING_ARG);
    return;
  }
  output(computeUiPlanGate(projectDir, phase), raw, undefined);
}

// ─── ui-safety-gate ───────────────────────────────────────────────────────────

/**
 * ui-safety-gate: post-wave check that verifies UI-changed files conform to
 * the active UI-SPEC for the phase. Called after each wave by execute:wave:post.
 *
 * Returns JSON: { frontend: boolean, hasUiFiles: boolean, hasUiSpec: boolean, block: boolean, message?: string }
 *   block = frontend && hasUiFiles && !hasUiSpec
 *
 * Args: check ui-safety-gate <phase>
 * Invocable as: gsd_run check ui-safety-gate <phase>
 *             or gsd_run check ui.safety-gate <phase> (dots normalized to hyphens)
 *
 * Uses checkUiPresence from ui-safety-gate.cjs — does NOT reimplement frontend detection.
 * Checks whether any files changed in recent git history match frontend file patterns.
 * Also checks whether a *-UI-SPEC.md exists in the phase directory (same as ui-plan-gate).
 *
 * Limitation: uses git diff HEAD~1..HEAD which covers only the last commit; in a
 * multi-plan wave the wave-start commit would be more accurate but is not yet stored
 * in the wave manifest. This is tracked as a known limitation.
 */
const UI_FILE_EXTENSIONS_RE = /\.(tsx|jsx|css|scss|sass|less|vue|svelte|html)$/i;
const UI_PATH_PATTERNS_RE = /\/(components|pages|views|screens|layouts|ui|frontend)\//i;

/**
 * Pure logic for ui-safety-gate — exposed for direct behavioral testing.
 *
 * Given a projectDir and phase number:
 *   (a) Reads the phase section from ROADMAP.md via getRoadmapPhaseWithFallback —
 *       same lookup as computeUiPlanGate — to determine if this is a frontend phase.
 *   (b) Runs checkUiPresence (frontend detection) — no reimplementation.
 *   (c) Checks git diff HEAD~1..HEAD for UI file changes in the current worktree.
 *   (d) Resolves the phase directory via core.findPhaseInternal; checks for *-UI-SPEC.md.
 *
 * Returns: { frontend, hasUiFiles, hasUiSpec, block, message?, phaseLookupFailed? }
 *   block = frontend && hasUiFiles && !hasUiSpec
 *   phaseLookupFailed = ROADMAP.md present but phase header not found
 */
function computeUiSafetyGate(projectDir: string, phase: string): {
  frontend: boolean;
  hasUiFiles: boolean;
  hasUiSpec: boolean;
  block: boolean;
  message?: string;
  phaseLookupFailed?: boolean;
} {
  // (a) Read the phase section text (same two-pass lookup as computeUiPlanGate)
  let phaseSection = '';
  let phaseLookupFailed: boolean | undefined;
  try {
    const section = getRoadmapPhaseWithFallback(projectDir, phase);
    if (section === null) {
      const planDir: string = typeof (core as unknown as Record<string, unknown>)['planningDir'] === 'function'
        ? (core as unknown as Record<string, (cwd: string) => string>)['planningDir'](projectDir)
        : path.join(projectDir, '.planning');
      const roadmapPath = path.join(planDir, 'ROADMAP.md');
      if (fs.existsSync(roadmapPath)) {
        phaseLookupFailed = true;
      }
    } else {
      phaseSection = section;
    }
  } catch { /* roadmap read failure → treat as empty (non-frontend) */ }

  // (b) Run checkUiPresence (frontend detection) — reuse existing helper; no reimplementation
  const presenceResult = checkUiPresence(phaseSection);
  const frontend = presenceResult.hasUI;

  // (c) Check whether any UI files were changed in recent git commits
  // Uses git diff HEAD~1..HEAD to detect frontend file changes since last commit.
  // Known limitation: multi-plan waves may need the wave-start commit for full coverage.
  let hasUiFiles = false;
  try {
    const changed = execFileSync('git', ['diff', '--name-only', 'HEAD~1', 'HEAD'], {
      cwd: projectDir,
      encoding: 'utf-8',
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    });
    hasUiFiles = changed.split('\n').some((f) =>
      f.trim() && (UI_FILE_EXTENSIONS_RE.test(f) || UI_PATH_PATTERNS_RE.test(f)),
    );
  } catch { /* git unavailable or no prior commit — treat as no UI files changed */ }

  // (d) Resolve phase directory and check for *-UI-SPEC.md (same as computeUiPlanGate)
  const coreModule = core as unknown as Record<string, unknown>;
  let phaseDir = '';
  try {
    const findPhase = coreModule['findPhaseInternal'] as ((cwd: string, phase: string) => Record<string, unknown> | string | null) | undefined;
    if (typeof findPhase === 'function') {
      const result = findPhase(projectDir, phase);
      if (result && typeof result === 'object') {
        const relDir = typeof result['directory'] === 'string' ? result['directory'] : '';
        if (relDir) {
          phaseDir = path.resolve(projectDir, relDir);
        }
      } else if (typeof result === 'string') {
        phaseDir = result;
      }
    }
  } catch { /* phase dir lookup failure → hasUiSpec=false */ }

  const uiSpecPath = findUiSpecInDir(phaseDir);
  const hasUiSpec = uiSpecPath !== '';

  // block only when: this is a frontend phase AND UI files were changed AND no UI-SPEC exists
  const block = frontend && hasUiFiles && !hasUiSpec;

  const result: {
    frontend: boolean;
    hasUiFiles: boolean;
    hasUiSpec: boolean;
    block: boolean;
    message?: string;
    phaseLookupFailed?: boolean;
  } = { frontend, hasUiFiles, hasUiSpec, block };

  if (block) {
    result.message = `UI files changed in this wave but no UI-SPEC.md exists for Phase ${phase}. ` +
      `Run /gsd:ui-phase ${phase} to generate the design contract before continuing.`;
  }
  if (phaseLookupFailed) result.phaseLookupFailed = true;
  return result;
}

function cmdUiSafetyGate(projectDir: string, args: string[], raw: boolean): void {
  // args[0] = 'check', args[1] = 'ui-safety-gate', args[2] = phase
  const phase = args[2] || '';
  if (!phase) {
    error('ui-safety-gate requires a phase argument: check ui-safety-gate <phase>', ERROR_REASON.SDK_MISSING_ARG);
    return;
  }
  output(computeUiSafetyGate(projectDir, phase), raw, undefined);
}

// ─── tdd-review-checkpoint ────────────────────────────────────────────────────

/**
 * tdd-review-checkpoint: end-of-phase advisory check that scans type:tdd plans
 * for RED/GREEN/REFACTOR gate-sequence compliance and surfaces a review table.
 *
 * Logic from gsd-core/references/tdd.md <end_of_phase_review> and
 * execute-phase.md <step name="tdd_review_checkpoint"> (now removed).
 *
 * Returns JSON:
 *   { passed: true, tddPlans: N, violations: N, table: string, rows: PlanRow[] }
 * where passed is always true (advisory gate — never blocks).
 *
 * Args: check tdd.review-checkpoint <phase>
 *   Phase can be a number or phase-dir path; if not resolvable the check
 *   returns passed:true with tddPlans:0 (no plans to review).
 */
interface TddPlanRow {
  planId: string;
  red: boolean;
  green: boolean;
  refactor: boolean;
  status: 'Pass' | 'FAIL';
  missing: string[];
}

function cmdTddReviewCheckpoint(projectDir: string, args: string[], raw: boolean): void {
  // args[0] = 'check', args[1] = 'tdd-review-checkpoint' (normalized), args[2] = phase
  const phase = args[2] || '';
  if (!phase) {
    error('tdd.review-checkpoint requires a phase argument: check tdd.review-checkpoint <phase>', ERROR_REASON.SDK_MISSING_ARG);
    return;
  }

  // Resolve phase directory
  const coreModule = core as unknown as Record<string, unknown>;
  let phaseDir = '';
  try {
    const findPhase = coreModule['findPhaseInternal'] as ((cwd: string, phase: string) => Record<string, unknown> | string | null) | undefined;
    if (typeof findPhase === 'function') {
      const result = findPhase(projectDir, phase);
      if (result && typeof result === 'object') {
        const relDir = typeof result['directory'] === 'string' ? result['directory'] : '';
        if (relDir) phaseDir = path.resolve(projectDir, relDir);
      } else if (typeof result === 'string') {
        phaseDir = result;
      }
    }
  } catch { /* phase dir lookup failure */ }

  // Find all PLAN.md files with type: tdd in frontmatter
  const tddPlanFiles: string[] = [];
  if (phaseDir) {
    try {
      const files = fs.readdirSync(phaseDir).filter(f => f.endsWith('-PLAN.md'));
      for (const file of files) {
        const planPath = path.join(phaseDir, file);
        const content = readIfExists(planPath);
        // Check frontmatter for type: tdd
        const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
        if (frontmatterMatch) {
          const fm = frontmatterMatch[1];
          if (/^type:\s*tdd\s*$/m.test(fm)) {
            tddPlanFiles.push(planPath);
          }
        }
      }
    } catch { /* directory read failure */ }
  }

  if (tddPlanFiles.length === 0) {
    const result = {
      passed: true,
      tddPlans: 0,
      violations: 0,
      table: '',
      rows: [] as TddPlanRow[],
      message: `No type:tdd plans found in phase ${phase}. TDD review skipped.`,
    };
    output(result, raw, result.message);
    return;
  }

  // For each TDD plan, extract the plan ID (padded plan number) and check git log
  const rows: TddPlanRow[] = [];
  for (const planPath of tddPlanFiles) {
    // Extract plan ID from filename (e.g. "01-02-PLAN.md" → "01-02", or "03-PLAN.md" → "03")
    const basename = path.basename(planPath, '-PLAN.md');
    // planId for commit grep: phase-plan format, e.g. "01-02"
    const planId = basename;

    // Check for RED gate commit: test({planId}):
    let red = false;
    let green = false;
    let refactor = false;
    try {
      const redCommit = execFileSync(
        'git', ['log', '--oneline', `--grep=^test(${planId}):`, '--', '.'],
        { cwd: projectDir, encoding: 'utf-8', maxBuffer: 1024 * 1024, windowsHide: true },
      );
      red = redCommit.trim().length > 0;
    } catch { /* git unavailable or no match */ }

    try {
      const greenCommit = execFileSync(
        'git', ['log', '--oneline', `--grep=^feat(${planId}):`, '--', '.'],
        { cwd: projectDir, encoding: 'utf-8', maxBuffer: 1024 * 1024, windowsHide: true },
      );
      green = greenCommit.trim().length > 0;
    } catch { /* git unavailable or no match */ }

    try {
      const refactorCommit = execFileSync(
        'git', ['log', '--oneline', `--grep=^refactor(${planId}):`, '--', '.'],
        { cwd: projectDir, encoding: 'utf-8', maxBuffer: 1024 * 1024, windowsHide: true },
      );
      refactor = refactorCommit.trim().length > 0;
    } catch { /* git unavailable or no match */ }

    const missing: string[] = [];
    if (!red) missing.push('RED');
    if (!green) missing.push('GREEN');
    const status: 'Pass' | 'FAIL' = missing.length === 0 ? 'Pass' : 'FAIL';

    rows.push({ planId, red, green, refactor, status, missing });
  }

  const violations = rows.filter(r => r.status === 'FAIL').length;

  // Build review table
  const sep = '━'.repeat(53);
  const tableHeader = '| Plan | RED | GREEN | REFACTOR | Status |';
  const tableDivider = '|------|-----|-------|----------|--------|';
  const tableRows = rows.map(r =>
    `| ${r.planId.padEnd(4)} | ${r.red ? ' ✓ ' : ' ✗ '} | ${r.green ? '  ✓  ' : '  ✗  '} | ${r.refactor ? '   ✓    ' : '   —    '} | ${r.status.padEnd(6)} |`,
  );

  let table = [
    sep,
    ` TDD REVIEW — Phase ${phase}`,
    sep,
    '',
    `TDD Plans: ${tddPlanFiles.length} | Gate violations: ${violations}`,
    '',
    tableHeader,
    tableDivider,
    ...tableRows,
  ].join('\n');

  if (violations > 0) {
    table += '\n\n⚠ Gate violations are advisory — review before advancing.';
    for (const r of rows.filter(row => row.status === 'FAIL')) {
      table += `\n  Plan ${r.planId} missing: ${r.missing.join(', ')} gate commit(s).`;
      table += `\n  Expected commit pattern: test(${r.planId}): ... → feat(${r.planId}): ...`;
    }
  }

  const result = {
    passed: true,
    tddPlans: tddPlanFiles.length,
    violations,
    table,
    rows,
  };
  output(result, raw, table);
}

// ─── gap-analysis-plan-post ───────────────────────────────────────────────────

/**
 * gap-analysis-plan-post: non-blocking advisory check that runs the post-planning
 * gap analysis after all PLAN.md files are generated for a phase.
 *
 * Cross-references every REQ-ID and D-ID from REQUIREMENTS.md and CONTEXT.md
 * against the concatenated text of all *-PLAN.md files, emitting a coverage table.
 *
 * This gate is always advisory (passed: true) — it never blocks phase advancement.
 *
 * Args: check gap-analysis.plan-post <phase-dir> [phase-req-ids]
 * Invocable as: gsd_run check gap-analysis.plan-post <phase-dir> [phase-req-ids]
 */
function cmdGapAnalysisPlanPost(projectDir: string, args: string[], raw: boolean): void {
  // args[0] = 'check', args[1] = 'gap-analysis-plan-post' (normalized), args[2] = phaseDir, args[3] = phaseReqIds
  const phaseDir = args[2] || '';
  if (!phaseDir) {
    error('gap-analysis.plan-post requires a phase-dir argument: check gap-analysis.plan-post <phase-dir> [phase-req-ids]', ERROR_REASON.SDK_MISSING_ARG);
    return;
  }
  const phaseReqIds = args[3] ?? undefined;
  const result = runGapAnalysis(projectDir, phaseDir, { phaseReqIds });
  output(
    { passed: true, enabled: result.enabled, table: result.table, summary: result.summary, counts: result.counts },
    raw,
    result.table || result.summary || undefined,
  );
}

interface RouteCheckCommandOptions {
  args: string[];
  cwd: string;
  raw: boolean;
}

function routeCheckCommand({ args, cwd, raw }: RouteCheckCommandOptions): void {
  // Normalize dots to hyphens in the subcommand so both forms are accepted.
  // This makes `check.query = "ui.plan-gate"` (dotted form in capability.json gates)
  // directly runnable as `gsd_run check ui.plan-gate` — the dot is normalized to
  // `ui-plan-gate` before routing. The generic gate-dispatch in §5.6 reads
  // `check.query` from the active gate hook and runs `gsd_run check ${hook.check.query}`,
  // so the declared query must be dispatchable exactly as declared.
  const rawSubcommand = args[1];
  const subcommand = typeof rawSubcommand === 'string' ? rawSubcommand.replace(/\./g, '-') : rawSubcommand;
  if (subcommand === 'auto-mode') {
    cmdAutoMode(cwd, raw);
    return;
  }
  if (subcommand === 'decision-coverage-plan') {
    cmdDecisionCoveragePlan(cwd, args, raw);
    return;
  }
  if (subcommand === 'decision-coverage-verify') {
    cmdDecisionCoverageVerify(cwd, args, raw);
    return;
  }
  if (subcommand === 'ui-plan-gate') {
    cmdUiPlanGate(cwd, args, raw);
    return;
  }
  if (subcommand === 'gap-analysis-plan-post') {
    cmdGapAnalysisPlanPost(cwd, args, raw);
    return;
  }
  if (subcommand === 'tdd-review-checkpoint') {
    cmdTddReviewCheckpoint(cwd, args, raw);
    return;
  }
  if (subcommand === 'ui-safety-gate') {
    cmdUiSafetyGate(cwd, args, raw);
    return;
  }
  if (subcommand === 'verify-schema-drift') {
    // Delegates to verify.schema-drift — drift capability gate at execute:wave:post (blocking).
    // Dot-to-hyphen normalization means query "verify.schema-drift" routes here.
    const phaseArg = typeof args[2] === 'string' ? args[2] : '';
    cmdVerifySchemaDrift(cwd, phaseArg, false, raw);
    return;
  }
  if (subcommand === 'verify-codebase-drift') {
    // Delegates to verify.codebase-drift — drift capability gate at execute:wave:post (non-blocking).
    // Dot-to-hyphen normalization means query "verify.codebase-drift" routes here.
    cmdVerifyCodebaseDrift(cwd, raw);
    return;
  }
  error('Unknown check subcommand. Available: auto-mode, decision-coverage-plan, decision-coverage-verify, gap-analysis-plan-post, tdd-review-checkpoint, ui-plan-gate, ui-safety-gate, verify-schema-drift, verify-codebase-drift', ERROR_REASON.SDK_UNKNOWN_COMMAND);
}

export = {
  routeCheckCommand,
  decisionMentioned,
  extractPlanDesignatedSections,
  computeUiPlanGate,
  computeUiSafetyGate,
  cmdGapAnalysisPlanPost,
  cmdTddReviewCheckpoint,
};
