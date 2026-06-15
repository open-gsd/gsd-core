/**
 * Core — Shared utilities, constants, and internal helpers
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/core.cjs collapsed
 * to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only strict types are added.
 */

// (fs, path, execGit removed — last callers relocated to leaf modules during #1268 T0 rehome)
// eslint-disable-next-line @typescript-eslint/no-require-imports
import ioModule = require('./io.cjs');
const { output, error, ERROR_REASON, setJsonErrorMode, getJsonErrorMode, GSD_TEMP_DIR, reapStaleTempFiles } = ioModule;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseIdModule = require('./phase-id.cjs');
const { escapeRegex, normalizePhaseName, getMilestoneFromPhaseId, getPhaseDirFromPhaseId, phaseMarkdownRegexSource, phaseMarkdownRegexSourceExact, comparePhaseNum, extractPhaseToken, phaseTokenMatches } = phaseIdModule;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import roadmapParserModule = require('./roadmap-parser.cjs');
const { stripShippedMilestones, extractCurrentMilestone, replaceInCurrentMilestone, getRoadmapPhaseInternal, getMilestoneInfo, getMilestonePhaseFilter } = roadmapParserModule;
import { RUNTIME_PROFILE_MAP, KNOWN_RUNTIMES, RUNTIMES_WITH_REASONING_EFFORT, RUNTIMES_WITH_FAST_MODE, KNOWN_PROVIDERS, MODEL_ALIAS_MAP } from './model-catalog.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import worktreeSafety = require('./worktree-safety.cjs');
const {
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

// ─── Config Loader Module (extracted from core, ADR-857 phase 2e / #885) ─────
// eslint-disable-next-line @typescript-eslint/no-require-imports
import configLoaderModule = require('./config-loader.cjs');
const {
  loadConfig,
  isGitIgnored,
  CONFIG_DEFAULTS,
  _warnUnknownProfileOverrides,
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
// getAgentsDir and checkAgentsInstalled moved to agent-install-check.cjs (T0 #1268).
// Re-exports removed in T1 (#1277); callers import directly from agent-install-check.cjs.

// ─── Model alias resolution ───────────────────────────────────────────────────
// RUNTIME_OVERRIDE_TIERS, _warnedConfigKeys, _warnUnknownProfileOverrides, and
// _resetRuntimeWarningCacheForTests moved to config-loader.cjs (ADR-857 phase 2e / #885)
// and model-resolver.cjs (ADR-857 phase 2f / #888) respectively.
// _resetRuntimeWarningCacheForTests is NO LONGER re-exported from core.cjs; callers
// must import it directly from config-loader.cjs / model-resolver.cjs (or use
// the shared resetRuntimeWarningCaches() helper in tests/helpers.cjs).

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
  pathExistsInternal,
  generateSlugInternal,
  getMilestoneInfo,
  getMilestonePhaseFilter,
  stripShippedMilestones,
  extractCurrentMilestone,
  replaceInCurrentMilestone,
  toPosixPath,
  extractOneLinerFromBody,
  resolveWorktreeRoot: worktreeSafety.resolveWorktreeRoot,
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
  timeAgo,
  pruneOrphanedWorktrees: worktreeSafety.pruneOrphanedWorktrees,
  inspectWorktreeHealth,
};
