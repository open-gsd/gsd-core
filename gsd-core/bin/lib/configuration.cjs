"use strict";
/**
 * Configuration Module — legacy-key normalization, defaults merge, and explicit
 * on-disk migration. Pure normalization primitives consumed by config-loader.cjs
 * and config-schema.cjs. `loadConfig` was extracted to config-loader.cjs per
 * ADR-857 phase 2e (#885) and removed from this module per #893.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/configuration.cjs collapsed
 * to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only types are added.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DYNAMIC_KEY_PATTERNS = exports.RUNTIME_STATE_KEYS = exports.VALID_CONFIG_KEYS = exports.CONFIG_DEFAULTS = void 0;
exports.normalizeLegacyKeys = normalizeLegacyKeys;
exports.mergeDefaults = mergeDefaults;
exports.migrateOnDisk = migrateOnDisk;
exports.isConfigSection = isConfigSection;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
// ⚠️ DO NOT add a sibling `.cjs` import to this module. `configuration.cjs` must load
// from an install layout containing ONLY itself plus `bin/shared/*.manifest.json` —
// that is the #3571 contract, pinned by "co-located bin/shared manifests let
// configuration.cjs load without sdk/shared" in tests/install.test.cjs. A `require`
// for a sibling that the installer does not co-locate fails at load time with
// MODULE_NOT_FOUND. This is why #3760's out-of-band diagnostic is emitted by this
// module's CALLERS (`cmdMigrateConfig` in config.cts, `loadConfigResolved` in
// config-loader.cts) rather than here: `normalizeLegacyKeys` reports refusals
// in-band via `skipped[]`, which keeps it both pure AND dependency-free.
// In .cts (CommonJS output) files, `require` is available as a global.
const _require = require;
// ─── Manifest requires ───────────────────────────────────────────────────────
function loadConfigurationManifest(fileName) {
    const candidates = [
        // Installed runtime layout: gsd-core/bin/shared/*.manifest.json
        (0, node_path_1.join)(__dirname, '..', 'shared', fileName),
    ];
    let lastErr = null;
    for (const candidate of candidates) {
        try {
            return _require(candidate);
        }
        catch (err) {
            const e = err;
            const isMissingCandidate = e && e.code === 'MODULE_NOT_FOUND' && String(e.message || '').includes(candidate);
            if (!isMissingCandidate)
                throw err;
            lastErr = e;
        }
    }
    throw new Error(`${fileName} not found. Tried:\n${candidates.map((p) => `  ${p}`).join('\n')}\nLast error: ${lastErr?.message}`);
}
const CONFIG_DEFAULTS = loadConfigurationManifest('config-defaults.manifest.json');
exports.CONFIG_DEFAULTS = CONFIG_DEFAULTS;
const SCHEMA_MANIFEST = loadConfigurationManifest('config-schema.manifest.json');
const VALID_CONFIG_KEYS = new Set(SCHEMA_MANIFEST.validKeys);
exports.VALID_CONFIG_KEYS = VALID_CONFIG_KEYS;
const RUNTIME_STATE_KEYS = new Set(SCHEMA_MANIFEST.runtimeStateKeys);
exports.RUNTIME_STATE_KEYS = RUNTIME_STATE_KEYS;
const DYNAMIC_KEY_PATTERNS = SCHEMA_MANIFEST.dynamicKeyPatterns.map((p) => {
    const pattern = new RegExp(p.source);
    return {
        ...p,
        test: (key) => {
            pattern.lastIndex = 0;
            return pattern.test(key);
        },
    };
});
exports.DYNAMIC_KEY_PATTERNS = DYNAMIC_KEY_PATTERNS;
// ─── Depth → Granularity mapping ─────────────────────────────────────────────
const DEPTH_TO_GRANULARITY = {
    quick: 'coarse',
    standard: 'standard',
    comprehensive: 'fine',
};
// ─── Internal helpers ─────────────────────────────────────────────────────────
function planningDir(cwd, workstream) {
    if (!workstream)
        return (0, node_path_1.join)(cwd, '.planning');
    return (0, node_path_1.join)(cwd, '.planning', 'workstreams', workstream);
}
function detectSubRepos(cwd) {
    const results = [];
    try {
        const entries = (0, node_fs_1.readdirSync)(cwd, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory())
                continue;
            if (entry.name.startsWith('.') || entry.name === 'node_modules')
                continue;
            const gitPath = (0, node_path_1.join)(cwd, entry.name, '.git');
            try {
                if ((0, node_fs_1.existsSync)(gitPath)) {
                    results.push(entry.name);
                }
            }
            catch { /* ignore */ }
        }
    }
    catch { /* ignore */ }
    return results.sort();
}
function deepMergeConfig(base, overlay) {
    const result = { ...base };
    for (const key of Object.keys(overlay)) {
        const ov = overlay[key];
        if (ov !== null && ov !== undefined && typeof ov === 'object' && !Array.isArray(ov)) {
            const bv = base[key];
            if (bv !== null && bv !== undefined && typeof bv === 'object' && !Array.isArray(bv)) {
                result[key] = deepMergeConfig(bv, ov);
            }
            else {
                result[key] = deepMergeConfig({}, ov);
            }
        }
        else {
            result[key] = ov;
        }
    }
    return result;
}
/** Type name for a report — `'array'` for arrays, otherwise `typeof`. */
function describeSectionType(value) {
    return Array.isArray(value) ? 'array' : typeof value;
}
/**
 * Is `value` usable as a config SECTION — something a nested key can be written into?
 *
 * Three cases, and the distinction between the second and third is the whole of #3760:
 *
 *  - `null` / `undefined` — ABSENT. Not a section yet, but nothing is lost by creating one.
 *    Callers substitute `{}`; this predicate reports `false` and callers check for absence
 *    separately, so the two are never conflated.
 *  - a non-null, non-array `object` — a SECTION. Spreading it is safe and correct.
 *  - anything else (string, number, boolean, array) — a PRESENT NON-OBJECT, i.e. user data
 *    that a spread would destroy. `{...'main'}` is `{0:'m',1:'a',2:'i',3:'n'}`; `{...7}` is
 *    `{}`. An array is included here because `typeof [] === 'object'` and `{...['a']}` is
 *    `{0:'a'}` — the identical expansion a bare `typeof` guard would wave through.
 *
 * This is the nested-section analog of the top-level shape check ADR-227 already requires
 * in `_readConfigFile` (`config-loader.cts`): valid JSON is not the same as a config object.
 * It lives here, exported, rather than being copied into `config-loader.cts`, because two
 * hand-rolled copies of one predicate is `DEFECT.GENERATIVE-FIX` by construction — the same
 * reasoning that made `unusable-input.cts` a shared seam.
 */
function isConfigSection(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
// ─── Exported functions ───────────────────────────────────────────────────────
/**
 * Hoist a legacy top-level key into its canonical nested section.
 *
 * Refuses — and reports the refusal — when the destination section is present but is not an
 * object. Refusing means leaving BOTH the section and the legacy key exactly as they were and
 * pushing no `Normalization`, so this block never marks the config dirty and nothing it
 * touched can be written back. That is the #3760 contract: never expand, never drop, never
 * persist a shape the user did not write.
 */
function hoistLegacyKey(result, normalizations, skipped, legacyKey, section, field) {
    const raw = result[section];
    // `null`/`undefined` mean "no section yet" and have always been treated as absent here.
    // They carry no user data, so creating the section loses nothing.
    const absent = raw === null || raw === undefined;
    if (!absent && !isConfigSection(raw)) {
        skipped.push({
            from: legacyKey,
            to: `${section}.${field}`,
            section,
            reason: 'non_object_section',
            value: result[legacyKey],
            sectionType: describeSectionType(raw),
        });
        return;
    }
    // `raw` is already narrowed by the isConfigSection guard above.
    const existing = absent ? {} : raw;
    const value = result[legacyKey];
    // Canonical nested wins when it is already set; otherwise the legacy value is hoisted.
    result[section] = existing[field] === undefined
        ? { ...existing, [field]: value }
        : { ...existing };
    delete result[legacyKey];
    normalizations.push({ from: legacyKey, to: `${section}.${field}`, value });
}
function normalizeLegacyKeys(parsed) {
    const result = { ...parsed };
    const normalizations = [];
    const skipped = [];
    // 1. branching_strategy → git.branching_strategy
    if (Object.prototype.hasOwnProperty.call(result, 'branching_strategy')) {
        hoistLegacyKey(result, normalizations, skipped, 'branching_strategy', 'git', 'branching_strategy');
    }
    // 2. top-level sub_repos → planning.sub_repos
    if (Object.prototype.hasOwnProperty.call(result, 'sub_repos')) {
        hoistLegacyKey(result, normalizations, skipped, 'sub_repos', 'planning', 'sub_repos');
    }
    // 3. multiRepo: true → marker (filesystem detection deferred to migrateOnDisk / caller)
    if (result['multiRepo'] === true) {
        // #3760: refuse here too, for the same reason as blocks 1 and 2 — and it must be
        // decided HERE, not in the caller. The caller is the one that runs filesystem
        // detection, but whether `planning` can receive the result is knowable from the
        // parsed config alone. Deciding it later meant `multiRepo` had already been
        // deleted and a Normalization already pushed: the config was written, the
        // sub_repos injection silently no-opped against the non-object section, and the
        // user's `multiRepo: true` was consumed with nothing to show for it and no
        // diagnostic. Refusing here keeps the marker, keeps the config clean of a
        // migration that did not happen, and gives all three callers the same report.
        const planning = result['planning'];
        if (planning !== null && planning !== undefined && !isConfigSection(planning)) {
            skipped.push({
                from: 'multiRepo',
                to: 'planning.sub_repos',
                section: 'planning',
                reason: 'non_object_section',
                value: true,
                sectionType: describeSectionType(planning),
            });
        }
        else {
            delete result['multiRepo'];
            normalizations.push({ from: 'multiRepo', to: 'planning.sub_repos', value: true, requiresFilesystem: true });
        }
    }
    // 4. top-level depth → granularity
    if (Object.prototype.hasOwnProperty.call(result, 'depth') && !Object.prototype.hasOwnProperty.call(result, 'granularity')) {
        const rawDepth = result['depth'];
        const mapped = DEPTH_TO_GRANULARITY[rawDepth] ?? rawDepth;
        result['granularity'] = mapped;
        delete result['depth'];
        normalizations.push({ from: 'depth', to: 'granularity', value: mapped });
    }
    // 5. top-level base_branch → git.base_branch
    if (Object.prototype.hasOwnProperty.call(result, 'base_branch')) {
        hoistLegacyKey(result, normalizations, skipped, 'base_branch', 'git', 'base_branch');
    }
    return { parsed: result, normalizations, skipped };
}
function mergeDefaults(parsed) {
    // Start with a deep clone of defaults, then overlay parsed
    const defaults = structuredClone(CONFIG_DEFAULTS);
    return deepMergeConfig(defaults, parsed);
}
/**
 * Largest config.json migrateOnDisk will read — the same 1 MiB bound as CONFIG_MAX_BYTES in
 * config-file-read.cts (#5759). Inlined, not imported: this module may not import a sibling
 * (the #3571 contract above). A test pins that the two bounds agree.
 */
const CONFIG_READ_MAX_BYTES = 1024 * 1024;
/**
 * Read a config.json as a bounded regular file (#5759): non-blocking open, fstat on the
 * descriptor, regular files up to CONFIG_READ_MAX_BYTES only. A FIFO/device would otherwise
 * block open(2) forever. Throws on anything unreadable (ENOENT included); migrateOnDisk
 * treats every throw as "nothing to migrate".
 */
function readConfigBounded(filePath) {
    const fd = (0, node_fs_1.openSync)(filePath, node_fs_1.constants.O_RDONLY | (node_fs_1.constants.O_NONBLOCK ?? 0) | (node_fs_1.constants.O_NOCTTY ?? 0));
    try {
        const st = (0, node_fs_1.fstatSync)(fd);
        if (!st.isFile()) {
            throw Object.assign(new Error(`${filePath} is not a regular file`), { code: st.isDirectory() ? 'EISDIR' : 'ENXIO' });
        }
        if (st.size > CONFIG_READ_MAX_BYTES) {
            throw Object.assign(new Error(`${filePath} exceeds ${CONFIG_READ_MAX_BYTES} bytes`), { code: 'EFBIG' });
        }
        const buf = Buffer.allocUnsafe(st.size);
        let off = 0;
        while (off < st.size) {
            const n = (0, node_fs_1.readSync)(fd, buf, off, st.size - off, off);
            if (n <= 0)
                break;
            off += n;
        }
        return buf.toString('utf-8', 0, off);
    }
    finally {
        try {
            (0, node_fs_1.closeSync)(fd);
        }
        catch { /* best-effort */ }
    }
}
function migrateOnDisk(cwd, workstream, configPathOverride) {
    // #3749: the caller (cmdMigrateConfig in config.cts) supplies the config
    // path resolved through planning-workspace's PROJECT-aware planningDir.
    // This module cannot import that sibling (#3571 install-layout contract),
    // and its own local planningDir above is deliberately workstream-only —
    // resolving here through the local copy made migrate-config under
    // GSD_PROJECT rewrite the ROOT config instead of the scoped one.
    const configPath = configPathOverride ?? (0, node_path_1.join)(planningDir(cwd, workstream), 'config.json');
    let raw;
    try {
        raw = readConfigBounded(configPath);
    }
    catch {
        // File missing, unreadable, non-regular or oversized — nothing to migrate
        return { migrated: false, normalizations: [], wrote: null, skipped: [] };
    }
    const trimmed = raw.trim();
    if (trimmed === '') {
        return { migrated: false, normalizations: [], wrote: null, skipped: [] };
    }
    let parsed;
    try {
        parsed = JSON.parse(trimmed);
    }
    catch {
        // Malformed — can't migrate
        return { migrated: false, normalizations: [], wrote: null, skipped: [] };
    }
    const { parsed: normalized, normalizations, skipped } = normalizeLegacyKeys(parsed);
    // Resolve multiRepo filesystem detection
    const result = { ...normalized };
    for (const norm of normalizations) {
        if (norm.requiresFilesystem) {
            const detected = detectSubRepos(cwd);
            if (detected.length > 0) {
                // #3760: `requiresFilesystem` is pushed by block 3 only when `planning` was
                // absent or an object, and nothing between there and here changes it — so
                // `isConfigSection` picks between merge and create, and never has to discard.
                const planning = result['planning'];
                const existing = isConfigSection(planning) ? planning : {};
                result['planning'] = { ...existing, sub_repos: detected, commit_docs: false };
            }
        }
    }
    if (normalizations.length === 0) {
        // Nothing changed — and that now includes the case where every legacy key was
        // REFUSED. Returning early here is what keeps the corrupted-section input from
        // reaching writeFileSync at all.
        return { migrated: false, normalizations: [], wrote: null, skipped };
    }
    try {
        (0, node_fs_1.writeFileSync)(configPath, JSON.stringify(result, null, 2));
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to write migrated config at ${configPath}: ${msg}`);
    }
    return { migrated: true, normalizations, wrote: configPath, skipped };
}
