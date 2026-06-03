/**
 * Configuration Module — single source of truth for config loading,
 * legacy-key normalization, defaults merge, and explicit on-disk migration.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/configuration.cjs collapsed
 * to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only types are added.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// In .cts (CommonJS output) files, `require` is available as a global.
const _require: NodeRequire = require;

// ─── Manifest requires ───────────────────────────────────────────────────────
function loadConfigurationManifest(fileName: string): Record<string, unknown> {
  const candidates = [
    // Installed runtime layout: gsd-core/bin/shared/*.manifest.json
    join(__dirname, '..', 'shared', fileName),
  ];
  let lastErr: Error | null = null;
  for (const candidate of candidates) {
    try {
      return _require(candidate) as Record<string, unknown>;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      const isMissingCandidate =
        e && e.code === 'MODULE_NOT_FOUND' && String(e.message || '').includes(candidate);
      if (!isMissingCandidate) throw err;
      lastErr = e;
    }
  }
  throw new Error(
    `${fileName} not found. Tried:\n${candidates.map((p) => `  ${p}`).join('\n')}\nLast error: ${lastErr?.message}`
  );
}

const CONFIG_DEFAULTS = loadConfigurationManifest('config-defaults.manifest.json');
const SCHEMA_MANIFEST = loadConfigurationManifest('config-schema.manifest.json') as {
  validKeys: string[];
  runtimeStateKeys: string[];
  dynamicKeyPatterns: Array<{ source: string; [k: string]: unknown }>;
};
const VALID_CONFIG_KEYS = new Set<string>(SCHEMA_MANIFEST.validKeys);
const RUNTIME_STATE_KEYS = new Set<string>(SCHEMA_MANIFEST.runtimeStateKeys);

interface DynamicKeyPattern {
  source: string;
  test: (key: string) => boolean;
  [k: string]: unknown;
}

const DYNAMIC_KEY_PATTERNS: DynamicKeyPattern[] = SCHEMA_MANIFEST.dynamicKeyPatterns.map((p) => {
  const pattern = new RegExp(p.source);
  return {
    ...p,
    test: (key: string) => {
      pattern.lastIndex = 0;
      return pattern.test(key);
    },
  };
});

// ─── Depth → Granularity mapping ─────────────────────────────────────────────
const DEPTH_TO_GRANULARITY: Record<string, string> = {
  quick: 'coarse',
  standard: 'standard',
  comprehensive: 'fine',
};

// ─── Internal helpers ─────────────────────────────────────────────────────────
function planningDir(cwd: string, workstream?: string): string {
  if (!workstream)
    return join(cwd, '.planning');
  return join(cwd, '.planning', 'workstreams', workstream);
}

function detectSubRepos(cwd: string): string[] {
  const results: string[] = [];
  try {
    const entries = readdirSync(cwd, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory())
        continue;
      if (entry.name.startsWith('.') || entry.name === 'node_modules')
        continue;
      const gitPath = join(cwd, entry.name, '.git');
      try {
        if (existsSync(gitPath)) {
          results.push(entry.name);
        }
      }
      catch { /* ignore */ }
    }
  }
  catch { /* ignore */ }
  return results.sort();
}

function deepMergeConfig(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const key of Object.keys(overlay)) {
    const ov = overlay[key];
    if (ov !== null && ov !== undefined && typeof ov === 'object' && !Array.isArray(ov)) {
      const bv = base[key];
      if (bv !== null && bv !== undefined && typeof bv === 'object' && !Array.isArray(bv)) {
        result[key] = deepMergeConfig(bv as Record<string, unknown>, ov as Record<string, unknown>);
      }
      else {
        result[key] = deepMergeConfig({}, ov as Record<string, unknown>);
      }
    }
    else {
      result[key] = ov;
    }
  }
  return result;
}

// ─── Exported types ───────────────────────────────────────────────────────────

interface Normalization {
  from: string;
  to: string;
  value: unknown;
  requiresFilesystem?: boolean;
}

interface NormalizeLegacyKeysResult {
  parsed: Record<string, unknown>;
  normalizations: Normalization[];
}

interface LoadConfigOptions {
  workstream?: string;
  onNormalizations?: (normalizations: Normalization[]) => void;
}

interface MigrateOnDiskResult {
  migrated: boolean;
  normalizations: Normalization[];
  wrote: string | null;
}

// ─── Exported functions ───────────────────────────────────────────────────────
function normalizeLegacyKeys(parsed: Record<string, unknown>): NormalizeLegacyKeysResult {
  const result: Record<string, unknown> = { ...parsed };
  const normalizations: Normalization[] = [];
  // 1. branching_strategy → git.branching_strategy
  if (Object.prototype.hasOwnProperty.call(result, 'branching_strategy')) {
    const value = result['branching_strategy'];
    const git = (result['git'] ?? {}) as Record<string, unknown>;
    if (git['branching_strategy'] === undefined) {
      result['git'] = { ...git, branching_strategy: value };
    }
    else {
      // canonical nested wins — just delete the stale top-level
      result['git'] = { ...git };
    }
    delete result['branching_strategy'];
    normalizations.push({ from: 'branching_strategy', to: 'git.branching_strategy', value });
  }
  // 2. top-level sub_repos → planning.sub_repos
  if (Object.prototype.hasOwnProperty.call(result, 'sub_repos')) {
    const value = result['sub_repos'];
    const planning = (result['planning'] ?? {}) as Record<string, unknown>;
    if (planning['sub_repos'] === undefined) {
      result['planning'] = { ...planning, sub_repos: value };
    }
    else {
      // canonical nested wins — just drop the stale top-level
      result['planning'] = { ...planning };
    }
    delete result['sub_repos'];
    normalizations.push({ from: 'sub_repos', to: 'planning.sub_repos', value });
  }
  // 3. multiRepo: true → marker (filesystem detection deferred to migrateOnDisk / caller)
  if (result['multiRepo'] === true) {
    delete result['multiRepo'];
    normalizations.push({ from: 'multiRepo', to: 'planning.sub_repos', value: true, requiresFilesystem: true });
  }
  // 4. top-level depth → granularity
  if (Object.prototype.hasOwnProperty.call(result, 'depth') && !Object.prototype.hasOwnProperty.call(result, 'granularity')) {
    const rawDepth = result['depth'] as string;
    const mapped = DEPTH_TO_GRANULARITY[rawDepth] ?? rawDepth;
    result['granularity'] = mapped;
    delete result['depth'];
    normalizations.push({ from: 'depth', to: 'granularity', value: mapped });
  }
  return { parsed: result, normalizations };
}

function mergeDefaults(parsed: Record<string, unknown>): Record<string, unknown> {
  // Start with a deep clone of defaults, then overlay parsed
  const defaults = structuredClone(CONFIG_DEFAULTS);
  return deepMergeConfig(defaults, parsed);
}

function loadConfig(cwd: string, options?: LoadConfigOptions): Record<string, unknown> {
  const configPath = join(planningDir(cwd, options?.workstream), 'config.json');
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  }
  catch {
    // File missing — return defaults
    return mergeDefaults({});
  }
  const trimmed = raw.trim();
  if (trimmed === '') {
    return mergeDefaults({});
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  }
  catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse config at ${configPath}: ${msg}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Config at ${configPath} must be a JSON object`);
  }
  const { parsed: normalized, normalizations } = normalizeLegacyKeys(parsed as Record<string, unknown>);
  if (options?.onNormalizations && normalizations.length > 0) {
    options.onNormalizations(normalizations);
  }
  return mergeDefaults(normalized);
}

function migrateOnDisk(cwd: string, workstream?: string): MigrateOnDiskResult {
  const configPath = join(planningDir(cwd, workstream), 'config.json');
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  }
  catch {
    // File missing — nothing to migrate
    return { migrated: false, normalizations: [], wrote: null };
  }
  const trimmed = raw.trim();
  if (trimmed === '') {
    return { migrated: false, normalizations: [], wrote: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  }
  catch {
    // Malformed — can't migrate
    return { migrated: false, normalizations: [], wrote: null };
  }
  const { parsed: normalized, normalizations } = normalizeLegacyKeys(parsed as Record<string, unknown>);
  if (normalizations.length === 0) {
    return { migrated: false, normalizations: [], wrote: null };
  }
  // Resolve multiRepo filesystem detection
  const result: Record<string, unknown> = { ...normalized };
  for (const norm of normalizations) {
    if (norm.requiresFilesystem) {
      const detected = detectSubRepos(cwd);
      if (detected.length > 0) {
        const planning = (result['planning'] ?? {}) as Record<string, unknown>;
        result['planning'] = { ...planning, sub_repos: detected, commit_docs: false };
      }
    }
  }
  try {
    writeFileSync(configPath, JSON.stringify(result, null, 2));
  }
  catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to write migrated config at ${configPath}: ${msg}`);
  }
  return { migrated: true, normalizations, wrote: configPath };
}

export {
  loadConfig,
  normalizeLegacyKeys,
  mergeDefaults,
  migrateOnDisk,
  CONFIG_DEFAULTS,
  VALID_CONFIG_KEYS,
  RUNTIME_STATE_KEYS,
  DYNAMIC_KEY_PATTERNS,
};
