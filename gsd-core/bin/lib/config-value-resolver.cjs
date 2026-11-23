"use strict";
/**
 * Config Value Resolution Module — per-key precedence with producing-layer provenance.
 * Existing call sites stay on the assembled-object loader; adoption belongs to C3/C4.
 *
 * An unusable layer degrades a key only when that layer could have produced it.
 * A present non-object parent stops every lower layer, including declared defaults. The one
 * exception mirrors the loader's workstream-over-root merge: an object parent in the workstream
 * layer replaces a non-object root parent at the same prefix, so it does not block.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const node_path_1 = __importDefault(require("node:path"));
const configuration_cjs_1 = require("./configuration.cjs");
const runtime_homes_cjs_1 = require("./runtime-homes.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports -- #6030 config-file-read.cjs is an export= CommonJS module
const configFileRead = require("./config-file-read.cjs");
const { readConfigFileBounded } = configFileRead;
const settings_jsonc_cjs_1 = require("./settings-jsonc.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports -- #5096 CJS interop import, as in the sibling config modules
const loader = require("./config-loader.cjs");
const { CONFIG_REASON } = loader;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- #5096 CJS interop import, as in the sibling config modules
const schema = require("./config-schema.cjs");
const { isCentralConfigKey, getCapabilityConfigSchema } = schema;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- #5096 CJS interop import, as in the sibling config modules
const federatedConfig = require("./federated-config.cjs");
const { isWellFormedSlice, typeMatchesSlice } = federatedConfig;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- #5096 CJS interop import, as in the sibling config modules
const coreUtils = require("./core-utils.cjs");
const { detectSubRepos } = coreUtils;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- #5096 CJS interop import, as in the sibling config modules
const schemaDefaults = require("./config-schema-defaults.cjs");
const { resolveSchemaDefault } = schemaDefaults;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- #5096 CJS interop import, as in the sibling config modules
const planning = require("./planning-workspace.cjs");
const { planningDir, planningRoot, resolveEnvWorkstream } = planning;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- #5096 CJS interop import, as in the sibling config modules
const unusableInput = require("./unusable-input.cjs");
const { warnUnusableInput, UNUSABLE_REASON } = unusableInput;
/**
 * Existing merge containers may be queried as wholes even when config-set validates
 * only their dotted children; this does not add accepted configuration keys.
 */
const MERGE_KEYS = Object.freeze({
    effort: ['agent_overrides', 'routing_tier_defaults'],
    model_overrides: [],
    agent_tools: [],
    agent_skills: [],
});
const FAMILY_B_KEYS = new Set(['worktree.baseRef']);
const UNSAFE_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);
/** Read one layer without changing the assembled Config Loader Module. */
function readConfigLayer(file, family, readFile) {
    let raw;
    try {
        // Bounded regular-file read (#5759): a FIFO, device or oversized layer is a fault here, never a
        // blocking open. Migrated readers inherit this guarantee from the resolver. A caller that holds
        // the text already (family B, #6031) supplies its own `readFile`.
        raw = readFile ? readFile(file) : readConfigFileBounded(file);
    }
    catch (err) {
        return { kind: 'fault', fault: {
                reason: CONFIG_REASON.CONFIG_UNREADABLE,
                path: file,
                code: err.code ?? 'EUNKNOWN',
            } };
    }
    if (raw === null)
        return { kind: 'absent' };
    let parsed;
    try {
        parsed = family === 'B' ? (0, settings_jsonc_cjs_1.parseJsonc)(raw) : JSON.parse(raw);
    }
    catch {
        return { kind: 'fault', fault: {
                reason: CONFIG_REASON.CONFIG_UNPARSEABLE,
                path: file,
                code: '',
            } };
    }
    if (!(0, configuration_cjs_1.isConfigSection)(parsed)) {
        return { kind: 'fault', fault: {
                reason: CONFIG_REASON.CONFIG_UNPARSEABLE,
                path: file,
                code: '',
            } };
    }
    return { kind: 'ok', data: parsed };
}
function ownValue(obj, key) {
    let current = obj;
    let objectPrefixes = 0;
    const segments = key.split('.');
    const miss = (blockedAt) => ({ found: false, value: undefined, blockedAt, objectPrefixes });
    for (const [index, segment] of segments.entries()) {
        if (UNSAFE_SEGMENTS.has(segment))
            return miss(0);
        if (!(0, configuration_cjs_1.isConfigSection)(current))
            return miss(index);
        if (!Object.prototype.hasOwnProperty.call(current, segment))
            return miss(0);
        current = current[segment];
        if (index + 1 < segments.length && (0, configuration_cjs_1.isConfigSection)(current))
            objectPrefixes = index + 1;
    }
    return { found: true, value: current, blockedAt: 0, objectPrefixes };
}
function mergeValues(previous, incoming, layer, key, composite) {
    if (!(0, configuration_cjs_1.isConfigSection)(incoming)) {
        for (const leaf of Object.keys(composite))
            delete composite[leaf];
        return { value: incoming, contributed: true };
    }
    let contributed = !(0, configuration_cjs_1.isConfigSection)(previous);
    const result = (0, configuration_cjs_1.isConfigSection)(previous) ? { ...previous } : {};
    const deepFields = MERGE_KEYS[key];
    for (const [field, value] of Object.entries(incoming)) {
        if (UNSAFE_SEGMENTS.has(field))
            continue;
        if (deepFields.includes(field) && (0, configuration_cjs_1.isConfigSection)(value)) {
            const old = (0, configuration_cjs_1.isConfigSection)(result[field]) ? result[field] : {};
            const nested = { ...old };
            if (!(0, configuration_cjs_1.isConfigSection)(result[field])) {
                delete composite[field];
                contributed = true;
            }
            for (const [leaf, nestedValue] of Object.entries(value)) {
                if (UNSAFE_SEGMENTS.has(leaf))
                    continue;
                nested[leaf] = nestedValue;
                composite[`${field}.${leaf}`] = layer;
                contributed = true;
            }
            result[field] = nested;
        }
        else {
            for (const leaf of Object.keys(composite)) {
                if (leaf === field || leaf.startsWith(`${field}.`))
                    delete composite[leaf];
            }
            result[field] = value;
            composite[field] = layer;
            contributed = true;
        }
    }
    return { value: result, contributed };
}
/** A key belongs to exactly one ladder. An explicit family is only an assertion. */
function keyFamily(key, capabilitySchema) {
    if (FAMILY_B_KEYS.has(key))
        return 'B';
    if (Object.prototype.hasOwnProperty.call(MERGE_KEYS, key))
        return 'A';
    if (isCentralConfigKey(key))
        return 'A';
    const registry = capabilitySchema();
    return Object.prototype.hasOwnProperty.call(registry, key) && isWellFormedSlice(registry[key]) ? 'A' : null;
}
/**
 * The files of one ladder, highest first.
 */
function fileLayers(cwd, family, io) {
    if (family === 'A') {
        const result = [];
        const ws = resolveEnvWorkstream();
        if (ws)
            result.push({ layer: 'workstream', file: node_path_1.default.join(planningDir(cwd, ws), 'config.json') });
        result.push({ layer: 'root', file: node_path_1.default.join(ws ? planningRoot(cwd) : planningDir(cwd, null), 'config.json') });
        result.push({ layer: 'global-defaults', file: node_path_1.default.join((0, runtime_homes_cjs_1.resolveGsdHome)(), '.gsd', 'defaults.json') });
        return result;
    }
    const projectDir = node_path_1.default.join(cwd, '.claude');
    const userDir = io && Object.hasOwn(io, 'userDir') ? io.userDir : (0, runtime_homes_cjs_1.getGlobalConfigDir)('claude');
    const result = [
        { layer: 'runtime-local', file: node_path_1.default.join(projectDir, 'settings.local.json') },
        { layer: 'runtime-shared', file: node_path_1.default.join(projectDir, 'settings.json') },
    ];
    if (userDir && node_path_1.default.resolve(userDir) !== node_path_1.default.resolve(projectDir)) {
        result.push({ layer: 'runtime-user', file: node_path_1.default.join(userDir, 'settings.json') });
    }
    return result;
}
/** Resolve one eligible key without ever rewriting a configuration layer. */
function resolveConfigValue(key, opts) {
    // `configSchema` lets a caller that already holds a capability registry snapshot resolve
    // against it; `quiet` keeps a read that must never write to stderr (an activation gate, #5139)
    // from reporting an unusable layer. `honorGlobal` lets a caller that must stay inside what the
    // loader reads from the global defaults file (`honorsGlobalDefaults`) skip that layer for a key
    // outside it. None of the three changes which of the remaining layers wins.
    const warn = opts.quiet === true ? () => false : warnUnusableInput;
    let cachedSchema;
    const capabilitySchema = () => cachedSchema ??= opts.configSchema ?? getCapabilityConfigSchema(opts.cwd);
    const family = keyFamily(key, capabilitySchema);
    const missing = (reason) => ({
        found: false, value: undefined, layer: null, reason,
    });
    if (family === null)
        return missing(CONFIG_REASON.NOT_CONFIGURED);
    if (opts.family && opts.family !== family)
        throw new RangeError(`Config key ${key} belongs to family ${family}`);
    const federatedSlice = family === 'A' && !isCentralConfigKey(key)
        ? capabilitySchema()[key] : null;
    const entries = [];
    const faults = [];
    let emptyFile = false;
    let workstreamMissing = false;
    let blockedByParent = false;
    let workstreamObjectPrefixes = 0;
    const typeMismatchRanks = [];
    let detected;
    const runtimeIo = family === 'B' ? opts.io : undefined;
    const layers = fileLayers(opts.cwd, family, runtimeIo);
    for (const [rank, { layer, file }] of layers.entries()) {
        if (layer === 'global-defaults' && opts.honorGlobal && !opts.honorGlobal(key))
            continue;
        const read = readConfigLayer(file, family, runtimeIo?.readFile);
        if (read.kind === 'fault') {
            faults.push({ rank, fault: read.fault });
            if (layer === 'workstream')
                workstreamMissing = true;
            continue;
        }
        if (read.kind === 'absent') {
            if (layer === 'workstream')
                workstreamMissing = true;
            continue;
        }
        if (Object.keys(read.data).length === 0)
            emptyFile = true;
        const data = family === 'A' ? (0, configuration_cjs_1.normalizeLegacyKeys)(read.data) : null;
        if (data?.skipped.length) {
            warn({ reason: UNUSABLE_REASON.CONFIG_SECTION_NOT_OBJECT, source: file });
        }
        if (data?.normalizations.some((normalization) => normalization.requiresFilesystem)) {
            const planningSection = data.parsed['planning'];
            if (!(0, configuration_cjs_1.isConfigSection)(planningSection) || !planningSection['sub_repos']) {
                detected ??= detectSubRepos(opts.cwd);
                if (detected.length > 0) {
                    const section = (0, configuration_cjs_1.isConfigSection)(planningSection) ? planningSection : {};
                    section['sub_repos'] = detected;
                    section['commit_docs'] = false;
                    data.parsed['planning'] = section;
                }
            }
        }
        const resolved = ownValue(data?.parsed ?? read.data, key);
        if (resolved.found) {
            const typed = opts.valueType === undefined || family !== 'B' || typeof resolved.value === opts.valueType;
            if (typed && (!federatedSlice || (isWellFormedSlice(federatedSlice)
                && typeMatchesSlice(resolved.value, federatedSlice)))) {
                entries.push({ layer, value: resolved.value, rank });
            }
            else {
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
        if (blocked && family === 'B' && opts.valueType !== undefined)
            blocked = false;
        if (blocked && layer === 'root' && resolved.blockedAt <= workstreamObjectPrefixes)
            blocked = false;
        if (layer === 'workstream')
            workstreamObjectPrefixes = resolved.objectPrefixes;
        if (blocked) {
            blockedByParent = true;
            break;
        }
    }
    if (family === 'A' && !blockedByParent) {
        const schemaDefault = resolveSchemaDefault(opts.cwd, key, capabilitySchema);
        if (schemaDefault.found)
            entries.push({ layer: 'schema-default', value: schemaDefault.value, rank: layers.length });
        const builtin = ownValue(configuration_cjs_1.CONFIG_DEFAULTS, key);
        if (builtin.found)
            entries.push({ layer: 'builtin-default', value: builtin.value, rank: layers.length + 1 });
    }
    const mergedKey = Object.prototype.hasOwnProperty.call(MERGE_KEYS, key) ? key : null;
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
    const composite = {};
    let value;
    const highestLayer = entries[0].layer;
    let layer = highestLayer;
    for (const entry of [...entries].reverse()) {
        const merged = mergeValues(value, entry.value, entry.layer, mergedKey, composite);
        value = merged.value;
        if (merged.contributed)
            layer = entry.layer;
    }
    // With no leaves, the highest present container is itself the producing value.
    if ((0, configuration_cjs_1.isConfigSection)(value) && Object.keys(composite).length === 0)
        layer = highestLayer;
    return { found: true, value, layer,
        reason: faultReason ?? mismatchReason ?? (layer === 'root' && workstreamMissing
            ? CONFIG_REASON.WORKSTREAM_FALLBACK : CONFIG_REASON.RESOLVED),
        ...((0, configuration_cjs_1.isConfigSection)(value) ? { composite } : {}) };
}
module.exports = { resolveConfigValue };
