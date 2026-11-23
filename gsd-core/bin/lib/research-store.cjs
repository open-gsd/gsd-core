"use strict";
/**
 * Research Store Module
 *
 * Provides deterministic cache key generation, TTL policy, path resolution,
 * and JSON-backed put/get operations for research entries.
 *
 * ADR-457 build-at-publish: authored as TypeScript .cts → emits .cjs via tsc.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const node_crypto_1 = __importDefault(require("node:crypto"));
const shell_command_projection_cjs_1 = require("./shell-command-projection.cjs");
// ADR-4650 decision 6: lexical family — the key is validated before
// `fs.mkdirSync` creates the store dir, so the candidate legitimately does
// not exist yet at check time.
const security_cjs_1 = require("./security.cjs");
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const DAY_MS = 86_400_000;
// ---------------------------------------------------------------------------
// researchKey
// ---------------------------------------------------------------------------
function normalize(x) {
    if (x === null || x === undefined)
        return '';
    if (typeof x === 'object')
        return JSON.stringify(x).trim().toLowerCase();
    // After excluding null, undefined, and object, x can only be a primitive —
    // cast through number | string | boolean to avoid no-base-to-string on unknown.
    return `${x}`.trim().toLowerCase();
}
function researchKey(input) {
    const parts = {
        ecosystem: normalize(input.ecosystem),
        library: normalize(input.library),
        version: normalize(input.version),
        query: normalize(input.query),
        kind: normalize(input.kind),
    };
    const serialized = JSON.stringify(parts);
    return node_crypto_1.default.createHash('sha256').update(serialized).digest('hex');
}
// ---------------------------------------------------------------------------
// ttlForSource
// ---------------------------------------------------------------------------
function ttlForSource(source, confidence) {
    if (source === 'curated' && confidence === 'HIGH')
        return 30 * DAY_MS;
    if (source === 'curated' && confidence === 'MEDIUM')
        return 7 * DAY_MS;
    return DAY_MS;
}
// ---------------------------------------------------------------------------
// tierForSource / resolveStorePath
// ---------------------------------------------------------------------------
const CURATED_SOURCES = new Set(['curated']);
function tierForSource(source) {
    return CURATED_SOURCES.has(source) ? 'user' : 'project';
}
function resolveStorePath(cwd, source, { homeDir = node_os_1.default.homedir() } = {}) {
    if (tierForSource(source) === 'user') {
        return node_path_1.default.join(homeDir, '.gsd', 'research-cache');
    }
    return node_path_1.default.join(cwd, '.planning', 'research', '.cache');
}
// ---------------------------------------------------------------------------
// isValidResearchKey
// ---------------------------------------------------------------------------
/**
 * Returns true iff key is a valid 64-character lowercase hexadecimal SHA-256
 * string (the exact shape produced by researchKey).  Any other shape —
 * including path-traversal sequences — is rejected.
 */
function isValidResearchKey(key) {
    return typeof key === 'string' && /^[0-9a-f]{64}$/.test(key);
}
// ---------------------------------------------------------------------------
// putResearch
// ---------------------------------------------------------------------------
function putResearch(cwd, key, payload, { clock = Date, homeDir = node_os_1.default.homedir() } = {}) {
    // Defense-in-depth: reject any key that is not a 64-char sha256 hex string.
    if (!isValidResearchKey(key)) {
        throw new Error('invalid research key');
    }
    const { content, source, provider, confidence, kind, version } = payload;
    let ttl = ttlForSource(source, confidence);
    // Cap TTL when version is blank/missing — a versionless curated entry must not
    // get the long 30-day window since we can't know if it's still current.
    if (!version) {
        ttl = Math.min(ttl, DAY_MS);
    }
    const fetched_at = new Date(clock.now()).toISOString();
    const entry = { content, source, provider, confidence, fetched_at, ttl, kind };
    const dir = resolveStorePath(cwd, source, { homeDir });
    const containedFile = (0, security_cjs_1.tryWithinRootLexical)(`${key}.json`, dir);
    if (containedFile === null || containedFile === node_path_1.default.resolve(dir)) {
        throw new Error('invalid research key');
    }
    node_fs_1.default.mkdirSync(dir, { recursive: true });
    (0, shell_command_projection_cjs_1.platformWriteSync)(containedFile, JSON.stringify(entry));
    return entry;
}
// ---------------------------------------------------------------------------
// getResearch
// ---------------------------------------------------------------------------
function getResearch(cwd, key, { clock = Date, homeDir = node_os_1.default.homedir() } = {}) {
    // Defense-in-depth: reject any key that is not a 64-char sha256 hex string.
    if (!isValidResearchKey(key)) {
        return { hit: false, stale: false, entry: null };
    }
    try {
        // Search both physical tiers: user (curated) and project (web/etc.)
        const userDir = node_path_1.default.join(homeDir, '.gsd', 'research-cache');
        const projectDir = node_path_1.default.join(cwd, '.planning', 'research', '.cache');
        const tierDirs = [userDir, projectDir];
        const candidates = [];
        for (const dir of tierDirs) {
            const containedFile = (0, security_cjs_1.tryWithinRootLexical)(`${key}.json`, dir);
            if (containedFile === null || containedFile === node_path_1.default.resolve(dir))
                continue;
            if (!node_fs_1.default.existsSync(containedFile))
                continue;
            let entry;
            try {
                entry = JSON.parse(node_fs_1.default.readFileSync(containedFile, 'utf8'));
            }
            catch {
                // Corrupt file in this tier — skip it
                continue;
            }
            // Finding 3: validate entry metadata shape before accepting as a candidate.
            // An entry with missing/invalid fetched_at or ttl must be treated as a miss.
            const parsedFetchedAt = Date.parse(entry.fetched_at);
            if (!Number.isFinite(parsedFetchedAt))
                continue;
            if (typeof entry.ttl !== 'number' ||
                !Number.isFinite(entry.ttl) ||
                entry.ttl <= 0)
                continue;
            const age = clock.now() - parsedFetchedAt;
            const stale = age > entry.ttl;
            candidates.push({ entry, stale, age });
        }
        if (candidates.length === 0) {
            return { hit: false, stale: false, entry: null };
        }
        // Prefer: non-stale over stale; among same-staleness, lowest age (most recent)
        candidates.sort((a, b) => {
            if (a.stale !== b.stale)
                return a.stale ? 1 : -1; // non-stale first
            return a.age - b.age; // lower age (more recent) first
        });
        const best = candidates[0];
        return { hit: true, stale: best.stale, entry: best.entry };
    }
    catch {
        return { hit: false, stale: false, entry: null };
    }
}
module.exports = { isValidResearchKey, researchKey, ttlForSource, tierForSource, resolveStorePath, putResearch, getResearch };
