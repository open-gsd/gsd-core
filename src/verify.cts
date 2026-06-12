/**
 * Verify — Verification suite, consistency, and health validation
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/verify.cjs collapsed to
 * a TypeScript source of truth, compiled by tsc to a gitignored .cjs at the
 * same require() path. Behaviour preserved byte-for-behaviour; only types are added.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { phaseVariants, buildRoadmapPhaseVariants, buildNotStartedPhaseVariants } from './validate.cjs';
import { phaseDirNameRe, PHASE_TOKEN_FROM_DIR_RE, MILESTONE_ARCHIVE_DIR_RE, canonicalPlanStem } from './validate.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- core.cjs is an export= CommonJS module
import core = require('./core.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- planning-workspace.cjs is an export= CommonJS module
import planningWorkspace = require('./planning-workspace.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- frontmatter.cjs is an export= CommonJS module
import frontmatterMod = require('./frontmatter.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- state.cjs is an export= CommonJS module
import stateMod = require('./state.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- model-profiles.cjs is an export= CommonJS module
import modelProfilesMod = require('./model-profiles.cjs');
import { execGit, platformReadSync as safeReadFile, platformWriteSync } from './shell-command-projection.cjs';
import { PACKAGE_NAME } from './package-identity.cjs';
import { formatGsdSlash, resolveRuntime } from './runtime-slash.cjs';
import { detectSchemaFiles, checkSchemaDrift } from './schema-detect.cjs';
import { isCanonicalPlanningFile } from './artifacts.cjs';

const {
  loadConfig,
  normalizePhaseName,
  phaseTokenMatches,
  escapeRegex,
  findPhaseInternal,
  getMilestoneInfo,
  stripShippedMilestones,
  extractCurrentMilestone,
  output,
  error,
  checkAgentsInstalled,
  CONFIG_DEFAULTS,
  inspectWorktreeHealth,
} = core;

const { planningDir } = planningWorkspace;
const { extractFrontmatter, parseMustHavesBlock } = frontmatterMod;
const { writeStateMd } = stateMod;
const { MODEL_PROFILES } = modelProfilesMod;

// Unused but imported for structural parity
void stripShippedMilestones;
void detectSchemaFiles;

function cmdVerifySummary(
  cwd: string,
  summaryPath: string,
  checkFileCount: number | undefined,
  raw: boolean,
): void {
  if (!summaryPath) {
    error('summary-path required');
  }

  const fullPath = path.join(cwd, summaryPath);
  const checkCount = checkFileCount || 2;

  if (!fs.existsSync(fullPath)) {
    const result = {
      passed: false,
      checks: {
        summary_exists: false,
        files_created: { checked: 0, found: 0, missing: [] },
        commits_exist: false,
        self_check: 'not_found',
      },
      errors: ['SUMMARY.md not found'],
    };
    output(result, raw, 'failed');
    return;
  }

  const content = fs.readFileSync(fullPath, 'utf-8');
  const errors: string[] = [];

  const mentionedFiles = new Set<string>();
  const patterns = [
    /`([^`]+\.[a-zA-Z]+)`/g,
    /(?:Created|Modified|Added|Updated|Edited):\s*`?([^\s`]+\.[a-zA-Z]+)`?/gi,
  ];

  for (const pattern of patterns) {
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(content)) !== null) {
      const filePath = m[1];
      if (filePath && !filePath.startsWith('http') && filePath.includes('/')) {
        mentionedFiles.add(filePath);
      }
    }
  }

  const filesToCheck = Array.from(mentionedFiles).slice(0, checkCount);
  const missing: string[] = [];
  for (const file of filesToCheck) {
    if (!fs.existsSync(path.join(cwd, file))) {
      missing.push(file);
    }
  }

  const commitHashPattern = /\b[0-9a-f]{7,40}\b/g;
  const hashes = content.match(commitHashPattern) || [];
  let commitsExist = false;
  if (hashes.length > 0) {
    for (const hash of hashes.slice(0, 3)) {
      const result = execGit(['cat-file', '-t', hash], { cwd }) as unknown as { exitCode: number; stdout: string };
      if (result.exitCode === 0 && result.stdout.trim() === 'commit') {
        commitsExist = true;
        break;
      }
    }
  }

  let selfCheck = 'not_found';
  const selfCheckPattern = /##\s*(?:Self[- ]?Check|Verification|Quality Check)/i;
  if (selfCheckPattern.test(content)) {
    const passPattern = /(?:all\s+)?(?:pass|✓|✅|complete|succeeded)/i;
    const failPattern = /(?:fail|✗|❌|incomplete|blocked)/i;
    const checkSection = content.slice(content.search(selfCheckPattern));
    if (failPattern.test(checkSection)) {
      selfCheck = 'failed';
    } else if (passPattern.test(checkSection)) {
      selfCheck = 'passed';
    }
  }

  if (missing.length > 0) errors.push('Missing files: ' + missing.join(', '));
  if (!commitsExist && hashes.length > 0)
    errors.push('Referenced commit hashes not found in git history');
  if (selfCheck === 'failed') errors.push('Self-check section indicates failure');

  const checks = {
    summary_exists: true,
    files_created: { checked: filesToCheck.length, found: filesToCheck.length - missing.length, missing },
    commits_exist: commitsExist,
    self_check: selfCheck,
  };

  const passed = missing.length === 0 && selfCheck !== 'failed';
  const result = { passed, checks, errors };
  output(result, raw, passed ? 'passed' : 'failed');
}

/**
 * Issue #429 — negative-grep comment-text echo gate.
 * A literal that an acceptance criterion negative-greps for (grep -c 'LIT' file == 0)
 * must not also appear verbatim inside an <action> body, or the executor's commit-time
 * verify gate fails on the comment echo rather than a real regression. Conservative:
 * errors only on a confidently-extracted QUOTED literal; ambiguous (bareword) → warning.
 */
function scanNegativeGrepCommentEcho(content: string): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  // Normalize newlines; join backslash line-continuations so a verify command wrapped
  // across lines (grep ... \ <newline> == 0) is still seen as one segment.
  const text = (content || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\\\n/g, ' ');

  // 1. Allowlisted literals: <!-- planner-discipline-allow: LIT -->
  const allow = new Set<string>();
  const allowRe = /<!--\s*planner-discipline-allow:\s*(.+?)\s*-->/g;
  let am: RegExpExecArray | null;
  while ((am = allowRe.exec(text)) !== null) allow.add(am[1]);

  // Zero-equality comparison (the negative grep). The required leading whitespace
  // before the operator distinguishes a shell comparison (`[ $c == 0 ]`, `... == 0`,
  // always spaced) from an assignment (`VAR=0`, never spaced) and naturally excludes
  // `>= 0`, `<= 0`, `!= 0`, `!== 0`, `=== 0`.
  const zeroCmp = (s: string): boolean =>
    /\s==?\s*0\b/.test(s) || /-eq\s+0\b/.test(s) || /\bequals\s+0\b/.test(s);

  // A grep invocation using a count flag (-c / -cF / -Fc / --count), capturing the
  // search pattern (first quoted token, else first bareword) after a run of options.
  // The options run lets `grep -c -F 'LIT'`, `grep -F -c 'LIT'`, `grep -c -e 'LIT'`
  // and `grep --count 'LIT'` all resolve to the LIT pattern.
  const countGrepRe =
    /grep((?:\s+-{1,2}[A-Za-z][A-Za-z-]*)+)\s+(?:'([^']*)'|"([^"]*)"|([^\s'"|>&;]+))/g;
  const optsHaveCount = (opts: string): boolean =>
    /(?:^|\s)-[A-Za-z]*c[A-Za-z]*(?=\s|$)/.test(opts) || /--count\b/.test(opts);
  // `grep -cv 'pat' == 0` counts NON-matching lines, so == 0 there asserts "all lines
  // match" — a POSITIVE gate, not our negative gate. Skip inverted greps.
  const optsHaveInvert = (opts: string): boolean =>
    /(?:^|\s)-[A-Za-z]*v[A-Za-z]*(?=\s|$)/.test(opts) || /--invert-match\b/.test(opts);
  // Bareword sanity: a real grep target, not a stray operator/number/flag.
  const plausibleBare = (s: string): boolean => /[A-Za-z0-9_]/.test(s) && !/^[-=!<>0-9]+$/.test(s);

  // 2. <action> text to scan, with negative-grep COMMAND SPANS removed (only the
  //    command, not the whole line) so a pasted verify command does not self-flag
  //    while a prose echo on the same line is still caught.
  const cmdSpanRe =
    /grep(?:\s+-{1,2}[A-Za-z][A-Za-z-]*)+\s+(?:'[^']*'|"[^"]*"|[^\s'"|>&;]+)[^\n]*?(?:==|-eq|=)\s*0\b/g;
  const actionZones: string[] = [];
  const actionRe = /<action>([\s\S]*?)<\/action>/g;
  let acm: RegExpExecArray | null;
  while ((acm = actionRe.exec(text)) !== null) actionZones.push(acm[1]);
  const scannableActionText = actionZones.map((zone) => zone.replace(cmdSpanRe, ' ')).join('\n');

  // 3. Per shell SEGMENT (split lines on && / ||) extract count-grep literals and
  //    check echoes. Per-segment splitting keeps a positive gate (`== 1`) from
  //    poisoning a negative gate (`== 0`) sharing the same physical line.
  const seenErr = new Set<string>();
  const seenWarn = new Set<string>();
  const segments = text.split('\n').flatMap((line) => line.split(/\s*(?:&&|\|\|)\s*/));
  for (const seg of segments) {
    if (!/grep(?:\s+-{1,2}[A-Za-z])/.test(seg) || !zeroCmp(seg)) continue;
    countGrepRe.lastIndex = 0;
    const quotedLits: string[] = [];
    const bareLits: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = countGrepRe.exec(seg)) !== null) {
      if (!optsHaveCount(m[1]) || optsHaveInvert(m[1])) continue; // need count, not invert (-cv is positive)
      if (m[2] !== undefined) quotedLits.push(m[2]);
      else if (m[3] !== undefined) quotedLits.push(m[3]);
      else if (m[4] !== undefined && plausibleBare(m[4])) bareLits.push(m[4]);
    }
    for (const quoted of quotedLits) {
      if (!quoted || allow.has(quoted) || seenErr.has(quoted)) continue;
      if (scannableActionText.includes(quoted)) {
        seenErr.add(quoted);
        errors.push(
          `Plan body contains forbidden literal "${quoted}" in an <action> block, but an acceptance criterion negative-greps for it (grep -c ... == 0). Rephrase the literal by concept, remove it from the plan body, or add <!-- planner-discipline-allow: ${quoted} --> if it must legitimately appear.`,
        );
      }
    }
    if (quotedLits.length === 0) {
      for (const bare of bareLits) {
        if (allow.has(bare) || seenWarn.has(bare)) continue;
        if (scannableActionText.includes(bare)) {
          seenWarn.add(bare);
          warnings.push(
            `Possible comment-text echo (#429): negative-grep target "${bare}" is unquoted so its literal could not be extracted unambiguously, but it appears in an <action> block. Quote the grep literal and add an allowlist marker if the echo is intended, or rephrase by concept.`,
          );
        }
      }
    }
  }
  return { errors, warnings };
}

function cmdVerifyPlanStructure(cwd: string, filePath: string, raw: boolean): void {
  if (!filePath) {
    error('file path required');
  }
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
  const content = safeReadFile(fullPath);
  if (!content) {
    output({ error: 'File not found', path: filePath }, raw);
    return;
  }

  const fm = extractFrontmatter(content);
  const errors: string[] = [];
  const warnings: string[] = [];

  const required = ['phase', 'plan', 'type', 'wave', 'depends_on', 'files_modified', 'autonomous', 'must_haves'];
  for (const field of required) {
    if (fm[field] === undefined) errors.push(`Missing required frontmatter field: ${field}`);
  }

  const taskPattern = /<task[^>]*>([\s\S]*?)<\/task>/g;
  const tasks: Record<string, unknown>[] = [];
  let taskMatch: RegExpExecArray | null;
  while ((taskMatch = taskPattern.exec(content)) !== null) {
    const taskContent = taskMatch[1];
    const nameMatch = taskContent.match(/<name>([\s\S]*?)<\/name>/);
    const taskName = nameMatch ? nameMatch[1].trim() : 'unnamed';
    const hasFiles = /<files>/.test(taskContent);
    const hasAction = /<action>/.test(taskContent);
    const hasVerify = /<verify>/.test(taskContent);
    const hasDone = /<done>/.test(taskContent);

    if (!nameMatch) errors.push('Task missing <name> element');
    if (!hasAction) errors.push(`Task '${taskName}' missing <action>`);
    if (!hasVerify) warnings.push(`Task '${taskName}' missing <verify>`);
    if (!hasDone) warnings.push(`Task '${taskName}' missing <done>`);
    if (!hasFiles) warnings.push(`Task '${taskName}' missing <files>`);

    tasks.push({ name: taskName, hasFiles, hasAction, hasVerify, hasDone });
  }

  if (tasks.length === 0) warnings.push('No <task> elements found');

  if (
    fm['wave'] &&
    parseInt(fm['wave'] as string) > 1 &&
    (!fm['depends_on'] ||
      (Array.isArray(fm['depends_on']) && (fm['depends_on'] as unknown[]).length === 0))
  ) {
    warnings.push('Wave > 1 but depends_on is empty');
  }

  const hasCheckpoints = /<task\s+type=["']?checkpoint/.test(content);
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- FrontmatterValue comparison
  if (hasCheckpoints && fm['autonomous'] !== 'false' && String(fm['autonomous']) !== 'false') {
    errors.push('Has checkpoint tasks but autonomous is not false');
  }

  const echoScan = scanNegativeGrepCommentEcho(content);
  errors.push(...echoScan.errors);
  warnings.push(...echoScan.warnings);

  output(
    {
      valid: errors.length === 0,
      errors,
      warnings,
      task_count: tasks.length,
      tasks,
      frontmatter_fields: Object.keys(fm),
    },
    raw,
    errors.length === 0 ? 'valid' : 'invalid',
  );
}

function cmdVerifyPhaseCompleteness(cwd: string, phase: string, raw: boolean): void {
  if (!phase) {
    error('phase required');
  }
  const phaseInfoRaw = findPhaseInternal(cwd, phase);
  if (!phaseInfoRaw || !(phaseInfoRaw as unknown as Record<string, unknown>)['found']) {
    output({ error: 'Phase not found', phase }, raw);
    return;
  }
  const phaseInfo = phaseInfoRaw as unknown as Record<string, unknown>;

  const errors: string[] = [];
  const warnings: string[] = [];
  const phaseDir = path.join(cwd, phaseInfo['directory'] as string);

  let files: string[];
  try {
    files = fs.readdirSync(phaseDir);
  } catch {
    output({ error: 'Cannot read phase directory' }, raw);
    return;
  }

  const plans = files.filter((f) => f.match(/-PLAN\.md$/i));
  const summaries = files.filter((f) => f.match(/-SUMMARY\.md$/i));

  const planIds = new Set(plans.map((p) => p.replace(/-PLAN\.md$/i, '')));
  const summaryIds = new Set(summaries.map((s) => s.replace(/-SUMMARY\.md$/i, '')));

  const incompletePlans = [...planIds].filter((id) => !summaryIds.has(id));
  if (incompletePlans.length > 0) {
    errors.push(`Plans without summaries: ${incompletePlans.join(', ')}`);
  }

  const orphanSummaries = [...summaryIds].filter((id) => !planIds.has(id));
  if (orphanSummaries.length > 0) {
    warnings.push(`Summaries without plans: ${orphanSummaries.join(', ')}`);
  }

  output(
    {
      complete: errors.length === 0,
      phase: phaseInfo['phase_number'],
      plan_count: plans.length,
      summary_count: summaries.length,
      incomplete_plans: incompletePlans,
      orphan_summaries: orphanSummaries,
      errors,
      warnings,
    },
    raw,
    errors.length === 0 ? 'complete' : 'incomplete',
  );
}

function cmdVerifyReferences(cwd: string, filePath: string, raw: boolean): void {
  if (!filePath) {
    error('file path required');
  }
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
  const content = safeReadFile(fullPath);
  if (!content) {
    output({ error: 'File not found', path: filePath }, raw);
    return;
  }

  const found: string[] = [];
  const missing: string[] = [];

  const atRefs = content.match(/@([^\s\n,)]+\/[^\s\n,)]+)/g) || [];
  for (const ref of atRefs) {
    const cleanRef = ref.slice(1);
    const resolved = cleanRef.startsWith('~/')
      ? path.join(process.env['HOME'] || '', cleanRef.slice(2))
      : path.join(cwd, cleanRef);
    if (fs.existsSync(resolved)) {
      found.push(cleanRef);
    } else {
      missing.push(cleanRef);
    }
  }

  const backtickRefs = content.match(/`([^`]+\/[^`]+\.[a-zA-Z]{1,10})`/g) || [];
  for (const ref of backtickRefs) {
    const cleanRef = ref.slice(1, -1);
    if (cleanRef.startsWith('http') || cleanRef.includes('${') || cleanRef.includes('{{')) continue;
    if (found.includes(cleanRef) || missing.includes(cleanRef)) continue;
    const resolved = path.join(cwd, cleanRef);
    if (fs.existsSync(resolved)) {
      found.push(cleanRef);
    } else {
      missing.push(cleanRef);
    }
  }

  output(
    {
      valid: missing.length === 0,
      found: found.length,
      missing,
      total: found.length + missing.length,
    },
    raw,
    missing.length === 0 ? 'valid' : 'invalid',
  );
}

function cmdVerifyCommits(cwd: string, hashes: string[], raw: boolean): void {
  if (!hashes || hashes.length === 0) {
    error('At least one commit hash required');
  }

  const valid: string[] = [];
  const invalid: string[] = [];
  for (const hash of hashes) {
    const result = execGit(['cat-file', '-t', hash], { cwd }) as unknown as { exitCode: number; stdout: string };
    if (result.exitCode === 0 && result.stdout.trim() === 'commit') {
      valid.push(hash);
    } else {
      invalid.push(hash);
    }
  }

  output(
    {
      all_valid: invalid.length === 0,
      valid,
      invalid,
      total: hashes.length,
    },
    raw,
    invalid.length === 0 ? 'valid' : 'invalid',
  );
}

function cmdVerifyArtifacts(cwd: string, planFilePath: string, raw: boolean): void {
  if (!planFilePath) {
    error('plan file path required');
  }
  const fullPath = path.isAbsolute(planFilePath) ? planFilePath : path.join(cwd, planFilePath);
  const content = safeReadFile(fullPath);
  if (!content) {
    output({ error: 'File not found', path: planFilePath }, raw);
    return;
  }

  const artifacts = parseMustHavesBlock(content, 'artifacts') as Record<string, unknown>[];
  if (artifacts.length === 0) {
    output({ error: 'No must_haves.artifacts found in frontmatter', path: planFilePath }, raw);
    return;
  }

  const results: Record<string, unknown>[] = [];
  for (const artifact of artifacts) {
    if (typeof artifact === 'string') continue;
    const artPath = artifact['path'] as string | undefined;
    if (!artPath) continue;

    const artFullPath = path.join(cwd, artPath);
    const exists = fs.existsSync(artFullPath);
    const check: Record<string, unknown> = { path: artPath, exists, issues: [], passed: false };

    if (exists) {
      const fileContent = safeReadFile(artFullPath) || '';
      const lineCount = fileContent.split('\n').length;

      if (artifact['min_lines'] && lineCount < (artifact['min_lines'] as number)) {
        (check['issues'] as string[]).push(`Only ${lineCount} lines, need ${artifact['min_lines'] as number}`);
      }
      if (artifact['contains'] && !fileContent.includes(artifact['contains'] as string)) {
        (check['issues'] as string[]).push(`Missing pattern: ${artifact['contains'] as string}`);
      }
      if (artifact['exports']) {
        const exports = Array.isArray(artifact['exports'])
          ? artifact['exports']
          : [artifact['exports']];
        for (const exp of exports) {
          if (!fileContent.includes(exp as string)) (check['issues'] as string[]).push(`Missing export: ${exp as string}`);
        }
      }
      check['passed'] = (check['issues'] as string[]).length === 0;
    } else {
      (check['issues'] as string[]).push('File not found');
    }

    results.push(check);
  }

  const passed = results.filter((r) => r['passed']).length;
  output(
    {
      all_passed: passed === results.length,
      passed,
      total: results.length,
      artifacts: results,
    },
    raw,
    passed === results.length ? 'valid' : 'invalid',
  );
}

function cmdVerifyKeyLinks(cwd: string, planFilePath: string, raw: boolean): void {
  if (!planFilePath) {
    error('plan file path required');
  }
  const fullPath = path.isAbsolute(planFilePath) ? planFilePath : path.join(cwd, planFilePath);
  const content = safeReadFile(fullPath);
  if (!content) {
    output({ error: 'File not found', path: planFilePath }, raw);
    return;
  }

  const keyLinks = parseMustHavesBlock(content, 'key_links') as Record<string, unknown>[];
  if (keyLinks.length === 0) {
    output({ error: 'No must_haves.key_links found in frontmatter', path: planFilePath }, raw);
    return;
  }

  const results: Record<string, unknown>[] = [];
  for (const link of keyLinks) {
    if (typeof link === 'string') continue;
    const check: Record<string, unknown> = {
      from: link['from'],
      to: link['to'],
      via: link['via'] || '',
      verified: false,
      detail: '',
    };

    const sourceContent = safeReadFile(path.join(cwd, (link['from'] as string) || ''));
    if (!sourceContent) {
      check['detail'] = 'Source file not found (from: must be a relative file path; describe components/endpoints in via:)';
    } else if (link['pattern']) {
      try {
        const regex = new RegExp(link['pattern'] as string);
        if (regex.test(sourceContent)) {
          check['verified'] = true;
          check['detail'] = 'Pattern found in source';
        } else {
          const targetContent = safeReadFile(path.join(cwd, (link['to'] as string) || ''));
          if (targetContent && regex.test(targetContent)) {
            check['verified'] = true;
            check['detail'] = 'Pattern found in target';
          } else {
            check['detail'] = `Pattern "${link['pattern'] as string}" not found in source or target`;
          }
        }
      } catch {
        check['detail'] = `Invalid regex pattern: ${link['pattern'] as string}`;
      }
    } else {
      if (sourceContent.includes((link['to'] as string) || '')) {
        check['verified'] = true;
        check['detail'] = 'Target referenced in source';
      } else {
        check['detail'] = 'Target not referenced in source';
      }
    }

    results.push(check);
  }

  const verified = results.filter((r) => r['verified']).length;
  output(
    {
      all_verified: verified === results.length,
      verified,
      total: results.length,
      links: results,
    },
    raw,
    verified === results.length ? 'valid' : 'invalid',
  );
}

function listMilestoneArchiveDirs(planBase: string): string[] {
  const milestonesDir = path.join(planBase, 'milestones');
  try {
    return fs
      .readdirSync(milestonesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && MILESTONE_ARCHIVE_DIR_RE.test(e.name))
      .map((e) => path.join(milestonesDir, e.name))
      .sort((a, b) =>
        path.basename(a).localeCompare(path.basename(b), undefined, { numeric: true }),
      );
  } catch {
    return [];
  }
}

function forEachArchivedPhaseToken(planBase: string, onPhase: (token: string) => void): void {
  for (const archiveDir of listMilestoneArchiveDirs(planBase)) {
    try {
      const entries = fs.readdirSync(archiveDir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const m = e.name.match(PHASE_TOKEN_FROM_DIR_RE);
        if (m) onPhase(m[1]);
      }
    } catch {
      /* archive dir absent/unreadable */
    }
  }
}

function getActiveMilestoneArchiveDir(planBase: string): string | null {
  const archiveDirs = listMilestoneArchiveDirs(planBase);
  if (archiveDirs.length === 0) return null;

  try {
    const statePath = path.join(planBase, 'STATE.md');
    if (fs.existsSync(statePath)) {
      const state = fs.readFileSync(statePath, 'utf-8');
      const m = state.match(
        /^\s*(?:\*\*)?milestone(?:\*\*)?:\s*\*{0,2}\s*([^\s*\r\n#][^\s\r\n#]*)/mi,
      );
      if (m && m[1]) {
        const milestone = m[1].trim();
        const candidate = path.join(planBase, 'milestones', `${milestone}-phases`);
        return archiveDirs.includes(candidate) ? candidate : null;
      }
    }
  } catch {
    /* intentionally empty — fall through to version-sort below */
  }

  return archiveDirs[archiveDirs.length - 1];
}

function collectPhaseRoots(planBase: string): string[] {
  const roots: string[] = [];
  const flatPhasesDir = path.join(planBase, 'phases');
  if (fs.existsSync(flatPhasesDir)) roots.push(flatPhasesDir);
  const activeArchive = getActiveMilestoneArchiveDir(planBase);
  if (activeArchive) roots.push(activeArchive);
  return roots;
}

function collectDiskPhases(planBase: string): Set<string> {
  const diskPhases = new Set<string>();
  const phaseRoots = collectPhaseRoots(planBase);
  const scanDir = (dir: string) => {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory()) {
          const m = e.name.match(PHASE_TOKEN_FROM_DIR_RE);
          if (m) diskPhases.add(m[1]);
        }
      }
    } catch {
      /* dir absent */
    }
  };

  for (const root of phaseRoots) scanDir(root);

  return diskPhases;
}

interface MilestoneMismatch {
  phaseId: string;
  foundInMilestone: string;
  expectedMilestone: string;
}

function checkMilestonePrefixMismatches(
  roadmapContent: string,
  { getMilestoneFromPhaseId }: { getMilestoneFromPhaseId: (id: string) => string | null },
): MilestoneMismatch[] {
  const mismatches: MilestoneMismatch[] = [];
  const sections: { version: string; start: number; end: number }[] = [];
  const sectionRx = /^#{1,3}\s+(?:\[[^\]]+\]\s*)?.*v(\d+\.\d+)/gim;
  let m: RegExpExecArray | null;
  while ((m = sectionRx.exec(roadmapContent)) !== null) {
    if (sections.length > 0) sections[sections.length - 1].end = m.index;
    sections.push({ version: `v${m[1]}`, start: m.index, end: roadmapContent.length });
  }
  for (const section of sections) {
    const content = roadmapContent.slice(section.start, section.end);
    const phaseRx = /#{2,4}\s*(?:\[[^\]]+\]\s*)?Phase\s+([\w][\w.-]*)\s*:/gi;
    let pm: RegExpExecArray | null;
    while ((pm = phaseRx.exec(content)) !== null) {
      const phaseId = pm[1];
      const expectedMilestone = getMilestoneFromPhaseId(phaseId);
      if (expectedMilestone !== null && expectedMilestone !== section.version) {
        mismatches.push({
          phaseId,
          foundInMilestone: section.version,
          expectedMilestone,
        });
      }
    }
  }
  return mismatches;
}

interface IssueEntry {
  code: string;
  message: string;
  fix: string;
  repairable: boolean;
}

function cmdValidateConsistency(cwd: string, raw: boolean): void {
  const planBase = planningDir(cwd);
  const roadmapPath = path.join(planBase, 'ROADMAP.md');
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!fs.existsSync(roadmapPath)) {
    errors.push('ROADMAP.md not found');
    output({ passed: false, errors, warnings }, raw, 'failed');
    return;
  }

  const roadmapContentRaw = fs.readFileSync(roadmapPath, 'utf-8');
  const roadmapContent = extractCurrentMilestone(roadmapContentRaw, cwd);

  const { roadmapPhases } = buildRoadmapPhaseVariants(roadmapContent);
  const { roadmapPhaseVariants: fullRoadmapPhaseVariants } = buildRoadmapPhaseVariants(roadmapContentRaw);

  const diskPhases = collectDiskPhases(planBase);

  for (const p of roadmapPhases) {
    if (!diskPhases.has(p) && !diskPhases.has(normalizePhaseName(p))) {
      warnings.push(`Phase ${p} in ROADMAP.md but no directory on disk`);
    }
  }

  for (const p of diskPhases) {
    const variants = phaseVariants(p);
    if (![...variants].some((v) => fullRoadmapPhaseVariants.has(v))) {
      warnings.push(`Phase ${p} exists on disk but not in ROADMAP.md`);
    }
  }

  const config = loadConfig(cwd);
  if (config.phase_naming !== 'custom') {
    const integerPhases = [...diskPhases]
      .filter((p) => !p.includes('.'))
      .map((p) => parseInt(p, 10))
      .sort((a, b) => a - b);

    for (let i = 1; i < integerPhases.length; i++) {
      if (integerPhases[i] !== integerPhases[i - 1] + 1) {
        warnings.push(`Gap in phase numbering: ${integerPhases[i - 1]} → ${integerPhases[i]}`);
      }
    }
  }

  const phaseRoots = collectPhaseRoots(planBase);
  for (const phaseRoot of phaseRoots) {
    try {
      const entries = fs.readdirSync(phaseRoot, { withFileTypes: true });
      const dirs = entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();

      for (const dir of dirs) {
        const phasePath = path.join(phaseRoot, dir);
        const phaseLabel = path.relative(planBase, phasePath).replace(/\\/g, '/');
        const phaseFiles = fs.readdirSync(phasePath);
        const plans = phaseFiles.filter((f) => f.endsWith('-PLAN.md')).sort();

        const planNums = plans
          .map((p) => {
            const pm = p.match(/-(\d{2})-PLAN\.md$/);
            return pm ? parseInt(pm[1], 10) : null;
          })
          .filter((n): n is number => n !== null);

        for (let i = 1; i < planNums.length; i++) {
          if (planNums[i] !== planNums[i - 1] + 1) {
            warnings.push(
              `Gap in plan numbering in ${phaseLabel}: plan ${planNums[i - 1]} → ${planNums[i]}`,
            );
          }
        }

        const summaries = phaseFiles.filter((f) => f.endsWith('-SUMMARY.md'));
        const planIds = new Set(plans.map((p) => p.replace('-PLAN.md', '')));
        const summaryIds = new Set(summaries.map((s) => s.replace('-SUMMARY.md', '')));

        for (const sid of summaryIds) {
          if (!planIds.has(sid)) {
            warnings.push(`Summary ${sid}-SUMMARY.md in ${phaseLabel} has no matching PLAN.md`);
          }
        }

        for (const plan of plans) {
          const content = fs.readFileSync(path.join(phasePath, plan), 'utf-8');
          const fmData = extractFrontmatter(content);
          if (!fmData['wave']) {
            warnings.push(`${phaseLabel}/${plan}: missing 'wave' in frontmatter`);
          }
        }
      }
    } catch {
      /* intentionally empty */
    }
  }

  const passed = errors.length === 0;
  output({ passed, errors, warnings, warning_count: warnings.length }, raw, passed ? 'passed' : 'failed');
}

function cmdValidateHealth(
  cwd: string,
  options: Record<string, unknown>,
  raw: boolean,
): Record<string, unknown> | undefined {
  const resolved = path.resolve(cwd);
  if (resolved === os.homedir()) {
    output(
      {
        status: 'error',
        errors: [
          {
            code: 'E010',
            message: `CWD is home directory (${resolved}) — health check would read the wrong .planning/ directory. Run from your project root instead.`,
            fix: 'cd into your project directory and retry',
          },
        ],
        warnings: [],
        info: [{ code: 'I010', message: `Resolved CWD: ${resolved}` }],
        repairable_count: 0,
      },
      raw,
    );
    return;
  }

  const planBase = planningDir(cwd);
  const projectPath = path.join(planBase, 'PROJECT.md');
  const roadmapPath = path.join(planBase, 'ROADMAP.md');
  const statePath = path.join(planBase, 'STATE.md');
  const configPath = path.join(planBase, 'config.json');
  const phasesDir = path.join(planBase, 'phases');
  const _slashRuntime = resolveRuntime(cwd);
  const slash = (name: string) => formatGsdSlash(name, _slashRuntime) as string;

  const errors: IssueEntry[] = [];
  const warnings: IssueEntry[] = [];
  const info: IssueEntry[] = [];
  const repairs: string[] = [];

  const addIssue = (
    severity: 'error' | 'warning' | 'info',
    code: string,
    message: string,
    fix: string,
    repairable = false,
  ) => {
    const issue: IssueEntry = { code, message, fix, repairable };
    if (severity === 'error') errors.push(issue);
    else if (severity === 'warning') warnings.push(issue);
    else info.push(issue);
  };

  if (!fs.existsSync(planBase)) {
    addIssue('error', 'E001', '.planning/ directory not found', `Run ${slash('new-project')} to initialize`);
    output({ status: 'broken', errors, warnings, info, repairable_count: 0 }, raw);
    return;
  }

  if (!fs.existsSync(projectPath)) {
    addIssue('error', 'E002', 'PROJECT.md not found', `Run ${slash('new-project')} to create`);
  } else {
    const content = fs.readFileSync(projectPath, 'utf-8');
    const requiredSections = ['## What This Is', '## Core Value', '## Requirements'];
    for (const section of requiredSections) {
      if (!content.includes(section)) {
        addIssue('warning', 'W001', `PROJECT.md missing section: ${section}`, 'Add section manually');
      }
    }
  }

  if (!fs.existsSync(roadmapPath)) {
    addIssue('error', 'E003', 'ROADMAP.md not found', `Run ${slash('new-milestone')} to create roadmap`);
  }

  if (!fs.existsSync(statePath)) {
    addIssue(
      'error',
      'E004',
      'STATE.md not found',
      `Run ${slash('health')} --repair to regenerate`,
      true,
    );
    repairs.push('regenerateState');
  } else {
    const stateContent = fs.readFileSync(statePath, 'utf-8');
    const phaseRefs = [...stateContent.matchAll(/[Pp]hase\s+(\d+[A-Z]?(?:\.\d+)*)/g)].map(
      (m) => m[1],
    );
    const validPhases = collectDiskPhases(planBase);
    try {
      if (fs.existsSync(roadmapPath)) {
        const roadmapRaw = fs.readFileSync(roadmapPath, 'utf-8');
        const all = [...roadmapRaw.matchAll(/#{2,4}\s*Phase\s+(\d+[A-Z]?(?:\.\d+)*)/gi)];
        for (const m of all) validPhases.add(m[1]);
      }
    } catch {
      /* intentionally empty */
    }
    forEachArchivedPhaseToken(planBase, (token) => validPhases.add(token));
    const normalizedValid = new Set<string>();
    for (const p of validPhases) {
      normalizedValid.add(p);
      const dotIdx = p.indexOf('.');
      const head = dotIdx === -1 ? p : p.slice(0, dotIdx);
      const tail = dotIdx === -1 ? '' : p.slice(dotIdx);
      if (/^\d+$/.test(head)) {
        normalizedValid.add(head.padStart(2, '0') + tail);
      }
    }
    for (const ref of phaseRefs) {
      const dotIdx = ref.indexOf('.');
      const head = dotIdx === -1 ? ref : ref.slice(0, dotIdx);
      const tail = dotIdx === -1 ? '' : ref.slice(dotIdx);
      const padded = /^\d+$/.test(head) ? head.padStart(2, '0') + tail : ref;
      if (!normalizedValid.has(ref) && !normalizedValid.has(padded)) {
        if (normalizedValid.size > 0) {
          addIssue(
            'warning',
            'W002',
            `STATE.md references phase ${ref}, but only phases ${[...validPhases].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).join(', ')} are declared`,
            `Review STATE.md manually before changing it; ${slash('health')} --repair will not overwrite an existing STATE.md for phase mismatches`,
          );
        }
      }
    }
  }

  if (!fs.existsSync(configPath)) {
    addIssue(
      'warning',
      'W003',
      'config.json not found',
      `Run ${slash('health')} --repair to create with defaults`,
      true,
    );
    repairs.push('createConfig');
  } else {
    try {
      const rawCfg = fs.readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(rawCfg) as Record<string, unknown>;
      const validProfiles = ['quality', 'balanced', 'budget', 'inherit'];
      if (parsed['model_profile'] && !validProfiles.includes(parsed['model_profile'] as string)) {
        addIssue(
          'warning',
          'W004',
          `config.json: invalid model_profile "${parsed['model_profile'] as string}"`,
          `Valid values: ${validProfiles.join(', ')}`,
        );
      }
    } catch (err) {
      addIssue(
        'error',
        'E005',
        `config.json: JSON parse error - ${err instanceof Error ? err.message : String(err)}`,
        `Run ${slash('health')} --repair to reset to defaults`,
        true,
      );
      repairs.push('resetConfig');
    }
  }

  if (fs.existsSync(configPath)) {
    try {
      const configRaw = fs.readFileSync(configPath, 'utf-8');
      const configParsed = JSON.parse(configRaw) as Record<string, unknown>;
      const workflow = configParsed['workflow'] as Record<string, unknown> | undefined;
      if (workflow && workflow['nyquist_validation'] === undefined) {
        addIssue(
          'warning',
          'W008',
          'config.json: workflow.nyquist_validation absent (defaults to enabled but agents may skip)',
          `Run ${slash('health')} --repair to add key`,
          true,
        );
        if (!repairs.includes('addNyquistKey')) repairs.push('addNyquistKey');
      }
      if (workflow && workflow['ai_integration_phase'] === undefined) {
        addIssue(
          'warning',
          'W016',
          `config.json: workflow.ai_integration_phase absent (defaults to enabled — run ${slash('ai-integration-phase')} before planning AI system phases)`,
          `Run ${slash('health')} --repair to add key`,
          true,
        );
        if (!repairs.includes('addAiIntegrationPhaseKey')) repairs.push('addAiIntegrationPhaseKey');
      }
    } catch {
      /* intentionally empty */
    }
  }

  let phaseDirEntries: fs.Dirent[] = [];
  const phaseDirFiles = new Map<string, string[]>();
  try {
    phaseDirEntries = fs
      .readdirSync(phasesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory());
    for (const e of phaseDirEntries) {
      try {
        phaseDirFiles.set(e.name, fs.readdirSync(path.join(phasesDir, e.name)));
      } catch {
        phaseDirFiles.set(e.name, []);
      }
    }
  } catch {
    /* intentionally empty */
  }

  for (const e of phaseDirEntries) {
    if (!e.name.match(phaseDirNameRe)) {
      addIssue(
        'warning',
        'W005',
        `Phase directory "${e.name}" doesn't follow NN-name format`,
        'Rename to match pattern (e.g., 01-setup)',
      );
    }
  }

  for (const e of phaseDirEntries) {
    const phaseFiles = phaseDirFiles.get(e.name) || [];
    const plans = phaseFiles.filter((f) => f.endsWith('-PLAN.md') || f === 'PLAN.md');
    const summaries = phaseFiles.filter((f) => f.endsWith('-SUMMARY.md') || f === 'SUMMARY.md');
    const summaryBases = new Set<string>();
    for (const s of summaries) {
      const summaryBase = s.replace('-SUMMARY.md', '').replace('SUMMARY.md', '');
      summaryBases.add(summaryBase);
      summaryBases.add(canonicalPlanStem(summaryBase));
    }

    for (const plan of plans) {
      const planBase = plan.replace('-PLAN.md', '').replace('PLAN.md', '');
      const canonicalBase = canonicalPlanStem(planBase);
      if (!summaryBases.has(planBase) && !summaryBases.has(canonicalBase)) {
        addIssue('info', 'I001', `${e.name}/${plan} has no SUMMARY.md`, 'May be in progress');
      }
    }
  }

  for (const e of phaseDirEntries) {
    const phaseFiles = phaseDirFiles.get(e.name) || [];
    const hasResearch = phaseFiles.some((f) => f.endsWith('-RESEARCH.md'));
    const hasValidation = phaseFiles.some((f) => f.endsWith('-VALIDATION.md'));
    if (hasResearch && !hasValidation) {
      const researchFile = phaseFiles.find((f) => f.endsWith('-RESEARCH.md'));
      try {
        const researchContent = fs.readFileSync(
          path.join(phasesDir, e.name, researchFile!),
          'utf-8',
        );
        if (researchContent.includes('## Validation Architecture')) {
          addIssue(
            'warning',
            'W009',
            `Phase ${e.name}: has Validation Architecture in RESEARCH.md but no VALIDATION.md`,
            `Re-run ${slash('plan-phase')} with --research to regenerate`,
          );
        }
      } catch {
        /* intentionally empty */
      }
    }
  }

  try {
    const agentStatus = checkAgentsInstalled();
    if (!agentStatus.agents_installed) {
      if ((agentStatus.installed_agents).length === 0) {
        addIssue(
          'warning',
          'W010',
          `No GSD agents found in ${agentStatus.agents_dir} — Task(subagent_type="gsd-*") will fall back to general-purpose`,
          `Run the GSD installer: npx ${PACKAGE_NAME}@latest`,
        );
      } else if ((agentStatus.incomplete_agents).length > 0 && (agentStatus.missing_agents).length === 0) {
        addIssue(
          'warning',
          'W010',
          `Incomplete agent installs (missing generated file): ${(agentStatus.incomplete_agents).join(', ')} — affected workflows may fall back to general-purpose`,
          `Re-run the GSD installer to complete the install: npx ${PACKAGE_NAME}@latest`,
        );
      } else if ((agentStatus.incomplete_agents).length > 0) {
        addIssue(
          'warning',
          'W010',
          `Missing ${(agentStatus.missing_agents).length} GSD agents: ${(agentStatus.missing_agents).join(', ')}; incomplete agent installs (missing generated file): ${(agentStatus.incomplete_agents).join(', ')} — affected workflows will fall back to general-purpose`,
          `Run the GSD installer: npx ${PACKAGE_NAME}@latest`,
        );
      } else {
        addIssue(
          'warning',
          'W010',
          `Missing ${(agentStatus.missing_agents).length} GSD agents: ${(agentStatus.missing_agents).join(', ')} — affected workflows will fall back to general-purpose`,
          `Run the GSD installer: npx ${PACKAGE_NAME}@latest`,
        );
      }
    }
  } catch {
    /* intentionally empty — agent check is non-blocking */
  }

  if (fs.existsSync(roadmapPath)) {
    const roadmapContentRaw = fs.readFileSync(roadmapPath, 'utf-8');
    const roadmapContent = extractCurrentMilestone(roadmapContentRaw, cwd);

    const { roadmapPhases } = buildRoadmapPhaseVariants(roadmapContent);
    const { roadmapPhaseVariants: fullRoadmapPhaseVariants } =
      buildRoadmapPhaseVariants(roadmapContentRaw);

    const diskPhases = collectDiskPhases(planBase);
    forEachArchivedPhaseToken(planBase, (token) => diskPhases.add(token));

    const activeDiskPhases = collectDiskPhases(planBase);

    const notStartedPhases = buildNotStartedPhaseVariants(roadmapContent);

    for (const p of roadmapPhases) {
      const variants = phaseVariants(p);
      const existsOnDisk = [...variants].some((v) => diskPhases.has(v));
      if (!existsOnDisk) {
        const isNotStarted = [...variants].some((v) => notStartedPhases.has(v));
        if (isNotStarted) continue;
        addIssue(
          'warning',
          'W006',
          `Phase ${p} in ROADMAP.md but no directory on disk`,
          'Create phase directory or remove from roadmap',
        );
      }
    }

    for (const p of activeDiskPhases) {
      const variants = phaseVariants(p);
      if (![...variants].some((v) => fullRoadmapPhaseVariants.has(v))) {
        addIssue(
          'warning',
          'W007',
          `Phase ${p} exists on disk but not in ROADMAP.md`,
          'Add to roadmap or remove directory',
        );
      }
    }
  }

  if (fs.existsSync(statePath) && fs.existsSync(roadmapPath)) {
    try {
      const stateContent = fs.readFileSync(statePath, 'utf-8');
      const roadmapContentFull = fs.readFileSync(roadmapPath, 'utf-8');

      const currentPhaseMatch =
        stateContent.match(/\*\*Current Phase:\*\*\s*(\S+)/i) ||
        stateContent.match(/Current Phase:\s*(\S+)/i);
      if (currentPhaseMatch) {
        const statePhase = currentPhaseMatch[1].replace(/^0+/, '');
        const phaseCheckboxRe = new RegExp(
          `-\\s*\\[x\\].*Phase\\s+0*${escapeRegex(statePhase)}[:\\s]`,
          'i',
        );
        if (phaseCheckboxRe.test(roadmapContentFull)) {
          const stateStatus = stateContent.match(/\*\*Status:\*\*\s*(.+)/i);
          const statusVal = stateStatus ? stateStatus[1].trim().toLowerCase() : '';
          if (statusVal !== 'complete' && statusVal !== 'done') {
            addIssue(
              'warning',
              'W011',
              `STATE.md says current phase is ${statePhase} (status: ${statusVal || 'unknown'}) but ROADMAP.md shows it as [x] complete — state files may be out of sync`,
              `Run ${slash('progress')} to re-derive current position, or manually update STATE.md`,
            );
          }
        }
      }
    } catch {
      /* intentionally empty — cross-validation is advisory */
    }
  }

  if (fs.existsSync(configPath)) {
    try {
      const configRaw = fs.readFileSync(configPath, 'utf-8');
      const configParsed = JSON.parse(configRaw) as Record<string, unknown>;

      const validStrategies = ['none', 'phase', 'milestone'];
      if (
        configParsed['branching_strategy'] &&
        !validStrategies.includes(configParsed['branching_strategy'] as string)
      ) {
        addIssue(
          'warning',
          'W012',
          `config.json: invalid branching_strategy "${configParsed['branching_strategy'] as string}"`,
          `Valid values: ${validStrategies.join(', ')}`,
        );
      }

      if (configParsed['context_window'] !== undefined) {
        const cw = configParsed['context_window'];
        if (typeof cw !== 'number' || cw <= 0 || !Number.isInteger(cw)) {
          addIssue(
            'warning',
            'W013',
            `config.json: context_window should be a positive integer, got "${cw as string}"`,
            'Set to 200000 (default) or 1000000 (for 1M models)',
          );
        }
      }

      if (
        configParsed['phase_branch_template'] &&
        !(configParsed['phase_branch_template'] as string).includes('{phase}')
      ) {
        addIssue(
          'warning',
          'W014',
          'config.json: phase_branch_template missing {phase} placeholder',
          'Template must include {phase} for phase number substitution',
        );
      }
      if (
        configParsed['milestone_branch_template'] &&
        !(configParsed['milestone_branch_template'] as string).includes('{milestone}')
      ) {
        addIssue(
          'warning',
          'W015',
          'config.json: milestone_branch_template missing {milestone} placeholder',
          'Template must include {milestone} for version substitution',
        );
      }
    } catch {
      /* parse error already caught in Check 5 */
    }
  }

  try {
    const worktreeHealth = (inspectWorktreeHealth as unknown as (
      cwd: string,
      opts: { staleAfterMs: number },
      deps: { execGit: unknown; existsSync: unknown; statSync: unknown },
    ) => Record<string, unknown>)(
      cwd,
      { staleAfterMs: 60 * 60 * 1000 },
      { execGit, existsSync: fs.existsSync, statSync: fs.statSync },
    );
    if (!(worktreeHealth['ok'] as boolean)) {
      if (worktreeHealth['reason'] === 'git_timed_out') {
        addIssue(
          'warning',
          'W020',
          'Worktree health check degraded: git worktree list timed out after 10s — orphan/stale worktrees could not be inspected',
          'Run: git worktree list --porcelain to diagnose; check for .git/index.lock or a hung git process',
        );
      }
      if (worktreeHealth['reason'] === 'git_list_failed') {
        addIssue(
          'warning',
          'W020',
          'Worktree health check degraded: git worktree list failed — orphan/stale worktrees could not be inspected',
          'Run: git worktree list --porcelain to diagnose; check git repository state and permissions',
        );
      }
    } else {
      for (const finding of worktreeHealth['findings'] as Record<string, unknown>[]) {
        if (finding['kind'] === 'orphan') {
          addIssue(
            'warning',
            'W017',
            `Orphan git worktree: ${finding['path'] as string} (path no longer exists on disk)`,
            'Run: git worktree prune',
          );
          continue;
        }

        if (finding['kind'] === 'stale') {
          addIssue(
            'warning',
            'W017',
            `Stale git worktree: ${finding['path'] as string} (last modified ${finding['ageMinutes'] as number} minutes ago)`,
            `Run: git worktree remove ${finding['path'] as string} --force`,
          );
        }
      }
    }
  } catch {
    /* git worktree not available or not a git repo — skip silently */
  }

  try {
    const phaseConvention = (() => {
      if (!fs.existsSync(configPath)) return null;
      try {
        const configRaw = fs.readFileSync(configPath, 'utf-8');
        const configParsed = JSON.parse(configRaw) as Record<string, unknown>;
        return (configParsed['phase_id_convention'] as string | undefined) || null;
      } catch {
        return null;
      }
    })();
    if (phaseConvention === 'milestone-prefixed') {
      if (fs.existsSync(roadmapPath)) {
        const roadmapContent = fs.readFileSync(roadmapPath, 'utf-8');
        const { getMilestoneFromPhaseId } = core;
        const mismatches = checkMilestonePrefixMismatches(roadmapContent, {
          getMilestoneFromPhaseId: getMilestoneFromPhaseId,
        });
        for (const mm of mismatches) {
          addIssue(
            'warning',
            'W021',
            `Phase ${mm.phaseId}: integer prefix implies ${mm.expectedMilestone} but listed under ${mm.foundInMilestone}`,
            'Run `gsd-tools roadmap upgrade --convention milestone-prefixed` to migrate (dry-run by default)',
          );
        }
      }
    }
  } catch {
    /* W021 check is advisory — skip on error */
  }

  const milestonesPath = path.join(planBase, 'MILESTONES.md');
  const milestonesArchiveDir = path.join(planBase, 'milestones');
  const missingFromRegistry: string[] = [];
  try {
    if (fs.existsSync(milestonesArchiveDir)) {
      const archiveFiles = fs.readdirSync(milestonesArchiveDir);
      const archivedVersions = archiveFiles
        .map((f) => f.match(/^(v\d+\.\d+(?:\.\d+)?)-ROADMAP\.md$/))
        .filter(Boolean)
        .map((m) => m![1]);

      if (archivedVersions.length > 0) {
        const registryContent = fs.existsSync(milestonesPath)
          ? fs.readFileSync(milestonesPath, 'utf-8')
          : '';
        for (const ver of archivedVersions) {
          if (!registryContent.includes(`## ${ver}`)) {
            missingFromRegistry.push(ver);
          }
        }
        if (missingFromRegistry.length > 0) {
          addIssue(
            'warning',
            'W018',
            `MILESTONES.md missing ${missingFromRegistry.length} archived milestone(s): ${missingFromRegistry.join(', ')}`,
            `Run ${slash('health')} --backfill to synthesize missing entries from archive snapshots`,
            true,
          );
          repairs.push('backfillMilestones');
        }
      }
    }
  } catch {
    /* intentionally empty — milestone sync check is advisory */
  }

  try {
    const entries = fs.readdirSync(planBase, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.md')) continue;
      if (!isCanonicalPlanningFile(entry.name)) {
        addIssue(
          'warning',
          'W019',
          `Unrecognized .planning/ file: ${entry.name} — not a canonical GSD artifact`,
          'Move to .planning/milestones/ archive subdir or delete if stale. See templates/README.md for the canonical artifact list.',
          false,
        );
      }
    }
  } catch {
    /* artifact check is advisory — skip on error */
  }

  try {
    if (fs.existsSync(statePath) && fs.existsSync(roadmapPath)) {
      const stateRaw = fs.readFileSync(statePath, 'utf-8');
      const statusMatch = stateRaw.match(/^status:\s*(.+)/im);
      const stateStatus = statusMatch ? statusMatch[1].trim().toLowerCase() : '';
      const isMarkedComplete = /milestone complete|archived/.test(stateStatus);
      if (isMarkedComplete) {
        const roadmapRaw = fs.readFileSync(roadmapPath, 'utf-8');
        const scopedContent = extractCurrentMilestone(roadmapRaw, cwd);
        const phasePattern = /#{2,4}\s*Phase\s+(\d+[A-Z]?(?:\.\d+)*)\s*:\s*([^\n]+)/gi;
        const unstarted: string[] = [];
        let pm: RegExpExecArray | null;
        // Non-hoisted: load-order matters (circular dep guard)
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- planning-workspace.cjs is an export= CommonJS module
        const planningWorkspace2 = require('./planning-workspace.cjs') as typeof planningWorkspace;
        const phasesDir2 = planningWorkspace2.planningPaths(cwd).phases;
        const phaseDirNames2 = (() => {
          try {
            return fs
              .readdirSync(phasesDir2, { withFileTypes: true })
              .filter((e) => e.isDirectory())
              .map((e) => e.name);
          } catch {
            return [];
          }
        })();
        while ((pm = phasePattern.exec(scopedContent)) !== null) {
          const phaseNum = pm[1];
          const normalizedPh = normalizePhaseName(phaseNum);
          const hasDirectory = phaseDirNames2.some((d) => phaseTokenMatches(d, normalizedPh));
          if (!hasDirectory) {
            unstarted.push(phaseNum);
          }
        }
        if (unstarted.length > 0) {
          addIssue(
            'warning',
            'W021',
            `STATE says milestone complete but ROADMAP lists ${unstarted.length} unstarted phase(s) (e.g. Phase ${unstarted[0]})`,
            'Run validate consistency or re-run complete-milestone after verifying all phases are done',
          );
        }
      }
    }
  } catch {
    /* W021 check is advisory — skip on error */
  }

  // ─── Perform repairs if requested ─────────────────────────────────────────
  const repairActions: Record<string, unknown>[] = [];
  if (options['repair'] && repairs.length > 0) {
    for (const repair of repairs) {
      try {
        switch (repair) {
          case 'createConfig':
          case 'resetConfig': {
            const defaults = {
              model_profile: CONFIG_DEFAULTS.model_profile,
              commit_docs: CONFIG_DEFAULTS.commit_docs,
              search_gitignored: CONFIG_DEFAULTS.search_gitignored,
              branching_strategy: CONFIG_DEFAULTS.branching_strategy,
              phase_branch_template: CONFIG_DEFAULTS.phase_branch_template,
              milestone_branch_template: CONFIG_DEFAULTS.milestone_branch_template,
              quick_branch_template: CONFIG_DEFAULTS.quick_branch_template,
              workflow: {
                research: CONFIG_DEFAULTS.research,
                plan_check: CONFIG_DEFAULTS.plan_checker,
                verifier: CONFIG_DEFAULTS.verifier,
                nyquist_validation: CONFIG_DEFAULTS.nyquist_validation,
              },
              parallelization: CONFIG_DEFAULTS.parallelization,
              brave_search: CONFIG_DEFAULTS.brave_search,
            };
            platformWriteSync(configPath, JSON.stringify(defaults, null, 2));
            repairActions.push({ action: repair, success: true, path: 'config.json' });
            break;
          }
          case 'regenerateState': {
            if (fs.existsSync(statePath)) {
              const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
              const backupPath = `${statePath}.bak-${timestamp}`;
              fs.copyFileSync(statePath, backupPath);
              repairActions.push({ action: 'backupState', success: true, path: backupPath });
            }
            const milestone = getMilestoneInfo(cwd);
            const projectRef = path
              .relative(cwd, path.join(planningDir(cwd), 'PROJECT.md'))
              .split(path.sep)
              .join('/');
            let stateContent = `# Session State\n\n`;
            stateContent += `## Project Reference\n\n`;
            stateContent += `See: ${projectRef}\n\n`;
            stateContent += `## Position\n\n`;
            stateContent += `**Milestone:** ${milestone.version} ${milestone.name}\n`;
            stateContent += `**Current phase:** (determining...)\n`;
            stateContent += `**Status:** Resuming\n\n`;
            stateContent += `## Session Log\n\n`;
            stateContent += `- ${new Date().toISOString().split('T')[0]}: STATE.md regenerated by ${slash('health')} --repair\n`;
            writeStateMd(statePath, stateContent, cwd);
            repairActions.push({ action: repair, success: true, path: 'STATE.md' });
            break;
          }
          case 'addNyquistKey': {
            if (fs.existsSync(configPath)) {
              try {
                const configRaw = fs.readFileSync(configPath, 'utf-8');
                const configParsed = JSON.parse(configRaw) as Record<string, unknown>;
                if (!configParsed['workflow']) configParsed['workflow'] = {};
                const wf = configParsed['workflow'] as Record<string, unknown>;
                if (wf['nyquist_validation'] === undefined) {
                  wf['nyquist_validation'] = true;
                  platformWriteSync(configPath, JSON.stringify(configParsed, null, 2));
                }
                repairActions.push({ action: repair, success: true, path: 'config.json' });
              } catch (err) {
                repairActions.push({
                  action: repair,
                  success: false,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            }
            break;
          }
          case 'addAiIntegrationPhaseKey': {
            if (fs.existsSync(configPath)) {
              try {
                const configRaw = fs.readFileSync(configPath, 'utf-8');
                const configParsed = JSON.parse(configRaw) as Record<string, unknown>;
                if (!configParsed['workflow']) configParsed['workflow'] = {};
                const wf = configParsed['workflow'] as Record<string, unknown>;
                if (wf['ai_integration_phase'] === undefined) {
                  wf['ai_integration_phase'] = true;
                  platformWriteSync(configPath, JSON.stringify(configParsed, null, 2));
                }
                repairActions.push({ action: repair, success: true, path: 'config.json' });
              } catch (err) {
                repairActions.push({
                  action: repair,
                  success: false,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            }
            break;
          }
          case 'backfillMilestones': {
            if (!options['backfill'] && !options['repair']) break;
            const today = new Date().toISOString().split('T')[0];
            let backfilled = 0;
            for (const ver of missingFromRegistry) {
              try {
                const snapshotPath = path.join(milestonesArchiveDir, `${ver}-ROADMAP.md`);
                const snapshot = safeReadFile(snapshotPath);
                const titleMatch = snapshot && snapshot.match(/^#\s+(.+)$/m);
                const milestoneName = titleMatch
                  ? titleMatch[1].replace(/^Milestone\s+/i, '').replace(/^v[\d.]+\s*/, '').trim()
                  : ver;
                const entry =
                  `## ${ver}${milestoneName && milestoneName !== ver ? ` ${milestoneName}` : ''} (Backfilled: ${today})\n\n**Note:** Synthesized from archive snapshot by \`${slash('health')} --backfill\`. Original completion date unknown.\n\n---\n\n`;
                const milestonesContent = fs.existsSync(milestonesPath)
                  ? fs.readFileSync(milestonesPath, 'utf-8')
                  : '';
                if (!milestonesContent.trim()) {
                  platformWriteSync(milestonesPath, `# Milestones\n\n${entry}`);
                } else {
                  const headerMatch = milestonesContent.match(/^(#{1,3}\s+[^\n]*\n\n?)/);
                  if (headerMatch) {
                    const header = headerMatch[1];
                    const rest = milestonesContent.slice(header.length);
                    platformWriteSync(milestonesPath, header + entry + rest);
                  } else {
                    platformWriteSync(milestonesPath, entry + milestonesContent);
                  }
                }
                backfilled++;
              } catch {
                /* intentionally empty — partial backfill is acceptable */
              }
            }
            repairActions.push({
              action: repair,
              success: true,
              detail: `Backfilled ${backfilled} milestone(s) into MILESTONES.md`,
            });
            break;
          }
        }
      } catch (err) {
        repairActions.push({
          action: repair,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  let status: string;
  if (errors.length > 0) {
    status = 'broken';
  } else if (warnings.length > 0) {
    status = 'degraded';
  } else {
    status = 'healthy';
  }

  const repairableCount =
    errors.filter((e) => e.repairable).length + warnings.filter((w) => w.repairable).length;

  const result: Record<string, unknown> = {
    status,
    errors,
    warnings,
    info,
    repairable_count: repairableCount,
    repairs_performed: repairActions.length > 0 ? repairActions : undefined,
  };
  output(result, raw);
  return result;
}

function cmdValidateAgents(cwd: string, raw: boolean): void {
  const agentStatus = checkAgentsInstalled();
  const expected = Object.keys(MODEL_PROFILES);

  output(
    {
      agents_dir: agentStatus.agents_dir,
      agents_found: agentStatus.agents_installed,
      installed: agentStatus.installed_agents,
      missing: agentStatus.missing_agents,
      incomplete: agentStatus.incomplete_agents,
      expected,
    },
    raw,
  );
}

function cmdVerifySchemaDrift(
  cwd: string,
  phaseArg: string,
  skipFlag: boolean | undefined,
  raw: boolean,
): void {
  if (!phaseArg) {
    error('Usage: verify schema-drift <phase> [--skip]');
    return;
  }

  const pDir = planningDir(cwd);
  const phasesDir = path.join(pDir, 'phases');
  if (!fs.existsSync(phasesDir)) {
    output({ drift_detected: false, blocking: false, message: 'No phases directory' }, raw);
    return;
  }

  let phaseDir: string | null = null;
  const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.includes(phaseArg)) {
      phaseDir = path.join(phasesDir, entry.name);
      break;
    }
  }

  if (!phaseDir) {
    const exact = path.join(phasesDir, phaseArg);
    if (fs.existsSync(exact)) phaseDir = exact;
  }

  if (!phaseDir) {
    output(
      { drift_detected: false, blocking: false, message: `Phase directory not found: ${phaseArg}` },
      raw,
    );
    return;
  }

  const allFiles: string[] = [];
  const planFiles = fs.readdirSync(phaseDir).filter((f) => f.endsWith('-PLAN.md'));
  for (const pf of planFiles) {
    const content = fs.readFileSync(path.join(phaseDir, pf), 'utf-8');
    const fmMatch = content.match(/files_modified:\s*\[([^\]]*)\]/);
    if (fmMatch) {
      const files = fmMatch[1].split(',').map((f) => f.trim()).filter(Boolean);
      allFiles.push(...files);
    }
  }

  let executionLog = '';
  const summaryFiles = fs.readdirSync(phaseDir).filter((f) => f.endsWith('-SUMMARY.md'));
  for (const sf of summaryFiles) {
    executionLog += fs.readFileSync(path.join(phaseDir, sf), 'utf-8') + '\n';
  }

  const gitLog = execGit(['log', '--oneline', '--all', '-50'], { cwd }) as unknown as { exitCode: number; stdout: string };
  if (gitLog.exitCode === 0) {
    executionLog += '\n' + gitLog.stdout;
  }

  const result = checkSchemaDrift(allFiles, executionLog, { skipCheck: !!skipFlag }) as unknown as Record<string, unknown>;

  output(
    {
      drift_detected: result['driftDetected'],
      blocking: result['blocking'],
      schema_files: result['schemaFiles'],
      orms: result['orms'],
      unpushed_orms: result['unpushedOrms'],
      message: result['message'],
      skipped: result['skipped'] || false,
    },
    raw,
  );
}

function cmdVerifyCodebaseDrift(cwd: string, raw: boolean): void {
  // Non-hoisted: load-order matters for circular dep guard
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- drift.cjs is an export= CommonJS module
  const drift = require('./drift.cjs') as Record<string, unknown>;

  const emit = (payload: unknown) => output(payload, raw);

  try {
    const codebaseDir = path.join(planningDir(cwd), 'codebase');
    const structurePath = path.join(codebaseDir, 'STRUCTURE.md');
    if (!fs.existsSync(structurePath)) {
      emit({
        skipped: true,
        reason: 'no-structure-md',
        action_required: false,
        directive: 'none',
        elements: [],
      });
      return;
    }

    let structureMd: string;
    try {
      structureMd = fs.readFileSync(structurePath, 'utf-8');
    } catch (err) {
      emit({
        skipped: true,
        reason: 'cannot-read-structure-md: ' + (err instanceof Error ? err.message : String(err)),
        action_required: false,
        directive: 'none',
        elements: [],
      });
      return;
    }

    const lastMapped = (drift['readMappedCommit'] as (p: string) => string | null)(structurePath);

    const revProbe = execGit(['rev-parse', 'HEAD'], { cwd }) as unknown as { exitCode: number; stdout: string };
    if (revProbe.exitCode !== 0) {
      emit({
        skipped: true,
        reason: 'not-a-git-repo',
        action_required: false,
        directive: 'none',
        elements: [],
      });
      return;
    }

    const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
    let base = lastMapped;
    if (!base) {
      base = EMPTY_TREE;
    } else {
      const verify = execGit(['cat-file', '-t', base], { cwd }) as unknown as { exitCode: number; stdout: string };
      if (verify.exitCode !== 0) base = EMPTY_TREE;
    }

    const diff = execGit(['diff', '--name-status', base, 'HEAD'], { cwd }) as unknown as { exitCode: number; stdout: string };
    if (diff.exitCode !== 0) {
      emit({
        skipped: true,
        reason: 'git-diff-failed',
        action_required: false,
        directive: 'none',
        elements: [],
      });
      return;
    }

    const added: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];
    for (const line of diff.stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const m = line.match(/^([A-Z])\d*\t(.+?)(?:\t(.+))?$/);
      if (!m) continue;
      const status = m[1];
      const file = m[3] || m[2];
      if (status === 'A' || status === 'R' || status === 'C') added.push(file);
      else if (status === 'M') modified.push(file);
      else if (status === 'D') deleted.push(file);
    }

    const config = loadConfig(cwd);
    const wf = config?.workflow as Record<string, unknown> | undefined;
    const threshold =
      Number.isInteger(wf?.drift_threshold) && (wf?.drift_threshold as number) >= 1
        ? (wf?.drift_threshold as number)
        : 3;
    const action = wf?.drift_action === 'auto-remap' ? 'auto-remap' : 'warn';

    const driftResult = (drift['detectDrift'] as (opts: unknown) => Record<string, unknown>)({
      addedFiles: added,
      modifiedFiles: modified,
      deletedFiles: deleted,
      structureMd,
      threshold,
      action,
      runtime: resolveRuntime(cwd),
    });

    emit({
      skipped: !!driftResult['skipped'],
      reason: driftResult['reason'] || null,
      action_required: !!driftResult['actionRequired'],
      directive: driftResult['directive'],
      spawn_mapper: !!driftResult['spawnMapper'],
      affected_paths: driftResult['affectedPaths'] || [],
      elements: driftResult['elements'] || [],
      threshold,
      action,
      last_mapped_commit: lastMapped,
      message: driftResult['message'] || '',
    });
  } catch (err) {
    emit({
      skipped: true,
      reason: 'exception: ' + (err && err instanceof Error ? err.message : String(err)),
      action_required: false,
      directive: 'none',
      elements: [],
    });
  }
}

export = {
  scanNegativeGrepCommentEcho,
  cmdVerifySummary,
  cmdVerifyPlanStructure,
  cmdVerifyPhaseCompleteness,
  cmdVerifyReferences,
  cmdVerifyCommits,
  cmdVerifyArtifacts,
  cmdVerifyKeyLinks,
  cmdValidateConsistency,
  cmdValidateHealth,
  cmdValidateAgents,
  cmdVerifySchemaDrift,
  cmdVerifyCodebaseDrift,
};
