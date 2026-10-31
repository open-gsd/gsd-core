/**
 * Config Value Resolution Module — per-key precedence with producing-layer provenance.
 * Existing call sites stay on the assembled-object loader; adoption belongs to C3/C4.
 *
 * An unusable layer degrades a key only when that layer could have produced it.
 * A present non-object parent stops every lower layer, including declared defaults.
 */

import os from 'node:os';
import path from 'node:path';
import { CONFIG_DEFAULTS, normalizeLegacyKeys, isConfigSection } from './configuration.cjs';
import { getGlobalConfigDir } from './runtime-homes.cjs';
import { platformReadSync } from './shell-command-projection.cjs';
import { parseJsonc } from './settings-jsonc.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import loader = require('./config-loader.cjs');
const { CONFIG_REASON } = loader;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import schema = require('./config-schema.cjs');
const { isCentralConfigKey, getCapabilityConfigSchema } = schema;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import federatedConfig = require('./federated-config.cjs');
const { isWellFormedSlice, typeMatchesSlice } = federatedConfig;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import coreUtils = require('./core-utils.cjs');
const { detectSubRepos } = coreUtils;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import schemaDefaults = require('./config-schema-defaults.cjs');
const { resolveSchemaDefault } = schemaDefaults;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planning = require('./planning-workspace.cjs');
const { planningDir, planningRoot, resolveEnvWorkstream } = planning;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import unusableInput = require('./unusable-input.cjs');
const { warnUnusableInput, UNUSABLE_REASON } = unusableInput;

type ConfigFamily = 'A' | 'B';
type ConfigLayer = 'workstream' | 'root' | 'global-defaults' | 'schema-default' | 'builtin-default'
  | 'runtime-local' | 'runtime-shared' | 'runtime-user';
type ConfigReason = (typeof CONFIG_REASON)[keyof typeof CONFIG_REASON];

type ConfigValueResolution =
  | { found: false; value: undefined; layer: null; reason: ConfigReason }
  | { found: true; value: unknown; layer: ConfigLayer; reason: ConfigReason;
      composite?: Readonly<Record<string, ConfigLayer>> };

/**
 * Existing merge containers may be queried as wholes even when config-set validates
 * only their dotted children; this does not add accepted configuration keys.
 */
const MERGE_KEYS = Object.freeze({
  effort: ['agent_overrides', 'routing_tier_defaults'],
  model_overrides: [],
  agent_tools: [],
  agent_skills: [],
} as const);
type MergeKey = keyof typeof MERGE_KEYS;
const FAMILY_B_KEYS = new Set(['worktree.baseRef']);
const UNSAFE_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

type ConfigFault = { reason: ConfigReason; path: string; code: string };
type LayerRead = { kind: 'ok'; data: Record<string, unknown> }
  | { kind: 'absent' }
  | { kind: 'fault'; fault: ConfigFault };

/** Read one layer without changing the assembled Config Loader Module. */
function readConfigLayer(file: string, family: ConfigFamily): LayerRead {
  let raw: string | null;
  try {
    raw = platformReadSync(file);
  } catch (err) {
    return { kind: 'fault', fault: {
      reason: CONFIG_REASON.CONFIG_UNREADABLE,
      path: file,
      code: (err as NodeJS.ErrnoException).code ?? 'EUNKNOWN',
    } };
  }
  if (raw === null) return { kind: 'absent' };
  let parsed: unknown;
  try {
    parsed = family === 'B' ? parseJsonc(raw) : JSON.parse(raw);
  } catch {
    return { kind: 'fault', fault: {
      reason: CONFIG_REASON.CONFIG_UNPARSEABLE,
      path: file,
      code: '',
    } };
  }
  if (!isConfigSection(parsed)) {
    return { kind: 'fault', fault: {
      reason: CONFIG_REASON.CONFIG_UNPARSEABLE,
      path: file,
      code: '',
    } };
  }
  return { kind: 'ok', data: parsed };
}

function ownValue(obj: unknown, key: string): { found: boolean; value: unknown; blocked: boolean } {
  let current: unknown = obj;
  for (const [index, segment] of key.split('.').entries()) {
    if (UNSAFE_SEGMENTS.has(segment)) return { found: false, value: undefined, blocked: false };
    if (!isConfigSection(current)) {
      return { found: false, value: undefined, blocked: index > 0 };
    }
    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      return { found: false, value: undefined, blocked: false };
    }
    current = current[segment];
  }
  return { found: true, value: current, blocked: false };
}

function mergeValues(
  previous: unknown,
  incoming: unknown,
  layer: ConfigLayer,
  key: MergeKey,
  composite: Record<string, ConfigLayer>,
): { value: unknown; contributed: boolean } {
  if (!isConfigSection(incoming)) {
    for (const leaf of Object.keys(composite)) delete composite[leaf];
    return { value: incoming, contributed: true };
  }
  let contributed = !isConfigSection(previous);
  const result: Record<string, unknown> = isConfigSection(previous) ? { ...previous } : {};
  const deepFields: readonly string[] = MERGE_KEYS[key];
  for (const [field, value] of Object.entries(incoming)) {
    if (UNSAFE_SEGMENTS.has(field)) continue;
    if (deepFields.includes(field) && isConfigSection(value)) {
      const old = isConfigSection(result[field]) ? result[field] : {};
      const nested: Record<string, unknown> = { ...old };
      if (!isConfigSection(result[field])) {
        delete composite[field];
        contributed = true;
      }
      for (const [leaf, nestedValue] of Object.entries(value)) {
        if (UNSAFE_SEGMENTS.has(leaf)) continue;
        nested[leaf] = nestedValue;
        composite[`${field}.${leaf}`] = layer;
        contributed = true;
      }
      result[field] = nested;
    } else {
      for (const leaf of Object.keys(composite)) {
        if (leaf === field || leaf.startsWith(`${field}.`)) delete composite[leaf];
      }
      result[field] = value;
      composite[field] = layer;
      contributed = true;
    }
  }
  return { value: result, contributed };
}

/** A key belongs to exactly one ladder. An explicit family is only an assertion. */
function keyFamily(key: string, capabilitySchema: () => Record<string, unknown>): ConfigFamily | null {
  if (FAMILY_B_KEYS.has(key)) return 'B';
  if (Object.prototype.hasOwnProperty.call(MERGE_KEYS, key)) return 'A';
  if (isCentralConfigKey(key)) return 'A';
  const registry = capabilitySchema();
  return Object.prototype.hasOwnProperty.call(registry, key) && isWellFormedSlice(registry[key]) ? 'A' : null;
}

/**
 * The files of one ladder, highest first.
 */
function fileLayers(cwd: string, family: ConfigFamily): Array<{ layer: ConfigLayer; file: string }> {
  if (family === 'A') {
    const result: Array<{ layer: ConfigLayer; file: string }> = [];
    const ws = resolveEnvWorkstream();
    if (ws) result.push({ layer: 'workstream', file: path.join(planningDir(cwd, ws), 'config.json') });
    result.push({ layer: 'root', file: path.join(ws ? planningRoot(cwd) : planningDir(cwd, null), 'config.json') });
    result.push({ layer: 'global-defaults', file: path.join(process.env['GSD_HOME'] || os.homedir(), '.gsd', 'defaults.json') });
    return result;
  }
  const projectDir = path.join(cwd, '.claude');
  const userDir = getGlobalConfigDir('claude');
  const result: Array<{ layer: ConfigLayer; file: string }> = [
    { layer: 'runtime-local', file: path.join(projectDir, 'settings.local.json') },
    { layer: 'runtime-shared', file: path.join(projectDir, 'settings.json') },
  ];
  if (path.resolve(userDir) !== path.resolve(projectDir)) {
    result.push({ layer: 'runtime-user', file: path.join(userDir, 'settings.json') });
  }
  return result;
}

/** Resolve one eligible key without ever rewriting a configuration layer. */
function resolveConfigValue(
  key: string,
  opts: { cwd: string; family?: ConfigFamily },
): ConfigValueResolution {
  let cachedSchema: Record<string, unknown> | undefined;
  const capabilitySchema = (): Record<string, unknown> =>
    cachedSchema ??= getCapabilityConfigSchema(opts.cwd);
  const family = keyFamily(key, capabilitySchema);
  const missing = (reason: ConfigReason): ConfigValueResolution => ({
    found: false, value: undefined, layer: null, reason,
  });
  if (family === null) return missing(CONFIG_REASON.NOT_CONFIGURED);
  if (opts.family && opts.family !== family) throw new RangeError(`Config key ${key} belongs to family ${family}`);
  const federatedSlice = family === 'A' && !isCentralConfigKey(key)
    ? capabilitySchema()[key] : null;
  const entries: Array<{ layer: ConfigLayer; value: unknown; rank: number }> = [];
  const faults: Array<{ rank: number; fault: ConfigFault }> = [];
  let emptyFile = false;
  let workstreamMissing = false;
  let blockedByParent = false;
  let detected: string[] | undefined;
  const layers = fileLayers(opts.cwd, family);
  for (const [rank, { layer, file }] of layers.entries()) {
    const read = readConfigLayer(file, family);
    if (read.kind === 'fault') {
      faults.push({ rank, fault: read.fault });
      if (layer === 'workstream') workstreamMissing = true;
      continue;
    }
    if (read.kind === 'absent') {
      if (layer === 'workstream') workstreamMissing = true;
      continue;
    }
    if (Object.keys(read.data).length === 0) emptyFile = true;
    const data = family === 'A' ? normalizeLegacyKeys(read.data) : null;
    if (data?.skipped.length) {
      warnUnusableInput({ reason: UNUSABLE_REASON.CONFIG_SECTION_NOT_OBJECT, source: file });
    }
    if (data?.normalizations.some((normalization) => normalization.requiresFilesystem)) {
      const planningSection = data.parsed['planning'];
      if (!isConfigSection(planningSection) || !planningSection['sub_repos']) {
        detected ??= detectSubRepos(opts.cwd);
        if (detected.length > 0) {
          const section = isConfigSection(planningSection) ? planningSection : {};
          section['sub_repos'] = detected;
          section['commit_docs'] = false;
          data.parsed['planning'] = section;
        }
      }
    }
    const resolved = ownValue(data?.parsed ?? read.data, key);
    if (resolved.found && (!federatedSlice || (isWellFormedSlice(federatedSlice)
        && typeMatchesSlice(resolved.value, federatedSlice)))) {
      entries.push({ layer, value: resolved.value, rank });
    }
    if (resolved.blocked) {
      blockedByParent = true;
      break;
    }
  }
  if (family === 'A' && !blockedByParent) {
    const schemaDefault = resolveSchemaDefault(opts.cwd, key, capabilitySchema);
    if (schemaDefault.found) entries.push({ layer: 'schema-default', value: schemaDefault.value, rank: layers.length });
    const builtin = ownValue(CONFIG_DEFAULTS, key);
    if (builtin.found) entries.push({ layer: 'builtin-default', value: builtin.value, rank: layers.length + 1 });
  }
  const mergedKey = Object.prototype.hasOwnProperty.call(MERGE_KEYS, key) ? key as MergeKey : null;
  // An unusable layer degrades this key only if it could have produced it: any layer
  // when nothing was found or for a merge key (its leaves would have joined), otherwise
  // a layer ranked above the winner. A fault below a healthy winner stays silent, as the
  // loader keeps a global-defaults fault silent once a project config parsed.
  const winnerRank = entries.length === 0 || mergedKey !== null ? Infinity : entries[0].rank;
  const relevant = faults.filter(({ rank }) => rank < winnerRank);
  for (const { fault } of relevant) {
    warnUnusableInput({ reason: UNUSABLE_REASON.CONFIG_UNREADABLE, source: fault.path });
  }
  const faultReason = relevant.length > 0 ? relevant[0].fault.reason : null;
  if (entries.length === 0) {
    return missing(faultReason ?? (emptyFile ? CONFIG_REASON.CONFIGURED_EMPTY : CONFIG_REASON.NOT_CONFIGURED));
  }
  if (mergedKey === null) {
    const winner = entries[0];
    return { found: true, value: winner.value, layer: winner.layer,
      reason: faultReason ?? (winner.layer === 'root' && workstreamMissing
        ? CONFIG_REASON.WORKSTREAM_FALLBACK : CONFIG_REASON.RESOLVED) };
  }
  const composite: Record<string, ConfigLayer> = {};
  let value: unknown;
  const highestLayer = entries[0].layer;
  let layer: ConfigLayer = highestLayer;
  for (const entry of [...entries].reverse()) {
    const merged = mergeValues(value, entry.value, entry.layer, mergedKey, composite);
    value = merged.value;
    if (merged.contributed) layer = entry.layer;
  }
  // With no leaves, the highest present container is itself the producing value.
  if (isConfigSection(value) && Object.keys(composite).length === 0) layer = highestLayer;
  return { found: true, value, layer,
    reason: faultReason ?? (layer === 'root' && workstreamMissing
      ? CONFIG_REASON.WORKSTREAM_FALLBACK : CONFIG_REASON.RESOLVED),
    ...(isConfigSection(value) ? { composite } : {}) };
}

export = { resolveConfigValue };
