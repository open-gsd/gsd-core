/**
 * Init — Compound init commands for workflow bootstrapping
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/init.cjs collapsed to
 * a TypeScript source of truth, compiled by tsc to a gitignored .cjs at the
 * same require() path. Behaviour preserved byte-for-behaviour; only types are added.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execGit, platformWriteSync, platformReadSync } from './shell-command-projection.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- core.cjs is an export= CommonJS module
import core = require('./core.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- planning-workspace.cjs is an export= CommonJS module
import planningWorkspace = require('./planning-workspace.cjs');
import { maskIfSecret } from './secrets.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- plan-scan.cjs is an export= CommonJS module
import scanPhasePlans = require('./plan-scan.cjs');
import { stateExtractField } from './state-document.cjs';
import { formatGsdSlash, resolveRuntime } from './runtime-slash.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- commands.cjs is an export= CommonJS module
import commandsMod = require('./commands.cjs');
import { validatePath } from './security.cjs';
import { getGlobalSkillDir, getGlobalSkillDisplayPath, getGlobalSkillsBase } from './runtime-homes.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- frontmatter.cjs is an export= CommonJS module
import frontmatterMod = require('./frontmatter.cjs');

const {
  loadConfig,
  resolveModelInternal,
  findPhaseInternal,
  getRoadmapPhaseInternal,
  pathExistsInternal,
  gitWorktreeInfoInternal,
  generateSlugInternal,
  getMilestoneInfo,
  getMilestonePhaseFilter,
  stripShippedMilestones,
  extractCurrentMilestone,
  normalizePhaseName,
  toPosixPath,
  output,
  error,
  checkAgentsInstalled,
  phaseTokenMatches,
} = core;

const {
  planningPaths,
  planningDir,
  planningRoot,
  findContextMdIn,
} = planningWorkspace;

const { determinePhaseStatus } = commandsMod;
const { extractFrontmatter } = frontmatterMod;

// Unused but imported for structural parity
void stripShippedMilestones;

// Accept all bold/colon variants of the Requirements header (#2769)
const REQUIREMENTS_HEADER_RE = /^\*\*Requirements:?\*\*[^\S\n]*:?[^\S\n]*([^\n]*)$/m;

function listPhaseSummaryFiles(phaseDir: string): string[] {
  return (scanPhasePlans(phaseDir) as unknown as Record<string, string[]>)['summaryFiles'];
}

function listPhasePlanFiles(phaseDir: string): string[] {
  return (scanPhasePlans(phaseDir) as unknown as Record<string, string[]>)['planFiles'];
}

function getLatestCompletedMilestone(cwd: string): { version: string; name: string } | null {
  const milestonesPath = path.join(planningRoot(cwd), 'MILESTONES.md');
  const content = platformReadSync(milestonesPath);
  if (content === null) return null;

  const match = content.match(/^##\s+(v[\d.]+)\s+(.+?)\s+\(Shipped:/m);
  if (!match) return null;
  return {
    version: match[1],
    name: match[2].trim(),
  };
}

function withProjectRoot(cwd: string, result: Record<string, unknown>): Record<string, unknown> {
  result['project_root'] = cwd;
  const activeRuntime = resolveRuntime(cwd);
  const agentStatus = checkAgentsInstalled(activeRuntime);
  result['agents_installed'] = agentStatus.agents_installed;
  result['missing_agents'] = agentStatus.missing_agents;
  result['agents_dir'] = agentStatus.agents_dir;
  result['agent_runtime'] = agentStatus.agent_runtime;
  const config = loadConfig(cwd);
  if (config.response_language) {
    result['response_language'] = config.response_language;
  }
  if (config.project_code) {
    result['project_code'] = config.project_code;
  }
  const projectMdPath = path.join(planningDir(cwd), 'PROJECT.md');
  const content = platformReadSync(projectMdPath);
  if (content) {
    const h1Match = content.match(/^#\s+(.+)$/m);
    if (h1Match) {
      result['project_title'] = h1Match[1].trim();
    }
  }
  return result;
}

interface GitState {
  has_git: boolean;
  git_worktree_root: string | null;
  in_nested_subdir: boolean;
}

function getInitGitState(cwd: string): GitState {
  const info = gitWorktreeInfoInternal(cwd) as unknown as Record<string, unknown>;
  const worktreeRoot = info['worktreeRoot'] as string | null;
  const normalizeForCompare = (p: string): string | null => {
    if (typeof p !== 'string' || p.length === 0) return null;
    let resolved: string;
    try {
      resolved = fs.realpathSync.native(p);
    } catch {
      resolved = path.resolve(p);
    }
    resolved = path.resolve(resolved);
    if (process.platform === 'win32') {
      return resolved.replace(/\//g, '\\').toLowerCase();
    }
    return resolved;
  };

  let inNestedSubdir = false;
  if (info['inside']) {
    let resolvedByGitPrefix = false;
    try {
      const prefixResult = execGit(['rev-parse', '--show-prefix'], { cwd, timeout: 5000 }) as unknown as Record<string, unknown>;
      if (prefixResult['exitCode'] === 0) {
        const prefix = (typeof prefixResult['stdout'] === 'string' ? prefixResult['stdout'] : '').trim().replace(/\\/g, '/');
        inNestedSubdir = prefix.length > 0 && prefix !== '.' && prefix !== './';
        resolvedByGitPrefix = true;
      }
    } catch {
      /* intentionally empty */
    }

    if (!resolvedByGitPrefix) {
      const rootNorm = normalizeForCompare(worktreeRoot!);
      const cwdNorm = normalizeForCompare(cwd);
      if (rootNorm && cwdNorm) {
        if (rootNorm === cwdNorm) {
          inNestedSubdir = false;
        } else {
          const rel = path.relative(rootNorm, cwdNorm);
          const relNorm = process.platform === 'win32' ? rel.replace(/\//g, '\\') : rel;
          inNestedSubdir =
            relNorm !== '' &&
            relNorm !== '.' &&
            !relNorm.startsWith('..') &&
            !path.isAbsolute(relNorm);
        }
      } else {
        inNestedSubdir = worktreeRoot !== null;
      }
    }
  }

  if (inNestedSubdir && typeof worktreeRoot === 'string') {
    const toComparableRaw = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/g, '').toLowerCase();
    if (toComparableRaw(worktreeRoot) === toComparableRaw(String(cwd))) {
      inNestedSubdir = false;
    }
  }

  return {
    has_git: info['inside'] as boolean,
    git_worktree_root: worktreeRoot,
    in_nested_subdir: inNestedSubdir,
  };
}

function cmdInitExecutePhase(
  cwd: string,
  phase: string,
  raw: boolean,
  options: Record<string, unknown> = {},
): void {
  if (!phase) {
    error('phase required for init execute-phase');
  }

  const config = loadConfig(cwd);
  let phaseInfo = findPhaseInternal(cwd, phase) as unknown as Record<string, unknown> | null;
  const milestone = getMilestoneInfo(cwd) as unknown as Record<string, unknown>;

  const roadmapPhase = getRoadmapPhaseInternal(cwd, phase) as unknown as Record<string, unknown> | null;

  if (phaseInfo?.['archived'] && roadmapPhase?.['found']) {
    phaseInfo = null;
  }

  if (!phaseInfo && roadmapPhase?.['found']) {
    const phaseName = roadmapPhase['phase_name'] as string | null;
    phaseInfo = {
      found: true,
      directory: null,
      phase_number: roadmapPhase['phase_number'],
      phase_name: phaseName,
      phase_slug: phaseName
        ? phaseName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
        : null,
      plans: [],
      summaries: [],
      incomplete_plans: [],
      has_research: false,
      has_context: false,
      has_verification: false,
      has_reviews: false,
    };
  }
  const reqMatch = (roadmapPhase?.['section'] as string | undefined)?.match(REQUIREMENTS_HEADER_RE);
  const reqExtracted = reqMatch
    ? reqMatch[1].replace(/[\[\]]/g, '').split(',').map((s) => s.trim()).filter(Boolean).join(', ')
    : null;
  const phase_req_ids = reqExtracted && reqExtracted !== 'TBD' ? reqExtracted : null;

  const result: Record<string, unknown> = {
    executor_model: resolveModelInternal(cwd, 'gsd-executor'),
    verifier_model: resolveModelInternal(cwd, 'gsd-verifier'),

    tdd_mode: options['tdd'] || config.tdd_mode || false,
    commit_docs: config.commit_docs,
    sub_repos: config.sub_repos,
    parallelization: config.parallelization,
    context_window: config.context_window,
    branching_strategy: config.branching_strategy,
    phase_branch_template: config.phase_branch_template,
    milestone_branch_template: config.milestone_branch_template,
    verifier_enabled: config.verifier,

    phase_found: !!phaseInfo,
    phase_dir: phaseInfo?.['directory'] || null,
    phase_number: phaseInfo?.['phase_number'] || null,
    phase_name: phaseInfo?.['phase_name'] || null,
    phase_slug: phaseInfo?.['phase_slug'] || null,
    phase_req_ids,

    plans: phaseInfo?.['plans'] || [],
    summaries: phaseInfo?.['summaries'] || [],
    incomplete_plans: phaseInfo?.['incomplete_plans'] || [],
    plan_count: (phaseInfo?.['plans'] as unknown[] | undefined)?.length || 0,
    incomplete_count: (phaseInfo?.['incomplete_plans'] as unknown[] | undefined)?.length || 0,

    branch_name:
      config.branching_strategy === 'phase' && phaseInfo
        ? (config.phase_branch_template as string)
            .replace('{project}', (config.project_code as string) || '')
            .replace('{phase}', phaseInfo['phase_number'] as string)
            .replace('{slug}', (phaseInfo['phase_slug'] as string) || 'phase')
        : config.branching_strategy === 'milestone'
          ? (config.milestone_branch_template as string)
              .replace('{milestone}', milestone['version'] as string)
              .replace(
                '{slug}',
                generateSlugInternal(milestone['name'] as string) || 'milestone',
              )
          : null,

    milestone_version: milestone['version'],
    milestone_name: milestone['name'],
    milestone_slug: generateSlugInternal(milestone['name'] as string),

    state_exists: fs.existsSync(path.join(planningDir(cwd), 'STATE.md')),
    roadmap_exists: fs.existsSync(path.join(planningDir(cwd), 'ROADMAP.md')),
    config_exists: fs.existsSync(path.join(planningDir(cwd), 'config.json')),
    state_path: toPosixPath(
      path.relative(cwd, path.join(planningDir(cwd), 'STATE.md')),
    ),
    roadmap_path: toPosixPath(
      path.relative(cwd, path.join(planningDir(cwd), 'ROADMAP.md')),
    ),
    config_path: toPosixPath(
      path.relative(cwd, path.join(planningDir(cwd), 'config.json')),
    ),
  };

  if (options['validate']) {
    try {
      const statePath = path.join(planningDir(cwd), 'STATE.md');
      const stateContent = platformReadSync(statePath);
      if (stateContent !== null) {
        result['state_validation_ran'] = true;
        const stateWarnings: string[] = [];
        if (phaseInfo?.['directory'] && fs.existsSync(path.join(cwd, phaseInfo['directory'] as string))) {
          const diskPlans = listPhasePlanFiles(path.join(cwd, phaseInfo['directory'] as string)).length;
          const totalPlansRaw = stateExtractField(stateContent, 'Total Plans in Phase');
          const totalPlansInPhase = totalPlansRaw ? parseInt(totalPlansRaw, 10) : null;
          if (totalPlansInPhase !== null && diskPlans !== totalPlansInPhase) {
            stateWarnings.push(
              `Plan count mismatch: STATE.md says ${totalPlansInPhase}, disk has ${diskPlans}`,
            );
          }
        }
        result['state_warnings'] = stateWarnings;
      }
    } catch {
      /* intentionally empty */
    }
  }

  output(withProjectRoot(cwd, result), raw);
}

function cmdInitPlanPhase(
  cwd: string,
  phase: string,
  raw: boolean,
  options: Record<string, unknown> = {},
): void {
  if (!phase) {
    error('phase required for init plan-phase');
  }

  const config = loadConfig(cwd);
  let phaseInfo = findPhaseInternal(cwd, phase) as unknown as Record<string, unknown> | null;

  const roadmapPhase = getRoadmapPhaseInternal(cwd, phase) as unknown as Record<string, unknown> | null;

  if (phaseInfo?.['archived'] && roadmapPhase?.['found']) {
    phaseInfo = null;
  }

  if (!phaseInfo && roadmapPhase?.['found']) {
    const phaseName = roadmapPhase['phase_name'] as string | null;
    phaseInfo = {
      found: true,
      directory: null,
      phase_number: roadmapPhase['phase_number'],
      phase_name: phaseName,
      phase_slug: phaseName
        ? phaseName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
        : null,
      plans: [],
      summaries: [],
      incomplete_plans: [],
      has_research: false,
      has_context: false,
      has_verification: false,
      has_reviews: false,
    };
  }
  const reqMatch = (roadmapPhase?.['section'] as string | undefined)?.match(REQUIREMENTS_HEADER_RE);
  const reqExtracted = reqMatch
    ? reqMatch[1].replace(/[\[\]]/g, '').split(',').map((s) => s.trim()).filter(Boolean).join(', ')
    : null;
  const phase_req_ids = reqExtracted && reqExtracted !== 'TBD' ? reqExtracted : null;

  const phaseDirPlan = (phaseInfo?.['directory'] as string | undefined) || null;
  const phaseNumberPlan = (phaseInfo?.['phase_number'] as string | undefined) || null;
  const phaseNamePlan = (phaseInfo?.['phase_name'] as string | undefined) || null;
  const rawProjectCodePlan = (config.project_code as string) || '';
  let expectedPhaseDirPlan: string | null = null;
  if (!phaseDirPlan && phaseNumberPlan && phaseNamePlan) {
    const paddedNum = normalizePhaseName(phaseNumberPlan);
    const slug = (generateSlugInternal(phaseNamePlan) || '').substring(0, 60);
    if (slug) {
      const prefix = rawProjectCodePlan ? `${rawProjectCodePlan}-` : '';
      const dirName = `${prefix}${paddedNum}-${slug}`;
      expectedPhaseDirPlan = toPosixPath(
        path.relative(cwd, path.join(planningPaths(cwd).phases, dirName)),
      );
    }
  }

  const result: Record<string, unknown> = {
    researcher_model: resolveModelInternal(cwd, 'gsd-phase-researcher'),
    planner_model: resolveModelInternal(cwd, 'gsd-planner'),
    checker_model: resolveModelInternal(cwd, 'gsd-plan-checker'),

    tdd_mode: options['tdd'] || config.tdd_mode || false,
    research_enabled: config.research,
    plan_checker_enabled: config.plan_checker,
    nyquist_validation_enabled: config.nyquist_validation,
    commit_docs: config.commit_docs,
    text_mode: config.text_mode,
    auto_advance: !!(config.auto_advance),
    auto_chain_active: !!(config._auto_chain_active),
    mode: config.mode || 'interactive',

    phase_found: !!phaseInfo,
    phase_dir: phaseDirPlan,
    expected_phase_dir: expectedPhaseDirPlan,
    phase_number: phaseNumberPlan,
    phase_name: phaseNamePlan,
    phase_slug: phaseInfo?.['phase_slug'] || null,
    padded_phase: phaseNumberPlan ? normalizePhaseName(phaseNumberPlan) : null,
    phase_req_ids,

    phase_status: phaseDirPlan
      ? determinePhaseStatus(
          (phaseInfo?.['plans'] as unknown[] | undefined)?.length || 0,
          (phaseInfo?.['summaries'] as unknown[] | undefined)?.length || 0,
          path.join(cwd, phaseDirPlan),
          'Pending',
        )
      : 'Pending',

    has_research: phaseInfo?.['has_research'] || false,
    has_context: phaseInfo?.['has_context'] || false,
    has_reviews: phaseInfo?.['has_reviews'] || false,
    has_plans: ((phaseInfo?.['plans'] as unknown[] | undefined)?.length || 0) > 0,
    plan_count: (phaseInfo?.['plans'] as unknown[] | undefined)?.length || 0,

    planning_exists: fs.existsSync(planningDir(cwd)),
    roadmap_exists: fs.existsSync(path.join(planningDir(cwd), 'ROADMAP.md')),

    state_path: toPosixPath(
      path.relative(cwd, path.join(planningDir(cwd), 'STATE.md')),
    ),
    roadmap_path: toPosixPath(
      path.relative(cwd, path.join(planningDir(cwd), 'ROADMAP.md')),
    ),
    requirements_path: toPosixPath(
      path.relative(cwd, path.join(planningDir(cwd), 'REQUIREMENTS.md')),
    ),

    patterns_path: null,
  };

  if (phaseInfo?.['directory']) {
    const phaseDirFull = path.join(cwd, phaseInfo['directory'] as string);
    try {
      const files = fs.readdirSync(phaseDirFull);
      const contextFile = findContextMdIn(phaseDirFull);
      if (contextFile) {
        result['context_path'] = toPosixPath(
          path.join(phaseInfo['directory'] as string, contextFile),
        );
      }
      const researchFile = files.find(
        (f) => f.endsWith('-RESEARCH.md') || f === 'RESEARCH.md',
      );
      if (researchFile) {
        result['research_path'] = toPosixPath(
          path.join(phaseInfo['directory'] as string, researchFile),
        );
      }
      const verificationFile = files.find(
        (f) => f.endsWith('-VERIFICATION.md') || f === 'VERIFICATION.md',
      );
      if (verificationFile) {
        result['verification_path'] = toPosixPath(
          path.join(phaseInfo['directory'] as string, verificationFile),
        );
      }
      const uatFile = files.find((f) => f.endsWith('-UAT.md') || f === 'UAT.md');
      if (uatFile) {
        result['uat_path'] = toPosixPath(path.join(phaseInfo['directory'] as string, uatFile));
      }
      const reviewsFile = files.find(
        (f) => f.endsWith('-REVIEWS.md') || f === 'REVIEWS.md',
      );
      if (reviewsFile) {
        result['reviews_path'] = toPosixPath(
          path.join(phaseInfo['directory'] as string, reviewsFile),
        );
      }
      const patternsFile = files.find(
        (f) => f.endsWith('-PATTERNS.md') || f === 'PATTERNS.md',
      );
      if (patternsFile) {
        result['patterns_path'] = toPosixPath(
          path.join(phaseInfo['directory'] as string, patternsFile),
        );
      }
    } catch {
      /* intentionally empty */
    }
  }

  if (options['validate']) {
    try {
      const statePath = path.join(planningDir(cwd), 'STATE.md');
      const stateContent = platformReadSync(statePath);
      if (stateContent !== null) {
        const stateWarnings: string[] = [];
        result['state_validation_ran'] = true;
        const totalPlansRaw = stateExtractField(stateContent, 'Total Plans in Phase');
        const totalPlansInPhase = totalPlansRaw ? parseInt(totalPlansRaw, 10) : null;
        if (
          totalPlansInPhase !== null &&
          phaseInfo &&
          totalPlansInPhase !==
            ((phaseInfo['plans'] as unknown[] | undefined)?.length || 0)
        ) {
          stateWarnings.push(
            `Plan count mismatch: STATE.md says ${totalPlansInPhase}, disk has ${(phaseInfo['plans'] as unknown[] | undefined)?.length || 0}`,
          );
        }
        result['state_warnings'] = stateWarnings;
      }
    } catch {
      /* intentionally empty */
    }
  }

  output(withProjectRoot(cwd, result), raw);
}

function cmdInitNewProject(cwd: string, raw: boolean): void {
  const config = loadConfig(cwd);

  const homedir = os.homedir();
  const braveKeyFile = path.join(homedir, '.gsd', 'brave_api_key');
  const hasBraveSearch = !!(process.env['BRAVE_API_KEY'] || fs.existsSync(braveKeyFile));

  const firecrawlKeyFile = path.join(homedir, '.gsd', 'firecrawl_api_key');
  const hasFirecrawl = !!(process.env['FIRECRAWL_API_KEY'] || fs.existsSync(firecrawlKeyFile));

  const exaKeyFile = path.join(homedir, '.gsd', 'exa_api_key');
  const hasExaSearch = !!(process.env['EXA_API_KEY'] || fs.existsSync(exaKeyFile));

  let hasCode = false;
  let hasPackageFile = false;
  try {
    const codeExtensions = new Set([
      '.ts', '.js', '.py', '.go', '.rs', '.swift', '.java',
      '.kt', '.kts',
      '.c', '.cpp', '.h',
      '.cs',
      '.rb',
      '.php',
      '.dart',
      '.m', '.mm',
      '.scala',
      '.groovy',
      '.lua',
      '.r', '.R',
      '.zig',
      '.ex', '.exs',
      '.clj',
    ]);
    const skipDirs = new Set([
      'node_modules', '.git', '.planning', '.claude', '.codex',
      '__pycache__', 'target', 'dist', 'build',
    ]);
    function findCodeFiles(dir: string, depth: number): boolean {
      if (depth > 3) return false;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return false;
      }
      for (const entry of entries) {
        if (entry.isFile() && codeExtensions.has(path.extname(entry.name))) return true;
        if (entry.isDirectory() && !skipDirs.has(entry.name)) {
          if (findCodeFiles(path.join(dir, entry.name), depth + 1)) return true;
        }
      }
      return false;
    }
    hasCode = findCodeFiles(cwd, 0);
  } catch {
    /* intentionally empty — best-effort detection */
  }

  hasPackageFile =
    pathExistsInternal(cwd, 'package.json') ||
    pathExistsInternal(cwd, 'requirements.txt') ||
    pathExistsInternal(cwd, 'Cargo.toml') ||
    pathExistsInternal(cwd, 'go.mod') ||
    pathExistsInternal(cwd, 'Package.swift') ||
    pathExistsInternal(cwd, 'build.gradle') ||
    pathExistsInternal(cwd, 'build.gradle.kts') ||
    pathExistsInternal(cwd, 'pom.xml') ||
    pathExistsInternal(cwd, 'Gemfile') ||
    pathExistsInternal(cwd, 'composer.json') ||
    pathExistsInternal(cwd, 'pubspec.yaml') ||
    pathExistsInternal(cwd, 'CMakeLists.txt') ||
    pathExistsInternal(cwd, 'Makefile') ||
    pathExistsInternal(cwd, 'build.zig') ||
    pathExistsInternal(cwd, 'mix.exs') ||
    pathExistsInternal(cwd, 'project.clj');

  const result: Record<string, unknown> = {
    researcher_model: resolveModelInternal(cwd, 'gsd-project-researcher'),
    synthesizer_model: resolveModelInternal(cwd, 'gsd-research-synthesizer'),
    roadmapper_model: resolveModelInternal(cwd, 'gsd-roadmapper'),

    commit_docs: config.commit_docs,

    project_exists: pathExistsInternal(cwd, '.planning/PROJECT.md'),
    has_codebase_map: pathExistsInternal(cwd, '.planning/codebase'),
    planning_exists: pathExistsInternal(cwd, '.planning'),

    has_existing_code: hasCode,
    has_package_file: hasPackageFile,
    is_brownfield: hasCode || hasPackageFile,
    needs_codebase_map:
      (hasCode || hasPackageFile) && !pathExistsInternal(cwd, '.planning/codebase'),

    ...getInitGitState(cwd),

    brave_search_available: hasBraveSearch,
    firecrawl_available: hasFirecrawl,
    exa_search_available: hasExaSearch,

    project_path: '.planning/PROJECT.md',
  };

  output(withProjectRoot(cwd, result), raw);
}

function cmdInitNewMilestone(cwd: string, raw: boolean): void {
  const config = loadConfig(cwd);
  const milestone = getMilestoneInfo(cwd) as unknown as Record<string, unknown>;
  const latestCompleted = getLatestCompletedMilestone(cwd);
  const phasesDir = path.join(planningDir(cwd), 'phases');
  let phaseDirCount = 0;

  try {
    if (fs.existsSync(phasesDir)) {
      const isDirInMilestone = getMilestonePhaseFilter(cwd);
      phaseDirCount = fs
        .readdirSync(phasesDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && isDirInMilestone(entry.name))
        .length;
    }
  } catch {
    /* intentionally empty */
  }

  const result: Record<string, unknown> = {
    researcher_model: resolveModelInternal(cwd, 'gsd-project-researcher'),
    synthesizer_model: resolveModelInternal(cwd, 'gsd-research-synthesizer'),
    roadmapper_model: resolveModelInternal(cwd, 'gsd-roadmapper'),

    commit_docs: config.commit_docs,
    research_enabled: config.research,

    current_milestone: milestone['version'],
    current_milestone_name: milestone['name'],
    latest_completed_milestone: latestCompleted?.version || null,
    latest_completed_milestone_name: latestCompleted?.name || null,
    phase_dir_count: phaseDirCount,
    phase_archive_path: latestCompleted
      ? toPosixPath(
          path.relative(
            cwd,
            path.join(
              planningRoot(cwd),
              'milestones',
              `${latestCompleted.version}-phases`,
            ),
          ),
        )
      : null,

    project_exists: pathExistsInternal(cwd, '.planning/PROJECT.md'),
    roadmap_exists: fs.existsSync(path.join(planningDir(cwd), 'ROADMAP.md')),
    state_exists: fs.existsSync(path.join(planningDir(cwd), 'STATE.md')),

    project_path: '.planning/PROJECT.md',
    roadmap_path: toPosixPath(
      path.relative(cwd, path.join(planningDir(cwd), 'ROADMAP.md')),
    ),
    state_path: toPosixPath(
      path.relative(cwd, path.join(planningDir(cwd), 'STATE.md')),
    ),
  };

  output(withProjectRoot(cwd, result), raw);
}

function cmdInitQuick(cwd: string, description: string | undefined, raw: boolean): void {
  const config = loadConfig(cwd);
  const now = new Date();
  const slug = description ? generateSlugInternal(description)?.substring(0, 40) : null;

  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const dateStr = yy + mm + dd;
  const secondsSinceMidnight =
    now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
  const timeBlocks = Math.floor(secondsSinceMidnight / 2);
  const timeEncoded = timeBlocks.toString(36).padStart(3, '0');
  const quickId = dateStr + '-' + timeEncoded;
  const branchSlug = slug || 'quick';
  const quickBranchName = config.quick_branch_template
    ? (config.quick_branch_template as string)
        .replace('{num}', quickId)
        .replace('{quick}', quickId)
        .replace('{slug}', branchSlug)
    : null;

  const result: Record<string, unknown> = {
    planner_model: resolveModelInternal(cwd, 'gsd-planner'),
    executor_model: resolveModelInternal(cwd, 'gsd-executor'),
    checker_model: resolveModelInternal(cwd, 'gsd-plan-checker'),
    verifier_model: resolveModelInternal(cwd, 'gsd-verifier'),

    commit_docs: config.commit_docs,
    branch_name: quickBranchName,

    quick_id: quickId,
    slug: slug,
    description: description || null,

    date: now.toISOString().split('T')[0],
    timestamp: now.toISOString(),

    quick_dir: '.planning/quick',
    task_dir: slug ? `.planning/quick/${quickId}-${slug}` : null,

    roadmap_exists: fs.existsSync(path.join(planningDir(cwd), 'ROADMAP.md')),
    planning_exists: fs.existsSync(planningRoot(cwd)),
  };

  output(withProjectRoot(cwd, result), raw);
}

function cmdInitIngestDocs(cwd: string, raw: boolean): void {
  const config = loadConfig(cwd);
  const result: Record<string, unknown> = {
    project_exists: pathExistsInternal(cwd, '.planning/PROJECT.md'),
    planning_exists: fs.existsSync(planningRoot(cwd)),
    ...getInitGitState(cwd),
    project_path: '.planning/PROJECT.md',
    commit_docs: config.commit_docs,
  };
  output(withProjectRoot(cwd, result), raw);
}

function cmdInitResume(cwd: string, raw: boolean): void {
  const config = loadConfig(cwd);

  let interruptedAgentId: string | null = null;
  const agentIdRaw = platformReadSync(
    path.join(planningRoot(cwd), 'current-agent-id.txt'),
  );
  if (agentIdRaw !== null) interruptedAgentId = agentIdRaw.trim();

  const result: Record<string, unknown> = {
    state_exists: fs.existsSync(path.join(planningDir(cwd), 'STATE.md')),
    roadmap_exists: fs.existsSync(path.join(planningDir(cwd), 'ROADMAP.md')),
    project_exists: pathExistsInternal(cwd, '.planning/PROJECT.md'),
    planning_exists: fs.existsSync(planningRoot(cwd)),

    state_path: toPosixPath(
      path.relative(cwd, path.join(planningDir(cwd), 'STATE.md')),
    ),
    roadmap_path: toPosixPath(
      path.relative(cwd, path.join(planningDir(cwd), 'ROADMAP.md')),
    ),
    project_path: '.planning/PROJECT.md',

    has_interrupted_agent: !!interruptedAgentId,
    interrupted_agent_id: interruptedAgentId,

    commit_docs: config.commit_docs,
  };

  output(withProjectRoot(cwd, result), raw);
}

function cmdInitVerifyWork(cwd: string, phase: string, raw: boolean): void {
  if (!phase) {
    error('phase required for init verify-work');
  }

  const config = loadConfig(cwd);
  let phaseInfo = findPhaseInternal(cwd, phase) as unknown as Record<string, unknown> | null;

  if (phaseInfo?.['archived']) {
    const roadmapPhase = getRoadmapPhaseInternal(cwd, phase) as unknown as Record<string, unknown> | null;
    if (roadmapPhase?.['found']) {
      phaseInfo = null;
    }
  }

  if (!phaseInfo) {
    const roadmapPhase = getRoadmapPhaseInternal(cwd, phase) as unknown as Record<string, unknown> | null;
    if (roadmapPhase?.['found']) {
      const phaseName = roadmapPhase['phase_name'] as string | null;
      phaseInfo = {
        found: true,
        directory: null,
        phase_number: roadmapPhase['phase_number'],
        phase_name: phaseName,
        phase_slug: phaseName
          ? phaseName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
          : null,
        plans: [],
        summaries: [],
        incomplete_plans: [],
        has_research: false,
        has_context: false,
        has_verification: false,
      };
    }
  }

  const result: Record<string, unknown> = {
    planner_model: resolveModelInternal(cwd, 'gsd-planner'),
    checker_model: resolveModelInternal(cwd, 'gsd-plan-checker'),

    commit_docs: config.commit_docs,

    phase_found: !!phaseInfo,
    phase_dir: phaseInfo?.['directory'] || null,
    phase_number: phaseInfo?.['phase_number'] || null,
    phase_name: phaseInfo?.['phase_name'] || null,

    has_verification: phaseInfo?.['has_verification'] || false,
  };

  output(withProjectRoot(cwd, result), raw);
}

function cmdInitPhaseOp(cwd: string, phase: string, raw: boolean): void {
  const config = loadConfig(cwd);
  let phaseInfo = findPhaseInternal(cwd, phase) as unknown as Record<string, unknown> | null;

  if (phaseInfo?.['archived']) {
    const roadmapPhase = getRoadmapPhaseInternal(cwd, phase) as unknown as Record<string, unknown> | null;
    if (roadmapPhase?.['found']) {
      const phaseName = roadmapPhase['phase_name'] as string | null;
      phaseInfo = {
        found: true,
        directory: null,
        phase_number: roadmapPhase['phase_number'],
        phase_name: phaseName,
        phase_slug: phaseName
          ? phaseName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
          : null,
        plans: [],
        summaries: [],
        incomplete_plans: [],
        has_research: false,
        has_context: false,
        has_verification: false,
      };
    }
  }

  if (!phaseInfo) {
    const roadmapPhase = getRoadmapPhaseInternal(cwd, phase) as unknown as Record<string, unknown> | null;
    if (roadmapPhase?.['found']) {
      const phaseName = roadmapPhase['phase_name'] as string | null;
      phaseInfo = {
        found: true,
        directory: null,
        phase_number: roadmapPhase['phase_number'],
        phase_name: phaseName,
        phase_slug: phaseName
          ? phaseName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
          : null,
        plans: [],
        summaries: [],
        incomplete_plans: [],
        has_research: false,
        has_context: false,
        has_verification: false,
      };
    }
  }

  const phaseDir = (phaseInfo?.['directory'] as string | undefined) || null;
  const phaseNumber = (phaseInfo?.['phase_number'] as string | undefined) || null;
  const phaseName = (phaseInfo?.['phase_name'] as string | undefined) || null;
  const rawProjectCode = (config.project_code as string) || '';
  let expectedPhaseDir: string | null = null;
  if (!phaseDir && phaseNumber && phaseName) {
    const paddedNum = normalizePhaseName(phaseNumber);
    const slug = (generateSlugInternal(phaseName) || '').substring(0, 60);
    if (slug) {
      const prefix = rawProjectCode ? `${rawProjectCode}-` : '';
      const dirName = `${prefix}${paddedNum}-${slug}`;
      expectedPhaseDir = toPosixPath(
        path.relative(cwd, path.join(planningPaths(cwd).phases, dirName)),
      );
    }
  }

  const result: Record<string, unknown> = {
    commit_docs: config.commit_docs,
    brave_search:
      typeof config.brave_search === 'string'
        ? maskIfSecret('brave_search', config.brave_search)
        : config.brave_search,
    firecrawl:
      typeof config.firecrawl === 'string'
        ? maskIfSecret('firecrawl', config.firecrawl)
        : config.firecrawl,
    exa_search:
      typeof config.exa_search === 'string'
        ? maskIfSecret('exa_search', config.exa_search)
        : config.exa_search,

    phase_found: !!phaseInfo,
    phase_dir: phaseDir,
    expected_phase_dir: expectedPhaseDir,
    phase_number: phaseNumber,
    phase_name: phaseName,
    phase_slug: phaseInfo?.['phase_slug'] || null,
    padded_phase: phaseNumber ? normalizePhaseName(phaseNumber) : null,

    has_research: phaseInfo?.['has_research'] || false,
    has_context: phaseInfo?.['has_context'] || false,
    has_plans: ((phaseInfo?.['plans'] as unknown[] | undefined)?.length || 0) > 0,
    has_verification: phaseInfo?.['has_verification'] || false,
    has_reviews: phaseInfo?.['has_reviews'] || false,
    plan_count: (phaseInfo?.['plans'] as unknown[] | undefined)?.length || 0,

    roadmap_exists: fs.existsSync(path.join(planningDir(cwd), 'ROADMAP.md')),
    planning_exists: fs.existsSync(planningDir(cwd)),

    state_path: toPosixPath(
      path.relative(cwd, path.join(planningDir(cwd), 'STATE.md')),
    ),
    roadmap_path: toPosixPath(
      path.relative(cwd, path.join(planningDir(cwd), 'ROADMAP.md')),
    ),
    requirements_path: toPosixPath(
      path.relative(cwd, path.join(planningDir(cwd), 'REQUIREMENTS.md')),
    ),
  };

  if (phaseInfo?.['directory']) {
    const phaseDirFull = path.join(cwd, phaseInfo['directory'] as string);
    try {
      const files = fs.readdirSync(phaseDirFull);
      const contextFile = findContextMdIn(phaseDirFull);
      if (contextFile) {
        result['context_path'] = toPosixPath(
          path.join(phaseInfo['directory'] as string, contextFile),
        );
      }
      const researchFile = files.find(
        (f) => f.endsWith('-RESEARCH.md') || f === 'RESEARCH.md',
      );
      if (researchFile) {
        result['research_path'] = toPosixPath(
          path.join(phaseInfo['directory'] as string, researchFile),
        );
      }
      const verificationFile = files.find(
        (f) => f.endsWith('-VERIFICATION.md') || f === 'VERIFICATION.md',
      );
      if (verificationFile) {
        result['verification_path'] = toPosixPath(
          path.join(phaseInfo['directory'] as string, verificationFile),
        );
      }
      const uatFile = files.find((f) => f.endsWith('-UAT.md') || f === 'UAT.md');
      if (uatFile) {
        result['uat_path'] = toPosixPath(
          path.join(phaseInfo['directory'] as string, uatFile),
        );
      }
      const reviewsFile = files.find(
        (f) => f.endsWith('-REVIEWS.md') || f === 'REVIEWS.md',
      );
      if (reviewsFile) {
        result['reviews_path'] = toPosixPath(
          path.join(phaseInfo['directory'] as string, reviewsFile),
        );
      }
    } catch {
      /* intentionally empty */
    }
  }

  output(withProjectRoot(cwd, result), raw);
}

function cmdInitTodos(cwd: string, area: string | undefined, raw: boolean): void {
  const config = loadConfig(cwd);
  const now = new Date();

  const pendingDir = path.join(planningDir(cwd), 'todos', 'pending');
  let count = 0;
  const todos: Record<string, unknown>[] = [];

  try {
    const files = fs.readdirSync(pendingDir).filter((f) => f.endsWith('.md'));
    for (const file of files) {
      const content = platformReadSync(path.join(pendingDir, file));
      if (content === null) continue;
      try {
        const createdMatch = content.match(/^created:\s*(.+)$/m);
        const titleMatch = content.match(/^title:\s*(.+)$/m);
        const areaMatch = content.match(/^area:\s*(.+)$/m);
        const todoArea = areaMatch ? areaMatch[1].trim() : 'general';

        if (area && todoArea !== area) continue;

        count++;
        todos.push({
          file,
          created: createdMatch ? createdMatch[1].trim() : 'unknown',
          title: titleMatch ? titleMatch[1].trim() : 'Untitled',
          area: todoArea,
          path: toPosixPath(
            path.relative(
              cwd,
              path.join(planningDir(cwd), 'todos', 'pending', file),
            ),
          ),
        });
      } catch {
        /* intentionally empty */
      }
    }
  } catch {
    /* intentionally empty */
  }

  const result: Record<string, unknown> = {
    commit_docs: config.commit_docs,

    date: now.toISOString().split('T')[0],
    timestamp: now.toISOString(),

    todo_count: count,
    todos,
    area_filter: area || null,

    pending_dir: toPosixPath(
      path.relative(cwd, path.join(planningDir(cwd), 'todos', 'pending')),
    ),
    completed_dir: toPosixPath(
      path.relative(cwd, path.join(planningDir(cwd), 'todos', 'completed')),
    ),

    planning_exists: fs.existsSync(planningDir(cwd)),
    todos_dir_exists: fs.existsSync(path.join(planningDir(cwd), 'todos')),
    pending_dir_exists: fs.existsSync(path.join(planningDir(cwd), 'todos', 'pending')),
  };

  output(withProjectRoot(cwd, result), raw);
}

function cmdInitMilestoneOp(cwd: string, raw: boolean): void {
  const config = loadConfig(cwd);
  const milestone = getMilestoneInfo(cwd) as unknown as Record<string, unknown>;

  let phaseCount = 0;
  let completedPhases = 0;
  const phasesDir = path.join(planningDir(cwd), 'phases');

  const roadmapPhaseNumbers: string[] = [];
  try {
    const roadmapPath = path.join(planningDir(cwd), 'ROADMAP.md');
    const roadmapRaw = fs.readFileSync(roadmapPath, 'utf-8');
    const currentSection = extractCurrentMilestone(roadmapRaw, cwd);
    const phasePattern = /#{2,4}\s*Phase\s+(\d+[A-Z]?(?:\.\d+)*)\s*:/gi;
    let m: RegExpExecArray | null;
    while ((m = phasePattern.exec(currentSection)) !== null) {
      roadmapPhaseNumbers.push(m[1]);
    }
  } catch {
    /* intentionally empty */
  }

  const canonicalizePhase = (tok: string): string => {
    const m = tok.match(/^(\d+)([A-Z]?(?:\.\d+)*)$/);
    return m ? String(parseInt(m[1], 10)) + m[2] : tok;
  };
  const diskPhaseDirs = new Map<string, string>();
  try {
    const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const m = e.name.match(/^(\d+[A-Z]?(?:\.\d+)*)/);
      if (!m) continue;
      diskPhaseDirs.set(canonicalizePhase(m[1]), e.name);
    }
  } catch {
    /* intentionally empty */
  }

  if (roadmapPhaseNumbers.length > 0) {
    phaseCount = roadmapPhaseNumbers.length;
    for (const num of roadmapPhaseNumbers) {
      const dirName = diskPhaseDirs.get(canonicalizePhase(num));
      if (!dirName) continue;
      try {
        const hasSummary = listPhaseSummaryFiles(path.join(phasesDir, dirName)).length > 0;
        if (hasSummary) completedPhases++;
      } catch {
        /* intentionally empty */
      }
    }
  } else {
    try {
      const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
      const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
      phaseCount = dirs.length;
      for (const dir of dirs) {
        try {
          const hasSummary = listPhaseSummaryFiles(path.join(phasesDir, dir)).length > 0;
          if (hasSummary) completedPhases++;
        } catch {
          /* intentionally empty */
        }
      }
    } catch {
      /* intentionally empty */
    }
  }

  const archiveDir = path.join(planningRoot(cwd), 'archive');
  let archivedMilestones: string[] = [];
  try {
    archivedMilestones = fs
      .readdirSync(archiveDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    /* intentionally empty */
  }

  const result: Record<string, unknown> = {
    commit_docs: config.commit_docs,

    milestone_version: milestone['version'],
    milestone_name: milestone['name'],
    milestone_slug: generateSlugInternal(milestone['name'] as string),

    phase_count: phaseCount,
    completed_phases: completedPhases,
    all_phases_complete: phaseCount > 0 && phaseCount === completedPhases,

    archived_milestones: archivedMilestones,
    archive_count: archivedMilestones.length,

    project_exists: pathExistsInternal(cwd, '.planning/PROJECT.md'),
    roadmap_exists: fs.existsSync(path.join(planningDir(cwd), 'ROADMAP.md')),
    state_exists: fs.existsSync(path.join(planningDir(cwd), 'STATE.md')),
    archive_exists: fs.existsSync(path.join(planningRoot(cwd), 'archive')),
    phases_dir_exists: fs.existsSync(path.join(planningDir(cwd), 'phases')),
  };

  output(withProjectRoot(cwd, result), raw);
}

function cmdInitMapCodebase(cwd: string, raw: boolean): void {
  const config = loadConfig(cwd);
  const now = new Date();

  const codebaseDir = path.join(planningRoot(cwd), 'codebase');
  let existingMaps: string[] = [];
  try {
    existingMaps = fs.readdirSync(codebaseDir).filter((f) => f.endsWith('.md'));
  } catch {
    /* intentionally empty */
  }

  const result: Record<string, unknown> = {
    mapper_model: resolveModelInternal(cwd, 'gsd-codebase-mapper'),

    commit_docs: config.commit_docs,
    search_gitignored: config.search_gitignored,
    parallelization: config.parallelization,
    subagent_timeout: config.subagent_timeout,

    date: now.toISOString().split('T')[0],
    timestamp: now.toISOString(),

    codebase_dir: '.planning/codebase',

    existing_maps: existingMaps,
    has_maps: existingMaps.length > 0,

    planning_exists: pathExistsInternal(cwd, '.planning'),
    codebase_dir_exists: pathExistsInternal(cwd, '.planning/codebase'),
  };

  output(withProjectRoot(cwd, result), raw);
}

function cmdInitManager(cwd: string, raw: boolean): void {
  const config = loadConfig(cwd);
  const milestone = getMilestoneInfo(cwd) as unknown as Record<string, unknown>;
  const _slashRuntime = resolveRuntime(cwd);

  const paths = planningPaths(cwd);

  if (!fs.existsSync(paths.roadmap)) {
    error(`No ROADMAP.md found. Run ${formatGsdSlash('new-milestone', _slashRuntime) as string} first.`);
  }
  if (!fs.existsSync(paths.state)) {
    error(`No STATE.md found. Run ${formatGsdSlash('new-milestone', _slashRuntime) as string} first.`);
  }
  const rawContent = fs.readFileSync(paths.roadmap, 'utf-8');
  const content = extractCurrentMilestone(rawContent, cwd);
  const phasesDir = paths.phases;
  const isDirInMilestone = getMilestonePhaseFilter(cwd);

  const _phaseDirEntries = (() => {
    try {
      return fs
        .readdirSync(phasesDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return [];
    }
  })();

  const _checkboxStates = new Map<string, boolean>();
  const _cbPattern = /-\s*\[(x| )\]\s*.*Phase\s+(\d+[A-Z]?(?:\.\d+)*)[:\s]/gi;
  let _cbMatch: RegExpExecArray | null;
  while ((_cbMatch = _cbPattern.exec(content)) !== null) {
    _checkboxStates.set(_cbMatch[2], _cbMatch[1].toLowerCase() === 'x');
  }

  const phasePattern = /#{2,4}\s*Phase\s+(\d+[A-Z]?(?:\.\d+)*)\s*:\s*([^\n]+)/gi;
  const phases: Record<string, unknown>[] = [];
  let match: RegExpExecArray | null;

  while ((match = phasePattern.exec(content)) !== null) {
    const phaseNum = match[1];
    const phaseName = match[2].replace(/\(INSERTED\)/i, '').trim();

    const sectionStart = match.index;
    const restOfContent = content.slice(sectionStart);
    const nextHeader = restOfContent.match(/\n#{2,4}\s+Phase\s+\d[\d.]*/i);
    const sectionEnd = nextHeader
      ? sectionStart + (nextHeader.index as number)
      : content.length;
    const section = content.slice(sectionStart, sectionEnd);

    const goalMatch = section.match(/\*\*Goal(?::\*\*|\*\*:)\s*([^\n]+)/i);
    const goal = goalMatch ? goalMatch[1].trim() : null;

    const dependsMatch = section.match(/\*\*Depends on(?::\*\*|\*\*:)\s*([^\n]+)/i);
    const depends_on = dependsMatch ? dependsMatch[1].trim() : null;

    const normalized = normalizePhaseName(phaseNum);
    let diskStatus = 'no_directory';
    let planCount = 0;
    let summaryCount = 0;
    let hasContext = false;
    let hasResearch = false;
    let lastActivity: string | null = null;
    let isActive = false;

    try {
      const dirs = _phaseDirEntries.filter(isDirInMilestone);
      const dirMatch = dirs.find((d) => phaseTokenMatches(d, normalized));

      if (dirMatch) {
        const fullDir = path.join(phasesDir, dirMatch);
        const phaseFiles = fs.readdirSync(fullDir);
        planCount = listPhasePlanFiles(fullDir).length;
        summaryCount = listPhaseSummaryFiles(fullDir).length;
        hasContext = findContextMdIn(fullDir) !== null;
        hasResearch = phaseFiles.some(
          (f) => f.endsWith('-RESEARCH.md') || f === 'RESEARCH.md',
        );

        if (summaryCount >= planCount && planCount > 0) diskStatus = 'complete';
        else if (summaryCount > 0) diskStatus = 'partial';
        else if (planCount > 0) diskStatus = 'planned';
        else if (hasResearch) diskStatus = 'researched';
        else if (hasContext) diskStatus = 'discussed';
        else diskStatus = 'empty';

        const nowMs = Date.now();
        let newestMtime = 0;
        for (const f of phaseFiles) {
          try {
            const stat = fs.statSync(path.join(fullDir, f));
            if (stat.mtimeMs > newestMtime) newestMtime = stat.mtimeMs;
          } catch {
            /* intentionally empty */
          }
        }
        if (newestMtime > 0) {
          lastActivity = new Date(newestMtime).toISOString();
          isActive = nowMs - newestMtime < 300000;
        }
      }
    } catch {
      /* intentionally empty */
    }

    const roadmapComplete = _checkboxStates.get(phaseNum) || false;
    if (roadmapComplete && diskStatus !== 'complete') {
      diskStatus = 'complete';
    }

    phases.push({
      number: phaseNum,
      name: phaseName,
      goal,
      depends_on,
      disk_status: diskStatus,
      has_context: hasContext,
      has_research: hasResearch,
      plan_count: planCount,
      summary_count: summaryCount,
      roadmap_complete: roadmapComplete,
      last_activity: lastActivity,
      is_active: isActive,
    });
  }

  const MAX_NAME_WIDTH = 20;
  for (const phase of phases) {
    const name = phase['name'] as string;
    if (name.length > MAX_NAME_WIDTH) {
      phase['display_name'] = name.slice(0, MAX_NAME_WIDTH - 1) + '…';
    } else {
      phase['display_name'] = name;
    }
  }

  const completedNums = new Set(
    phases.filter((p) => p['disk_status'] === 'complete').map((p) => p['number'] as string),
  );

  const _allCompletedPattern = /-\s*\[x\]\s*.*Phase\s+(\d+[A-Z]?(?:\.\d+)*)[:\s]/gi;
  let _allMatch: RegExpExecArray | null;
  while ((_allMatch = _allCompletedPattern.exec(rawContent)) !== null) {
    completedNums.add(_allMatch[1]);
  }

  const phaseMap = new Map(phases.map((p) => [p['number'] as string, p]));

  function reaches(from: string, to: string, visited = new Set<string>()): boolean {
    if (visited.has(from)) return false;
    visited.add(from);
    const p = phaseMap.get(from);
    if (!p || !p['dep_phases'] || (p['dep_phases'] as string[]).length === 0) return false;
    if ((p['dep_phases'] as string[]).includes(to)) return true;
    return (p['dep_phases'] as string[]).some((dep) => reaches(dep, to, visited));
  }

  function hasDepRelationship(numA: string, numB: string): boolean {
    return reaches(numA, numB) || reaches(numB, numA);
  }

  for (const phase of phases) {
    if (
      !phase['depends_on'] ||
      /^none$/i.test((phase['depends_on'] as string).trim())
    ) {
      phase['deps_satisfied'] = true;
    } else {
      const depNums = (phase['depends_on'] as string).match(/\d+(?:\.\d+)*/g) || [];
      phase['deps_satisfied'] = depNums.every((n) => completedNums.has(n));
      phase['dep_phases'] = depNums;
    }
  }

  for (const phase of phases) {
    phase['deps_display'] =
      phase['dep_phases'] && (phase['dep_phases'] as string[]).length > 0
        ? (phase['dep_phases'] as string[]).join(',')
        : '—';
  }

  for (const phase of phases) {
    phase['is_next_to_discuss'] =
      (phase['disk_status'] === 'empty' || phase['disk_status'] === 'no_directory') &&
      phase['deps_satisfied'];
  }

  let waitingSignal: unknown = null;
  try {
    const waitingPath = path.join(cwd, '.planning', 'WAITING.json');
    const waitingRaw = platformReadSync(waitingPath);
    if (waitingRaw !== null) {
      waitingSignal = JSON.parse(waitingRaw);
    }
  } catch {
    /* intentionally empty */
  }

  const recommendedActions: Record<string, unknown>[] = [];
  for (const phase of phases) {
    if (phase['disk_status'] === 'complete') continue;
    if (/^999(?:\.|$)/.test(phase['number'] as string)) continue;

    if (phase['disk_status'] === 'planned' && phase['deps_satisfied']) {
      recommendedActions.push({
        phase: phase['number'],
        phase_name: phase['name'],
        action: 'execute',
        reason: `${phase['plan_count'] as number} plans ready, dependencies met`,
        command: `${formatGsdSlash('execute-phase', _slashRuntime) as string} ${phase['number'] as string}`,
      });
    } else if (
      phase['disk_status'] === 'discussed' ||
      phase['disk_status'] === 'researched'
    ) {
      recommendedActions.push({
        phase: phase['number'],
        phase_name: phase['name'],
        action: 'plan',
        reason: 'Context gathered, ready for planning',
        command: `${formatGsdSlash('plan-phase', _slashRuntime) as string} ${phase['number'] as string}`,
      });
    } else if (
      (phase['disk_status'] === 'empty' || phase['disk_status'] === 'no_directory') &&
      phase['is_next_to_discuss']
    ) {
      recommendedActions.push({
        phase: phase['number'],
        phase_name: phase['name'],
        action: 'discuss',
        reason: 'Unblocked, ready to gather context',
        command: `${formatGsdSlash('discuss-phase', _slashRuntime) as string} ${phase['number'] as string}`,
      });
    }
  }

  const activeExecuting = phases.filter(
    (p) =>
      p['disk_status'] === 'partial' ||
      (p['disk_status'] === 'planned' && p['is_active']),
  );
  const activePlanning = phases.filter(
    (p) =>
      p['is_active'] &&
      (p['disk_status'] === 'discussed' || p['disk_status'] === 'researched'),
  );

  const filteredActions = recommendedActions.filter((action) => {
    if (action['action'] === 'execute' && activeExecuting.length > 0) {
      return activeExecuting.every(
        (active) => !hasDepRelationship(action['phase'] as string, active['number'] as string),
      );
    }
    if (action['action'] === 'plan' && activePlanning.length > 0) {
      return activePlanning.every(
        (active) => !hasDepRelationship(action['phase'] as string, active['number'] as string),
      );
    }
    return true;
  });

  const nonBacklogPhases = phases.filter((p) => !/^999(?:\.|$)/.test(p['number'] as string));
  const completedCount = nonBacklogPhases.filter((p) => p['disk_status'] === 'complete').length;

  const sanitizeFlags = (rawVal: unknown): string => {
    const val = typeof rawVal === 'string' ? rawVal : '';
    if (!val) return '';
    const tokens = val.split(/\s+/).filter(Boolean);
    const safe = tokens.every(
      (t) =>
        /^--[a-zA-Z0-9][-a-zA-Z0-9]*$/.test(t) ||
        /^[a-zA-Z0-9][-a-zA-Z0-9_.]*$/.test(t),
    );
    if (!safe) {
      process.stderr.write(
        `gsd-tools: warning: manager.flags contains invalid tokens, ignoring: ${val}\n`,
      );
      return '';
    }
    return val;
  };
  const mgr = config.manager as Record<string, unknown> | undefined;
  const mgrFlags = mgr?.['flags'] as Record<string, unknown> | undefined;
  const managerFlags = {
    discuss: sanitizeFlags(mgrFlags?.['discuss']),
    plan: sanitizeFlags(mgrFlags?.['plan']),
    execute: sanitizeFlags(mgrFlags?.['execute']),
  };

  const result: Record<string, unknown> = {
    milestone_version: milestone['version'],
    milestone_name: milestone['name'],
    phases,
    phase_count: phases.length,
    completed_count: completedCount,
    in_progress_count: phases.filter((p) =>
      ['partial', 'planned', 'discussed', 'researched'].includes(p['disk_status'] as string),
    ).length,
    recommended_actions: filteredActions,
    waiting_signal: waitingSignal,
    all_complete:
      completedCount === nonBacklogPhases.length && nonBacklogPhases.length > 0,
    project_exists: pathExistsInternal(cwd, '.planning/PROJECT.md'),
    roadmap_exists: true,
    state_exists: true,
    manager_flags: managerFlags,
  };

  output(withProjectRoot(cwd, result), raw);
}

function cmdInitProgress(cwd: string, raw: boolean): void {
  try {
    const { pruneOrphanedWorktrees } = core;
    (pruneOrphanedWorktrees as (cwd: string) => void)(cwd);
  } catch {
    /* intentionally empty */
  }
  const config = loadConfig(cwd);
  const milestone = getMilestoneInfo(cwd) as unknown as Record<string, unknown>;

  const phasesDir = path.join(planningDir(cwd), 'phases');
  const phases: Record<string, unknown>[] = [];
  let currentPhase: Record<string, unknown> | null = null;
  let nextPhase: Record<string, unknown> | null = null;

  const roadmapPhaseNums = new Set<string>();
  const roadmapPhaseNames = new Map<string, string>();
  const roadmapCheckboxStates = new Map<string, boolean>();
  try {
    const roadmapContent = extractCurrentMilestone(
      fs.readFileSync(path.join(planningDir(cwd), 'ROADMAP.md'), 'utf-8'),
      cwd,
    );
    const headingPattern = /#{2,4}\s*Phase\s+(\d+[A-Z]?(?:\.\d+)*)\s*:\s*([^\n]+)/gi;
    let hm: RegExpExecArray | null;
    while ((hm = headingPattern.exec(roadmapContent)) !== null) {
      roadmapPhaseNums.add(hm[1]);
      roadmapPhaseNames.set(hm[1], hm[2].replace(/\(INSERTED\)/i, '').trim());
    }
    const cbPattern = /-\s*\[(x| )\]\s*.*Phase\s+(\d+[A-Z]?(?:\.\d+)*)[:\s]/gi;
    let cbm: RegExpExecArray | null;
    while ((cbm = cbPattern.exec(roadmapContent)) !== null) {
      roadmapCheckboxStates.set(cbm[2], cbm[1].toLowerCase() === 'x');
    }
  } catch {
    /* intentionally empty */
  }

  const isDirInMilestone = getMilestonePhaseFilter(cwd);
  const seenPhaseNums = new Set<string>();

  try {
    const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter(isDirInMilestone)
      .sort((a, b) => {
        const pa = a.match(/^(\d+[A-Z]?(?:\.\d+)*)/i);
        const pb = b.match(/^(\d+[A-Z]?(?:\.\d+)*)/i);
        if (!pa || !pb) return a.localeCompare(b);
        return parseInt(pa[1], 10) - parseInt(pb[1], 10);
      });

    for (const dir of dirs) {
      const dirMatch = dir.match(/^(\d+[A-Z]?(?:\.\d+)*)-?(.*)/i);
      const phaseNumber = dirMatch ? dirMatch[1] : dir;
      const phaseName = dirMatch && dirMatch[2] ? dirMatch[2] : null;
      seenPhaseNums.add(phaseNumber.replace(/^0+/, '') || '0');

      const phasePath = path.join(phasesDir, dir);
      const phaseFiles = fs.readdirSync(phasePath);

      const plans = listPhasePlanFiles(phasePath);
      const summaries = listPhaseSummaryFiles(phasePath);
      const hasResearch = phaseFiles.some(
        (f) => f.endsWith('-RESEARCH.md') || f === 'RESEARCH.md',
      );

      const status =
        summaries.length >= plans.length && plans.length > 0
          ? 'complete'
          : plans.length > 0
            ? 'in_progress'
            : hasResearch
              ? 'researched'
              : 'pending';

      const phaseInfo: Record<string, unknown> = {
        number: phaseNumber,
        name: phaseName,
        directory: toPosixPath(
          path.relative(cwd, path.join(planningDir(cwd), 'phases', dir)),
        ),
        status,
        plan_count: plans.length,
        summary_count: summaries.length,
        has_research: hasResearch,
      };

      phases.push(phaseInfo);

      if (!currentPhase && (status === 'in_progress' || status === 'researched')) {
        currentPhase = phaseInfo;
      }
      if (!nextPhase && status === 'pending') {
        nextPhase = phaseInfo;
      }
    }
  } catch {
    /* intentionally empty */
  }

  for (const [num, name] of roadmapPhaseNames) {
    const stripped = num.replace(/^0+/, '') || '0';
    if (!seenPhaseNums.has(stripped)) {
      const checkboxComplete =
        roadmapCheckboxStates.get(num) === true ||
        roadmapCheckboxStates.get(stripped) === true;
      const status = checkboxComplete ? 'complete' : 'not_started';
      const phaseInfo: Record<string, unknown> = {
        number: num,
        name: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
        directory: null,
        status,
        plan_count: 0,
        summary_count: 0,
        has_research: false,
      };
      phases.push(phaseInfo);
      if (!nextPhase && !currentPhase && status !== 'complete') {
        nextPhase = phaseInfo;
      }
    }
  }

  phases.sort(
    (a, b) => parseInt(a['number'] as string, 10) - parseInt(b['number'] as string, 10),
  );

  let pausedAt: string | null = null;
  const state = platformReadSync(path.join(planningDir(cwd), 'STATE.md'));
  if (state !== null) {
    const pauseMatch = state.match(/\*\*Paused At:\*\*\s*(.+)/);
    if (pauseMatch) pausedAt = pauseMatch[1].trim();
  }

  const result: Record<string, unknown> = {
    executor_model: resolveModelInternal(cwd, 'gsd-executor'),
    planner_model: resolveModelInternal(cwd, 'gsd-planner'),

    commit_docs: config.commit_docs,

    milestone_version: milestone['version'],
    milestone_name: milestone['name'],

    phases,
    phase_count: phases.length,
    completed_count: phases.filter((p) => p['status'] === 'complete').length,
    in_progress_count: phases.filter((p) => p['status'] === 'in_progress').length,

    current_phase: currentPhase,
    next_phase: nextPhase,
    paused_at: pausedAt,
    has_work_in_progress: !!currentPhase,

    project_exists: pathExistsInternal(cwd, '.planning/PROJECT.md'),
    roadmap_exists: fs.existsSync(path.join(planningDir(cwd), 'ROADMAP.md')),
    state_exists: fs.existsSync(path.join(planningDir(cwd), 'STATE.md')),
    state_path: toPosixPath(
      path.relative(cwd, path.join(planningDir(cwd), 'STATE.md')),
    ),
    roadmap_path: toPosixPath(
      path.relative(cwd, path.join(planningDir(cwd), 'ROADMAP.md')),
    ),
    project_path: '.planning/PROJECT.md',
    config_path: toPosixPath(
      path.relative(cwd, path.join(planningDir(cwd), 'config.json')),
    ),
  };

  output(withProjectRoot(cwd, result), raw);
}

function detectChildRepos(dir: string): { name: string; path: string; has_uncommitted: boolean }[] {
  const repos: { name: string; path: string; has_uncommitted: boolean }[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return repos;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);
    const gitDir = path.join(fullPath, '.git');
    if (fs.existsSync(gitDir)) {
      const statusResult = execGit(['status', '--porcelain'], {
        cwd: fullPath,
        timeout: 5000,
      }) as unknown as Record<string, unknown>;
      const hasUncommitted =
        statusResult['exitCode'] === 0 &&
        (statusResult['stdout'] as string).length > 0;
      repos.push({ name: entry.name, path: fullPath, has_uncommitted: hasUncommitted });
    }
  }
  return repos;
}

function cmdInitNewWorkspace(cwd: string, raw: boolean): void {
  const homedir = process.env['HOME'] || os.homedir();
  const defaultBase = path.join(homedir, 'gsd-workspaces');

  const childRepos = detectChildRepos(cwd);

  const gitVersion = execGit(['--version'], { timeout: 5000 }) as unknown as Record<string, unknown>;
  const worktreeAvailable = gitVersion['exitCode'] === 0;

  const result: Record<string, unknown> = {
    default_workspace_base: defaultBase,
    child_repos: childRepos,
    child_repo_count: childRepos.length,
    worktree_available: worktreeAvailable,
    is_git_repo: pathExistsInternal(cwd, '.git'),
    cwd_repo_name: path.basename(cwd),
  };

  output(withProjectRoot(cwd, result), raw);
}

function cmdInitListWorkspaces(cwd: string, raw: boolean): void {
  const homedir = process.env['HOME'] || os.homedir();
  const defaultBase = path.join(homedir, 'gsd-workspaces');

  const workspaces: Record<string, unknown>[] = [];
  if (fs.existsSync(defaultBase)) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(defaultBase, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const wsPath = path.join(defaultBase, entry.name);
      const manifestPath = path.join(wsPath, 'WORKSPACE.md');
      if (!fs.existsSync(manifestPath)) continue;

      let repoCount = 0;
      let hasProject = false;
      let strategy = 'unknown';
      const manifest = platformReadSync(manifestPath);
      if (manifest !== null) {
        const strategyMatch = manifest.match(/^Strategy:\s*(.+)$/m);
        if (strategyMatch) strategy = strategyMatch[1].trim();
        const tableRows = manifest
          .split('\n')
          .filter(
            (l) =>
              l.match(/^\|\s*\w/) && !l.includes('Repo') && !l.includes('---'),
          );
        repoCount = tableRows.length;
      }
      hasProject = fs.existsSync(path.join(wsPath, '.planning', 'PROJECT.md'));

      workspaces.push({
        name: entry.name,
        path: wsPath,
        repo_count: repoCount,
        strategy,
        has_project: hasProject,
      });
    }
  }

  const result: Record<string, unknown> = {
    workspace_base: defaultBase,
    workspaces,
    workspace_count: workspaces.length,
  };

  output(result, raw);
}

function cmdInitRemoveWorkspace(cwd: string, name: string | undefined, raw: boolean): void {
  const homedir = process.env['HOME'] || os.homedir();
  const defaultBase = path.join(homedir, 'gsd-workspaces');

  if (!name) {
    error('workspace name required for init remove-workspace');
  }

  const wsPath = path.join(defaultBase, name!);
  const manifestPath = path.join(wsPath, 'WORKSPACE.md');

  if (!fs.existsSync(wsPath)) {
    error(`Workspace not found: ${wsPath}`);
  }

  const repos: { name: string; source: string; branch: string; strategy: string }[] = [];
  let strategy = 'unknown';
  const manifestContent = platformReadSync(manifestPath);
  if (manifestContent !== null) {
    try {
      const manifest = manifestContent;
      const strategyMatch = manifest.match(/^Strategy:\s*(.+)$/m);
      if (strategyMatch) strategy = strategyMatch[1].trim();

      const lines = manifest.split('\n');
      for (const line of lines) {
        const lineMatch = line.match(
          /^\|\s*(\S+)\s*\|\s*(\S+)\s*\|\s*(\S+)\s*\|\s*(\S+)\s*\|$/,
        );
        if (lineMatch && lineMatch[1] !== 'Repo' && !lineMatch[1].includes('---')) {
          repos.push({
            name: lineMatch[1],
            source: lineMatch[2],
            branch: lineMatch[3],
            strategy: lineMatch[4],
          });
        }
      }
    } catch {
      /* best-effort */
    }
  }

  const dirtyRepos: string[] = [];
  for (const repo of repos) {
    const repoPath = path.join(wsPath, repo.name);
    if (!fs.existsSync(repoPath)) continue;
    const statusResult = execGit(['status', '--porcelain'], {
      cwd: repoPath,
      timeout: 5000,
    }) as unknown as Record<string, unknown>;
    if (
      statusResult['exitCode'] === 0 &&
      (statusResult['stdout'] as string).length > 0
    ) {
      dirtyRepos.push(repo.name);
    }
  }

  const result: Record<string, unknown> = {
    workspace_name: name,
    workspace_path: wsPath,
    has_manifest: fs.existsSync(manifestPath),
    strategy,
    repos,
    repo_count: repos.length,
    dirty_repos: dirtyRepos,
    has_dirty_repos: dirtyRepos.length > 0,
  };

  output(result, raw);
}

function buildAgentSkillsBlock(
  config: Record<string, unknown>,
  agentType: string,
  projectRoot: string,
): string {
  const runtime = (config && (config['runtime'] as string)) || 'claude';
  const globalSkillsBase = getGlobalSkillsBase(runtime);

  if (!config || !config['agent_skills'] || !agentType) return '';

  let skillPaths = (config['agent_skills'] as Record<string, unknown>)[agentType];
  if (!skillPaths) return '';

  if (typeof skillPaths === 'string') skillPaths = [skillPaths];
  if (!Array.isArray(skillPaths) || skillPaths.length === 0) return '';

  const validPaths: { ref: string; display: string }[] = [];
  for (const skillPath of skillPaths) {
    if (typeof skillPath !== 'string') continue;

    if (skillPath.startsWith('global:')) {
      const skillName = skillPath.slice(7);
      if (!skillName) {
        process.stderr.write(
          `[agent-skills] WARNING: "global:" prefix with empty skill name — skipping\n`,
        );
        continue;
      }
      if (!/^[a-zA-Z0-9_-]+$/.test(skillName)) {
        process.stderr.write(
          `[agent-skills] WARNING: Invalid global skill name "${skillName}" — skipping\n`,
        );
        continue;
      }
      if (globalSkillsBase === null) {
        process.stderr.write(
          `[agent-skills] WARNING: Runtime "${runtime}" does not use a skills directory — "global:${skillName}" is not supported on this runtime\n`,
        );
        continue;
      }
      const globalSkillDir = getGlobalSkillDir(runtime, skillName) as string;
      const globalSkillMd = path.join(globalSkillDir, 'SKILL.md');
      const displayPath = getGlobalSkillDisplayPath(runtime, skillName);
      if (!fs.existsSync(globalSkillMd)) {
        process.stderr.write(
          `[agent-skills] WARNING: Global skill not found at "${displayPath}/SKILL.md" — skipping\n`,
        );
        continue;
      }
      const pathCheck = validatePath(globalSkillMd, globalSkillsBase, { allowAbsolute: true }) as unknown as Record<string, unknown>;
      if (!pathCheck['safe']) {
        process.stderr.write(
          `[agent-skills] WARNING: Global skill "${skillName}" failed path check (symlink escape?) — skipping\n`,
        );
        continue;
      }
      validPaths.push({ ref: `${globalSkillDir}/SKILL.md`, display: displayPath });
      continue;
    }

    const pathCheck = validatePath(skillPath, projectRoot) as unknown as Record<string, unknown>;
    if (!pathCheck['safe']) {
      process.stderr.write(
        `[agent-skills] WARNING: Skipping unsafe path "${skillPath}": ${pathCheck['error'] as string}\n`,
      );
      continue;
    }

    const skillMdPath = path.join(projectRoot, skillPath, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) {
      process.stderr.write(
        `[agent-skills] WARNING: Skill not found at "${skillPath}/SKILL.md" — skipping\n`,
      );
      continue;
    }

    validPaths.push({ ref: `${skillPath}/SKILL.md`, display: skillPath });
  }

  if (validPaths.length === 0) return '';

  const lines = validPaths.map((p) => `- @${p.ref}`).join('\n');
  return `<agent_skills>\nRead these user-configured skills:\n${lines}\n</agent_skills>`;
}

function cmdAgentSkills(
  cwd: string,
  agentType: string | undefined,
  raw: boolean,
  jsonMode: boolean,
): void {
  if (!agentType) {
    output('', raw, '');
    return;
  }

  const config = loadConfig(cwd);
  const block = buildAgentSkillsBlock(
    config,
    agentType,
    cwd,
  );

  if (jsonMode) {
    const skillPaths =
      (config && config.agent_skills && (config.agent_skills as Record<string, unknown>)[agentType]) || [];
    const normalizedPaths = Array.isArray(skillPaths)
      ? skillPaths
      : skillPaths
        ? [skillPaths]
        : [];
    output({ agent_type: agentType, block: block || '', skills_count: normalizedPaths.length }, raw);
    return;
  }

  if (block) {
    process.stdout.write(block);
  }
  process.exit(0);
}

interface SkillEntry {
  name: string;
  description: string;
  triggers: string[];
  path: string;
  file_path: string;
  root: string;
  scope: string;
  installed: boolean;
  deprecated: boolean;
}

interface RootSummary {
  root: string;
  path: string;
  scope: string;
  present: boolean;
  deprecated: boolean;
  skill_count?: number;
  command_count?: number;
}

interface SkillManifest {
  skills: SkillEntry[];
  roots: RootSummary[];
  installation: {
    gsd_skills_installed: boolean;
    legacy_claude_commands_installed: boolean;
  };
  counts: {
    skills: number;
    roots: number;
  };
}

function buildSkillManifest(cwd: string, skillsDir: string | null = null): SkillManifest {
  interface CanonicalRoot {
    root: string;
    path: string;
    scope: string;
    kind: string;
    present?: boolean;
    deprecated?: boolean;
  }

  const canonicalRoots: CanonicalRoot[] = skillsDir
    ? [
        {
          root: path.resolve(skillsDir),
          path: path.resolve(skillsDir),
          scope: 'custom',
          present: fs.existsSync(skillsDir),
          kind: 'skills',
        },
      ]
    : [
        {
          root: '.claude/skills',
          path: path.join(cwd, '.claude', 'skills'),
          scope: 'project',
          kind: 'skills',
        },
        {
          root: '.agents/skills',
          path: path.join(cwd, '.agents', 'skills'),
          scope: 'project',
          kind: 'skills',
        },
        {
          root: '.cursor/skills',
          path: path.join(cwd, '.cursor', 'skills'),
          scope: 'project',
          kind: 'skills',
        },
        {
          root: '.github/skills',
          path: path.join(cwd, '.github', 'skills'),
          scope: 'project',
          kind: 'skills',
        },
        {
          root: '.codex/skills',
          path: path.join(cwd, '.codex', 'skills'),
          scope: 'project',
          kind: 'skills',
        },
        {
          root: '~/.claude/skills',
          path: getGlobalSkillsBase('claude') as string,
          scope: 'global',
          kind: 'skills',
        },
        {
          root: '~/.codex/skills',
          path: getGlobalSkillsBase('codex') as string,
          scope: 'global',
          kind: 'skills',
        },
        {
          root: '.claude/get-shit-done/skills',
          path: path.join(os.homedir(), '.claude', 'get-shit-done', 'skills'),
          scope: 'import-only',
          kind: 'skills',
          deprecated: true,
        },
        {
          root: '.claude/commands/gsd',
          path: path.join(os.homedir(), '.claude', 'commands', 'gsd'),
          scope: 'legacy-commands',
          kind: 'commands',
          deprecated: true,
        },
      ];

  const skills: SkillEntry[] = [];
  const roots: RootSummary[] = [];
  let legacyClaudeCommandsInstalled = false;
  for (const rootInfo of canonicalRoots) {
    const rootPath = rootInfo.path;
    const rootSummary: RootSummary = {
      root: rootInfo.root,
      path: rootPath,
      scope: rootInfo.scope,
      present: fs.existsSync(rootPath),
      deprecated: !!rootInfo.deprecated,
    };

    if (!rootSummary.present) {
      roots.push(rootSummary);
      continue;
    }

    if (rootInfo.kind === 'commands') {
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(rootPath, { withFileTypes: true });
      } catch {
        roots.push(rootSummary);
        continue;
      }

      const commandFiles = entries.filter(
        (entry) => entry.isFile() && entry.name.endsWith('.md'),
      );
      rootSummary.command_count = commandFiles.length;
      if (rootSummary.command_count > 0) legacyClaudeCommandsInstalled = true;
      roots.push(rootSummary);
      continue;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(rootPath, { withFileTypes: true });
    } catch {
      roots.push(rootSummary);
      continue;
    }

    let skillCount = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillMdPath = path.join(rootPath, entry.name, 'SKILL.md');
      const content = platformReadSync(skillMdPath);
      if (content === null) continue;

      const frontmatter = extractFrontmatter(content);
      const name = (frontmatter['name'] as string) || entry.name;
      const description = (frontmatter['description'] as string) || '';

      const triggers: string[] = [];
      const bodyMatch = content.match(/^---[\s\S]*?---\s*\n([\s\S]*)$/);
      if (bodyMatch) {
        const body = bodyMatch[1];
        const triggerLines = body.match(/^TRIGGER\s+when:\s*(.+)$/gmi);
        if (triggerLines) {
          for (const line of triggerLines) {
            const m = line.match(/^TRIGGER\s+when:\s*(.+)$/i);
            if (m) triggers.push(m[1].trim());
          }
        }
      }

      skills.push({
        name,
        description,
        triggers,
        path: entry.name,
        file_path: `${entry.name}/SKILL.md`,
        root: rootInfo.root,
        scope: rootInfo.scope,
        installed: rootInfo.scope !== 'import-only',
        deprecated: !!rootInfo.deprecated,
      });
      skillCount++;
    }

    rootSummary.skill_count = skillCount;
    roots.push(rootSummary);
  }

  skills.sort((a, b) => {
    const rootCmp = a.root.localeCompare(b.root);
    return rootCmp !== 0 ? rootCmp : a.name.localeCompare(b.name);
  });

  const gsdSkillsInstalled = skills.some((skill) => skill.name.startsWith('gsd-'));

  return {
    skills,
    roots,
    installation: {
      gsd_skills_installed: gsdSkillsInstalled,
      legacy_claude_commands_installed: legacyClaudeCommandsInstalled,
    },
    counts: {
      skills: skills.length,
      roots: roots.length,
    },
  };
}

function cmdSkillManifest(cwd: string, args: string[], raw: boolean): void {
  const skillsDirIdx = args.indexOf('--skills-dir');
  const skillsDir =
    skillsDirIdx >= 0 && args[skillsDirIdx + 1] ? args[skillsDirIdx + 1] : null;

  const manifest = buildSkillManifest(cwd, skillsDir);

  if (args.includes('--write')) {
    const planDir = path.join(cwd, '.planning');
    if (fs.existsSync(planDir)) {
      const manifestPath = path.join(planDir, 'skill-manifest.json');
      platformWriteSync(manifestPath, JSON.stringify(manifest, null, 2));
    }
  }

  output(manifest, raw);
}

export = {
  cmdInitExecutePhase,
  cmdInitPlanPhase,
  cmdInitNewProject,
  cmdInitNewMilestone,
  cmdInitQuick,
  cmdInitIngestDocs,
  cmdInitResume,
  cmdInitVerifyWork,
  cmdInitPhaseOp,
  cmdInitTodos,
  cmdInitMilestoneOp,
  cmdInitMapCodebase,
  cmdInitProgress,
  cmdInitManager,
  cmdInitNewWorkspace,
  cmdInitListWorkspaces,
  cmdInitRemoveWorkspace,
  detectChildRepos,
  buildAgentSkillsBlock,
  cmdAgentSkills,
  buildSkillManifest,
  cmdSkillManifest,
};
