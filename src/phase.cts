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
// eslint-disable-next-line @typescript-eslint/no-require-imports -- core.cjs is an export= CommonJS module
import core = require('./core.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- planning-workspace.cjs is an export= CommonJS module
import planningWorkspace = require('./planning-workspace.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- frontmatter.cjs is an export= CommonJS module
import frontmatterMod = require('./frontmatter.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- state.cjs is an export= CommonJS module
import stateMod = require('./state.cjs');
import { platformWriteSync, platformReadSync, platformEnsureDir } from './shell-command-projection.cjs';
import { formatGsdSlash, resolveRuntime } from './runtime-slash.cjs';
import { deriveProgressFromRoadmap, clampPercent } from './phase-lifecycle.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- uat-predicate.cjs is an export= CommonJS module
import uatPredicate = require('./uat-predicate.cjs');
const { evaluateUatPassed } = uatPredicate;

const {
  escapeRegex,
  loadConfig,
  normalizePhaseName,
  phaseMarkdownRegexSource,
  comparePhaseNum,
  findPhaseInternal,
  getArchivedPhaseDirs,
  generateSlugInternal,
  getMilestonePhaseFilter,
  stripShippedMilestones,
  extractCurrentMilestone,
  replaceInCurrentMilestone,
  toPosixPath,
  output,
  error,
  readSubdirectories,
  phaseTokenMatches,
  ERROR_REASON,
} = core;

const { planningDir, withPlanningLock } = planningWorkspace;
const { extractFrontmatter } = frontmatterMod;
const {
  readModifyWriteStateMd,
  stateExtractField,
  stateReplaceField,
  stateReplaceFieldWithFallback,
  syncStateFrontmatter,
  withStateLock,
  updatePerformanceMetricsSection,
} = stateMod;

// Unused import silences TS — keep for structural parity with .cjs (stripShippedMilestones,
// replaceInCurrentMilestone are exported from core but only used in phase.cjs as-is).
void stripShippedMilestones;
void replaceInCurrentMilestone;

// #2893 — strict canonical filter: `{padded_phase}-{NN}-PLAN.md` or `PLAN.md`.
const isCanonicalPlanFile = (f: string): boolean => f.endsWith('-PLAN.md') || f === 'PLAN.md';

// Any .md file with PLAN anywhere in the basename — diagnostic net
const PLAN_OUTLINE_RE = /-PLAN-OUTLINE\.md$/i;
const PLAN_PRE_BOUNCE_RE = /-PLAN.*\.pre-bounce\.md$/i;
const looksLikePlanFile = (f: string): boolean =>
  /\.md$/i.test(f) &&
  /PLAN/i.test(f) &&
  !PLAN_OUTLINE_RE.test(f) &&
  !PLAN_PRE_BOUNCE_RE.test(f);

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

function extractCanonicalPlanId(filename: string): string {
  const base = filename
    .replace(/-PLAN\.md$/i, '')
    .replace(/-SUMMARY\.md$/i, '')
    .replace(/\.md$/i, '');
  const parts = base.split('-').filter(Boolean);
  const tokenRe = /^\d+[A-Z]?(?:\.\d+)*$/i;
  const phaseIdx = parts.findIndex((p) => tokenRe.test(p));
  if (phaseIdx >= 0 && phaseIdx + 1 < parts.length && tokenRe.test(parts[phaseIdx + 1])) {
    return `${parts[phaseIdx]}-${parts[phaseIdx + 1]}`;
  }
  return base;
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
    const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
    let dirs: string[] = entries.filter((e) => e.isDirectory()).map((e) => e.name);

    if (includeArchived) {
      const archived = getArchivedPhaseDirs(cwd);
      for (const a of archived) {
        dirs.push(`${a.name} [${a.milestone}]`);
      }
    }

    dirs.sort((a, b) => comparePhaseNum(a, b));

    if (phase) {
      const normalized = normalizePhaseName(phase);
      const match = dirs.find((d) => phaseTokenMatches(d, normalized));
      if (!match) {
        output({ files: [], count: 0, phase_dir: null, error: 'Phase not found' }, raw, '');
        return;
      }
      dirs = [match];
    }

    if (type) {
      const files: string[] = [];
      const warnings: string[] = [];
      for (const dir of dirs) {
        const dirPath = path.join(phasesDir, dir);
        const dirFiles = fs.readdirSync(dirPath);

        let filtered: string[];
        if (type === 'plans') {
          filtered = dirFiles.filter(isCanonicalPlanFile);
          const w = describeNonCanonicalPlans(dirFiles, filtered);
          if (w) warnings.push(`${dir}: ${w}`);
        } else if (type === 'summaries') {
          filtered = dirFiles.filter((f) => f.endsWith('-SUMMARY.md') || f === 'SUMMARY.md');
        } else {
          filtered = dirFiles;
        }

        files.push(...filtered.sort());
      }

      const result: Record<string, unknown> = {
        files,
        count: files.length,
        phase_dir: phase ? dirs[0].replace(/^\d+(?:\.\d+)*-?/, '') : null,
      };
      if (warnings.length) result['warning'] = warnings.join(' | ');
      output(result, raw, files.join('\n'));
      return;
    }

    output({ directories: dirs, count: dirs.length }, raw, dirs.join('\n'));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    error('Failed to list phases: ' + msg);
  }
}

function cmdPhaseNextDecimal(cwd: string, basePhase: string, raw: boolean): void {
  const phasesDir = path.join(planningDir(cwd), 'phases');
  const normalized = normalizePhaseName(basePhase);

  try {
    let baseExists = false;
    const decimalSet = new Set<number>();

    if (fs.existsSync(phasesDir)) {
      const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
      const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
      baseExists = dirs.some((d) => phaseTokenMatches(d, normalized));

      const dirPattern = new RegExp(`^(?:[A-Z]{1,6}-)?${escapeRegex(normalized)}\\.(\\d+)`);
      for (const dir of dirs) {
        const match = dir.match(dirPattern);
        if (match) decimalSet.add(parseInt(match[1], 10));
      }
    }

    const roadmapPath = path.join(planningDir(cwd), 'ROADMAP.md');
    if (fs.existsSync(roadmapPath)) {
      try {
        const roadmapContent = fs.readFileSync(roadmapPath, 'utf-8');
        const phasePattern = new RegExp(
          `#{2,4}\\s*Phase\\s+${phaseMarkdownRegexSource(normalized)}\\.(\\d+)\\s*:`,
          'gi',
        );
        let pm: RegExpExecArray | null;
        while ((pm = phasePattern.exec(roadmapContent)) !== null) {
          decimalSet.add(parseInt(pm[1], 10));
        }
      } catch {
        /* ROADMAP.md read failure is non-fatal */
      }
    }

    const existingDecimals = Array.from(decimalSet)
      .sort((a, b) => a - b)
      .map((n) => `${normalized}.${n}`);

    let nextDecimal: string;
    if (decimalSet.size === 0) {
      nextDecimal = `${normalized}.1`;
    } else {
      nextDecimal = `${normalized}.${Math.max(...decimalSet) + 1}`;
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
  const escapedPhase = phaseMarkdownRegexSource(phaseNum);
  const phaseHeader = new RegExp(`#{2,4}\\s*Phase\\s+${escapedPhase}\\s*:`, 'i');

  for (const content of [milestoneContent, fullContent]) {
    const headerMatch = content.match(phaseHeader);
    if (!headerMatch || headerMatch.index === undefined) continue;

    const sectionStart = headerMatch.index;
    const rest = content.slice(sectionStart);
    const nextHeader = rest.slice(headerMatch[0].length).match(/\n#{2,4}\s+Phase\s+\S/i);
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

function cmdFindPhase(cwd: string, phase: string, raw: boolean): void {
  if (!phase) {
    error('phase identifier required');
  }

  const planBase = planningDir(cwd);
  const normalized = normalizePhaseName(phase);
  const notFound = {
    found: false,
    directory: null,
    phase_number: null,
    phase_name: null,
    plans: [],
    summaries: [],
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

      const match = dirs.find((d) => phaseTokenMatches(d, normalized));
      if (!match) continue;

      const dirMatch =
        match.match(/^(?:[A-Z]{1,6}-)(\d+[A-Z]?(?:\.\d+)*)-?(.*)/i) ||
        match.match(/^(\d+[A-Z]?(?:\.\d+)*)-?(.*)/i);
      const phaseNumber = dirMatch ? dirMatch[1] : normalized;
      const phaseName = dirMatch && dirMatch[2] ? dirMatch[2] : null;

      const phaseDir = path.join(searchDir, match);
      const phaseFiles = fs.readdirSync(phaseDir);
      const plans = phaseFiles.filter(isCanonicalPlanFile).sort();
      const summaries = phaseFiles.filter((f) => f.endsWith('-SUMMARY.md') || f === 'SUMMARY.md').sort();
      const planNamingWarning = describeNonCanonicalPlans(phaseFiles, plans);

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

function extractObjective(content: string): string | null {
  const m = content.match(/<objective>\s*\n?\s*(.+)/);
  return m ? m[1].trim() : null;
}

interface RawPlan {
  id: string;
  declaredWave: number | null;
  dependsOn: string[];
  autonomous: boolean;
  objective: string | null;
  filesModified: string[];
  taskCount: number;
  hasSummary: boolean;
}

// O(V + E). Assigns each in-phase plan its longest-path topological level over the
// in-phase dependsOn DAG (Kahn's algorithm). Returns { level: Map<id,number>, visited: number }.
// visited < rawPlans.length signals a dependency cycle.
function computeDependencyLevels(
  rawPlans: RawPlan[],
  planMap: Map<string, RawPlan>,
  canonicalToId: Map<string, string>,
): { level: Map<string, number>; visited: number } {
  const level = new Map<string, number>();
  const inDeg = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const p of rawPlans) {
    if (!inDeg.has(p.id)) inDeg.set(p.id, 0);
    if (!adj.has(p.id)) adj.set(p.id, []);
    for (const dep of p.dependsOn) {
      const depLower = dep.toLowerCase();
      const resolvedDep = planMap.has(depLower)
        ? (planMap.get(depLower) as RawPlan).id
        : canonicalToId.get(depLower);
      if (!resolvedDep) continue;
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

  return { level, visited };
}

function cmdPhasePlanIndex(cwd: string, phase: string, raw: boolean): void {
  if (!phase) {
    error('phase required for phase-plan-index');
  }

  const phasesDir = path.join(planningDir(cwd), 'phases');
  const normalized = normalizePhaseName(phase);

  let phaseDir: string | null = null;
  let phaseDirName: string | null = null;
  try {
    const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => comparePhaseNum(a, b));
    const match = dirs.find((d) => phaseTokenMatches(d, normalized));
    if (match) {
      phaseDir = path.join(phasesDir, match);
      phaseDirName = match;
    }
  } catch {
    // phases dir doesn't exist
  }

  if (!phaseDir) {
    output(
      { phase: normalized, error: 'Phase not found', plans: [], waves: {}, incomplete: [], has_checkpoints: false },
      raw,
    );
    return;
  }
  void phaseDirName; // used only to set phaseDir above

  const phaseFiles = fs.readdirSync(phaseDir);
  const planFiles = phaseFiles.filter(isCanonicalPlanFile).sort();
  const summaryFiles = phaseFiles.filter((f) => f.endsWith('-SUMMARY.md') || f === 'SUMMARY.md');
  const planNamingWarning = describeNonCanonicalPlans(phaseFiles, planFiles);

  const completedPlanIds = new Set(
    summaryFiles.flatMap((s) => {
      const exact = s.replace('-SUMMARY.md', '').replace('SUMMARY.md', '');
      const canonical = extractCanonicalPlanId(s);
      return canonical === exact ? [exact] : [exact, canonical];
    }),
  );

  // ── Pass 1: parse each plan file ─────────────────────────────────────────

  const rawPlans: RawPlan[] = [];

  for (const planFile of planFiles) {
    const planId = planFile.replace('-PLAN.md', '').replace('PLAN.md', '');
    const planPath = path.join(phaseDir, planFile);
    const content = fs.readFileSync(planPath, 'utf-8');
    const fm = extractFrontmatter(content);

    const xmlTasks = content.match(/<task[\s>]/gi) || [];
    const mdTasks = content.match(/##\s*Task\s*\d+/gi) || [];
    const taskCount = xmlTasks.length || mdTasks.length;

    const parsedWave = parseInt(fm['wave'] as string, 10);
    const declaredWave = Number.isNaN(parsedWave) ? null : parsedWave;

    let dependsOn: string[] = [];
    const fmDeps = fm['depends_on'];
    if (Array.isArray(fmDeps)) {
      dependsOn = fmDeps.map(String);
    } else if (typeof fmDeps === 'string' && fmDeps.trim() !== '') {
      dependsOn = [fmDeps];
    }

    let autonomous = true;
    if (fm['autonomous'] !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-base-to-string -- FrontmatterValue comparison
      autonomous = fm['autonomous'] === 'true' || String(fm['autonomous']) === 'true';
    }

    let filesModified: string[] = [];
    const fmFiles = fm['files_modified'] || fm['files-modified'];
    if (fmFiles) {
      // eslint-disable-next-line @typescript-eslint/no-base-to-string -- FrontmatterValue scalar-to-string
      filesModified = Array.isArray(fmFiles) ? fmFiles.map(String) : [String(fmFiles)];
    }

    const hasSummary =
      completedPlanIds.has(planId) || completedPlanIds.has(extractCanonicalPlanId(planFile));

    rawPlans.push({
      id: planId,
      declaredWave,
      dependsOn,
      autonomous,
      objective: extractObjective(content) || (fm['objective'] as string | null) || null,
      filesModified,
      taskCount,
      hasSummary,
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

  const { level, visited } = computeDependencyLevels(rawPlans, planMap, canonicalToId);

  if (visited < rawPlans.length) {
    const cycleNodes = rawPlans.filter((p) => !level.has(p.id)).map((p) => p.id);
    error(
      `depends_on cycle detected in phase ${normalized} — cycle involves: ${cycleNodes.join(', ')}`,
    );
    return;
  }

  // ── Pass 3: determine lowest bucket key and build output ─────────────────

  const anyWaveZero = rawPlans.some((p) => p.declaredWave === 0);
  const levelOffset = anyWaveZero ? 0 : 1;

  const plans: Record<string, unknown>[] = [];
  const waves: Record<string, string[]> = {};
  const incomplete: string[] = [];
  let hasCheckpoints = false;
  const warnings: string[] = [];

  for (const rawPlan of rawPlans) {
    if (!rawPlan.autonomous) {
      hasCheckpoints = true;
    }
    if (!rawPlan.hasSummary) {
      incomplete.push(rawPlan.id);
    }

    const computedWave = (level.get(rawPlan.id) ?? 0) + levelOffset;
    const effectiveWave = computedWave;
    if (rawPlan.declaredWave !== null && rawPlan.declaredWave !== computedWave) {
      warnings.push(
        `Plan ${rawPlan.id}: declared wave: ${rawPlan.declaredWave} but depends_on DAG places it in wave ${computedWave}`,
      );
    }

    const plan: Record<string, unknown> = {
      id: rawPlan.id,
      wave: effectiveWave,
      depends_on: rawPlan.dependsOn.map((dep) => {
        const lower = String(dep).toLowerCase();
        return planMap.has(lower) ? (planMap.get(lower) as RawPlan).id : dep;
      }),
      autonomous: rawPlan.autonomous,
      objective: rawPlan.objective,
      files_modified: rawPlan.filesModified,
      task_count: rawPlan.taskCount,
      has_summary: rawPlan.hasSummary,
    };

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
    has_checkpoints: hasCheckpoints,
  };
  if (planNamingWarning) result['warning'] = planNamingWarning;
  if (warnings.length > 0) result['warnings'] = warnings;

  output(result, raw);
}

function cmdPhaseAdd(cwd: string, description: string, raw: boolean, customId?: string): void {
  if (!description) {
    error('description required for phase add');
  }

  const config = loadConfig(cwd);
  const roadmapPath = path.join(planningDir(cwd), 'ROADMAP.md');
  if (!fs.existsSync(roadmapPath)) {
    error('ROADMAP.md not found');
  }

  const slug = generateSlugInternal(description) || '';

  const { newPhaseId, dirName } = withPlanningLock(cwd, () => {
    const rawContent = fs.readFileSync(roadmapPath, 'utf-8');
    const content = extractCurrentMilestone(rawContent, cwd);

    const projectCode = (config.project_code as string) || '';
    const prefix = projectCode ? `${projectCode}-` : '';

    let _newPhaseId: number | string;
    let _dirName: string;

    if (customId || config.phase_naming === 'custom') {
      _newPhaseId = customId || slug.toUpperCase();
      if (!_newPhaseId) error('--id required when phase_naming is "custom"');
      _dirName = `${prefix}${_newPhaseId}-${slug}`;
    } else {
      const phasePattern = /#{2,4}\s*Phase\s+(\d+)[A-Z]?(?:\.\d+)*:/gi;
      let maxPhase = 0;
      let m: RegExpExecArray | null;
      while ((m = phasePattern.exec(content)) !== null) {
        const num = parseInt(m[1], 10);
        if (num === 999) continue;
        if (num > maxPhase) maxPhase = num;
      }

      const phasesOnDisk = path.join(planningDir(cwd), 'phases');
      if (fs.existsSync(phasesOnDisk)) {
        const dirNumPattern = /^(?:[A-Z][A-Z0-9]*-)?(\d+)-/;
        for (const entry of fs.readdirSync(phasesOnDisk)) {
          const match = entry.match(dirNumPattern);
          if (!match) continue;
          const num = parseInt(match[1], 10);
          if (num === 999) continue;
          if (num > maxPhase) maxPhase = num;
        }
      }

      _newPhaseId = maxPhase + 1;
      const paddedNum = String(_newPhaseId).padStart(2, '0');
      _dirName = `${prefix}${paddedNum}-${slug}`;
    }

    const dirPath = path.join(planningDir(cwd), 'phases', _dirName);

    platformEnsureDir(dirPath);
    platformWriteSync(path.join(dirPath, '.gitkeep'), '');

    const dependsOn =
      config.phase_naming === 'custom'
        ? ''
        : `\n**Depends on:** Phase ${typeof _newPhaseId === 'number' ? _newPhaseId - 1 : 'TBD'}`;
    const phaseEntry =
      `\n### Phase ${_newPhaseId}: ${description}\n\n**Goal:** [To be planned]\n**Requirements**: TBD${dependsOn}\n**Plans:** 0 plans\n\nPlans:\n- [ ] TBD (run ${formatGsdSlash('plan-phase', resolveRuntime(cwd)) as string} ${_newPhaseId} to break down)\n`;

    let updatedContent: string;
    const lastSeparator = rawContent.lastIndexOf('\n---');
    if (lastSeparator > 0) {
      updatedContent = rawContent.slice(0, lastSeparator) + phaseEntry + rawContent.slice(lastSeparator);
    } else {
      updatedContent = rawContent + phaseEntry;
    }

    platformWriteSync(roadmapPath, updatedContent);
    return { newPhaseId: _newPhaseId, dirName: _dirName };
  });

  const result = {
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

  output(result, raw, result.padded);
}

function cmdPhaseAddBatch(cwd: string, descriptions: string[], raw: boolean): void {
  if (!Array.isArray(descriptions) || descriptions.length === 0) {
    error('descriptions array required for phase add-batch');
  }
  const config = loadConfig(cwd);
  const roadmapPath = path.join(planningDir(cwd), 'ROADMAP.md');
  if (!fs.existsSync(roadmapPath)) {
    error('ROADMAP.md not found');
  }
  const projectCode = (config.project_code as string) || '';
  const prefix = projectCode ? `${projectCode}-` : '';

  const results = withPlanningLock(cwd, () => {
    let rawContent = fs.readFileSync(roadmapPath, 'utf-8');
    const content = extractCurrentMilestone(rawContent, cwd);
    let maxPhase = 0;
    if (config.phase_naming !== 'custom') {
      const phasePattern = /#{2,4}\s*Phase\s+(\d+)[A-Z]?(?:\.\d+)*:/gi;
      let m: RegExpExecArray | null;
      while ((m = phasePattern.exec(content)) !== null) {
        const num = parseInt(m[1], 10);
        if (num === 999) continue;
        if (num > maxPhase) maxPhase = num;
      }
      const phasesOnDisk = path.join(planningDir(cwd), 'phases');
      if (fs.existsSync(phasesOnDisk)) {
        const dirNumPattern = /^(?:[A-Z][A-Z0-9]*-)?(\d+)-/;
        for (const entry of fs.readdirSync(phasesOnDisk)) {
          const match = entry.match(dirNumPattern);
          if (!match) continue;
          const num = parseInt(match[1], 10);
          if (num === 999) continue;
          if (num > maxPhase) maxPhase = num;
        }
      }
    }
    const added: Record<string, unknown>[] = [];
    for (const description of descriptions) {
      const slug = generateSlugInternal(description) || '';
      let newPhaseId: number | string;
      let dirName: string;
      if (config.phase_naming === 'custom') {
        newPhaseId = slug.toUpperCase();
        dirName = `${prefix}${newPhaseId}-${slug}`;
      } else {
        maxPhase += 1;
        newPhaseId = maxPhase;
        dirName = `${prefix}${String(newPhaseId).padStart(2, '0')}-${slug}`;
      }
      const dirPath = path.join(planningDir(cwd), 'phases', dirName);
      platformEnsureDir(dirPath);
      platformWriteSync(path.join(dirPath, '.gitkeep'), '');
      const dependsOn =
        config.phase_naming === 'custom'
          ? ''
          : `\n**Depends on:** Phase ${typeof newPhaseId === 'number' ? newPhaseId - 1 : 'TBD'}`;
      const phaseEntry =
        `\n### Phase ${newPhaseId}: ${description}\n\n**Goal:** [To be planned]\n**Requirements**: TBD${dependsOn}\n**Plans:** 0 plans\n\nPlans:\n- [ ] TBD (run ${formatGsdSlash('plan-phase', resolveRuntime(cwd)) as string} ${newPhaseId} to break down)\n`;
      const lastSeparator = rawContent.lastIndexOf('\n---');
      rawContent =
        lastSeparator > 0
          ? rawContent.slice(0, lastSeparator) + phaseEntry + rawContent.slice(lastSeparator)
          : rawContent + phaseEntry;
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
    platformWriteSync(roadmapPath, rawContent);
    return added;
  });
  output({ phases: results, count: results.length }, raw);
}

function cmdPhaseInsert(cwd: string, afterPhase: string, description: string, raw: boolean): void {
  if (!afterPhase || !description) {
    error('after-phase and description required for phase insert');
  }

  const roadmapPath = path.join(planningDir(cwd), 'ROADMAP.md');
  if (!fs.existsSync(roadmapPath)) {
    error('ROADMAP.md not found');
  }

  const slug = generateSlugInternal(description) || '';

  const { decimalPhase, dirName } = withPlanningLock(cwd, () => {
    const rawContent = fs.readFileSync(roadmapPath, 'utf-8');
    const content = extractCurrentMilestone(rawContent, cwd);

    const normalizedAfter = normalizePhaseName(afterPhase);
    const afterPhaseEscaped = phaseMarkdownRegexSource(normalizedAfter);
    const targetPattern = new RegExp(`#{2,4}\\s*Phase\\s+${afterPhaseEscaped}:`, 'i');
    const headingMatch = targetPattern.test(content);

    const bulletPattern = new RegExp(
      `-\\s*\\[[ x]\\]\\s*(?:\\*\\*)?Phase\\s+${afterPhaseEscaped}[:\\s]`,
      'i',
    );
    const anyHeadingPattern = /#{2,4}\s*Phase\s+\d/i;
    const roadmapHasHeadingPhases = anyHeadingPattern.test(content);
    const isBulletStyle = !headingMatch && bulletPattern.test(content) && !roadmapHasHeadingPhases;

    if (!headingMatch && !isBulletStyle) {
      const checklistPattern = new RegExp(
        `-\\s*\\[[ x]\\]\\s*(?:\\*\\*)?Phase\\s+${afterPhaseEscaped}[:\\s]`,
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
    const normalizedBase = normalizePhaseName(afterPhase);
    const decimalSet = new Set<number>();

    try {
      const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
      const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
      const decimalPattern = new RegExp(
        `^(?:[A-Z]{1,6}-)?${escapeRegex(normalizedBase)}\\.(\\d+)`,
      );
      for (const dir of dirs) {
        const dm = dir.match(decimalPattern);
        if (dm) decimalSet.add(parseInt(dm[1], 10));
      }
    } catch {
      /* intentionally empty */
    }

    const rmPhasePattern = new RegExp(
      `#{2,4}\\s*Phase\\s+${phaseMarkdownRegexSource(normalizedBase)}\\.(\\d+)\\s*:`,
      'gi',
    );
    let rmMatch: RegExpExecArray | null;
    while ((rmMatch = rmPhasePattern.exec(rawContent)) !== null) {
      decimalSet.add(parseInt(rmMatch[1], 10));
    }

    const nextDecimal = decimalSet.size === 0 ? 1 : Math.max(...decimalSet) + 1;
    const _decimalPhase = `${normalizedBase}.${nextDecimal}`;
    const insertConfig = loadConfig(cwd);
    const projectCode = (insertConfig.project_code as string) || '';
    const pfx = projectCode ? `${projectCode}-` : '';
    const _dirName = `${pfx}${_decimalPhase}-${slug}`;
    const dirPath = path.join(planningDir(cwd), 'phases', _dirName);

    platformEnsureDir(dirPath);
    platformWriteSync(path.join(dirPath, '.gitkeep'), '');

    let updatedContent: string;

    if (isBulletStyle) {
      const boldBulletPattern = new RegExp(
        `-\\s*\\[[ x]\\]\\s*\\*\\*Phase\\s+${afterPhaseEscaped}:`,
        'i',
      );
      const useBold = boldBulletPattern.test(content);
      const phaseLabel = useBold
        ? `**Phase ${_decimalPhase}: ${description}**`
        : `Phase ${_decimalPhase}: ${description}`;
      const bulletEntry = `\n- [ ] ${phaseLabel}`;

      const targetBulletPattern = new RegExp(
        `(-\\s*\\[[ x]\\]\\s*(?:\\*\\*)?Phase\\s+${afterPhaseEscaped}[:\\s][^\\n]*)`,
        'i',
      );
      const bulletMatchResult = rawContent.match(targetBulletPattern);
      if (!bulletMatchResult) {
        error(`Could not find Phase ${afterPhase} bullet line`);
      }

      const bulletLineEnd =
        rawContent.indexOf(bulletMatchResult![0]) + bulletMatchResult![0].length;
      const afterBullet = rawContent.slice(bulletLineEnd);
      const nextBulletMatch = afterBullet.match(/\n-\s*\[[ x]\]\s*(?:\*\*)?Phase\s+\d/i);

      let insertIdx: number;
      if (nextBulletMatch) {
        insertIdx = bulletLineEnd + (nextBulletMatch.index as number);
      } else {
        insertIdx = bulletLineEnd;
      }

      updatedContent =
        rawContent.slice(0, insertIdx) + bulletEntry + rawContent.slice(insertIdx);
    } else {
      const phaseEntry =
        `\n### Phase ${_decimalPhase}: ${description} (INSERTED)\n\n**Goal:** [Urgent work - to be planned]\n**Requirements**: TBD\n**Depends on:** Phase ${afterPhase}\n**Plans:** 0 plans\n\nPlans:\n- [ ] TBD (run ${formatGsdSlash('plan-phase', resolveRuntime(cwd)) as string} ${_decimalPhase} to break down)\n`;

      const headerPattern = new RegExp(
        `(#{2,4}\\s*Phase\\s+${afterPhaseEscaped}:[^\\n]*\\n)`,
        'i',
      );
      const headerMatch = rawContent.match(headerPattern);
      if (!headerMatch) {
        error(`Could not find Phase ${afterPhase} header`);
      }

      const headerIdx = rawContent.indexOf(headerMatch![0]);
      const afterHeader = rawContent.slice(headerIdx + headerMatch![0].length);
      const nextPhaseMatch = afterHeader.match(/\n#{2,4}\s+Phase\s+\d[\d.]*/i);

      let insertIdx: number;
      if (nextPhaseMatch) {
        insertIdx = headerIdx + headerMatch![0].length + (nextPhaseMatch.index as number);
      } else {
        insertIdx = rawContent.length;
      }

      updatedContent =
        rawContent.slice(0, insertIdx) + phaseEntry + rawContent.slice(insertIdx);
    }

    platformWriteSync(roadmapPath, updatedContent);
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
    fs.renameSync(path.join(phasesDir, item.dir), path.join(phasesDir, newDirName));
    renamedDirs.push({ from: item.dir, to: newDirName });
    for (const f of fs.readdirSync(path.join(phasesDir, newDirName))) {
      if (f.includes(oldPhaseId)) {
        const newFileName = f.replace(oldPhaseId, newPhaseId);
        fs.renameSync(
          path.join(phasesDir, newDirName, f),
          path.join(phasesDir, newDirName, newFileName),
        );
        renamedFiles.push({ from: f, to: newFileName });
      }
    }
  }
  return { renamedDirs, renamedFiles };
}

function renameIntegerPhases(
  phasesDir: string,
  removedInt: number,
): { renamedDirs: { from: string; to: string }[]; renamedFiles: { from: string; to: string }[] } {
  const renamedDirs: { from: string; to: string }[] = [];
  const renamedFiles: { from: string; to: string }[] = [];
  const dirs = readSubdirectories(phasesDir, true);
  const toRename: RenameIntInfo[] = dirs
    .map((dir) => {
      const m = dir.match(/^(\d+)([A-Z])?(?:\.(\d+))?-(.+)$/i);
      if (!m) return null;
      const dirInt = parseInt(m[1], 10);
      return dirInt > removedInt && dirInt !== 999
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
    fs.renameSync(path.join(phasesDir, item.dir), path.join(phasesDir, newDirName));
    renamedDirs.push({ from: item.dir, to: newDirName });
    for (const f of fs.readdirSync(path.join(phasesDir, newDirName))) {
      if (f.startsWith(oldPrefix)) {
        const newFileName = newPrefix + f.slice(oldPrefix.length);
        fs.renameSync(
          path.join(phasesDir, newDirName, f),
          path.join(phasesDir, newDirName, newFileName),
        );
        renamedFiles.push({ from: f, to: newFileName });
      }
    }
  }
  return { renamedDirs, renamedFiles };
}

function decrementRoadmapPhaseNumber(raw: string, removedInt: number): string {
  const num = parseInt(raw, 10);
  if (!Number.isInteger(num) || num <= removedInt || num === 999) return raw;
  return String(num - 1);
}

function decrementRoadmapPhaseToken(raw: string, removedInt: number): string {
  const match = String(raw).match(/^(\d+)(\.\d+)?$/);
  if (!match) return raw;
  const num = parseInt(match[1], 10);
  if (!Number.isInteger(num) || num <= removedInt || num === 999) return raw;
  return `${num - 1}${match[2] || ''}`;
}

function decrementRoadmapPaddedPhaseNumber(raw: string, removedInt: number): string {
  const num = parseInt(raw, 10);
  if (!Number.isInteger(num) || num <= removedInt || num === 999) return raw;
  return String(num - 1).padStart(raw.length, '0');
}

function updateRoadmapAfterPhaseRemoval(
  roadmapPath: string,
  targetPhase: string,
  isDecimal: boolean,
  removedInt: number,
  cwd: string,
): void {
  withPlanningLock(cwd, () => {
    let content = fs.readFileSync(roadmapPath, 'utf-8');
    const escaped = escapeRegex(targetPhase);

    content = content.replace(
      new RegExp(
        `\\n?(?<h>#{2,4})\\s*Phase\\s+${escaped}\\s*:[\\s\\S]*?(?=\\n\\k<h>(?!#)\\s+Phase\\s+[^\\n:]+\\s*:|$)`,
        'i',
      ),
      '',
    );
    content = content.replace(
      new RegExp(`\\n?-\\s*\\[[ x]\\]\\s*.*Phase\\s+${escaped}[:\\s][^\\n]*`, 'gi'),
      '',
    );
    content = content.replace(
      new RegExp(`\\n?\\|\\s*${escaped}\\.?\\s[^|]*\\|[^\\n]*`, 'gi'),
      '',
    );

    if (!isDecimal) {
      content = content.replace(
        /(#{2,4}\s*Phase\s+)(\d+(?:\.\d+)?)(\s*:)/gi,
        (_match, prefix: string, num: string, suffix: string) =>
          `${prefix}${decrementRoadmapPhaseToken(num, removedInt)}${suffix}`,
      );
      content = content.replace(
        /(-\s*\[[ x]\]\s*.*?Phase\s+)(\d+)(\s*:|\s+)/gi,
        (_match, prefix: string, num: string, suffix: string) =>
          `${prefix}${decrementRoadmapPhaseNumber(num, removedInt)}${suffix}`,
      );
      content = content.replace(
        /(\|\s*)(\d+)(\.\s)/g,
        (_match, prefix: string, num: string, suffix: string) =>
          `${prefix}${decrementRoadmapPhaseNumber(num, removedInt)}${suffix}`,
      );
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
  });
}

interface PhaseRemoveOptions {
  force?: boolean;
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

  const normalized = normalizePhaseName(targetPhase);
  const isDecimal = targetPhase.includes('.');
  const force = options.force || false;

  const subdirs = readSubdirectories(phasesDir, true);
  const targetDir = subdirs.find((d) => phaseTokenMatches(d, normalized)) || null;

  if (targetDir && !force) {
    const files = fs.readdirSync(path.join(phasesDir, targetDir));
    const summaries = files.filter((f) => f.endsWith('-SUMMARY.md') || f === 'SUMMARY.md');
    if (summaries.length > 0) {
      error(
        `Phase ${targetPhase} has ${summaries.length} executed plan(s). Use --force to remove anyway.`,
      );
    }
  }

  if (targetDir) fs.rmSync(path.join(phasesDir, targetDir), { recursive: true, force: true });

  let renamedDirs: { from: string; to: string }[] = [];
  let renamedFiles: { from: string; to: string }[] = [];
  try {
    const renamed = isDecimal
      ? renameDecimalPhases(
          phasesDir,
          parseInt(normalized.split('.')[0], 10),
          parseInt(normalized.split('.')[1], 10),
        )
      : renameIntegerPhases(phasesDir, parseInt(normalized, 10));
    renamedDirs = renamed.renamedDirs;
    renamedFiles = renamed.renamedFiles;
  } catch {
    /* intentionally empty */
  }

  updateRoadmapAfterPhaseRemoval(
    roadmapPath,
    targetPhase,
    isDecimal,
    parseInt(normalized, 10),
    cwd,
  );

  const statePath = path.join(planningDir(cwd), 'STATE.md');
  if (fs.existsSync(statePath)) {
    readModifyWriteStateMd(
      statePath,
      (stateContent: string) => {
        const totalRaw = stateExtractField(stateContent, 'Total Phases');
        if (totalRaw) {
          stateContent =
            stateReplaceField(stateContent, 'Total Phases', String(parseInt(totalRaw, 10) - 1)) ||
            stateContent;
        }
        const ofMatch = stateContent.match(/(\bof\s+)(\d+)(\s*(?:\(|phases?))/i);
        if (ofMatch) {
          stateContent = stateContent.replace(
            /(\bof\s+)(\d+)(\s*(?:\(|phases?))/i,
            `$1${parseInt(ofMatch[2], 10) - 1}$3`,
          );
        }
        return stateContent;
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
      roadmap_updated: true,
      state_updated: fs.existsSync(statePath),
    },
    raw,
  );
}

interface WriteSpec {
  filePath: string;
  before: string;
  after: string;
}

function writePlanningFileSet(writes: WriteSpec[]): void {
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
}

function cmdPhaseComplete(cwd: string, phaseNum: string, raw: boolean): void {
  if (!phaseNum) {
    error('phase number required for phase complete');
  }

  const roadmapPath = path.join(planningDir(cwd), 'ROADMAP.md');
  const statePath = path.join(planningDir(cwd), 'STATE.md');
  const phasesDir = path.join(planningDir(cwd), 'phases');
  const today = new Date().toISOString().split('T')[0];

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

  const warnings: string[] = [];
  try {
    const phaseFullDir = path.join(cwd, phaseInfo['directory'] as string);
    const phaseFiles = fs.readdirSync(phaseFullDir);

    for (const file of phaseFiles.filter((f) => f.includes('-UAT') && f.endsWith('.md'))) {
      const content = fs.readFileSync(path.join(phaseFullDir, file), 'utf-8');
      if (/result: pending/.test(content)) warnings.push(`${file}: has pending tests`);
      if (/result: blocked/.test(content)) warnings.push(`${file}: has blocked tests`);
      if (/status: partial/.test(content)) warnings.push(`${file}: testing incomplete (partial)`);
      if (/status: diagnosed/.test(content)) warnings.push(`${file}: has diagnosed gaps`);
    }

    for (const file of phaseFiles.filter(
      (f) => f.includes('-VERIFICATION') && f.endsWith('.md'),
    )) {
      const content = fs.readFileSync(path.join(phaseFullDir, file), 'utf-8');
      if (/status: human_needed/.test(content)) warnings.push(`${file}: needs human verification`);
      if (/status: gaps_found/.test(content)) warnings.push(`${file}: has unresolved gaps`);
    }
  } catch {
    /* intentionally empty */
  }

  let nextPhaseNum: string | null = null;
  let nextPhaseName: string | null = null;
  let isLastPhase = true;

  withPlanningLock(cwd, () => {
    const runPhaseCompleteTransaction = () => {
      const writes: WriteSpec[] = [];
      let roadmapContent: string | null = null;

      if (fs.existsSync(roadmapPath)) {
        const originalRoadmapContent = fs.readFileSync(roadmapPath, 'utf-8');
        roadmapContent = originalRoadmapContent;

        const phaseEscaped = phaseMarkdownRegexSource(phaseNum);
        const checkboxPattern = new RegExp(
          `(-\\s*\\[)[ ](\\]\\s*.*Phase\\s+${phaseEscaped}[:\\s][^\\n]*)`,
          'i',
        );
        roadmapContent = roadmapContent.replace(
          checkboxPattern,
          `$1x$2 (completed ${today})`,
        );

        const tableRowPattern = new RegExp(
          `^(\\|\\s*${phaseEscaped}\\.?\\s[^|]*(?:\\|[^\\n]*))$`,
          'im',
        );
        roadmapContent = roadmapContent.replace(tableRowPattern, (fullRow) => {
          const cells = fullRow.split('|').slice(1, -1);
          if (cells.length === 5) {
            cells[2] = ` ${summaryCount}/${planCount} `;
            cells[3] = ' Complete    ';
            cells[4] = ` ${today} `;
          } else if (cells.length === 4) {
            cells[1] = ` ${summaryCount}/${planCount} `;
            cells[2] = ' Complete    ';
            cells[3] = ` ${today} `;
          }
          return '|' + cells.join('|') + '|';
        });

        const planCountPattern = new RegExp(
          `(#{2,4}\\s*Phase\\s+${phaseEscaped}[\\s\\S]*?\\*\\*Plans:\\*\\*\\s*)[^\\n]+`,
          'i',
        );
        roadmapContent = roadmapContent.replace(
          planCountPattern,
          `$1${summaryCount}/${planCount} plans complete`,
        );

        const phaseInfoSummaries = phaseInfo['summaries'] as string[];
        for (const summaryFile of phaseInfoSummaries) {
          const planId = summaryFile.replace('-SUMMARY.md', '').replace('SUMMARY.md', '');
          if (!planId) continue;
          const planEscaped = escapeRegex(planId);
          const planCheckboxPattern = new RegExp(
            `(-\\s*\\[) (\\]\\s*(?:\\*\\*)?${planEscaped}(?:\\*\\*)?)`,
            'i',
          );
          roadmapContent = (roadmapContent).replace(planCheckboxPattern, '$1x$2');
        }

        writes.push({
          filePath: roadmapPath,
          before: originalRoadmapContent,
          after: roadmapContent,
        });

        const reqPath = path.join(planningDir(cwd), 'REQUIREMENTS.md');
        if (fs.existsSync(reqPath)) {
          const phaseEsc = phaseMarkdownRegexSource(phaseNum);
          const currentMilestoneRoadmap = extractCurrentMilestone(roadmapContent, cwd);
          const phaseSectionMatch = currentMilestoneRoadmap.match(
            new RegExp(
              `(#{2,4}\\s*Phase\\s+${phaseEsc}[:\\s][\\s\\S]*?)(?=#{2,4}\\s*Phase\\s+|$)`,
              'i',
            ),
          );

          const sectionText = phaseSectionMatch ? phaseSectionMatch[1] : '';
          const reqMatch = sectionText.match(
            /\*\*Requirements:?\*\*[^\S\n]*:?[^\S\n]*([^\n]+)/i,
          );

          const originalReqContent = fs.readFileSync(reqPath, 'utf-8');
          let reqContent = originalReqContent;

          if (reqMatch) {
            const reqIds = reqMatch[1]
              .replace(/[\[\]]/g, '')
              .split(/[,\s]+/)
              .map((r) => r.trim())
              .filter(Boolean);

            for (const reqId of reqIds) {
              const reqEscaped = escapeRegex(reqId);
              reqContent = reqContent.replace(
                new RegExp(`(-\\s*\\[)[ ](\\]\\s*\\*\\*${reqEscaped}\\*\\*)`, 'gi'),
                '$1x$2',
              );
              reqContent = reqContent.replace(
                new RegExp(
                  `(\\|\\s*${reqEscaped}\\s*\\|[^|]+\\|)\\s*(?:Pending|In Progress)\\s*(\\|)`,
                  'gi',
                ),
                '$1 Complete $2',
              );
            }
          }

          const bodyReqIds: string[] = [];
          const bodyReqPattern = /\*\*([A-Z][A-Z0-9]*-\d+)\*\*/g;
          let bodyMatch: RegExpExecArray | null;
          while ((bodyMatch = bodyReqPattern.exec(reqContent)) !== null) {
            const id = bodyMatch[1];
            if (!bodyReqIds.includes(id)) bodyReqIds.push(id);
          }

          const traceabilityHeadingMatch = reqContent.match(/^#{1,6}\s+Traceability\b/im);
          const traceabilitySection = traceabilityHeadingMatch
            ? reqContent.slice(traceabilityHeadingMatch.index)
            : '';
          const tableReqIds = new Set<string>();
          const tableRowPat = /^\|\s*([A-Z][A-Z0-9]*-\d+)\s*\|/gm;
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

          writes.push({ filePath: reqPath, before: originalReqContent, after: reqContent });
          requirementsUpdated = true;
        }
      }

      try {
        const isDirInMilestone = getMilestonePhaseFilter(cwd);
        const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
        const dirs = entries
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
          .filter(isDirInMilestone)
          .sort((a, b) => comparePhaseNum(a, b));

        for (const dir of dirs) {
          const dm = dir.match(/^(\d+[A-Z]?(?:\.\d+)*)-?(.*)/i);
          if (dm) {
            if (/^999(?:\.|$)/.test(dm[1])) continue;
            if (comparePhaseNum(dm[1], phaseNum) > 0) {
              nextPhaseNum = dm[1];
              nextPhaseName = dm[2] || null;
              isLastPhase = false;
              break;
            }
          }
        }
      } catch {
        /* intentionally empty */
      }

      if (isLastPhase && roadmapContent !== null) {
        try {
          const roadmapForPhases = extractCurrentMilestone(roadmapContent, cwd);
          const phasePattern = /#{2,4}\s*Phase\s+(\d+[A-Z]?(?:\.\d+)*)\s*:\s*([^\n]+)/gi;
          let pm: RegExpExecArray | null;
          while ((pm = phasePattern.exec(roadmapForPhases)) !== null) {
            if (comparePhaseNum(pm[1], phaseNum) > 0) {
              nextPhaseNum = pm[1];
              nextPhaseName = pm[2]
                .replace(/\(INSERTED\)/i, '')
                .trim()
                .toLowerCase()
                .replace(/\s+/g, '-');
              isLastPhase = false;
              break;
            }
          }
        } catch {
          /* intentionally empty */
        }
      }

      if (fs.existsSync(statePath)) {
        const originalStateContent = platformReadSync(statePath) || '';
        let stateContent = originalStateContent;

        const phaseValue = nextPhaseNum || phaseNum;
        const existingPhaseField =
          stateExtractField(stateContent, 'Current Phase') ||
          stateExtractField(stateContent, 'Phase');
        let newPhaseValue = String(phaseValue);
        if (existingPhaseField) {
          const totalMatch = existingPhaseField.match(/of\s+(\d+)/);
          const nameMatch = existingPhaseField.match(/\(([^)]+)\)/);
          if (totalMatch) {
            const total = totalMatch[1];
            const nameStr = nextPhaseName
              ? ` (${nextPhaseName.replace(/-/g, ' ')})`
              : nameMatch
                ? ` (${nameMatch[1]})`
                : '';
            newPhaseValue = `${phaseValue} of ${total}${nameStr}`;
          }
        }
        stateContent = stateReplaceFieldWithFallback(
          stateContent,
          'Current Phase',
          'Phase',
          newPhaseValue,
        );

        if (nextPhaseName) {
          stateContent = stateReplaceFieldWithFallback(
            stateContent,
            'Current Phase Name',
            null,
            nextPhaseName.replace(/-/g, ' '),
          );
        }

        stateContent = stateReplaceFieldWithFallback(
          stateContent,
          'Status',
          null,
          isLastPhase ? 'Milestone complete' : 'Ready to plan',
        );

        stateContent = stateReplaceFieldWithFallback(
          stateContent,
          'Current Plan',
          'Plan',
          'Not started',
        );

        stateContent = stateReplaceFieldWithFallback(
          stateContent,
          'Last Activity',
          'Last activity',
          today,
        );

        stateContent = stateReplaceFieldWithFallback(
          stateContent,
          'Last Activity Description',
          null,
          `Phase ${phaseNum} complete${nextPhaseNum ? `, transitioned to Phase ${nextPhaseNum}` : ''}`,
        );

        const completedRaw = stateExtractField(stateContent, 'Completed Phases');
        if (completedRaw !== null) {
          let newCompleted = parseInt(completedRaw, 10);
          let derivedTotalPhases: number | null = null;
          if (roadmapContent !== null) {
            const derived = deriveProgressFromRoadmap(roadmapContent);
            if (derived.completedPhases !== null) newCompleted = derived.completedPhases;
            if (derived.totalPhases !== null) derivedTotalPhases = derived.totalPhases;
          }
          stateContent =
            stateReplaceField(stateContent, 'Completed Phases', String(newCompleted)) ||
            stateContent;

          const totalRaw = stateExtractField(stateContent, 'Total Phases');
          const totalPhases = derivedTotalPhases || (totalRaw ? parseInt(totalRaw, 10) : null);
          if (totalPhases && totalPhases > 0) {
            const newPercent = clampPercent(newCompleted, totalPhases);
            stateContent =
              stateReplaceField(stateContent, 'Progress', `${newPercent}%`) || stateContent;
            stateContent = stateContent.replace(/(percent:\s*)\d+/, `$1${newPercent}`);
          }
        }

        stateContent = updatePerformanceMetricsSection(
          stateContent,
          cwd,
          phaseNum,
          planCount,
          summaryCount,
        );
        stateContent = syncStateFrontmatter(stateContent, cwd);

        writes.push({ filePath: statePath, before: originalStateContent, after: stateContent });
      }

      writePlanningFileSet(writes);
    };

    if (fs.existsSync(statePath)) {
      withStateLock(statePath, runPhaseCompleteTransaction);
    } else {
      runPhaseCompleteTransaction();
    }
  });

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
    roadmap_updated: fs.existsSync(roadmapPath),
    state_updated: fs.existsSync(statePath),
    requirements_updated: requirementsUpdated,
    auto_pruned: autoPruned,
    warnings,
    has_warnings: warnings.length > 0,
  };

  output(result, raw);
}

function cmdPhaseUatPassed(
  cwd: string,
  phaseNum: string | undefined,
  raw: boolean,
  opts: { policy?: { requireVerification?: boolean } } = {},
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

export = {
  cmdPhasesList,
  cmdPhaseNextDecimal,
  cmdFindPhase,
  cmdPhasePlanIndex,
  cmdPhaseAdd,
  cmdPhaseAddBatch,
  cmdPhaseMvpMode,
  cmdPhaseInsert,
  cmdPhaseRemove,
  cmdPhaseComplete,
  cmdPhaseUatPassed,
  computeDependencyLevels,
};
