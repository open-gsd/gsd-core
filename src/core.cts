/**
 * Core — Shared utilities, constants, and internal helpers
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/core.cjs collapsed
 * to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only strict types are added.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execGit, platformWriteSync, platformReadSync, platformEnsureDir } from './shell-command-projection.cjs';
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
  findContextMdIn,
} = planningWorkspace;
import { findProjectRoot } from './project-root.cjs';
import { getGlobalConfigDir } from './runtime-homes.cjs';

// ─── Configuration Module (generated CJS mirror) ────────────────────────────
import { CONFIG_DEFAULTS as CANONICAL_CONFIG_DEFAULTS, normalizeLegacyKeys } from './configuration.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import configSchema = require('./config-schema.cjs');
const { VALID_CONFIG_KEYS, DYNAMIC_KEY_PATTERNS } = configSchema;

// ─── Path helpers ────────────────────────────────────────────────────────────

/** Normalize a relative path to always use forward slashes (cross-platform). */
function toPosixPath(p: string): string {
  return p.split(path.sep).join('/');
}

/**
 * Scan immediate child directories for separate git repos.
 * Returns a sorted array of directory names that have their own `.git`.
 * Excludes hidden directories and node_modules.
 */
function detectSubRepos(cwd: string): string[] {
  const results: string[] = [];
  try {
    const entries = fs.readdirSync(cwd, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const gitPath = path.join(cwd, entry.name, '.git');
      try {
        if (fs.existsSync(gitPath)) {
          results.push(entry.name);
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return results.sort();
}

// findProjectRoot is now re-exported from the generated CJS module above.

// ─── Output helpers ───────────────────────────────────────────────────────────

/**
 * Dedicated GSD temp directory: path.join(os.tmpdir(), 'gsd').
 * Created on first use. Keeps GSD temp files isolated from the system
 * temp directory so reap scans only GSD files (#1975).
 */
const GSD_TEMP_DIR = path.join(os.tmpdir(), 'gsd');

function ensureGsdTempDir(): void {
  platformEnsureDir(GSD_TEMP_DIR);
}

interface ReapOptions {
  maxAgeMs?: number;
  dirsOnly?: boolean;
}

/**
 * Remove stale gsd-* temp files/dirs older than maxAgeMs (default: 5 minutes).
 * Runs opportunistically before each new temp file write to prevent unbounded accumulation.
 * @param prefix - filename prefix to match (e.g., 'gsd-')
 * @param opts
 * @param opts.maxAgeMs - max age in ms before removal (default: 5 min)
 * @param opts.dirsOnly - if true, only remove directories (default: false)
 */
function reapStaleTempFiles(prefix = 'gsd-', { maxAgeMs = 5 * 60 * 1000, dirsOnly = false }: ReapOptions = {}): void {
  try {
    ensureGsdTempDir();
    const now = Date.now();
    const entries = fs.readdirSync(GSD_TEMP_DIR);
    for (const entry of entries) {
      if (!entry.startsWith(prefix)) continue;
      const fullPath = path.join(GSD_TEMP_DIR, entry);
      try {
        const stat = fs.statSync(fullPath);
        if (now - stat.mtimeMs > maxAgeMs) {
          if (stat.isDirectory()) {
            fs.rmSync(fullPath, { recursive: true, force: true });
          } else if (!dirsOnly) {
            fs.unlinkSync(fullPath);
          }
        }
      } catch {
        // File may have been removed between readdir and stat — ignore
      }
    }
  } catch {
    // Non-critical — don't let cleanup failures break output
  }
}

function output(result: unknown, raw: boolean, rawValue?: unknown): void {
  let data: string;
  if (raw && rawValue !== undefined) {
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    data = String(rawValue);
  } else {
    const json = JSON.stringify(result, null, 2);
    // Large payloads exceed Claude Code's Bash tool buffer (~50KB).
    // Write to tmpfile and output the path prefixed with @file: so callers can detect it.
    if (json.length > 50000) {
      reapStaleTempFiles();
      ensureGsdTempDir();
      const tmpPath = path.join(GSD_TEMP_DIR, `gsd-${Date.now()}.json`);
      platformWriteSync(tmpPath, json);
      data = '@file:' + tmpPath;
    } else {
      data = json;
    }
  }
  // process.stdout.write() is async when stdout is a pipe — process.exit()
  // can tear down the process before the reader consumes the buffer.
  // fs.writeSync(1, ...) blocks until the kernel accepts the bytes, and
  // skipping process.exit() lets the event loop drain naturally.
  fs.writeSync(1, data);
}

/**
 * Frozen enum of typed reason codes used by error() for structured errors.
 * Each subcommand contributes its own codes; the enum exists so tests can
 * assert against typed values instead of grepping stderr (#2974).
 *
 * Adding a new code:
 *   - Pick a snake_case lowercase value (the JSON wire form)
 *   - Group by subsystem prefix (CONFIG_*, SDK_*, etc)
 *   - Pass it to error(msg, ERROR_REASON.NEW_CODE) at the call site
 */
const ERROR_REASON = Object.freeze({
  // config-get / config-set
  CONFIG_KEY_NOT_FOUND: 'config_key_not_found',
  CONFIG_NO_FILE: 'config_no_file',
  CONFIG_PARSE_FAILED: 'config_parse_failed',
  CONFIG_INVALID_KEY: 'config_invalid_key',
  // SDK / gsd-tools dispatch
  SDK_FAIL_FAST: 'sdk_fail_fast',
  SDK_UNKNOWN_COMMAND: 'sdk_unknown_command',
  SDK_MISSING_ARG: 'sdk_missing_arg',
  // workflow / phase
  PHASE_NOT_FOUND: 'phase_not_found',
  SUMMARY_NO_PLANNING: 'summary_no_planning',
  // graphify
  GRAPHIFY_NO_GRAPH: 'graphify_no_graph',
  GRAPHIFY_INVALID_QUERY: 'graphify_invalid_query',
  // hooks
  HOOKS_OPT_OUT: 'hooks_opt_out',
  // security-scan
  SECURITY_SCAN_FAILED: 'security_scan_failed',
  // generic
  USAGE: 'usage',
  UNKNOWN: 'unknown',
});

type ErrorReasonValue = typeof ERROR_REASON[keyof typeof ERROR_REASON];

/**
 * Process-level flag: when true, error() emits structured JSON to stderr
 * instead of plain "Error: <message>" text. Set by gsd-tools.cjs when the
 * CLI is invoked with `--json-errors`. Tests opt in to typed-IR error
 * assertions by passing that flag and parsing the JSON.
 *
 * Default off so existing callers and human operators keep their plain-text
 * diagnostics. The structured form is opt-in for tooling and tests (#2974).
 */
let _jsonErrorMode = false;
function setJsonErrorMode(v: unknown): void { _jsonErrorMode = !!v; }
function getJsonErrorMode(): boolean { return _jsonErrorMode; }

/**
 * Emit an error and exit. When the second argument is provided it must be
 * a value from ERROR_REASON; tests can assert on `result.reason`. When the
 * process is in JSON-error mode, stderr receives `{ ok: false, reason,
 * message }` so callers can parse it; otherwise stderr keeps the plain
 * text form for human operators.
 */
function error(message: string, reason: ErrorReasonValue = ERROR_REASON.UNKNOWN): never {
  if (_jsonErrorMode) {
    const payload = JSON.stringify({ ok: false, reason, message }) + '\n';
    fs.writeSync(2, payload);
  } else {
    fs.writeSync(2, 'Error: ' + message + '\n');
  }
  process.exit(1);
}

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

// ─── Phase utilities ──────────────────────────────────────────────────────────

function escapeRegex(value: unknown): string {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizePhaseName(phase: unknown): string {
  const str = String(phase);
  // Strip optional project_code prefix (e.g., 'CK-01' → '01')
  const stripped = str.replace(/^[A-Z]{1,6}-(?=\d)/, '');
  // Milestone-prefixed phase IDs: M-NN or M-N-N (deep decomposition).
  const milestoneMatch = stripped.match(/^(\d+)((?:-\d+)+)([A-Z]?(?:\.\d+)*)$/i);
  if (milestoneMatch) {
    const major = milestoneMatch[1].padStart(2, '0');
    const subSegments = milestoneMatch[2].slice(1).split('-').map(s => s.padStart(2, '0'));
    const suffix = milestoneMatch[3] || '';
    return `${major}-${subSegments.join('-')}${suffix}`;
  }
  // Standard numeric phases: 1, 01, 12A, 12.1
  const match = stripped.match(/^(\d+)([A-Z])?((?:\.\d+)*)/i);
  if (match) {
    const padded = match[1].padStart(2, '0');
    // Preserve original case of letter suffix (#1962).
    const letter = match[2] || '';
    const decimal = match[3] || '';
    return padded + letter + decimal;
  }
  // Custom phase IDs (e.g. PROJ-42, AUTH-101): return as-is
  return str;
}

function getMilestoneFromPhaseId(phaseId: unknown): string | null {
  const str = String(phaseId);
  const stripped = str.replace(/^[A-Z]{1,6}-(?=\d)/i, '');
  const m = stripped.match(/^0*(\d+)-\d/);
  if (!m) return null;
  const major = parseInt(m[1], 10);
  if (major === 0 || major === 999) return null;
  return `v${major}.0`;
}

function getPhaseDirFromPhaseId(phaseId: unknown, phaseName: string | null | undefined, projectCode: string | null | undefined): string | null {
  const str = String(phaseId);
  const stripped = str.replace(/^[A-Z]{1,6}-(?=\d)/i, '');
  const m = stripped.match(/^0*(\d+)-(0*(\d+(?:-\d+)*))$/);
  if (!m) return null;
  const milestone = String(parseInt(m[1], 10)).padStart(2, '0');
  const subParts = m[2].split('-').map(p => String(parseInt(p, 10)).padStart(2, '0'));
  const sub = subParts.join('-');
  const slug = phaseName
    ? phaseName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    : '';
  const parts = [milestone, sub, slug].filter(Boolean);
  const base = parts.join('-');
  return projectCode ? `${projectCode}-${base}` : base;
}

/**
 * Render a regex source fragment matching a phase number against ROADMAP/STATE
 * prose regardless of zero-padding on either side.
 */
function phaseMarkdownRegexSource(phaseNum: unknown): string {
  const stripped = String(phaseNum).replace(/^[A-Z]{1,6}-(?=\d)/i, '');

  // Milestone-prefixed IDs: M-NN or M-N-N (deep).
  const milestoneSegments = stripped.match(/^(\d+)((?:-\d+)*)([A-Z]?(?:\.\d+)*)$/i);
  if (milestoneSegments && milestoneSegments[2]) {
    const majorUnpadded = milestoneSegments[1].replace(/^0+/, '') || '0';
    const subParts = milestoneSegments[2].slice(1).split('-');
    const subFragments = subParts.map(s => {
      const unpadded = s.replace(/^0+/, '') || '0';
      return `0*${escapeRegex(unpadded)}`;
    });
    const suffix = milestoneSegments[3] || '';
    const suffixFragment = suffix ? escapeRegex(suffix) : '';
    return `0*${escapeRegex(majorUnpadded)}-${subFragments.join('-')}${suffixFragment}`;
  }

  // Plain numeric phase: 1, 01, 12A, 12.1
  const match = stripped.match(/^0*(\d+)([A-Z])?((?:\.\d+)*)$/i);
  if (!match) return escapeRegex(phaseNum);

  const integer = match[1].replace(/^0+/, '') || '0';
  const letter = match[2] ? escapeRegex(match[2]) : '';
  const decimal = match[3] ? escapeRegex(match[3]) : '';
  return `0*${escapeRegex(integer)}${letter}${decimal}`;
}

/**
 * #3599: when the caller passed a project-code-prefixed ID like `PROJ-42`,
 * return the exact-escaped form.
 */
function phaseMarkdownRegexSourceExact(phaseNum: unknown): string | null {
  const raw = String(phaseNum);
  if (!/^[A-Z]{1,6}-(?=\d)/i.test(raw)) return null;
  return escapeRegex(raw);
}

function comparePhaseNum(a: unknown, b: unknown): number {
  // Strip optional project_code prefix before comparing
  const sa = String(a).replace(/^[A-Z]{1,6}-(?=\d)/i, '');
  const sb = String(b).replace(/^[A-Z]{1,6}-(?=\d)/i, '');

  const milestoneA = sa.match(/^(\d+)((?:-\d+)+)([A-Z]?(?:\.\d+)*)$/i);
  const milestoneB = sb.match(/^(\d+)((?:-\d+)+)([A-Z]?(?:\.\d+)*)$/i);

  if (milestoneA && milestoneB) {
    const segsA = [parseInt(milestoneA[1], 10), ...milestoneA[2].slice(1).split('-').map(s => parseInt(s, 10))];
    const segsB = [parseInt(milestoneB[1], 10), ...milestoneB[2].slice(1).split('-').map(s => parseInt(s, 10))];
    const maxSegs = Math.max(segsA.length, segsB.length);
    for (let i = 0; i < maxSegs; i++) {
      const av = segsA[i] !== undefined ? segsA[i] : 0;
      const bv = segsB[i] !== undefined ? segsB[i] : 0;
      if (av !== bv) return av - bv;
    }
    const sufA = milestoneA[3] || '';
    const sufB = milestoneB[3] || '';
    if (sufA !== sufB) return sufA < sufB ? -1 : 1;
    return 0;
  }

  if (milestoneA || milestoneB) return String(a).localeCompare(String(b));

  const pa = sa.match(/^(\d+)([A-Z])?((?:\.\d+)*)/i);
  const pb = sb.match(/^(\d+)([A-Z])?((?:\.\d+)*)/i);
  if (!pa || !pb) return String(a).localeCompare(String(b));
  const intDiff = parseInt(pa[1], 10) - parseInt(pb[1], 10);
  if (intDiff !== 0) return intDiff;
  const la = (pa[2] || '').toUpperCase();
  const lb = (pb[2] || '').toUpperCase();
  if (la !== lb) {
    if (!la) return -1;
    if (!lb) return 1;
    return la < lb ? -1 : 1;
  }
  const aDecParts = pa[3] ? pa[3].slice(1).split('.').map(p => parseInt(p, 10)) : [];
  const bDecParts = pb[3] ? pb[3].slice(1).split('.').map(p => parseInt(p, 10)) : [];
  const maxLen = Math.max(aDecParts.length, bDecParts.length);
  if (aDecParts.length === 0 && bDecParts.length > 0) return -1;
  if (bDecParts.length === 0 && aDecParts.length > 0) return 1;
  for (let i = 0; i < maxLen; i++) {
    const av = Number.isFinite(aDecParts[i]) ? aDecParts[i] : 0;
    const bv = Number.isFinite(bDecParts[i]) ? bDecParts[i] : 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

/**
 * Extract the phase token from a directory name.
 */
function extractPhaseToken(dirName: string): string {
  const codePrefixMatch = dirName.match(/^([A-Z]{1,6})-(\d.*)/i);
  let prefix = '';
  let rest = dirName;
  if (codePrefixMatch) {
    prefix = codePrefixMatch[1] + '-';
    rest = codePrefixMatch[2];
  }

  const segments = rest.split('-');
  const tokenSegments: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (/^\d/.test(seg)) {
      tokenSegments.push(seg);
    } else {
      break;
    }
  }

  if (tokenSegments.length === 0) {
    return dirName;
  }

  return prefix + tokenSegments.join('-');
}

/**
 * Check if a directory name's phase token matches the normalized phase exactly.
 */
function phaseTokenMatches(dirName: string, normalized: string): boolean {
  const token = extractPhaseToken(dirName);
  if (token.toUpperCase() === normalized.toUpperCase()) return true;
  const stripped = dirName.replace(/^[A-Z]{1,6}-(?=\d)/i, '');
  if (stripped !== dirName) {
    const strippedToken = extractPhaseToken(stripped);
    if (strippedToken.toUpperCase() === normalized.toUpperCase()) return true;
  }
  return false;
}

function extractCanonicalPlanId(filename: string): string {
  const base = filename.replace(/-PLAN\.md$/i, '').replace(/-SUMMARY\.md$/i, '').replace(/\.md$/i, '');
  const parts = base.split('-').filter(Boolean);
  const tokenRe = /^\d+[A-Z]?(?:\.\d+)*$/i;
  const phaseIdx = parts.findIndex(p => tokenRe.test(p));
  if (phaseIdx >= 0 && phaseIdx + 1 < parts.length && tokenRe.test(parts[phaseIdx + 1])) {
    return `${parts[phaseIdx]}-${parts[phaseIdx + 1]}`;
  }
  return base;
}

interface PhaseSearchResult {
  found: boolean;
  directory: string;
  phase_number: string;
  phase_name: string | null;
  phase_slug: string | null;
  plans: string[];
  summaries: string[];
  incomplete_plans: string[];
  has_research: boolean;
  has_context: boolean;
  has_verification: boolean;
  has_reviews: boolean;
  archived?: string;
}

function searchPhaseInDir(baseDir: string, relBase: string, normalized: string): PhaseSearchResult | null {
  try {
    const dirs = readSubdirectories(baseDir, true);
    const match = dirs.find(d => phaseTokenMatches(d, normalized));
    if (!match) return null;

    const phaseToken = extractPhaseToken(match);
    const phaseNumber = phaseToken || normalized;
    const afterToken = match.slice(phaseToken ? phaseToken.length : 0).replace(/^-/, '');
    const phaseName = afterToken || null;
    const phaseDir = path.join(baseDir, match);
    const { plans: unsortedPlans, summaries: unsortedSummaries, hasResearch, hasContext, hasVerification, hasReviews } = getPhaseFileStats(phaseDir);
    const plans = unsortedPlans.sort();
    const summaries = unsortedSummaries.sort();

    const completedPlanIds = new Set(
      summaries.flatMap(s => {
        const exact = s.replace('-SUMMARY.md', '').replace('SUMMARY.md', '');
        const canonical = extractCanonicalPlanId(s);
        return canonical === exact ? [exact] : [exact, canonical];
      })
    );
    const incompletePlans = plans.filter(p => {
      const planId = p.replace('-PLAN.md', '').replace('PLAN.md', '');
      const canonical = extractCanonicalPlanId(p);
      return !completedPlanIds.has(planId) && !completedPlanIds.has(canonical);
    });

    return {
      found: true,
      directory: toPosixPath(path.join(relBase, match)),
      phase_number: phaseNumber,
      phase_name: phaseName,
      phase_slug: phaseName ? phaseName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') : null,
      plans,
      summaries,
      incomplete_plans: incompletePlans,
      has_research: hasResearch,
      has_context: hasContext,
      has_verification: hasVerification,
      has_reviews: hasReviews,
    };
  } catch {
    return null;
  }
}

function findPhaseInternal(cwd: string, phase: unknown): PhaseSearchResult | null {
  if (!phase) return null;

  const phasesDir = path.join(planningDir(cwd), 'phases');
  const normalized = normalizePhaseName(phase);

  const relPhasesDir = toPosixPath(path.relative(cwd, phasesDir));
  const current = searchPhaseInDir(phasesDir, relPhasesDir, normalized);
  if (current) return current;

  const milestonesDir = path.join(cwd, '.planning', 'milestones');
  if (!fs.existsSync(milestonesDir)) return null;

  try {
    const milestoneEntries = fs.readdirSync(milestonesDir, { withFileTypes: true });
    const archiveDirs = milestoneEntries
      .filter(e => e.isDirectory() && /^v[\d.]+-phases$/.test(e.name))
      .map(e => e.name)
      .sort()
      .reverse();

    for (const archiveName of archiveDirs) {
      const versionMatch = archiveName.match(/^(v[\d.]+)-phases$/);
      const version = versionMatch![1];
      const archivePath = path.join(milestonesDir, archiveName);
      const relBase = '.planning/milestones/' + archiveName;
      const result = searchPhaseInDir(archivePath, relBase, normalized);
      if (result) {
        result.archived = version;
        return result;
      }
    }
  } catch { /* intentionally empty */ }

  return null;
}

interface ArchivedPhaseDir {
  name: string;
  milestone: string;
  basePath: string;
  fullPath: string;
}

function getArchivedPhaseDirs(cwd: string): ArchivedPhaseDir[] {
  const milestonesDir = path.join(cwd, '.planning', 'milestones');
  const results: ArchivedPhaseDir[] = [];

  if (!fs.existsSync(milestonesDir)) return results;

  try {
    const milestoneEntries = fs.readdirSync(milestonesDir, { withFileTypes: true });
    const phaseDirs = milestoneEntries
      .filter(e => e.isDirectory() && /^v[\d.]+-phases$/.test(e.name))
      .map(e => e.name)
      .sort()
      .reverse();

    for (const archiveName of phaseDirs) {
      const versionMatch = archiveName.match(/^(v[\d.]+)-phases$/);
      const version = versionMatch![1];
      const archivePath = path.join(milestonesDir, archiveName);
      const dirs = readSubdirectories(archivePath, true);

      for (const dir of dirs) {
        results.push({
          name: dir,
          milestone: version,
          basePath: path.join('.planning', 'milestones', archiveName),
          fullPath: path.join(archivePath, dir),
        });
      }
    }
  } catch { /* intentionally empty */ }

  return results;
}

// ─── Roadmap milestone scoping ───────────────────────────────────────────────

/**
 * Strip shipped milestone content wrapped in <details> blocks.
 */
function stripShippedMilestones(content: string): string {
  return content.replace(/<details>[\s\S]*?<\/details>/gi, '');
}

/**
 * Extract the current milestone section from ROADMAP.md by positive lookup.
 */
function extractCurrentMilestone(content: string, cwd?: string): string {
  if (!cwd) return stripShippedMilestones(content);

  let version: string | null = null;
  try {
    const statePath = path.join(planningDir(cwd), 'STATE.md');
    const stateRaw = platformReadSync(statePath);
    if (stateRaw !== null) {
      const milestoneMatch = stateRaw.match(/^milestone:\s*(.+)/m);
      if (milestoneMatch) {
        version = milestoneMatch[1].trim();
      }
    }
  } catch { /* ignore */ }

  if (!version) {
    const inProgressMatch = content.match(/(?:🚧|🔄)\s*\*\*v(\d+\.\d+)\s/);
    if (inProgressMatch) {
      version = 'v' + inProgressMatch[1];
    }
  }

  if (!version) return stripShippedMilestones(content);

  const escapedVersion = escapeRegex(version);
  const sectionPattern = new RegExp(
    `(^#{1,3}\\s+(?!Phase\\s+\\S).*${escapedVersion}\\b[^\\n]*)`,
    'gmi'
  );
  const summaryPattern = new RegExp(
    `<summary[^>]*>([^<]*${escapedVersion}[^<]*)<\\/summary>`,
    'i'
  );
  const headingMatches = [...content.matchAll(sectionPattern)];

  if (headingMatches.length === 0) {
    const summaryMatch = content.match(summaryPattern);
    if (summaryMatch) {
      const summaryIdx = content.indexOf(summaryMatch[0]);
      const beforeSummary = content.slice(0, summaryIdx);
      const detailsOpenIdx = beforeSummary.lastIndexOf('<details');
      if (detailsOpenIdx !== -1) {
        const afterDetails = content.slice(detailsOpenIdx);
        const closingMatch = afterDetails.match(/<\/details>/i);
        const detailsEnd = closingMatch
          ? detailsOpenIdx + (closingMatch.index ?? 0) + '</details>'.length
          : content.length;
        const anyMilestoneOrDetails = /^#{1,3}\s+(?!Phase\s+\S)(?:.*v\d+\.\d+|✅|📋|🚧|🔄)|<details/im;
        const firstMilestoneMatch = content.match(anyMilestoneOrDetails);
        const preambleCutoff = firstMilestoneMatch ? firstMilestoneMatch.index! : detailsOpenIdx;
        const preamble = content.slice(0, preambleCutoff)
          .replace(/<details>[\s\S]*?<\/details>/gi, '')
          .replace(/^#{2,4}\s*Phase\s+[\w][\w.-]*\s*:[^\n]*(?:\n(?!#{1,6}\s)[^\n]*)*\n?/gim, '')
          .replace(/^#{1,4}\s*Phase Details\b[^\n]*\n?/gim, '');
        return preamble + content.slice(detailsOpenIdx, detailsEnd);
      }
    }
    return stripShippedMilestones(content);
  }

  const allMatches = headingMatches;

  const closedMarkerPattern = /\b(?:CLOSED|ARCHIVED|ABANDONED|SHIPPED|FAILED)\b|✅|🗄/i;
  const activeMarkerPattern = /\b(?:STARTED|ACTIVE|WIP)\b|in\s+progress|🚧|🔄/i;
  const isClosed = (h: string) => closedMarkerPattern.test(h) && !activeMarkerPattern.test(h);
  const firstMatch = allMatches[0];
  const selected = allMatches.find((m) => !isClosed(m[1])) || firstMatch;

  const sectionStart = selected.index;

  const computeSectionEnd = (headingText: string, headingStart: number): number => {
    const level = (headingText.match(/^(#{1,3})\s/) ?? ['', '#'])[1].length;
    const rest = content.slice(headingStart + headingText.length);
    const stopPattern = new RegExp(
      `^#{1,${level}}\\s+(?!Phase\\s+\\S)(?:.*v\\d+\\.\\d+|✅|📋|🚧)`,
      'i',
    );
    let end = content.length;
    let fc: string | null = null;
    let fl = 0;
    let off = 0;
    for (const line of rest.split('\n')) {
      const fm = line.match(/^\s{0,3}((?:`{3,}|~{3,}))(.*)/);
      if (fm) {
        const ch = fm[1][0];
        const ln = fm[1].length;
        const trailing = fm[2] || '';
        if (!fc) {
          fc = ch;
          fl = ln;
        } else if (ch === fc && ln >= fl && /^\s*$/.test(trailing)) {
          fc = null;
          fl = 0;
        }
      } else if (!fc && stopPattern.test(line)) {
        end = headingStart + headingText.length + off;
        break;
      }
      off += line.length + 1;
    }
    return end;
  };

  const sectionEnd = computeSectionEnd(selected[0], sectionStart);

  const anyMilestonePattern = /^#{1,3}\s+(?!Phase\s+\S)(?:.*v\d+\.\d+|✅|📋|🚧)/im;
  const firstMilestoneMatch = content.match(anyMilestonePattern);
  const preambleCutoff = firstMilestoneMatch
    ? firstMilestoneMatch.index!
    : firstMatch.index;
  const beforeMilestones = content.slice(0, preambleCutoff);
  const currentSection = content.slice(sectionStart, sectionEnd);

  // Multi-milestone roadmaps split each added milestone across two version-bearing
  // headings: a `## Phases` checklist subsection (early) and a dedicated
  // `## Milestone … (Phase Details)` section (late) holding the `### Phase N:`
  // detail headers. The scope window above stops at the next version-bearing
  // heading — the current milestone's OWN Phase Details heading — leaving those
  // detail headers outside `currentSection`. Append that section so phase
  // resolution and counting see the current milestone's phases. Anchor the lookup
  // to the SELECTED heading's specific version token (boundary-aware, so a
  // `v3.0` state does not match a `v3.0-A` sub-milestone) so sibling milestones
  // that share a version prefix do not cross-pollinate. (#730)
  const selectedVersionToken = selected[1].match(
    /v\d+(?:\.\d+)+(?:[-.][A-Za-z0-9]+)*/i,
  )?.[0];
  const detailsVersionBoundary = selectedVersionToken
    ? new RegExp(`${escapeRegex(selectedVersionToken)}(?![\\w.-])`, 'i')
    : null;
  let detailsSection = '';
  const detailsMatch = allMatches.find(
    (m) =>
      /\(Phase\s+Details\)/i.test(m[1]) &&
      !isClosed(m[1]) &&
      (!detailsVersionBoundary || detailsVersionBoundary.test(m[1])) &&
      (m.index ?? 0) >= sectionEnd,
  );
  if (detailsMatch) {
    const detailsStart = detailsMatch.index ?? 0;
    detailsSection = content.slice(
      detailsStart,
      computeSectionEnd(detailsMatch[0], detailsStart),
    );
  }

  const preamble = beforeMilestones
    .replace(/<details>[\s\S]*?<\/details>/gi, '')
    .replace(/^#{2,4}\s*Phase\s+[\w][\w.-]*\s*:[^\n]*(?:\n(?!#{1,6}\s)[^\n]*)*\n?/gim, '')
    .replace(/^#{1,4}\s*Phase Details\b[^\n]*\n?/gim, '');

  return detailsSection
    ? preamble + currentSection + '\n' + detailsSection
    : preamble + currentSection;
}

/**
 * Replace a pattern only in the current milestone section of ROADMAP.md.
 */
function replaceInCurrentMilestone(content: string, pattern: RegExp, replacement: string): string {
  const lastDetailsClose = content.lastIndexOf('</details>');
  if (lastDetailsClose === -1) {
    return content.replace(pattern, replacement);
  }
  const offset = lastDetailsClose + '</details>'.length;
  const before = content.slice(0, offset);
  const after = content.slice(offset);
  return before + after.replace(pattern, replacement);
}

// ─── Roadmap & model utilities ────────────────────────────────────────────────

interface RoadmapPhaseResult {
  found: boolean;
  phase_number: string;
  phase_name: string;
  goal: string | null;
  section: string;
}

function getRoadmapPhaseInternal(cwd: string, phaseNum: unknown): RoadmapPhaseResult | null {
  if (!phaseNum) return null;
  const roadmapPath = path.join(planningDir(cwd), 'ROADMAP.md');
  if (!fs.existsSync(roadmapPath)) return null;

  try {
    const roadmapRaw = platformReadSync(roadmapPath);
    if (roadmapRaw === null) throw new Error('missing');
    const content = extractCurrentMilestone(roadmapRaw, cwd);
    const phasePattern = new RegExp(
      `#{2,4}\\s*(?:\\[[^\\]]+\\]\\s*)?Phase\\s+${phaseMarkdownRegexSource(phaseNum)}:\\s*([^\\n]+)`,
      'i'
    );
    const headerMatch = content.match(phasePattern);
    if (!headerMatch) return null;

    const phaseName = headerMatch[1].trim();
    const headerIndex = headerMatch.index!;
    const restOfContent = content.slice(headerIndex);
    const nextHeaderMatch = restOfContent.match(/\n#{2,4}\s+(?:\[[^\]]+\]\s*)?Phase\s+[\w]/i);
    const sectionEnd = nextHeaderMatch ? headerIndex + nextHeaderMatch.index! : content.length;
    const section = content.slice(headerIndex, sectionEnd).trim();

    const goalMatch = section.match(/\*\*Goal(?:\*\*:|\*?\*?:\*\*)\s*([^\n]+)/i);
    const goal = goalMatch ? goalMatch[1].trim() : null;

    return {
      found: true,
      // eslint-disable-next-line @typescript-eslint/no-base-to-string
      phase_number: String(phaseNum),
      phase_name: phaseName,
      goal,
      section,
    };
  } catch {
    return null;
  }
}

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
function resolveGranularityInternal(cwd: string, phaseType: string | null | undefined): string {
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

// ─── Summary body helpers ─────────────────────────────────────────────────

/**
 * Extract a one-liner from the summary body when it's not in frontmatter.
 */
function extractOneLinerFromBody(content: string | null | undefined): string | null {
  if (!content) return null;
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const body = normalized.replace(/^---\n[\s\S]*?\n---\n*/, '');
  const match = body.match(/^#[^\n]*\n+\*\*([^*\n]+)\*\*([^\n]*)/m);
  if (!match) return null;
  const boldInner = match[1].trim();
  const afterBold = match[2];
  if (/:\s*$/.test(boldInner)) {
    const prose = afterBold.trim();
    return prose.length > 0 ? prose : null;
  }
  return boldInner.length > 0 ? boldInner : null;
}

// ─── Misc utilities ───────────────────────────────────────────────────────────

function pathExistsInternal(cwd: string, targetPath: string): boolean {
  const fullPath = path.isAbsolute(targetPath) ? targetPath : path.join(cwd, targetPath);
  try {
    fs.statSync(fullPath);
    return true;
  } catch {
    return false;
  }
}

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

function generateSlugInternal(text: string | null | undefined): string | null {
  if (!text) return null;
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').substring(0, 60);
}

interface MilestoneInfo {
  version: string;
  name: string;
}

function getMilestoneInfo(cwd: string): MilestoneInfo {
  try {
    const roadmap = platformReadSync(path.join(planningDir(cwd), 'ROADMAP.md'));
    if (roadmap === null) throw new Error('missing');

    let stateVersion: string | null = null;
    if (cwd) {
      try {
        const statePath = path.join(planningDir(cwd), 'STATE.md');
        const stateRaw = platformReadSync(statePath);
        if (stateRaw !== null) {
          const m = stateRaw.match(/^milestone:\s*(.+)/m);
          if (m) stateVersion = m[1].trim();
        }
      } catch { /* intentionally empty */ }
    }

    if (stateVersion) {
      const escapedVer = escapeRegex(stateVersion);
      const headingMatch = roadmap.match(
        new RegExp(`##[^\\n]*${escapedVer}[:\\s]+([^\\n(]+)`, 'i')
      );
      if (headingMatch) {
        if (!headingMatch[0].includes('✅')) {
          return { version: stateVersion, name: headingMatch[1].trim() };
        }
      } else {
        const listMatch = roadmap.match(
          new RegExp(`🚧\\s*\\*?\\*?${escapedVer}\\s+([^*\\n]+)`, 'i')
        );
        if (listMatch) {
          return { version: stateVersion, name: listMatch[1].trim() };
        }
        return { version: stateVersion, name: 'milestone' };
      }
    }

    const inProgressMatch = roadmap.match(/🚧\s*\*\*v(\d+(?:\.\d+)+)\s+([^*]+)\*\*/);
    if (inProgressMatch) {
      return {
        version: 'v' + inProgressMatch[1],
        name: inProgressMatch[2].trim(),
      };
    }

    const cleaned = stripShippedMilestones(roadmap);
    const headingMatch = cleaned.match(/## (?!.*✅).*v(\d+(?:\.\d+)+)[:\s]+([^\n(]+)/);
    if (headingMatch) {
      return {
        version: 'v' + headingMatch[1],
        name: headingMatch[2].trim(),
      };
    }
    const versionMatch = cleaned.match(/v(\d+(?:\.\d+)+)/);
    return {
      version: versionMatch ? versionMatch[0] : 'v1.0',
      name: 'milestone',
    };
  } catch {
    return { version: 'v1.0', name: 'milestone' };
  }
}

type MilestonePhaseFilter = ((dirName: string) => boolean) & {
  phaseCount: number;
  missingExplicitVersion: boolean;
};

/**
 * Returns a filter function that checks whether a phase directory belongs
 * to the current milestone based on ROADMAP.md phase headings.
 */
function getMilestonePhaseFilter(cwd: string, versionOverride?: string | null): MilestonePhaseFilter {
  const milestonePhaseNums = new Set<string>();
  let missingExplicitVersion = false;
  try {
    const roadmapPath = path.join(planningDir(cwd), 'ROADMAP.md');
    const roadmapContent = platformReadSync(roadmapPath);
    if (roadmapContent === null) throw new Error('missing');
    let roadmap = extractCurrentMilestone(roadmapContent, cwd);

    const hasVersionedMilestonesGlobal = /^#{1,3}\s+.*v\d+\.\d+/mi.test(roadmapContent);
    const hasPhaseHeadings = /#{2,4}\s*(?:\[[^\]]+\]\s*)?Phase\s+[\w]/i.test(roadmapContent);
    if (!hasVersionedMilestonesGlobal && hasPhaseHeadings) {
      console.warn(
        '[gsd] Deprecated: free-form ROADMAP.md detected (no versioned milestone headings). ' +
        'Set phase_id_convention in config.json to suppress this warning.'
      );
    }

    if (versionOverride) {
      const escapedVersion = escapeRegex(versionOverride);
      const sectionPattern = new RegExp(`(^#{1,3}\\s+(?!Phase\\s+\\S).*${escapedVersion}[^\\n]*)`, 'mi');
      let sectionMatch = roadmapContent.match(sectionPattern);

      if (!sectionMatch) {
        const summaryPat = new RegExp(`<summary[^>]*>[^<]*${escapedVersion}[^<]*<\\/summary>`, 'i');
        const summaryHit = roadmapContent.match(summaryPat);
        if (summaryHit) {
          const beforeSummary = roadmapContent.slice(0, summaryHit.index);
          const detailsIdx = beforeSummary.lastIndexOf('<details');
          if (detailsIdx !== -1) {
            sectionMatch = null;
          }
        }
      }

      if (!sectionMatch) {
        const hasVersionedMilestones = /^#{1,3}\s+(?!Phase\s+\S).*v\d+\.\d+/mi.test(roadmapContent);
        const versionInSummary = new RegExp(`<summary[^>]*>[^<]*${escapedVersion}[^<]*<\\/summary>`, 'i').test(roadmapContent);
        if (hasVersionedMilestones && !versionInSummary) {
          roadmap = '';
          missingExplicitVersion = true;
        }
      } else {
        const sectionStart = sectionMatch.index!;
        const headingLevel = (sectionMatch[1].match(/^(#{1,3})\s/) ?? ['', '#'])[1].length;
        const restContent = roadmapContent.slice(sectionStart + sectionMatch[0].length);
        const nextMilestonePattern = new RegExp(`^#{1,${headingLevel}}\\s+(?!Phase\\s+\\S)(?:.*v\\d+\\.\\d+|✅|📋|🚧)`, 'i');

        let sectionEnd = roadmapContent.length;
        let fenceChar: string | null = null;
        let fenceLen = 0;
        let charOffset = 0;
        for (const line of restContent.split('\n')) {
          const fenceMatch = line.match(/^\s{0,3}((?:`{3,}|~{3,}))(.*)/);
          if (fenceMatch) {
            const char = fenceMatch[1][0];
            const len = fenceMatch[1].length;
            const trailing = fenceMatch[2] || '';
            if (!fenceChar) {
              fenceChar = char;
              fenceLen = len;
            } else if (char === fenceChar && len >= fenceLen && /^\s*$/.test(trailing)) {
              fenceChar = null;
              fenceLen = 0;
            }
          } else if (!fenceChar && nextMilestonePattern.test(line)) {
            sectionEnd = sectionStart + sectionMatch[0].length + charOffset;
            break;
          }
          charOffset += line.length + 1;
        }

        const currentSection = roadmapContent.slice(sectionStart, sectionEnd);
        roadmap = currentSection;
      }
    }

    const phasePattern = /#{2,4}\s*(?:\[[^\]]+\]\s*)?Phase\s+([\w][\w.-]*)\s*:/gi;
    let m: RegExpExecArray | null;
    while ((m = phasePattern.exec(roadmap)) !== null) {
      milestonePhaseNums.add(m[1]);
    }
  } catch { /* intentionally empty */ }

  if (milestonePhaseNums.size === 0) {
    const passAll = (() => true) as unknown as MilestonePhaseFilter;
    passAll.phaseCount = 0;
    passAll.missingExplicitVersion = missingExplicitVersion;
    return passAll;
  }

  const normalized = new Set(
    [...milestonePhaseNums].map(n => n.split('-').map(seg => (seg.replace(/^0+(?=\d)/, '') || '0')).join('-').toLowerCase())
  );

  function normalizePhaseIdSegments(id: string): string {
    return id.split('-').map(seg => seg.replace(/^0+(?=\d)/, '') || '0').join('-');
  }

  const roadmapUsesHyphenedIds = [...normalized].some(n => n.includes('-'));
  const numericRe = roadmapUsesHyphenedIds
    ? /^0*(\d+(?:-0*\d+)*[A-Za-z]?(?:\.\d+)*)/
    : /^0*(\d+[A-Za-z]?(?:\.\d+)*)/;

  function isDirInMilestone(dirName: string): boolean {
    const m2 = dirName.match(numericRe);
    if (m2 && normalized.has(normalizePhaseIdSegments(m2[1]).toLowerCase())) return true;
    const customMatch = dirName.match(/^([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*)/);
    if (customMatch && normalized.has(customMatch[1].toLowerCase())) return true;
    const stripped = dirName.replace(/^[A-Z]{1,6}-(?=\d)/i, '');
    if (stripped !== dirName) {
      const sm = stripped.match(numericRe);
      if (sm && normalized.has(normalizePhaseIdSegments(sm[1]).toLowerCase())) return true;
    }
    return false;
  }
  (isDirInMilestone as MilestonePhaseFilter).phaseCount = milestonePhaseNums.size;
  (isDirInMilestone as MilestonePhaseFilter).missingExplicitVersion = missingExplicitVersion;
  return isDirInMilestone as MilestonePhaseFilter;
}

// ─── Phase file helpers ──────────────────────────────────────────────────────

/** Filter a file list to just PLAN.md / *-PLAN.md entries. */
function filterPlanFiles(files: string[]): string[] {
  return files.filter(f => f.endsWith('-PLAN.md') || f === 'PLAN.md');
}

/** Filter a file list to just SUMMARY.md / *-SUMMARY.md entries. */
function filterSummaryFiles(files: string[]): string[] {
  return files.filter(f => f.endsWith('-SUMMARY.md') || f === 'SUMMARY.md');
}

interface PhaseFileStats {
  plans: string[];
  summaries: string[];
  hasResearch: boolean;
  hasContext: boolean;
  hasVerification: boolean;
  hasReviews: boolean;
}

/**
 * Read a phase directory and return counts/flags for common file types.
 */
function getPhaseFileStats(phaseDir: string): PhaseFileStats {
  const files = fs.readdirSync(phaseDir);
  return {
    plans: filterPlanFiles(files),
    summaries: filterSummaryFiles(files),
    hasResearch: files.some(f => f.endsWith('-RESEARCH.md') || f === 'RESEARCH.md'),
    hasContext: findContextMdIn(files) !== null,
    hasVerification: files.some(f => f.endsWith('-VERIFICATION.md') || f === 'VERIFICATION.md'),
    hasReviews: files.some(f => f.endsWith('-REVIEWS.md') || f === 'REVIEWS.md'),
  };
}

/**
 * Read immediate child directories from a path.
 * Returns [] if the path doesn't exist or can't be read.
 * Pass sort=true to apply comparePhaseNum ordering.
 */
function readSubdirectories(dirPath: string, sort = false): string[] {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const dirs = entries.filter(e => e.isDirectory()).map(e => e.name);
    return sort ? dirs.sort((a, b) => comparePhaseNum(a, b)) : dirs;
  } catch {
    return [];
  }
}

/**
 * Format a Date as a fuzzy relative time string (e.g. "5 minutes ago").
 */
function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes === 1) return '1 minute ago';
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours === 1) return '1 hour ago';
  if (hours < 24) return `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return '1 day ago';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months === 1) return '1 month ago';
  if (months < 12) return `${months} months ago`;
  const years = Math.floor(days / 365);
  if (years === 1) return '1 year ago';
  return `${years} years ago`;
}

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
