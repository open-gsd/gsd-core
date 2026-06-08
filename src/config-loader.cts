/**
 * Config Loader — Project configuration loading
 *
 * ADR-857 rollout phase 2e: extracted from core.cts (issue #885).
 * Owns project configuration loading: reads `.planning/config.json`,
 * merges built-in defaults (`CONFIG_DEFAULTS`/`CANONICAL_CONFIG_DEFAULTS`),
 * normalizes legacy keys, applies the active-workstream overlay, validates
 * against the config schema, and warns on unknown keys/profile overrides.
 * Behaviour is preserved byte-for-behaviour from the prior location; only
 * the module boundary moved. core.cjs re-exports `loadConfig` for back-compat.
 *
 * New imports should pull loadConfig from config-loader.cjs directly.
 *
 * Dependencies (leaf modules only — no core.cjs):
 *   - node:fs / node:os / node:path (stdlib)
 *   - ./configuration.cjs    (normalizeLegacyKeys, CONFIG_DEFAULTS as CANONICAL_CONFIG_DEFAULTS)
 *   - ./config-schema.cjs    (VALID_CONFIG_KEYS, DYNAMIC_KEY_PATTERNS)
 *   - ./planning-workspace.cjs (planningDir, planningRoot)
 *   - ./shell-command-projection.cjs (execGit, platformWriteSync, platformReadSync)
 *   - ./core-utils.cjs       (detectSubRepos)
 *   - ./model-catalog.cjs    (KNOWN_RUNTIMES, KNOWN_PROVIDERS)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execGit, platformWriteSync, platformReadSync } from './shell-command-projection.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspace = require('./planning-workspace.cjs');
const { planningDir, planningRoot } = planningWorkspace;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import coreUtilsModule = require('./core-utils.cjs');
const { detectSubRepos } = coreUtilsModule;
// ─── Configuration Module (generated CJS mirror) ────────────────────────────
import { CONFIG_DEFAULTS as CANONICAL_CONFIG_DEFAULTS, normalizeLegacyKeys } from './configuration.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import configSchema = require('./config-schema.cjs');
const { VALID_CONFIG_KEYS, DYNAMIC_KEY_PATTERNS } = configSchema;
import { KNOWN_RUNTIMES, KNOWN_PROVIDERS } from './model-catalog.cjs';

// ─── File & Config utilities ──────────────────────────────────────────────────

/**
 * Canonical config defaults — flat-key projection for CJS consumers.
 *
 * Cycle 4: Values are sourced from CANONICAL_CONFIG_DEFAULTS (the nested
 * manifest loaded by configuration.generated.cjs). The flat shape is
 * preserved here so legacy consumers (config.cjs, verify.cjs, tests that
 * regex-parse this source) continue to work without changes. The key names
 * and the `const CONFIG_DEFAULTS = {` pattern are intentionally kept.
 *
 * Mapping notes:
 *  - workflow.plan_check  → plan_checker (CJS flat name; verify.cjs uses this)
 *  - git.*               → flat git keys (branching_strategy, templates)
 *  - workflow.*          → flat names (research, verifier, …)
 *  - planning.sub_repos  → sub_repos
 *  - planning.commit_docs / search_gitignored → top-level flat keys
 */

// CANONICAL_CONFIG_DEFAULTS is typed as Record<string, unknown> from configuration.cjs;
// we use a typed accessor to avoid repeated casts.
function _getConfigDefault(key: string): unknown {
  return (CANONICAL_CONFIG_DEFAULTS)[key];
}
function _getNestedConfigDefault(section: string, field: string): unknown {
  const sec = (CANONICAL_CONFIG_DEFAULTS)[section];
  if (sec && typeof sec === 'object' && !Array.isArray(sec)) {
    return (sec as Record<string, unknown>)[field];
  }
  return undefined;
}

const CONFIG_DEFAULTS = {
  model_profile: _getConfigDefault('model_profile'),
  commit_docs: _getConfigDefault('commit_docs'),
  search_gitignored: _getConfigDefault('search_gitignored'),
  branching_strategy: _getNestedConfigDefault('git', 'branching_strategy'),
  phase_branch_template: _getNestedConfigDefault('git', 'phase_branch_template'),
  milestone_branch_template: _getNestedConfigDefault('git', 'milestone_branch_template'),
  quick_branch_template: _getNestedConfigDefault('git', 'quick_branch_template'),
  research: _getNestedConfigDefault('workflow', 'research'),
  plan_checker: _getNestedConfigDefault('workflow', 'plan_check'), // flat CJS name maps to workflow.plan_check
  verifier: _getNestedConfigDefault('workflow', 'verifier'),
  nyquist_validation: _getNestedConfigDefault('workflow', 'nyquist_validation'),
  ai_integration_phase: _getNestedConfigDefault('workflow', 'ai_integration_phase'),
  parallelization: _getConfigDefault('parallelization'),
  brave_search: _getConfigDefault('brave_search'),
  firecrawl: _getConfigDefault('firecrawl'),
  exa_search: _getConfigDefault('exa_search'),
  text_mode: _getNestedConfigDefault('workflow', 'text_mode'),
  sub_repos: _getNestedConfigDefault('planning', 'sub_repos'),
  resolve_model_ids: _getConfigDefault('resolve_model_ids'),
  context_window: _getConfigDefault('context_window'),
  phase_naming: _getConfigDefault('phase_naming'),
  project_code: _getConfigDefault('project_code'),
  subagent_timeout: _getNestedConfigDefault('workflow', 'subagent_timeout'),
  security_enforcement: _getNestedConfigDefault('workflow', 'security_enforcement'),
  security_asvs_level: _getNestedConfigDefault('workflow', 'security_asvs_level'),
  security_block_on: _getNestedConfigDefault('workflow', 'security_block_on'),
  post_planning_gaps: _getNestedConfigDefault('workflow', 'post_planning_gaps'),
};

/**
 * Deep-merge two plain config objects. `overlay` wins on key conflict.
 * Explicit `null` in overlay overrides base (null means "unset this key").
 * Arrays are replaced, not merged. Non-object primitives use overlay value.
 *
 * Note: `undefined` in overlay is treated as "no value provided" and falls
 * back to base (preserves inheritance). Explicit `null` overrides base.
 */
function _deepMergeConfig(base: Record<string, unknown>, overlay: Record<string, unknown> | null | undefined): Record<string, unknown> | null | undefined {
  if (overlay === null || overlay === undefined) return overlay;
  if (typeof base !== 'object' || typeof overlay !== 'object') return overlay;
  const result: Record<string, unknown> = { ...base };
  for (const key of Object.keys(overlay)) {
    if (overlay[key] !== null && typeof overlay[key] === 'object' && !Array.isArray(overlay[key])) {
      result[key] = _deepMergeConfig((base[key] ?? {}) as Record<string, unknown>, overlay[key] as Record<string, unknown>);
    } else {
      result[key] = overlay[key];
    }
  }
  return result;
}

// Module-level deduplication for unknown-key warnings (#3523).
// A single `init phase-op N` call invokes loadConfig more than once; this Set
// prevents the same warning from being echoed on each invocation.
const _warnedUnknownConfigKeys = new Set<string>();

// Normalization result shape from configuration.cjs
interface NormalizationEntry {
  requiresFilesystem?: boolean;
  [key: string]: unknown;
}

// Typed parsed config shape used internally
interface ParsedConfig {
  [key: string]: unknown;
  planning?: Record<string, unknown>;
}

// ─── Git utilities ────────────────────────────────────────────────────────────

const _gitIgnoredCache = new Map<string, boolean>();

function isGitIgnored(cwd: string, targetPath: string): boolean {
  const key = cwd + '::' + targetPath;
  if (_gitIgnoredCache.has(key)) return _gitIgnoredCache.get(key)!;
  // --no-index checks .gitignore rules regardless of whether the file is tracked.
  const result = execGit(['check-ignore', '-q', '--no-index', '--', targetPath], { cwd });
  const ignored = result.exitCode === 0;
  _gitIgnoredCache.set(key, ignored);
  return ignored;
}

// ─── Model alias resolution ───────────────────────────────────────────────────

const RUNTIME_OVERRIDE_TIERS = new Set(['opus', 'sonnet', 'haiku']);
const _warnedConfigKeys = new Set<string>();

function _warnUnknownProfileOverrides(parsed: Record<string, unknown>, configLabel: string): void {
  if (!parsed || typeof parsed !== 'object') return;

  const runtime = parsed['runtime'];
  if (runtime && typeof runtime === 'string' && !(KNOWN_RUNTIMES).has(runtime)) {
    const key = `${configLabel}::runtime::${runtime}`;
    if (!_warnedConfigKeys.has(key)) {
      _warnedConfigKeys.add(key);
      try {
        process.stderr.write(
          `gsd: warning — config key "runtime" has unknown value "${runtime}". ` +
          `Known runtimes: ${[...(KNOWN_RUNTIMES)].sort().join(', ')}. ` +
          `Resolution will fall back to safe defaults. (#2517)\n`
        );
      } catch { /* stderr might be closed in some test harnesses */ }
    }
  }

  const overrides = parsed['model_profile_overrides'];
  if (overrides && typeof overrides === 'object' && !Array.isArray(overrides)) {
    for (const [overrideRuntime, tierMap] of Object.entries(overrides as Record<string, unknown>)) {
      if (!(KNOWN_RUNTIMES).has(overrideRuntime)) {
        const key = `${configLabel}::override-runtime::${overrideRuntime}`;
        if (!_warnedConfigKeys.has(key)) {
          _warnedConfigKeys.add(key);
          try {
            process.stderr.write(
              `gsd: warning — model_profile_overrides.${overrideRuntime}.* uses ` +
              `unknown runtime "${overrideRuntime}". Known runtimes: ` +
              `${[...(KNOWN_RUNTIMES)].sort().join(', ')}. (#2517)\n`
            );
          } catch { /* ok */ }
        }
      }
      if (!tierMap || typeof tierMap !== 'object') continue;
      for (const tierName of Object.keys(tierMap)) {
        if (!RUNTIME_OVERRIDE_TIERS.has(tierName)) {
          const key = `${configLabel}::override-tier::${overrideRuntime}.${tierName}`;
          if (!_warnedConfigKeys.has(key)) {
            _warnedConfigKeys.add(key);
            try {
              process.stderr.write(
                `gsd: warning — model_profile_overrides.${overrideRuntime}.${tierName} ` +
                `uses unknown tier "${tierName}". Allowed tiers: opus, sonnet, haiku. (#2517)\n`
              );
            } catch { /* ok */ }
          }
        }
      }
    }
  }

  const policy = parsed['model_policy'];
  if (policy && typeof policy === 'object' && !Array.isArray(policy)) {
    const policyObj = policy as Record<string, unknown>;
    const provider = policyObj['provider'];
    const _POLICY_SENTINEL_PROVIDERS = new Set(['generic', 'custom']);
    if (provider && typeof provider === 'string' &&
        !(KNOWN_PROVIDERS).has(provider) && !_POLICY_SENTINEL_PROVIDERS.has(provider)) {
      const pkey = `${configLabel}::model_policy::provider::${provider}`;
      if (!_warnedConfigKeys.has(pkey)) {
        _warnedConfigKeys.add(pkey);
        try {
          process.stderr.write(
            `gsd: warning — model_policy.provider has unknown value "${provider}". ` +
            `Known providers: ${[...(KNOWN_PROVIDERS)].sort().join(', ')}. ` +
            `For manual model IDs use provider="custom". (#49)\n`
          );
        } catch { /* ok */ }
      }
    }

    const rtOverrides = policyObj['runtime_tiers'];
    if (rtOverrides && typeof rtOverrides === 'object' && !Array.isArray(rtOverrides)) {
      for (const [pruntime, tierMap] of Object.entries(rtOverrides as Record<string, unknown>)) {
        if (!(KNOWN_RUNTIMES).has(pruntime)) {
          const key = `${configLabel}::model_policy.runtime_tiers::${pruntime}`;
          if (!_warnedConfigKeys.has(key)) {
            _warnedConfigKeys.add(key);
            try {
              process.stderr.write(
                `gsd: warning — model_policy.runtime_tiers.${pruntime}.* uses ` +
                `unknown runtime "${pruntime}". Known runtimes: ` +
                `${[...(KNOWN_RUNTIMES)].sort().join(', ')}. (#49)\n`
              );
            } catch { /* ok */ }
          }
        }
        if (!tierMap || typeof tierMap !== 'object') continue;
        for (const tierName of Object.keys(tierMap)) {
          if (!RUNTIME_OVERRIDE_TIERS.has(tierName)) {
            const key = `${configLabel}::model_policy.runtime_tiers::${pruntime}.${tierName}`;
            if (!_warnedConfigKeys.has(key)) {
              _warnedConfigKeys.add(key);
              try {
                process.stderr.write(
                  `gsd: warning — model_policy.runtime_tiers.${pruntime}.${tierName} ` +
                  `uses unknown tier "${tierName}". Allowed: opus, sonnet, haiku. (#49)\n`
                );
              } catch { /* ok */ }
            }
          }
        }
      }
    }
  }
}

// Internal helper exposed for tests so per-process warning state can be reset
// between cases that intentionally exercise the warning path repeatedly.
function _resetRuntimeWarningCacheForTests(): void {
  _warnedConfigKeys.clear();
}

function loadConfig(cwd: string, options: Record<string, unknown> = {}): Record<string, unknown> {
  const activeWorkstream = Object.prototype.hasOwnProperty.call(options, 'workstream')
    ? options['workstream']
    : (options['workstreamContext'] && Object.prototype.hasOwnProperty.call(options['workstreamContext'], 'ws'))
      ? (options['workstreamContext'] as Record<string, unknown>)['ws']
    : (process.env['GSD_WORKSTREAM'] || null);
  // When GSD_WORKSTREAM is set, load root config first so workstream config
  // can inherit from it. This prevents users from duplicating model_overrides,
  // workflow.*, etc. across every workstream config (#2714).
  const ws = typeof activeWorkstream === 'string' ? activeWorkstream : (activeWorkstream === null ? null : null);
  // #315 — per-call lazy memo: all three detection sites inside this loadConfig
  // call operate on the same cwd and the subrepo set cannot change mid-call, so
  // a single scan is sufficient. The memo is scoped to THIS call (not module-level)
  // so separate loadConfig invocations each get a fresh scan.
  let cachedSubRepos: string[] | undefined;
  const getDetectedSubRepos = (): string[] => {
    if (cachedSubRepos === undefined) cachedSubRepos = detectSubRepos(cwd);
    // Return a copy: original detectSubRepos returned a fresh array per call,
    // so each site must keep an independent array (avoid cross-site aliasing).
    return cachedSubRepos.slice();
  };
  let rootParsed: ParsedConfig | null = null;
  if (ws) {
    const rootConfigPath = path.join(planningRoot(cwd), 'config.json');
    try {
      const raw = platformReadSync(rootConfigPath);
      if (raw === null) throw new Error('missing');
      rootParsed = JSON.parse(raw) as ParsedConfig;
      // Cycle 4: delegate all legacy-key normalization to the Configuration Module.
      const { parsed: rootNormalized, normalizations: rootNorms } = normalizeLegacyKeys(rootParsed);
      if (rootNorms.length > 0) {
        // Resolve filesystem-dependent normalizations (multiRepo → planning.sub_repos)
        for (const norm of rootNorms as unknown as NormalizationEntry[]) {
          if (norm.requiresFilesystem && !(rootNormalized as ParsedConfig).planning?.['sub_repos']) {
            const detected = getDetectedSubRepos();
            if (detected.length > 0) {
              if (!(rootNormalized as ParsedConfig).planning) (rootNormalized as ParsedConfig).planning = {};
              (rootNormalized as ParsedConfig).planning!['sub_repos'] = detected;
              (rootNormalized as ParsedConfig).planning!['commit_docs'] = false;
            }
          }
        }
        rootParsed = rootNormalized;
        try { platformWriteSync(rootConfigPath, JSON.stringify(rootParsed, null, 2)); } catch { /* ignore */ }
      } else {
        rootParsed = rootNormalized;
      }
    } catch {
      // Root config missing or unparseable — workstream config stands alone
    }
  }

  const configPath = path.join(planningDir(cwd, ws), 'config.json');
  const defaults = CONFIG_DEFAULTS;

  try {
    const raw = platformReadSync(configPath);
    if (raw === null) throw new Error('missing');
    // `fileData` is the parsed content of the config.json file on disk — used
    // for migrations and writes so we never persist merged values back to disk.
    const fileData: ParsedConfig = JSON.parse(raw) as ParsedConfig;

    // Cycle 4: Single normalizeLegacyKeys call replaces all four inline migration
    // blocks (depth→granularity, multiRepo→planning.sub_repos, sub_repos→planning.sub_repos,
    // branching_strategy→git.branching_strategy). The Module is pure (no I/O); disk
    // writeback is handled below with the existing platformWriteSync pattern.
    let configDirty = false;
    {
      const { parsed: normalized, normalizations } = normalizeLegacyKeys(fileData);
      if (normalizations.length > 0) {
        // Merge normalized values back into fileData (mutation-in-place for legacy code below)
        Object.keys(fileData).forEach(k => delete (fileData as Record<string, unknown>)[k]);
        Object.assign(fileData, normalized);
        configDirty = true;
        // Resolve filesystem-dependent normalizations (multiRepo → planning.sub_repos).
        for (const norm of normalizations as unknown as NormalizationEntry[]) {
          if (norm.requiresFilesystem && !fileData.planning?.['sub_repos']) {
            const detected = getDetectedSubRepos();
            if (detected.length > 0) {
              if (!fileData.planning) fileData.planning = {};
              fileData.planning['sub_repos'] = detected;
              fileData.planning['commit_docs'] = false;
            }
          }
        }
      }
    }

    // Keep planning.sub_repos in sync with actual filesystem
    const currentSubRepos = (fileData.planning?.['sub_repos'] as string[] | undefined) || [];
    if (Array.isArray(currentSubRepos) && currentSubRepos.length > 0) {
      const detected = getDetectedSubRepos();
      if (detected.length > 0) {
        const sorted = [...currentSubRepos].sort();
        if (JSON.stringify(sorted) !== JSON.stringify(detected)) {
          if (!fileData.planning) fileData.planning = {};
          fileData.planning['sub_repos'] = detected;
          configDirty = true;
        }
      }
    }

    // Persist sub_repos changes (migration or sync) — write only the on-disk
    // file contents, never the merged result, to avoid polluting workstream configs.
    if (configDirty) {
      try { platformWriteSync(configPath, JSON.stringify(fileData, null, 2)); } catch { /* ignore */ }
    }

    // Now apply root→workstream inheritance. `parsed` is the effective config
    // used for value extraction below; fileData is kept for disk writes only.
    const parsed: ParsedConfig = rootParsed
      ? (_deepMergeConfig(rootParsed, fileData) as ParsedConfig ?? fileData)
      : fileData;

    // Warn about unrecognized top-level keys so users don't silently lose config.
    const KNOWN_TOP_LEVEL = new Set([
      // Extract top-level key names from dot-notation paths (e.g., 'workflow.research' → 'workflow')
      ...[...VALID_CONFIG_KEYS].map((k: string) => k.split('.')[0]),
      // Dynamic-pattern top-level containers (e.g. review, model_profile_overrides)
      ...(DYNAMIC_KEY_PATTERNS as unknown as Array<{ topLevel: string }>).map(p => p.topLevel),
      // Internal keys loadConfig reads but config-set doesn't expose
      'model_overrides', 'context_window', 'resolve_model_ids', 'claude_md_path', 'effort', 'fast_mode',
      // Deprecated keys (still accepted for migration, not in config-set)
      'depth', 'multiRepo', 'branching_strategy',
    ]);
    const unknownKeys = Object.keys(parsed).filter(k => !KNOWN_TOP_LEVEL.has(k));
    if (unknownKeys.length > 0) {
      const warnKey = unknownKeys.join(',');
      if (!_warnedUnknownConfigKeys.has(warnKey)) {
        _warnedUnknownConfigKeys.add(warnKey);
        process.stderr.write(
          `gsd-tools: warning: unknown config key(s) in .planning/config.json: ${unknownKeys.join(', ')} — these will be ignored\n`
        );
      }
    }

    // #2517 — Validate runtime/tier values
    _warnUnknownProfileOverrides(parsed, '.planning/config.json');

    const get = (key: string, nested?: { section: string; field: string }): unknown => {
      if (parsed[key] !== undefined) return parsed[key];
      if (nested && parsed[nested.section] && typeof parsed[nested.section] === 'object' && parsed[nested.section] !== null) {
        const sec = parsed[nested.section] as Record<string, unknown>;
        if (sec[nested.field] !== undefined) {
          return sec[nested.field];
        }
      }
      return undefined;
    };

    const parallelization = (() => {
      const val = get('parallelization');
      if (typeof val === 'boolean') return val;
      if (typeof val === 'object' && val !== null && 'enabled' in (val)) return (val as Record<string, unknown>)['enabled'];
      return defaults.parallelization;
    })();

    return {
      model_profile: get('model_profile') ?? defaults.model_profile,
      commit_docs: (() => {
        const explicit = get('commit_docs', { section: 'planning', field: 'commit_docs' });
        // If explicitly set in config, respect the user's choice
        if (explicit !== undefined) return explicit;
        // Auto-detection: when no explicit value and .planning/ is gitignored,
        // default to false instead of true
        if (isGitIgnored(cwd, '.planning/')) return false;
        return defaults.commit_docs;
      })(),
      search_gitignored: get('search_gitignored', { section: 'planning', field: 'search_gitignored' }) ?? defaults.search_gitignored,
      branching_strategy: get('branching_strategy', { section: 'git', field: 'branching_strategy' }) ?? defaults.branching_strategy,
      phase_branch_template: get('phase_branch_template', { section: 'git', field: 'phase_branch_template' }) ?? defaults.phase_branch_template,
      milestone_branch_template: get('milestone_branch_template', { section: 'git', field: 'milestone_branch_template' }) ?? defaults.milestone_branch_template,
      quick_branch_template: get('quick_branch_template', { section: 'git', field: 'quick_branch_template' }) ?? defaults.quick_branch_template,
      research: get('research', { section: 'workflow', field: 'research' }) ?? defaults.research,
      plan_checker: get('plan_checker', { section: 'workflow', field: 'plan_check' }) ?? defaults.plan_checker,
      verifier: get('verifier', { section: 'workflow', field: 'verifier' }) ?? defaults.verifier,
      nyquist_validation: get('nyquist_validation', { section: 'workflow', field: 'nyquist_validation' }) ?? defaults.nyquist_validation,
      post_planning_gaps: get('post_planning_gaps', { section: 'workflow', field: 'post_planning_gaps' }) ?? defaults.post_planning_gaps,
      parallelization,
      brave_search: get('brave_search') ?? defaults.brave_search,
      firecrawl: get('firecrawl') ?? defaults.firecrawl,
      exa_search: get('exa_search') ?? defaults.exa_search,
      tdd_mode: get('tdd_mode', { section: 'workflow', field: 'tdd_mode' }) ?? false,
      mvp_mode: get('mvp_mode', { section: 'workflow', field: 'mvp_mode' }) ?? false,
      text_mode: get('text_mode', { section: 'workflow', field: 'text_mode' }) ?? defaults.text_mode,
      auto_advance: get('auto_advance', { section: 'workflow', field: 'auto_advance' }) ?? false,
      _auto_chain_active: get('_auto_chain_active', { section: 'workflow', field: '_auto_chain_active' }) ?? false,
      mode: get('mode') ?? 'interactive',
      sub_repos: get('sub_repos', { section: 'planning', field: 'sub_repos' }) ?? defaults.sub_repos,
      resolve_model_ids: get('resolve_model_ids') ?? defaults.resolve_model_ids,
      context_window: get('context_window') ?? defaults.context_window,
      phase_naming: get('phase_naming') ?? defaults.phase_naming,
      project_code: get('project_code') ?? defaults.project_code,
      subagent_timeout: get('subagent_timeout', { section: 'workflow', field: 'subagent_timeout' }) ?? defaults.subagent_timeout,
      model_overrides: (parsed['model_overrides']) || null,
      // #3023 — per-phase-type model map.
      models: (parsed['models']) || null,
      // #68 — top-level granularity
      granularity: parsed['granularity'] !== undefined ? parsed['granularity'] : null,
      // #68 — per-phase-type granularity map.
      granularities: (parsed['granularities']) || null,
      // #68 — planning sub-object
      planning: (parsed['planning']) || null,
      // #3024 — dynamic routing block.
      dynamic_routing: (parsed['dynamic_routing']) || null,
      // #2517 — runtime-aware profiles.
      runtime: (parsed['runtime']) || null,
      model_profile_overrides: (parsed['model_profile_overrides']) || null,
      // #49 — provider-neutral model policy presets.
      model_policy: (parsed['model_policy']) || null,
      // #443 — effort/fast_mode
      effort: (parsed['effort']) || null,
      fast_mode: (parsed['fast_mode']) || null,
      agent_skills: (parsed['agent_skills']) || {},
      agent_skills_security: (parsed['agent_skills_security']) || null,
      manager: (parsed['manager']) || {},
      response_language: get('response_language') || null,
      claude_md_path: get('claude_md_path') || null,
      claude_md_assembly: (parsed['claude_md_assembly']) || null,
    };
  } catch {
    // Fall back to ~/.gsd/defaults.json only for truly pre-project contexts (#1683)
    if (fs.existsSync(planningDir(cwd, ws))) {
      if (rootParsed) {
        // Workstream has no config.json: re-parse using root config as the sole source.
        return loadConfig(cwd, { workstream: null });
      }
      return defaults;
    }
    try {
      const home = process.env['GSD_HOME'] || os.homedir();
      const globalDefaultsPath = path.join(home, '.gsd', 'defaults.json');
      const raw = platformReadSync(globalDefaultsPath);
      if (raw === null) throw new Error('missing');
      const globalDefaults = JSON.parse(raw) as Record<string, unknown>;
      return {
        ...defaults,
        model_profile: (globalDefaults['model_profile']) ?? defaults.model_profile,
        commit_docs: (globalDefaults['commit_docs']) ?? defaults.commit_docs,
        research: (globalDefaults['research']) ?? defaults.research,
        plan_checker: (globalDefaults['plan_checker']) ?? defaults.plan_checker,
        verifier: (globalDefaults['verifier']) ?? defaults.verifier,
        nyquist_validation: (globalDefaults['nyquist_validation']) ?? defaults.nyquist_validation,
        post_planning_gaps: (globalDefaults['post_planning_gaps'])
          ?? (globalDefaults['workflow'] as Record<string, unknown> | undefined)?.['post_planning_gaps']
          ?? defaults.post_planning_gaps,
        parallelization: (globalDefaults['parallelization']) ?? defaults.parallelization,
        text_mode: (globalDefaults['text_mode']) ?? defaults.text_mode,
        resolve_model_ids: (globalDefaults['resolve_model_ids']) ?? defaults.resolve_model_ids,
        context_window: (globalDefaults['context_window']) ?? defaults.context_window,
        subagent_timeout: (globalDefaults['subagent_timeout']) ?? defaults.subagent_timeout,
        model_overrides: (globalDefaults['model_overrides']) || null,
        models: (globalDefaults['models']) || null,
        granularity: (globalDefaults['granularity']) !== undefined ? globalDefaults['granularity'] : null,
        granularities: (globalDefaults['granularities']) || null,
        planning: (globalDefaults['planning']) || null,
        dynamic_routing: (globalDefaults['dynamic_routing']) || null,
        effort: (globalDefaults['effort']) || null,
        fast_mode: (globalDefaults['fast_mode']) || null,
        agent_skills: (globalDefaults['agent_skills']) || {},
        response_language: (globalDefaults['response_language']) || null,
      };
    } catch {
      return defaults;
    }
  }
}

export = {
  loadConfig,
  isGitIgnored,
  CONFIG_DEFAULTS,
  _getConfigDefault,
  _getNestedConfigDefault,
  _deepMergeConfig,
  _warnedUnknownConfigKeys,
  _warnUnknownProfileOverrides,
  _resetRuntimeWarningCacheForTests,
  _warnedConfigKeys,
  _gitIgnoredCache,
  RUNTIME_OVERRIDE_TIERS,
};
