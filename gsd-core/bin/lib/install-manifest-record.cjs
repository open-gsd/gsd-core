"use strict";
/**
 * Install manifest per-file hash ownership (#5683).
 *
 * `gsd-file-manifest.json` records `sha256(file bytes)` per installed file,
 * keyed by path relative to the runtime config dir. `effort sync --apply`
 * rewrites installed agents, so it re-records exactly those files here.
 * `bin/install.js` fileHash delegates to this module: one hash function.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.fileHash = fileHash;
exports.tryFileHash = tryFileHash;
exports.recordManifestFileHashes = recordManifestFileHashes;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const node_crypto_1 = require("node:crypto");
const shell_command_projection_cjs_1 = require("./shell-command-projection.cjs");
const MANIFEST_NAME = 'gsd-file-manifest.json';
/** SHA256 (lowercase hex) of a file's bytes — the manifest's per-file hash. */
function fileHash(filePath) {
    return (0, node_crypto_1.createHash)('sha256').update((0, node_fs_1.readFileSync)(filePath)).digest('hex');
}
/** fileHash that returns null instead of throwing — for capturing a pre-rewrite hash. */
function tryFileHash(filePath) {
    try {
        return fileHash(filePath);
    }
    catch {
        return null;
    }
}
/**
 * Update ONLY the manifest entries for `rewritten` files (under `configDir`),
 * and only those that were GSD-owned before the rewrite: `preHash` equal to the
 * recorded manifest entry. A file the user had already edited keeps its stale
 * entry so the next install still detects it and backs it up.
 * Skips silently (returns false) when the manifest is absent, unparseable or
 * not the documented shape; publishes via tmp + rename.
 */
function recordManifestFileHashes(configDir, rewritten) {
    if (rewritten.length === 0)
        return false;
    const manifestPath = (0, node_path_1.join)(configDir, MANIFEST_NAME);
    let manifest;
    try {
        const parsed = JSON.parse((0, node_fs_1.readFileSync)(manifestPath, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            return false;
        manifest = parsed;
    }
    catch {
        return false;
    }
    const files = manifest['files'];
    if (!files || typeof files !== 'object' || Array.isArray(files))
        return false;
    const entries = files;
    let changed = false;
    for (const { path: absPath, preHash } of rewritten) {
        const rel = (0, node_path_1.relative)(configDir, absPath).replace(/\\/g, '/');
        if (rel === '' || rel.startsWith('..') || (0, node_path_1.isAbsolute)(rel))
            continue;
        if (preHash === null || entries[rel] !== preHash)
            continue;
        try {
            entries[rel] = fileHash(absPath);
            changed = true;
        }
        catch { /* unreadable file: leave its entry as recorded */ }
    }
    if (!changed)
        return false;
    const tmpPath = `${manifestPath}.tmp.${process.pid}`;
    try {
        (0, node_fs_1.writeFileSync)(tmpPath, JSON.stringify(manifest, null, 2));
        (0, shell_command_projection_cjs_1.retryRenameSync)(tmpPath, manifestPath);
        return true;
    }
    catch {
        try {
            (0, node_fs_1.unlinkSync)(tmpPath);
        }
        catch { /* already gone or never created */ }
        return false;
    }
}
