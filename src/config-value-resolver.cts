/**
 * Config Value Resolution Module — per-key precedence with producing-layer provenance.
 * Existing call sites stay on the assembled-object loader; adoption belongs to C3/C4.
 *
 * An unusable layer degrades a key only when that layer could have produced it.
 * A present non-object parent stops every lower layer, including declared defaults. The one
 * exception mirrors the loader's workstream-over-root merge: an object parent in the workstream
 * layer replaces a non-object root parent at the same prefix, so it does not block.
 */

import path from 'node:path';
import { CONFIG_DEFAULTS, normalizeLegacyKeys, isConfigSection } from './configuration.cjs';
import { getGlobalConfigDir, resolveGsdHome } from './runtime-homes.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- #6030 config-file-read.cjs is an export= CommonJS module
import configFileRead = require('./config-file-read.cjs');
const { readConfigFileBounded } = configFileRead;
import { parseJsonc } from './settings-jsonc.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- #5096 CJS interop import, as in the sibling config modules
import loader = require('./config-loader.cjs');
const { CONFIG_REASON, isUnreadGlobalDefault } = loader;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- #5096 CJS interop import, as in the sibling config modules
import schema = require('./config-schema.cjs');
const { isCentralConfigKey, getCapabilityConfigSchema } = schema;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- #5096 CJS interop import, as in the sibling config modules
import federatedConfig = require('./federated-config.cjs');
const { isWellFormedSlice, typeMatchesSlice } = federatedConfig;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- #5096 CJS interop import, as in the sibling config modules
import coreUtils = require('./core-utils.cjs');
const { detectSubRepos } = coreUtils;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- #5096 CJS interop import, as in the sibling config modules
import schemaDefaults = require('./config-schema-defaults.cjs');
const { resolveSchemaDefault } = schemaDefaults;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- #5096 CJS interop import, as in the sibling config modules
import planning = require('./planning-workspace.cjs');
const { planningDir, planningRoot, resolveEnvWorkstream } = planning;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- #5096 CJS interop import, as in the sibling config modules
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

/**
 * Family-B file access for callers that hold the settings text already or must name the user
 * directory (#6031): `readFile` returns the text, or null for an absent file; `userDir` set to
 * null drops the user layer. Family A never takes it.
 */
type RuntimeIo = { readFile?: (file: string) => string | null; userDir?: string | null };

/** Read one layer without changing the assembled Config Loader Module. */
function readConfigLayer(file: string, family: ConfigFamily, readFile?: (file: string) => string | null): LayerRead {
  let raw: string | null;
  try {
    // Bounded regular-file read (#5759): a FIFO, device or oversized layer is a fault here, never a
    // blocking open. Migrated readers inherit this guarantee from the resolver. A caller that holds
    // the text already (family B, #6031) supplies its own `readFile`.
    raw = readFile ? readFile(file) : readConfigFileBounded(file);
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

/**
 * Own-property walk of a dotted key through one layer. `blockedAt` is the length of the
 * dotted prefix whose present value is not an object (0 when nothing blocks the walk), and
 * `objectPrefixes` is how many leading prefixes this layer holds as objects.
 */
type OwnValue = { found: boolean; value: unknown; blockedAt: number; objectPrefixes: number };

function ownValue(obj: unknown, key: string): OwnValue {
  let current: unknown = obj;
  let objectPrefixes = 0;
  const segments = key.split('.');
  const miss = (blockedAt: number): OwnValue => ({ found: false, value: undefined, blockedAt, objectPrefixes });
  for (const [index, segment] of segments.entries()) {
    if (UNSAFE_SEGMENTS.has(segment)) return miss(0);
    if (!isConfigSection(current)) return miss(index);
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return miss(0);
    current = current[segment];
    if (index + 1 < segments.length && isConfigSection(current)) objectPrefixes = index + 1;
  }
  return { found: true, value: current, blockedAt: 0, objectPrefixes };
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
function fileLayers(cwd: string, family: ConfigFamily, io?: RuntimeIo): Array<{ layer: ConfigLayer; file: string }> {
  if (family === 'A') {
    const result: Array<{ layer: ConfigLayer; file: string }> = [];
    const ws = resolveEnvWorkstream();
    if (ws) result.push({ layer: 'workstream', file: path.join(planningDir(cwd, ws), 'config.json') });
    result.push({ layer: 'root', file: path.join(ws ? planningRoot(cwd) : planningDir(cwd, null), 'config.json') });
    result.push({ layer: 'global-defaults', file: path.join(resolveGsdHome(), '.gsd', 'defaults.json') });
    return result;
  }
  const projectDir = path.join(cwd, '.claude');
  const userDir = io && Object.hasOwn(io, 'userDir') ? io.userDir : getGlobalConfigDir('claude');
  const result: Array<{ layer: ConfigLayer; file: string }> = [
    { layer: 'runtime-local', file: path.join(projectDir, 'settings.local.json') },
    { layer: 'runtime-shared', file: path.join(projectDir, 'settings.json') },
  ];
  if (userDir && path.resolve(userDir) !== path.resolve(projectDir)) {
    result.push({ layer: 'runtime-user', file: path.join(userDir, 'settings.json') });
  }
  return result;
}

/** Resolve one eligible key without ever rewriting a configuration layer. */
function resolveConfigValue(
  key: string,
  opts: {
    cwd: string;
    family?: ConfigFamily;
    configSchema?: Record<string, unknown>;
    quiet?: boolean;
    honorGlobal?: (key: string) => boolean;
    /** Family B only: a layer whose value is not of this type is skipped as a type mismatch (#6031). */
    valueType?: 'string';
    io?: RuntimeIo;
    /**
     * A key no family declares still resolves over the family-A FILE layers (workstream, root and,
     * when `honorGlobal` allows, global defaults) with no schema or built-in default and no
     * federated type check (#6032). The activation gate reads switches a capability registry may
     * not declare; this keeps that read inside the one precedence implementation.
     */
    allowUndeclared?: boolean;
  },
): ConfigValueResolution {
  // `configSchema` lets a caller that already holds a capability registry snapshot resolve
  // against it; `quiet` keeps a read that must never write to stderr (an activation gate, #5139)
  // from reporting an unusable layer. `honorGlobal` lets a caller that must stay inside what the
  // loader reads from the global defaults file (`honorsGlobalDefaults`) skip that layer for a key
  // outside it. None of the three changes which of the remaining layers wins.
  const warn: typeof warnUnusableInput = opts.quiet === true ? () => false : warnUnusableInput;
  let cachedSchema: Record<string, unknown> | undefined;
  const capabilitySchema = (): Record<string, unknown> =>
    cachedSchema ??= opts.configSchema ?? getCapabilityConfigSchema(opts.cwd);
  const declaredFamily = keyFamily(key, capabilitySchema);
  const family = declaredFamily ?? (opts.allowUndeclared === true ? 'A' : null);
  const missing = (reason: ConfigReason): ConfigValueResolution => ({
    found: false, value: undefined, layer: null, reason,
  });
  if (family === null) return missing(CONFIG_REASON.NOT_CONFIGURED);
  if (opts.family && opts.family !== family) throw new RangeError(`Config key ${key} belongs to family ${family}`);
  const federatedSlice = declaredFamily === 'A' && !isCentralConfigKey(key)
    ? capabilitySchema()[key] : null;
  const entries: Array<{ layer: ConfigLayer; value: unknown; rank: number }> = [];
  const faults: Array<{ rank: number; fault: ConfigFault }> = [];
  let emptyFile = false;
  let workstreamMissing = false;
  let blockedByParent = false;
  let workstreamObjectPrefixes = 0;
  const typeMismatchRanks: number[] = [];
  let detected: string[] | undefined;
  const runtimeIo = family === 'B' ? opts.io : undefined;
  const layers = fileLayers(opts.cwd, family, runtimeIo);
  for (const [rank, { layer, file }] of layers.entries()) {
    if (layer === 'global-defaults' && opts.honorGlobal && !opts.honorGlobal(key)) continue;
    const read = readConfigLayer(file, family, runtimeIo?.readFile);
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
      warn({ reason: UNUSABLE_REASON.CONFIG_SECTION_NOT_OBJECT, source: file });
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
    if (resolved.found) {
      const typed = opts.valueType === undefined || family !== 'B' || typeof resolved.value === opts.valueType;
      // A store value the loader's global layer reads as no setting is skipped here as well (#5681).
      const unread = layer === 'global-defaults' && isUnreadGlobalDefault(key, resolved.value);
      if (typed && !unread && (!federatedSlice || (isWellFormedSlice(federatedSlice)
          && typeMatchesSlice(resolved.value, federatedSlice)))) {
        entries.push({ layer, value: resolved.value, rank });
      } else {
        typeMismatchRanks.push(rank);
      }
    }
    // The loader merges workstream over root with `_deepMergeConfig`, which replaces a
    // non-object root parent by an object workstream parent. An object parent held by the
    // workstream therefore outranks a root non-object at the same prefix; no other layer
    // pair is merged by the loader, so no other pair gets this rule.
    let blocked = resolved.blockedAt > 0;
    // A typed family-B read (#6031) keeps the bare-string cascade it replaces: a layer whose
    // `worktree` parent is not an object is skipped, not a barrier to the layers below.
    if (blocked && family === 'B' && opts.valueType !== undefined) blocked = false;
    if (blocked && layer === 'root' && resolved.blockedAt <= workstreamObjectPrefixes) blocked = false;
    if (layer === 'workstream') workstreamObjectPrefixes = resolved.objectPrefixes;
    if (blocked) {
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
  const hasRelevantTypeMismatch = typeMismatchRanks.some((rank) => rank < winnerRank);
  for (const { fault } of relevant) {
    warn({ reason: UNUSABLE_REASON.CONFIG_UNREADABLE, source: fault.path });
  }
  const faultReason = relevant.length > 0 ? relevant[0].fault.reason : null;
  const mismatchReason = hasRelevantTypeMismatch ? CONFIG_REASON.CONFIG_TYPE_MISMATCH : null;
  if (entries.length === 0) {
    return missing(faultReason ?? mismatchReason
      ?? (emptyFile ? CONFIG_REASON.CONFIGURED_EMPTY : CONFIG_REASON.NOT_CONFIGURED));
  }
  if (mergedKey === null) {
    const winner = entries[0];
    return { found: true, value: winner.value, layer: winner.layer,
      reason: faultReason ?? mismatchReason ?? (winner.layer === 'root' && workstreamMissing
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
    reason: faultReason ?? mismatchReason ?? (layer === 'root' && workstreamMissing
      ? CONFIG_REASON.WORKSTREAM_FALLBACK : CONFIG_REASON.RESOLVED),
    ...(isConfigSection(value) ? { composite } : {}) };
}

export = { resolveConfigValue };
