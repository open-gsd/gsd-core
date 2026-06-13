/**
 * Core — Shared utilities, constants, and internal helpers
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/core.cjs collapsed
 * to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only strict types are added.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execGit } from './shell-command-projection.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import ioModule = require('./io.cjs');
const { output, error, ERROR_REASON, setJsonErrorMode, getJsonErrorMode, GSD_TEMP_DIR, reapStaleTempFiles } = ioModule;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseIdModule = require('./phase-id.cjs');
const { escapeRegex, normalizePhaseName, getMilestoneFromPhaseId, getPhaseDirFromPhaseId, phaseMarkdownRegexSource, phaseMarkdownRegexSourceExact, comparePhaseNum, extractPhaseToken, phaseTokenMatches } = phaseIdModule;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import roadmapParserModule = require('./roadmap-parser.cjs');
const { stripShippedMilestones, extractCurrentMilestone, replaceInCurrentMilestone, getRoadmapPhaseInternal, getMilestoneInfo, getMilestonePhaseFilter } = roadmapParserModule;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import modelProfiles = require('./model-profiles.cjs');
const { MODEL_PROFILES, VALID_PHASE_TYPES: _VALID_PHASE_TYPES } = modelProfiles;
import { RUNTIME_PROFILE_MAP, KNOWN_RUNTIMES, RUNTIMES_WITH_REASONING_EFFORT, RUNTIMES_WITH_FAST_MODE, KNOWN_PROVIDERS, MODEL_ALIAS_MAP } from './model-catalog.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import worktreeSafety = require('./worktree-safety.cjs');
const {
  resolveWorktreeContext,
  parseWorktreePorcelain: parseWorktreePorcelainPolicy,
  planWorktreePrune,
  executeWorktreePrunePlan,
  inspectWorktreeHealth,
} = worktreeSafety;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspace = require('./planning-workspace.cjs');
// Compatibility shim: new imports should use planning-workspace.cjs directly.
const {
  planningDir,
  planningRoot,
  planningPaths,
  withPlanningLock,
  getActiveWorkstream,
  setActiveWorkstream,
} = planningWorkspace;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import coreUtilsModule = require('./core-utils.cjs');
const {
  toPosixPath,
  detectSubRepos,
  extractOneLinerFromBody,
  pathExistsInternal,
  generateSlugInternal,
  filterPlanFiles,
  filterSummaryFiles,
  getPhaseFileStats,
  readSubdirectories,
  timeAgo,
} = coreUtilsModule;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseLocatorModule = require('./phase-locator.cjs');
const { searchPhaseInDir, findPhaseInternal, getArchivedPhaseDirs } = phaseLocatorModule;
import { findProjectRoot } from './project-root.cjs';
import { getGlobalConfigDir } from './runtime-homes.cjs';

// ─── Config Loader Module (extracted from core, ADR-857 phase 2e / #885) ─────
// eslint-disable-next-line @typescript-eslint/no-require-imports
import configLoaderModule = require('./config-loader.cjs');
const {
  loadConfig,
  isGitIgnored,
  CONFIG_DEFAULTS,
  _warnUnknownProfileOverrides,
  _resetRuntimeWarningCacheForTests,
  RUNTIME_OVERRIDE_TIERS,
} = configLoaderModule;

// ─── Model Resolver Module (extracted from core, ADR-857 phase 2f / #888) ────
// eslint-disable-next-line @typescript-eslint/no-require-imports
import modelResolverModule = require('./model-resolver.cjs');
const {
  resolveTierEntry,
  resolveModelPolicy,
  resolveModelInternal,
  VALID_GRANULARITIES,
  resolveGranularityInternal,
  assertValidGranularityOverride,
  resolveModelForTier,
  VALID_EFFORTS,
  EFFORT_SET,
  nextEffort,
  resolveEffortInternal,
  resolveFastModeInternal,
  resolveEffortForTier,
  _resetModelPolicyWarningCacheForTests,
} = modelResolverModule;

// ─── Path helpers ────────────────────────────────────────────────────────────
// toPosixPath and detectSubRepos moved to core-utils.cjs (ADR-857 phase 2c / #877).
// The destructured bindings above (from coreUtilsModule) make them available to
// core-internal callers; core.cjs re-exports toPosixPath and detectSubRepos for back-compat.

// findProjectRoot is now re-exported from the generated CJS module above.

// loadConfig, isGitIgnored, CONFIG_DEFAULTS, and related helpers moved to
// config-loader.cjs (ADR-857 phase 2e / #885). The destructured bindings above
// (from configLoaderModule) make them available to core-internal callers;
// core.cjs re-exports loadConfig and isGitIgnored for back-compat.

// ─── Common path helpers ──────────────────────────────────────────────────────

/**
 * Resolve the main worktree root when running inside a git worktree.
 * In a linked worktree, .planning/ lives in the main worktree, not in the linked one.
 * Returns the main worktree path, or cwd if not in a worktree.
 */
function resolveWorktreeRoot(cwd: string): string {
  const context = resolveWorktreeContext(cwd, {
    existsSync: fs.existsSync,
  });
  return context.effectiveRoot;
}

/**
 * Parse `git worktree list --porcelain` output into an array of
 * { path, branch } objects.  Entries with a detached HEAD (no branch line)
 * are skipped because we cannot safely reason about their merge status.
 *
 * @param porcelain - raw output from git worktree list --porcelain
 * @returns {{ path: string, branch: string }[]}
 */
function parseWorktreePorcelain(porcelain: string): Array<{ path: string; branch: string }> {
  return parseWorktreePorcelainPolicy(porcelain);
}

/**
 * Clear stale worktree metadata references via `git worktree prune`.
 *
 * Destructive linked-worktree removal is disabled by default for safety.
 *
 * @param repoRoot - absolute path to the main (or any) worktree of
 *   the repository; used as `cwd` for git commands.
 * @returns list of worktree paths that were removed (always empty)
 */
function pruneOrphanedWorktrees(repoRoot: string): string[] {
  try {
    const plan = planWorktreePrune(
      repoRoot,
      { allowDestructive: false },
      { parseWorktreePorcelain }
    );
    const pruneResult = executeWorktreePrunePlan(plan) as { timedOut?: boolean } | null;
    if (pruneResult && pruneResult.timedOut) {
      process.stderr.write(
        '[gsd-tools] WARNING: worktree health check degraded' +
        ' — git worktree prune timed out after 10s.' +
        ' Orphaned worktree metadata may remain until the next successful run.\n'
      );
    }
  } catch { /* never crash the caller */ }
  return [];
}

// ─── Planning workspace (pathing + active workstream + lock) moved to planning-workspace.cjs ───

// ─── Phase utilities (pure helpers re-exported from phase-id.cjs) ─────────────
// escapeRegex, normalizePhaseName, getMilestoneFromPhaseId, getPhaseDirFromPhaseId,
// phaseMarkdownRegexSource, phaseMarkdownRegexSourceExact, comparePhaseNum,
// extractPhaseToken, phaseTokenMatches
// — all imported via `phaseIdModule` above; internal callers use the destructured bindings.

// extractCanonicalPlanId moved to core-utils.cjs (ADR-857 phase 2c / #877).
// It is consumed exclusively by phase-locator.cjs, which imports it from
// core-utils.cjs directly. It is NOT destructured in core.cts and is NOT
// in core.cjs's public export = block (it was never public).

// searchPhaseInDir, findPhaseInternal, getArchivedPhaseDirs moved to phase-locator.cjs
// (ADR-857 phase 2d / #881). The destructured bindings above (from phaseLocatorModule)
// make them available to core-internal callers; core.cjs re-exports findPhaseInternal,
// getArchivedPhaseDirs, and searchPhaseInDir for back-compat.

// ─── Roadmap milestone scoping (re-exported from roadmap-parser.cjs) ──────────
// stripShippedMilestones, extractCurrentMilestone, replaceInCurrentMilestone,
// getRoadmapPhaseInternal, getMilestoneInfo, getMilestonePhaseFilter
// — all imported via `roadmapParserModule` above; internal callers use the destructured bindings.

// ─── Agent installation validation (#1371) ───────────────────────────────────

/**
 * Resolve the agents directory for the given runtime.
 *
 * Priority:
 *   1. GSD_AGENTS_DIR env var (explicit override, any runtime)
 *   2. For claude runtime: __dirname-relative path (agents/ sibling of gsd-core/)
 *      This is correct for both repo runs and real installs (the runtime config dir's
 *      agents/ folder) because gsd-tools.cjs lives inside gsd-core/bin/ in both cases.
 *   3. For non-claude runtimes: getGlobalConfigDir(runtime)/agents
 *
 * @param runtime - the active runtime name; defaults to GSD_RUNTIME env, then 'claude'
 */
function getAgentsDir(runtime?: string): string {
  if (process.env['GSD_AGENTS_DIR']) {
    return process.env['GSD_AGENTS_DIR'];
  }
  const resolved = runtime ?? (process.env['GSD_RUNTIME'] || 'claude');
  if (resolved === 'claude') {
    return path.join(__dirname, '..', '..', '..', 'agents');
  }
  return path.join(getGlobalConfigDir(resolved), 'agents');
}

interface AgentsInstalledResult {
  agents_installed: boolean;
  missing_agents: string[];
  installed_agents: string[];
  incomplete_agents: string[];
  agents_dir: string;
  agent_runtime: string;
}

/**
 * Check which GSD agents are installed on disk.
 *
 * @param runtime - the active runtime name; defaults to GSD_RUNTIME env, then 'claude'
 */
function checkAgentsInstalled(runtime?: string): AgentsInstalledResult {
  const resolvedRuntime = runtime ?? (process.env['GSD_RUNTIME'] || 'claude');
  const agentsDir = getAgentsDir(resolvedRuntime);
  const expectedAgents = Object.keys(MODEL_PROFILES);
  const installed: string[] = [];
  const missing: string[] = [];

  if (!fs.existsSync(agentsDir)) {
    return {
      agents_installed: false,
      missing_agents: expectedAgents,
      installed_agents: [],
      incomplete_agents: [],
      agents_dir: agentsDir,
      agent_runtime: resolvedRuntime,
    };
  }

  for (const agent of expectedAgents) {
    const agentFile = path.join(agentsDir, `${agent}.md`);
    const agentFileCopilot = path.join(agentsDir, `${agent}.agent.md`);
    const agentFileCodex = path.join(agentsDir, `${agent}.toml`);
    const agentFileKimiYaml = path.join(agentsDir, 'subagents', `${agent}.yaml`);
    const agentFileKimiPrompt = path.join(agentsDir, 'subagents', `${agent}.md`);
    const kimiAgentInstalled =
      resolvedRuntime === 'kimi' &&
      fs.existsSync(agentFileKimiYaml) &&
      fs.existsSync(agentFileKimiPrompt);
    if (
      fs.existsSync(agentFile) ||
      fs.existsSync(agentFileCopilot) ||
      fs.existsSync(agentFileCodex) ||
      kimiAgentInstalled
    ) {
      installed.push(agent);
    } else {
      missing.push(agent);
    }
  }

  // ── Manifest-backed completeness check ──────────────────────────────────────
  // If a gsd-file-manifest.json exists alongside the agents dir (parent dir),
  // verify that every manifest-tracked file for each expected agent is present
  // on disk. Missing manifest-tracked files indicate an incomplete install even
  // when the plain presence check above passed (e.g. .md present, .toml absent).
  // If no manifest is found the check is a no-op (graceful for claude/bundled).
  const incomplete: string[] = [];
  const manifestPath = path.join(path.dirname(agentsDir), 'gsd-file-manifest.json');
  let manifestFiles: Record<string, unknown> = {};
  try {
    const raw = fs.readFileSync(manifestPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'files' in parsed &&
      typeof (parsed as Record<string, unknown>)['files'] === 'object' &&
      (parsed as Record<string, unknown>)['files'] !== null
    ) {
      manifestFiles = (parsed as Record<string, Record<string, unknown>>)['files'];
    }
  } catch {
    // No manifest or unreadable — completeness check is skipped
  }

  if (Object.keys(manifestFiles).length > 0) {
    for (const agent of expectedAgents) {
      // Find all manifest keys that belong to this agent:
      // key must be "agents/<agentName>.<ext>" with no further path segments.
      const agentPrefix = `agents/${agent}.`;
      const agentManifestKeys = Object.keys(manifestFiles).filter(key => {
        if (!key.startsWith(agentPrefix)) return false;
        const rest = key.slice(agentPrefix.length);
        // rest must be a bare extension (no slashes, non-empty)
        return rest.length > 0 && !rest.includes('/');
      });
      if (agentManifestKeys.length === 0) {
        // Agent not tracked in manifest — skip completeness check for this agent
        continue;
      }
      const allPresent = agentManifestKeys.every(key => {
        const basename = key.slice('agents/'.length);
        return fs.existsSync(path.join(agentsDir, basename));
      });
      if (!allPresent) {
        incomplete.push(agent);
      }
    }
  }

  return {
    agents_installed: installed.length > 0 && missing.length === 0 && incomplete.length === 0,
    missing_agents: missing,
    installed_agents: installed,
    incomplete_agents: incomplete,
    agents_dir: agentsDir,
    agent_runtime: resolvedRuntime,
  };
}

// ─── Model alias resolution ───────────────────────────────────────────────────
// RUNTIME_OVERRIDE_TIERS, _warnedConfigKeys, _warnUnknownProfileOverrides, and
// _resetRuntimeWarningCacheForTests moved to config-loader.cjs (ADR-857 phase 2e / #885).
// The destructured bindings above (from configLoaderModule) make them available to
// core-internal callers; _resetRuntimeWarningCacheForTests is re-exported for back-compat.

// resolveTierEntry, resolveModelPolicy, resolveModelInternal, VALID_GRANULARITIES,
// resolveGranularityInternal, assertValidGranularityOverride, resolveModelForTier,
// VALID_EFFORTS, EFFORT_SET, nextEffort, resolveEffortInternal, resolveFastModeInternal,
// resolveEffortForTier — all moved to model-resolver.cjs (ADR-857 phase 2f / #888).
// The destructured bindings above (from modelResolverModule) make them available to
// core-internal callers; core.cjs re-exports all 13 symbols for back-compat.

// ─── Summary body helpers / Misc utilities / Phase file helpers ───────────────
// extractOneLinerFromBody, pathExistsInternal, generateSlugInternal,
// filterPlanFiles, filterSummaryFiles, getPhaseFileStats, readSubdirectories,
// timeAgo — all moved to core-utils.cjs (ADR-857 phase 2c / #877).
// The destructured bindings above (from coreUtilsModule) make them available
// to core-internal callers; core.cjs re-exports the public ones for back-compat.

// ─── Misc utilities (remaining in core) ──────────────────────────────────────

interface GitWorktreeInfo {
  inside: boolean;
  worktreeRoot: string | null;
}

/**
 * Detect whether `cwd` sits inside a git worktree, and if so, return the
 * absolute path of the worktree root.
 */
function gitWorktreeInfoInternal(cwd: string): GitWorktreeInfo {
  try {
    const insideResult = execGit(['rev-parse', '--is-inside-work-tree'], { cwd, timeout: 5000 });
    if (insideResult.exitCode !== 0) {
      return { inside: false, worktreeRoot: null };
    }
    const insideStdout = String(insideResult.stdout || '').trim();
    if (insideStdout !== 'true') {
      return { inside: false, worktreeRoot: null };
    }
    const rootResult = execGit(['rev-parse', '--show-toplevel'], { cwd, timeout: 5000 });
    if (rootResult.exitCode !== 0) {
      return { inside: true, worktreeRoot: null };
    }
    const root = String(rootResult.stdout || '').trim();
    return { inside: true, worktreeRoot: root || null };
  } catch {
    return { inside: false, worktreeRoot: null };
  }
}

// MilestoneInfo, MilestonePhaseFilter, getMilestoneInfo, getMilestonePhaseFilter
// — all re-exported from roadmap-parser.cjs via roadmapParserModule above.

export = {
  output,
  error,
  ERROR_REASON,
  setJsonErrorMode,
  getJsonErrorMode,
  loadConfig,
  isGitIgnored,
  escapeRegex,
  normalizePhaseName,
  getMilestoneFromPhaseId,
  getPhaseDirFromPhaseId,
  phaseMarkdownRegexSource,
  phaseMarkdownRegexSourceExact,
  comparePhaseNum,
  searchPhaseInDir,
  extractPhaseToken,
  phaseTokenMatches,
  findPhaseInternal,
  getArchivedPhaseDirs,
  getRoadmapPhaseInternal,
  resolveModelInternal,
  resolveModelForTier,
  resolveGranularityInternal,
  VALID_GRANULARITIES,
  assertValidGranularityOverride,
  resolveEffortInternal,
  resolveFastModeInternal,
  resolveEffortForTier,
  VALID_EFFORTS,
  EFFORT_SET,
  nextEffort,
  RUNTIME_PROFILE_MAP,
  RUNTIMES_WITH_REASONING_EFFORT,
  RUNTIMES_WITH_FAST_MODE,
  KNOWN_RUNTIMES,
  RUNTIME_OVERRIDE_TIERS,
  resolveTierEntry,
  resolveModelPolicy,
  KNOWN_PROVIDERS,
  _resetRuntimeWarningCacheForTests: (): void => {
    _resetRuntimeWarningCacheForTests();
    _resetModelPolicyWarningCacheForTests();
  },
  pathExistsInternal,
  gitWorktreeInfoInternal,
  generateSlugInternal,
  getMilestoneInfo,
  getMilestonePhaseFilter,
  stripShippedMilestones,
  extractCurrentMilestone,
  replaceInCurrentMilestone,
  toPosixPath,
  extractOneLinerFromBody,
  resolveWorktreeRoot,
  // Deprecated re-exports — prefer direct import from planning-workspace.cjs
  withPlanningLock,
  findProjectRoot,
  detectSubRepos,
  reapStaleTempFiles,
  GSD_TEMP_DIR,
  MODEL_ALIAS_MAP,
  CONFIG_DEFAULTS,
  planningDir,
  planningRoot,
  planningPaths,
  getActiveWorkstream,
  setActiveWorkstream,
  filterPlanFiles,
  filterSummaryFiles,
  getPhaseFileStats,
  readSubdirectories,
  getAgentsDir,
  checkAgentsInstalled,
  timeAgo,
  pruneOrphanedWorktrees,
  inspectWorktreeHealth,
};
