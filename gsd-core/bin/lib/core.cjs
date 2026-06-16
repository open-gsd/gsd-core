"use strict";
/**
 * Core — Shared utilities, constants, and internal helpers
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/core.cjs collapsed
 * to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only strict types are added.
 */
const __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const shell_command_projection_cjs_1 = require("./shell-command-projection.cjs");
const ioModule = require("./io.cjs");
const { output, error, ERROR_REASON, setJsonErrorMode, getJsonErrorMode, GSD_TEMP_DIR, reapStaleTempFiles } = ioModule;
const phaseIdModule = require("./phase-id.cjs");
const { escapeRegex, normalizePhaseName, getMilestoneFromPhaseId, getPhaseDirFromPhaseId, phaseMarkdownRegexSource, phaseMarkdownRegexSourceExact, comparePhaseNum, extractPhaseToken, phaseTokenMatches } = phaseIdModule;
const roadmapParserModule = require("./roadmap-parser.cjs");
const { stripShippedMilestones, extractCurrentMilestone, replaceInCurrentMilestone, getRoadmapPhaseInternal, getMilestoneInfo, getMilestonePhaseFilter } = roadmapParserModule;
const modelProfiles = require("./model-profiles.cjs");
const { MODEL_PROFILES, VALID_PHASE_TYPES: _VALID_PHASE_TYPES } = modelProfiles;
const model_catalog_cjs_1 = require("./model-catalog.cjs");
const worktreeSafety = require("./worktree-safety.cjs");
const { resolveWorktreeContext, parseWorktreePorcelain: parseWorktreePorcelainPolicy, planWorktreePrune, executeWorktreePrunePlan, inspectWorktreeHealth, } = worktreeSafety;
const planningWorkspace = require("./planning-workspace.cjs");
// Compatibility shim: new imports should use planning-workspace.cjs directly.
const { planningDir, planningRoot, planningPaths, withPlanningLock, getActiveWorkstream, setActiveWorkstream, } = planningWorkspace;
const coreUtilsModule = require("./core-utils.cjs");
const { toPosixPath, detectSubRepos, extractOneLinerFromBody, pathExistsInternal, generateSlugInternal, filterPlanFiles, filterSummaryFiles, getPhaseFileStats, readSubdirectories, timeAgo, } = coreUtilsModule;
const phaseLocatorModule = require("./phase-locator.cjs");
const { searchPhaseInDir, findPhaseInternal, getArchivedPhaseDirs } = phaseLocatorModule;
const project_root_cjs_1 = require("./project-root.cjs");
const runtime_homes_cjs_1 = require("./runtime-homes.cjs");
// ─── Config Loader Module (extracted from core, ADR-857 phase 2e / #885) ─────
const configLoaderModule = require("./config-loader.cjs");
const { loadConfig, isGitIgnored, CONFIG_DEFAULTS, _warnUnknownProfileOverrides, _resetRuntimeWarningCacheForTests, RUNTIME_OVERRIDE_TIERS, } = configLoaderModule;
// ─── Model Resolver Module (extracted from core, ADR-857 phase 2f / #888) ────
const modelResolverModule = require("./model-resolver.cjs");
const { resolveTierEntry, resolveModelPolicy, resolveModelInternal, VALID_GRANULARITIES, resolveGranularityInternal, assertValidGranularityOverride, resolveModelForTier, VALID_EFFORTS, EFFORT_SET, nextEffort, resolveEffortInternal, resolveFastModeInternal, resolveEffortForTier, } = modelResolverModule;
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
function resolveWorktreeRoot(cwd) {
    const context = resolveWorktreeContext(cwd, {
        existsSync: node_fs_1.default.existsSync,
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
function parseWorktreePorcelain(porcelain) {
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
function pruneOrphanedWorktrees(repoRoot) {
    try {
        const plan = planWorktreePrune(repoRoot, { allowDestructive: false }, { parseWorktreePorcelain });
        const pruneResult = executeWorktreePrunePlan(plan);
        if (pruneResult && pruneResult.timedOut) {
            process.stderr.write('[gsd-tools] WARNING: worktree health check degraded' +
                ' — git worktree prune timed out after 10s.' +
                ' Orphaned worktree metadata may remain until the next successful run.\n');
        }
    }
    catch { /* never crash the caller */ }
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
function getAgentsDir(runtime) {
    if (process.env['GSD_AGENTS_DIR']) {
        return process.env['GSD_AGENTS_DIR'];
    }
    const resolved = runtime ?? (process.env['GSD_RUNTIME'] || 'claude');
    if (resolved === 'claude') {
        return node_path_1.default.join(__dirname, '..', '..', '..', 'agents');
    }
    return node_path_1.default.join((0, runtime_homes_cjs_1.getGlobalConfigDir)(resolved), 'agents');
}
/**
 * Check which GSD agents are installed on disk.
 *
 * @param runtime - the active runtime name; defaults to GSD_RUNTIME env, then 'claude'
 */
function checkAgentsInstalled(runtime) {
    const resolvedRuntime = runtime ?? (process.env['GSD_RUNTIME'] || 'claude');
    const agentsDir = getAgentsDir(resolvedRuntime);
    const expectedAgents = Object.keys(MODEL_PROFILES);
    const installed = [];
    const missing = [];
    if (!node_fs_1.default.existsSync(agentsDir)) {
        return {
            agents_installed: false,
            missing_agents: expectedAgents,
            installed_agents: [],
            agents_dir: agentsDir,
            agent_runtime: resolvedRuntime,
        };
    }
    for (const agent of expectedAgents) {
        const agentFile = node_path_1.default.join(agentsDir, `${agent}.md`);
        const agentFileCopilot = node_path_1.default.join(agentsDir, `${agent}.agent.md`);
        const agentFileCodex = node_path_1.default.join(agentsDir, `${agent}.toml`);
        const agentFileKimiYaml = node_path_1.default.join(agentsDir, 'subagents', `${agent}.yaml`);
        const agentFileKimiPrompt = node_path_1.default.join(agentsDir, 'subagents', `${agent}.md`);
        const kimiAgentInstalled = resolvedRuntime === 'kimi' &&
            node_fs_1.default.existsSync(agentFileKimiYaml) &&
            node_fs_1.default.existsSync(agentFileKimiPrompt);
        if (node_fs_1.default.existsSync(agentFile) ||
            node_fs_1.default.existsSync(agentFileCopilot) ||
            node_fs_1.default.existsSync(agentFileCodex) ||
            kimiAgentInstalled) {
            installed.push(agent);
        }
        else {
            missing.push(agent);
        }
    }
    return {
        agents_installed: installed.length > 0 && missing.length === 0,
        missing_agents: missing,
        installed_agents: installed,
        agents_dir: agentsDir,
        agent_runtime: resolvedRuntime,
    };
}
/**
 * Detect whether `cwd` sits inside a git worktree, and if so, return the
 * absolute path of the worktree root.
 */
function gitWorktreeInfoInternal(cwd) {
    try {
        const insideResult = (0, shell_command_projection_cjs_1.execGit)(['rev-parse', '--is-inside-work-tree'], { cwd, timeout: 5000 });
        if (insideResult.exitCode !== 0) {
            return { inside: false, worktreeRoot: null };
        }
        const insideStdout = String(insideResult.stdout || '').trim();
        if (insideStdout !== 'true') {
            return { inside: false, worktreeRoot: null };
        }
        const rootResult = (0, shell_command_projection_cjs_1.execGit)(['rev-parse', '--show-toplevel'], { cwd, timeout: 5000 });
        if (rootResult.exitCode !== 0) {
            return { inside: true, worktreeRoot: null };
        }
        const root = String(rootResult.stdout || '').trim();
        return { inside: true, worktreeRoot: root || null };
    }
    catch {
        return { inside: false, worktreeRoot: null };
    }
}
module.exports = {
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
    RUNTIME_PROFILE_MAP: model_catalog_cjs_1.RUNTIME_PROFILE_MAP,
    RUNTIMES_WITH_REASONING_EFFORT: model_catalog_cjs_1.RUNTIMES_WITH_REASONING_EFFORT,
    RUNTIMES_WITH_FAST_MODE: model_catalog_cjs_1.RUNTIMES_WITH_FAST_MODE,
    KNOWN_RUNTIMES: model_catalog_cjs_1.KNOWN_RUNTIMES,
    RUNTIME_OVERRIDE_TIERS,
    resolveTierEntry,
    resolveModelPolicy,
    KNOWN_PROVIDERS: model_catalog_cjs_1.KNOWN_PROVIDERS,
    _resetRuntimeWarningCacheForTests,
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
    findProjectRoot: project_root_cjs_1.findProjectRoot,
    detectSubRepos,
    reapStaleTempFiles,
    GSD_TEMP_DIR,
    MODEL_ALIAS_MAP: model_catalog_cjs_1.MODEL_ALIAS_MAP,
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
