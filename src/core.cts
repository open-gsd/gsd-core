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
const { MODEL_PROFILES, AGENT_TO_PHASE_TYPE, VALID_PHASE_TYPES: _VALID_PHASE_TYPES, AGENT_DEFAULT_TIERS, VALID_AGENT_TIERS, nextTier } = modelProfiles;
import { MODEL_ALIAS_MAP, RUNTIME_PROFILE_MAP, KNOWN_RUNTIMES, RUNTIMES_WITH_REASONING_EFFORT, RUNTIMES_WITH_FAST_MODE, PROVIDER_PRESETS, KNOWN_PROVIDERS } from './model-catalog.cjs';
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

// ─── Configuration Module (for CANONICAL_CONFIG_DEFAULTS used by effort/fast_mode resolvers) ─
import { CONFIG_DEFAULTS as CANONICAL_CONFIG_DEFAULTS } from './configuration.cjs';

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
      agents_dir: agentsDir,
      agent_runtime: resolvedRuntime,
    };
  }

  for (const agent of expectedAgents) {
    const agentFile = path.join(agentsDir, `${agent}.md`);
    const agentFileCopilot = path.join(agentsDir, `${agent}.agent.md`);
    const agentFileCodex = path.join(agentsDir, `${agent}.toml`);
    if (fs.existsSync(agentFile) || fs.existsSync(agentFileCopilot) || fs.existsSync(agentFileCodex)) {
      installed.push(agent);
    } else {
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

// ─── Model alias resolution ───────────────────────────────────────────────────
// RUNTIME_OVERRIDE_TIERS, _warnedConfigKeys, _warnUnknownProfileOverrides, and
// _resetRuntimeWarningCacheForTests moved to config-loader.cjs (ADR-857 phase 2e / #885).
// The destructured bindings above (from configLoaderModule) make them available to
// core-internal callers; _resetRuntimeWarningCacheForTests is re-exported for back-compat.

interface TierEntryResolved {
  model: string;
  reasoning_effort?: string;
  [key: string]: unknown;
}

interface ResolveTierEntryOpts {
  runtime: string | null | undefined;
  tier: string | null | undefined;
  overrides: Record<string, unknown> | null | undefined;
}

/**
 * #2517 — Resolve the runtime-aware tier entry for (runtime, tier).
 */
function resolveTierEntry({ runtime, tier, overrides }: ResolveTierEntryOpts): TierEntryResolved | null {
  if (!runtime || !tier) return null;

  const runtimeMap = RUNTIME_PROFILE_MAP as unknown as Record<string, Record<string, Record<string, unknown>>>;
  const builtin = runtimeMap[runtime]?.[tier] || null;
  const overridesMap = overrides as Record<string, Record<string, unknown>> | null | undefined;
  const userRaw = overridesMap?.[runtime]?.[tier];

  let userEntry: Record<string, unknown> | null = null;
  if (userRaw) {
    userEntry = typeof userRaw === 'string' ? { model: userRaw } : (userRaw as Record<string, unknown>);
  }

  if (!builtin && !userEntry) return null;
  return { ...(builtin || {}), ...(userEntry || {}) } as TierEntryResolved;
}

/**
 * Convenience wrapper used by resolveModelInternal.
 */
function _resolveRuntimeTier(config: Record<string, unknown>, tier: string): TierEntryResolved | null {
  return resolveTierEntry({
    runtime: config['runtime'] as string | null | undefined,
    tier,
    overrides: config['model_profile_overrides'] as Record<string, unknown> | null | undefined,
  });
}

/**
 * #49 — Provider-neutral model policy preset resolution.
 */
function resolveModelPolicy(policy: Record<string, unknown> | null | undefined, tier: string | null | undefined): string | null {
  if (!policy || typeof policy !== 'object') return null;
  if (!tier) return null;

  const runtime = policy['runtime'];
  const rtOverrides = policy['runtime_tiers'];
  if (runtime && typeof runtime === 'string' && rtOverrides && typeof rtOverrides === 'object') {
    const rtOverridesMap = rtOverrides as Record<string, unknown>;
    if (Object.hasOwn(rtOverridesMap, runtime)) {
      const runtimeEntry = rtOverridesMap[runtime];
      if (runtimeEntry && typeof runtimeEntry === 'object' && Object.hasOwn(runtimeEntry, tier)) {
        const raw = (runtimeEntry as Record<string, unknown>)[tier];
        if (raw != null) {
          const entry = typeof raw === 'string' ? { model: raw } : (raw as Record<string, unknown>);
          if (entry && entry['model']) return entry['model'] as string;
        }
      }
    }
  }

  const provider = policy['provider'];
  if (!provider || typeof provider !== 'string') return null;

  if (provider === 'generic' || provider === 'custom') {
    const TIER_TO_POLICY_KEY: Record<string, string> = { opus: 'high', sonnet: 'medium', haiku: 'low' };
    const policyKey = TIER_TO_POLICY_KEY[tier];
    if (!policyKey) return null;
    const v = policy[policyKey];
    return (v && typeof v === 'string') ? v : null;
  }

  const presetsMap = PROVIDER_PRESETS as Record<string, Record<string, Record<string, { model: string } | null>>>;
  if (!Object.hasOwn(presetsMap, provider)) return null;
  const presetForProvider = presetsMap[provider];
  if (!presetForProvider || typeof presetForProvider !== 'object') return null;

  if (!Object.hasOwn(presetForProvider, tier)) return null;
  const tierPresets = presetForProvider[tier];
  if (!tierPresets || typeof tierPresets !== 'object') return null;

  const budget = (policy['budget'] && typeof policy['budget'] === 'string') ? policy['budget'] : 'medium';
  if (!Object.hasOwn(tierPresets, budget)) return null;
  const budgetEntry = tierPresets[budget];
  if (!budgetEntry || !budgetEntry.model) return null;

  return budgetEntry.model;
}

function resolveModelInternal(cwd: string, agentType: string): string {
  const config = loadConfig(cwd);

  // 1. Per-agent override
  const modelOverrides = config['model_overrides'] as Record<string, string> | null | undefined;
  const override = modelOverrides?.[agentType];
  if (override) {
    return override;
  }

  // 2. Compute the tier
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  const profile = String(config['model_profile'] || 'balanced').toLowerCase();
  const agentModels = (MODEL_PROFILES as unknown as Record<string, Record<string, string>>)[agentType];
  const phaseType = (AGENT_TO_PHASE_TYPE)[agentType];
  const configModels = config['models'] as Record<string, string> | null | undefined;
  const phaseTypeTier = (phaseType && configModels && typeof configModels === 'object')
    ? configModels[phaseType]
    : undefined;
  const VALID_TIERS = new Set(['opus', 'sonnet', 'haiku', 'inherit']);
  const tier = (phaseTypeTier && VALID_TIERS.has(phaseTypeTier))
    ? phaseTypeTier
    : (profile === 'inherit'
      ? 'inherit'
      : (agentModels ? (agentModels[profile] || agentModels['balanced']) : null));

  // 2.5. model_policy preset (#49)
  const configRuntime = config['runtime'] as string | null | undefined;
  if (configRuntime && configRuntime !== 'claude' && tier && tier !== 'inherit') {
    const mergedPolicy = config['model_policy']
      ? { ...(config['model_policy'] as Record<string, unknown>), runtime: configRuntime }
      : null;
    const policyModel = resolveModelPolicy(mergedPolicy, tier);
    if (policyModel) return policyModel;
  }

  // 3. Runtime-aware resolution (#2517)
  if (configRuntime && configRuntime !== 'claude' && tier && tier !== 'inherit') {
    const entry = _resolveRuntimeTier(config, tier);
    if (entry?.model) return entry.model;
  }

  // 4. resolve_model_ids: "omit"
  if (config['resolve_model_ids'] === 'omit') {
    return '';
  }

  // 5. Profile lookup (Claude-native default).
  if (!agentModels) {
    return profile === 'quality' ? 'opus'
      : profile === 'budget' ? 'haiku'
      : profile === 'inherit' ? 'inherit'
      : 'sonnet';
  }
  if (tier === 'inherit') return 'inherit';
  const alias = tier;

  if (config['resolve_model_ids']) {
    return (MODEL_ALIAS_MAP as Record<string, string>)[alias!] || alias!;
  }

  return alias!;
}

const VALID_GRANULARITIES = new Set(['coarse', 'standard', 'fine']);

/**
 * Resolve the planning granularity for a phase type (#68).
 */
function resolveGranularityInternal(cwd: string, phaseType: string | null | undefined, override?: string | null): string {
  if (override !== undefined && override !== null && override !== '') {
    if (VALID_GRANULARITIES.has(override)) {
      return override;
    }
  }
  const config = loadConfig(cwd);
  const configGranularities = config['granularities'] as Record<string, string> | null | undefined;
  const perPhase = (phaseType && configGranularities && typeof configGranularities === 'object')
    ? configGranularities[phaseType]
    : undefined;
  if (perPhase && VALID_GRANULARITIES.has(perPhase)) {
    return perPhase;
  }
  if (config['granularity'] !== undefined && config['granularity'] !== null && config['granularity'] !== '') {
    return config['granularity'] as string;
  }
  const planning = config['planning'] as Record<string, unknown> | null | undefined;
  const planningGran = planning && planning['granularity'];
  if (planningGran !== undefined && planningGran !== null && planningGran !== '') {
    return planningGran as string;
  }
  return 'standard';
}

/**
 * Validate a CLI granularity override at the command boundary. Empty/null/undefined
 * are treated as "no override" (no-op). An invalid non-empty value calls `fail`.
 */
function assertValidGranularityOverride(
  override: string | null | undefined,
  fail: (msg: string) => never,
): void {
  if (override !== undefined && override !== null && override !== '' && !VALID_GRANULARITIES.has(override)) {
    fail(`invalid granularity '${override}' (valid: ${[...VALID_GRANULARITIES].join(', ')})`);
  }
}

/**
 * #3024 — Resolve a model for a specific dynamic-routing attempt.
 */
function resolveModelForTier(cwd: string, agentType: string, attempt?: number): string {
  const config = loadConfig(cwd);
  const attemptN = Number.isInteger(attempt) && (attempt as number) > 0 ? (attempt as number) : 0;

  const modelOverrides = config['model_overrides'] as Record<string, string> | null | undefined;
  const override = modelOverrides?.[agentType];
  if (override) return override;

  if (config['model_policy'] && config['runtime'] && config['runtime'] !== 'claude') {
    return resolveModelInternal(cwd, agentType);
  }

  const dr = config['dynamic_routing'] as Record<string, unknown> | null | undefined;
  if (!dr || typeof dr !== 'object' || dr['enabled'] !== true) {
    return resolveModelInternal(cwd, agentType);
  }

  const tierModels = dr['tier_models'] as Record<string, string> | null | undefined;
  if (!tierModels || typeof tierModels !== 'object') {
    return resolveModelInternal(cwd, agentType);
  }

  const defaultTier = (AGENT_DEFAULT_TIERS)[agentType];
  if (!defaultTier || !(VALID_AGENT_TIERS).has(defaultTier)) {
    return resolveModelInternal(cwd, agentType);
  }

  const maxEscalations = Number.isInteger(dr['max_escalations']) && (dr['max_escalations'] as number) >= 0
    ? (dr['max_escalations'] as number)
    : 1;
  const escalationEnabled = dr['escalate_on_failure'] !== false;
  const effectiveAttempt = escalationEnabled
    ? Math.min(attemptN, maxEscalations)
    : 0;

  let tier = defaultTier;
  for (let i = 0; i < effectiveAttempt; i += 1) {
    const next = (nextTier)(tier);
    if (!next || next === tier) break;
    tier = next;
  }

  const alias = tierModels[tier];
  if (typeof alias !== 'string' || alias.length === 0) {
    return resolveModelInternal(cwd, agentType);
  }
  return alias;
}

// ─── #443 — Unified effort + fast_mode resolvers ─────────────────────────────

const VALID_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_SET = new Set(VALID_EFFORTS);

/**
 * Walk one step up the effort ladder from `e`.
 */
function nextEffort(e: string): string | null {
  const i = VALID_EFFORTS.indexOf(e);
  if (i < 0) return null;
  return VALID_EFFORTS[Math.min(i + 1, VALID_EFFORTS.length - 1)];
}

interface EffortOpts {
  override?: string;
}

interface FastModeOpts {
  override?: boolean;
}

/**
 * #443 — Resolve a universal effort string for (cwd, agentType).
 */
function resolveEffortInternal(cwd: string, agentType: string, opts?: EffortOpts): string {
  // Step 1: invocation override
  if (opts && typeof opts.override === 'string' && EFFORT_SET.has(opts.override)) {
    return opts.override;
  }

  const config = loadConfig(cwd);
  const effortCfg = (config['effort'] && typeof config['effort'] === 'object' && !Array.isArray(config['effort']))
    ? (config['effort'] as Record<string, unknown>)
    : null;

  // Step 2: agent_overrides
  if (effortCfg) {
    const ao = effortCfg['agent_overrides'];
    if (ao && typeof ao === 'object' && !Array.isArray(ao)) {
      const v = (ao as Record<string, unknown>)[agentType];
      if (typeof v === 'string' && EFFORT_SET.has(v)) return v;
    }
  } else {
    const canonicalEffort = (CANONICAL_CONFIG_DEFAULTS)['effort'];
    const mao = canonicalEffort && typeof canonicalEffort === 'object'
      ? (canonicalEffort as Record<string, unknown>)['agent_overrides']
      : undefined;
    if (mao && typeof mao === 'object' && !Array.isArray(mao)) {
      const v = (mao as Record<string, unknown>)[agentType];
      if (typeof v === 'string' && EFFORT_SET.has(v)) return v;
    }
  }

  // Step 3: routing_tier_defaults by agent's default tier.
  const agentTier = (AGENT_DEFAULT_TIERS)[agentType];
  if (agentTier) {
    if (effortCfg && effortCfg['routing_tier_defaults'] &&
        typeof effortCfg['routing_tier_defaults'] === 'object' &&
        !Array.isArray(effortCfg['routing_tier_defaults'])) {
      const v = (effortCfg['routing_tier_defaults'] as Record<string, unknown>)[agentTier];
      if (typeof v === 'string' && EFFORT_SET.has(v)) return v;
    } else if (!effortCfg) {
      const canonicalEffort = (CANONICAL_CONFIG_DEFAULTS)['effort'];
      const manifestDefaults = canonicalEffort && typeof canonicalEffort === 'object'
        ? (canonicalEffort as Record<string, unknown>)['routing_tier_defaults']
        : undefined;
      if (manifestDefaults && typeof manifestDefaults === 'object') {
        const v = (manifestDefaults as Record<string, unknown>)[agentTier];
        if (typeof v === 'string' && EFFORT_SET.has(v)) return v;
      }
    }
  }

  // Step 4: effort.default
  if (effortCfg) {
    const d = effortCfg['default'];
    if (typeof d === 'string' && EFFORT_SET.has(d)) return d;
  } else {
    const canonicalEffort = (CANONICAL_CONFIG_DEFAULTS)['effort'];
    const d = canonicalEffort && typeof canonicalEffort === 'object'
      ? (canonicalEffort as Record<string, unknown>)['default']
      : undefined;
    if (typeof d === 'string' && EFFORT_SET.has(d)) return d;
  }

  // Step 5: hardcoded default
  return 'high';
}

/**
 * #443 — Resolve fast_mode boolean for (cwd, agentType).
 */
function resolveFastModeInternal(cwd: string, agentType: string, opts?: FastModeOpts): boolean {
  // Step 1: invocation override
  if (opts && typeof opts.override === 'boolean') {
    return opts.override;
  }

  const config = loadConfig(cwd);
  const fmCfg = (config['fast_mode'] && typeof config['fast_mode'] === 'object' && !Array.isArray(config['fast_mode']))
    ? (config['fast_mode'] as Record<string, unknown>)
    : null;

  // Step 2: agent_overrides
  if (fmCfg) {
    const ao = fmCfg['agent_overrides'];
    if (ao && typeof ao === 'object' && !Array.isArray(ao)) {
      const v = (ao as Record<string, unknown>)[agentType];
      if (typeof v === 'boolean') return v;
    }
  }

  // Step 3: routing_tier_defaults by agent's default tier.
  const agentTier = (AGENT_DEFAULT_TIERS)[agentType];
  if (agentTier) {
    if (fmCfg && fmCfg['routing_tier_defaults'] &&
        typeof fmCfg['routing_tier_defaults'] === 'object' &&
        !Array.isArray(fmCfg['routing_tier_defaults'])) {
      const v = (fmCfg['routing_tier_defaults'] as Record<string, unknown>)[agentTier];
      if (typeof v === 'boolean') return v;
    } else if (!fmCfg) {
      const canonicalFm = (CANONICAL_CONFIG_DEFAULTS)['fast_mode'];
      const manifestDefaults = canonicalFm && typeof canonicalFm === 'object'
        ? (canonicalFm as Record<string, unknown>)['routing_tier_defaults']
        : undefined;
      if (manifestDefaults && typeof manifestDefaults === 'object') {
        const v = (manifestDefaults as Record<string, unknown>)[agentTier];
        if (typeof v === 'boolean') return v;
      }
    }
  }

  // Step 4: fast_mode.enabled
  if (fmCfg && typeof fmCfg['enabled'] === 'boolean') {
    return fmCfg['enabled'];
  }

  // Step 5: hardcoded default
  return false;
}

/**
 * #443 — Resolve effort for a dynamic-routing attempt (with escalation).
 */
function resolveEffortForTier(cwd: string, agentType: string, attempt?: number): string {
  const base = resolveEffortInternal(cwd, agentType);

  const config = loadConfig(cwd);
  const dr = config['dynamic_routing'] as Record<string, unknown> | null | undefined;
  if (!dr || typeof dr !== 'object' || dr['enabled'] !== true) {
    return base;
  }
  if (dr['escalate_on_failure'] === false) {
    return base;
  }

  const maxEscalations = Number.isInteger(dr['max_escalations']) && (dr['max_escalations'] as number) >= 0
    ? (dr['max_escalations'] as number)
    : 1;

  const attemptN = Number.isInteger(attempt) && (attempt as number) > 0 ? (attempt as number) : 0;
  const effectiveAttempt = Math.min(attemptN, maxEscalations);

  let current = base;
  for (let i = 0; i < effectiveAttempt; i++) {
    const next = nextEffort(current);
    if (!next || next === current) break;
    current = next;
  }
  return current;
}

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
