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

interface RouteCheckCommandOptions {
  args: string[];
  cwd: string;
  raw: boolean;
}

function routeCheckCommand({ args, cwd, raw }: RouteCheckCommandOptions): void {
  const subcommand = args[1];
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
  error('Unknown check subcommand. Available: auto-mode, decision-coverage-plan, decision-coverage-verify', ERROR_REASON.SDK_UNKNOWN_COMMAND);
}

export = {
  routeCheckCommand,
  decisionMentioned,
  extractPlanDesignatedSections,
};
