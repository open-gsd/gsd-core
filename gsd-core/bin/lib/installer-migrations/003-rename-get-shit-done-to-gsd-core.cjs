"use strict";
/**
 * Installer migration 003: remove stale legacy get-shit-done/ runtime directory // gsd-allow-legacy-name
 * files after the rename to gsd-core/ (#604).
 *
 * Background: the GSD runtime config subdirectory was renamed from
 * get-shit-done/ to gsd-core/ in #604. On upgrade, both directories can exist // gsd-allow-legacy-name
 * simultaneously. This migration removes prior-manifest-managed files from the
 * legacy get-shit-done/ directory during install. Migrations run BEFORE the new // gsd-allow-legacy-name
 * runtime is materialized, so gsd-core/ will not yet exist on the first upgrade
 * run — the migration must not gate on its presence. If the install fails after
 * migrations apply, the framework rolls back by restoring files from rollback
 * storage (copied before deletion), so removing legacy files pre-materialization
 * is safe.
 *
 * Per-file approach: the migration framework has no recursive directory-removal
 * primitive — all actions operate on individual files identified by relPath. As
 * a result, any empty subdirectory shells left under the legacy tree after all
 * files are removed will remain on disk. Users can remove them manually if
 * desired. This is a known, intentional limitation of the ADR-0008 design: the
 * framework never removes directories, only files.
 *
 * User file preservation: files classified 'unknown' (not in the prior manifest)
 * receive a 'baseline-preserve-user' action and are explicitly NOT removed.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
function walkLegacyFiles(root, relDir, baseResolved, results) {
    const dir = node_path_1.default.join(root, relDir);
    const entries = node_fs_1.default.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        // Do not follow symlinks — skip them entirely to avoid out-of-tree traversal.
        if (entry.isSymbolicLink())
            continue; // gsd-allow-legacy-name (entry under legacy get-shit-done/ dir)
        const relPath = node_path_1.default.posix.join(relDir, entry.name);
        // Bounds check: ensure the resolved path stays under configDir.
        const resolved = node_path_1.default.resolve(root, relPath);
        if (resolved !== baseResolved && !resolved.startsWith(baseResolved + node_path_1.default.sep))
            continue;
        if (entry.isDirectory()) {
            walkLegacyFiles(root, relPath, baseResolved, results);
        }
        else if (entry.isFile()) {
            results.push(relPath);
        }
    }
}
const REASON = 'legacy runtime directory renamed to gsd-core (#604)';
const migration = {
    id: '2026-06-02-rename-get-shit-done-to-gsd-core', // gsd-allow-legacy-name
    title: 'Remove stale legacy get-shit-done/ runtime directory files (#604)', // gsd-allow-legacy-name
    description: 'After the config dir rename from get-shit-done/ to gsd-core/ (#604), remove prior-manifest-managed files ' + // gsd-allow-legacy-name
        'from the stale legacy directory during install (framework rollback restores them if install fails). User-added files are preserved.',
    introducedIn: '1.2.0',
    scopes: ['global', 'local'],
    destructive: true,
    plan(ctx) {
        const legacyRoot = node_path_1.default.join(ctx.configDir, 'get-shit-done'); // gsd-allow-legacy-name
        // Idempotency: if the legacy directory doesn't exist, nothing to do.
        if (!node_fs_1.default.existsSync(legacyRoot))
            return [];
        // Safety: if the legacy root itself is a symlink to an out-of-tree location,
        // do not process it — walking a symlinked dir could emit removes outside configDir.
        if (node_fs_1.default.lstatSync(legacyRoot).isSymbolicLink())
            return []; // gsd-allow-legacy-name
        const baseResolved = node_path_1.default.resolve(ctx.configDir);
        const relPaths = [];
        walkLegacyFiles(ctx.configDir, 'get-shit-done', baseResolved, relPaths); // gsd-allow-legacy-name
        const actions = [];
        for (const relPath of relPaths) {
            // Bounds-check each relPath before emitting any action.
            const resolved = node_path_1.default.resolve(ctx.configDir, relPath);
            if (resolved !== baseResolved && !resolved.startsWith(baseResolved + node_path_1.default.sep))
                continue;
            const { classification } = ctx.classifyArtifact(relPath);
            if (classification === 'managed-pristine') {
                actions.push({
                    type: 'remove-managed',
                    relPath,
                    reason: REASON,
                    ownershipEvidence: 'present in prior install manifest as a managed GSD runtime file',
                });
            }
            else if (classification === 'managed-modified') {
                actions.push({
                    type: 'backup-and-remove',
                    relPath,
                    reason: REASON,
                    ownershipEvidence: 'managed GSD runtime file, locally modified; backed up before removal',
                });
            }
            else if (classification === 'unknown') {
                actions.push({
                    type: 'baseline-preserve-user',
                    relPath,
                    reason: 'user-added file under legacy runtime dir; preserved per ADR-0008',
                    ownershipEvidence: 'file is not present in the prior install manifest; treated as user-owned',
                });
            }
            // 'managed-missing', 'missing', and any other classification: skip (no action)
        }
        return actions;
    },
};
module.exports = migration;
