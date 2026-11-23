"use strict";
/**
 * #4145: hash-first recovery for gsd-pristine/ baselines stored at an
 * unexpected path.
 *
 * Some installs hold a pristine snapshot whose SHA-256 equals the hash recorded
 * in backup-meta.json.pristine_hashes for a manifest-keyed file, but at a path
 * that is not `path.join(pristineDir, relPath)` — e.g. stored without the
 * `gsd-core/` top-level segment by an earlier release's writer. Both readers
 * (verify-reapply-patches.cjs verifyFile and install.js saveLocalPatches)
 * resolved strictly by that join, missed the snapshot, and reported
 * ok_no_baseline / fell into regeneration that can never satisfy the recorded
 * outgoing hash — a self-perpetuating gap.
 *
 * Hash equality with the recorded pristine_hashes entry is the same authority
 * the #3657 drift guard already trusts, so a match cannot be the wrong
 * baseline regardless of which release wrote it or where under gsd-pristine/
 * it lives. This module owns the shared scan so the two readers cannot drift
 * apart again (two private strict joins drifting is exactly the bug class).
 *
 * ADR-457: runtime module in src/*.cts, compiled to
 * gsd-core/bin/lib/pristine-baseline.cjs.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sha256File = sha256File;
exports.findPristineByHash = findPristineByHash;
exports.isCleanRelativePosixPath = isCleanRelativePosixPath;
exports.gitExec = gitExec;
exports.findPristineInGit = findPristineInGit;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const node_crypto_1 = __importDefault(require("node:crypto"));
const node_child_process_1 = require("node:child_process");
const read_only_git_env_cjs_1 = require("./read-only-git-env.cjs");
/**
 * SHA-256 hex digest of a file's raw bytes. Byte-for-byte the same digest
 * install.js fileHash() records into manifests and backup-meta.json.
 */
function sha256File(absPath) {
    return node_crypto_1.default.createHash('sha256').update(node_fs_1.default.readFileSync(absPath)).digest('hex');
}
function walkSorted(dir, relPrefix, results) {
    let entries;
    try {
        entries = node_fs_1.default.readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return; // absent or unreadable — nothing to scan here
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
        // Never follow symlinks: gsd-pristine/ is installer-authored plain files;
        // a link here is not a baseline and must not redirect the walk out of the
        // tree (same posture as migration 004's walker).
        if (entry.isSymbolicLink())
            continue;
        const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            walkSorted(node_path_1.default.join(dir, entry.name), rel, results);
        }
        else if (entry.isFile()) {
            results.push(rel);
        }
    }
}
/**
 * Find the first file under `pristineDir` (deterministic sorted walk) whose
 * SHA-256 equals `recordedHash`, as a pristineDir-relative POSIX path.
 *
 * - `skip` is never returned — a single POSIX relPath string or a Set of them.
 *   Callers pass the canonical path(s) they (or other files in the same run)
 *   already own, so a file sitting at a canonical path is never adopted
 *   through the scan. For the installer's relocation this is what prevents a
 *   byte-identical canonical belonging to ANOTHER modified file from being
 *   "rescued" away (relocated and deleted at its home path).
 * - Multiple matches are byte-identical by sha-256 authority; sorted order
 *   makes the choice deterministic.
 * - Returns null when pristineDir is absent/unreadable or nothing matches.
 */
function findPristineByHash(pristineDir, recordedHash, skip) {
    if (!pristineDir || typeof recordedHash !== 'string' || recordedHash.length === 0) {
        return null;
    }
    const skipSet = skip instanceof Set ? skip : new Set(skip !== undefined ? [skip] : []);
    const rels = [];
    walkSorted(pristineDir, '', rels);
    for (const rel of rels) {
        if (skipSet.has(rel))
            continue;
        try {
            if (sha256File(node_path_1.default.join(pristineDir, rel)) === recordedHash) {
                return rel;
            }
        }
        catch {
            // unreadable candidate — keep scanning
        }
    }
    return null;
}
/**
 * #4135: recover a pristine baseline from the config dir's OWN git history,
 * anchored by the recorded pristine_hashes entry.
 *
 * The #3407 promotion rule keeps only regeneration candidates byte-identical
 * across the whole version span, so a multi-version update leaves
 * gsd-pristine/ holding exactly the files upstream did NOT change — near-zero
 * coverage precisely where upstream churned the most. On a git-managed config
 * dir the outgoing bytes often still exist in history (the workflow's
 * documented Option A), and pristine_hashes is the same authority every other
 * resolution tier trusts: a blob whose SHA-256 equals the recorded hash cannot
 * be the wrong baseline. This is read-only recovery (git log / git show only).
 *
 * Guarantees:
 * - Only an EXACT sha-256 match with the recorded hash is ever returned.
 * - Newest-first commit order (git log default) makes multi-match resolution
 *   deterministic; byte-identical matches are interchangeable anyway.
 * - Any failure (git absent, not a repository, empty history, unreadable
 *   blob, subprocess timeout) yields null — never a throw — so the caller's
 *   OK_NO_BASELINE posture is the universal fallback.
 * - The walk is bounded: at most GIT_MAX_COMMITS_PER_FILE commits per file.
 */
const GIT_MAX_COMMITS_PER_FILE = 100;
/** Per-subprocess bound in ms — an unbounded git call is an indefinite hang. */
const GIT_SUBPROCESS_TIMEOUT_MS = 10_000;
/** git log --format=%H output cap; 100 full shas are ~4 KB, this is headroom. */
const GIT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
/**
 * #5105 review finding 1/4: shared containment guard AND the shared
 * non-trimming `git` subprocess runner, exported so `uat.cts`'s
 * `readBaselineAtHead` (byte-exact `git show HEAD:<path>` read) can route
 * through the same bounded, `windowsHide`d, stderr-discarding call this
 * module already uses, rather than maintaining a second private
 * `execFileSync` wrapper that can drift from this one's timeout/maxBuffer.
 */
function isCleanRelativePosixPath(relPath) {
    if (!relPath || relPath.startsWith('/') || relPath.includes('\\') || relPath.includes('\0')) {
        return false;
    }
    const segments = relPath.split('/');
    return segments.every((seg) => seg.length > 0 && seg !== '.' && seg !== '..');
}
function gitExec(gitDir, args) {
    return (0, node_child_process_1.execFileSync)('git', args, {
        // windowsHide (#685): a console-window flash per git call would spam the
        // user on Windows for what is a background, read-only history walk. Kept
        // high in the options so the completeness guard's 400-char scan finds it.
        windowsHide: true,
        cwd: gitDir,
        encoding: 'utf8',
        // #5048: every call here is a history/objects walk that never opens the
        // index, so the variable is inert today — set anyway so a future `status` /
        // `diff` caller inherits it. The block is owned by
        // src/read-only-git-env.cts and shared with every other read-only seam.
        // Parity: tests/git-optional-locks-parity.test.cjs.
        env: (0, read_only_git_env_cjs_1.readOnlyGitEnv)(),
        timeout: GIT_SUBPROCESS_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER_BYTES,
        // stderr is discarded: "file absent in commit" is an expected walk outcome,
        // not operator-visible diagnostics.
        stdio: ['ignore', 'pipe', 'ignore'],
    });
}
function findPristineInGit(gitDir, relPath, recordedHash) {
    if (!gitDir || typeof relPath !== 'string' || typeof recordedHash !== 'string'
        || recordedHash.length === 0 || !isCleanRelativePosixPath(relPath)) {
        return null;
    }
    let commits;
    try {
        const logOutput = gitExec(gitDir, ['log', '--format=%H', '--', relPath]).trim();
        if (!logOutput)
            return null;
        commits = logOutput.split('\n').slice(0, GIT_MAX_COMMITS_PER_FILE);
    }
    catch {
        return null; // git absent, not a repository, or the walk failed
    }
    for (const commit of commits) {
        if (!/^[0-9a-f]{40}$/i.test(commit))
            continue;
        try {
            const blob = gitExec(gitDir, ['show', `${commit}:${relPath}`]);
            if (sha256String(blob) === recordedHash) {
                return blob;
            }
        }
        catch {
            // blob absent in this commit (rename/add boundary) — keep walking
        }
    }
    return null;
}
/** sha256 of a utf8 string, matching how manifest hashes are recorded. */
function sha256String(content) {
    return node_crypto_1.default.createHash('sha256').update(content, 'utf8').digest('hex');
}
