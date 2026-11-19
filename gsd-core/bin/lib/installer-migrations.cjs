"use strict";
/**
 * Installer migrations engine — plan, apply, and track filesystem-mutation
 * migrations for GSD runtime config directories.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/installer-migrations.cjs
 * collapsed to a TypeScript source of truth. Behaviour is preserved
 * byte-for-behaviour from the prior hand-written .cjs; only types are added.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const node_crypto_1 = __importDefault(require("node:crypto"));
const installer_migration_authoring_cjs_1 = require("./installer-migration-authoring.cjs");
const shell_command_projection_cjs_1 = require("./shell-command-projection.cjs");
const clock_cjs_1 = require("./clock.cjs");
const install_scope_cjs_1 = require("./install-scope.cjs");
const security_cjs_1 = require("./security.cjs");
const jsonc_edit_cjs_1 = require("./jsonc-edit.cjs");
// #2874 (ADR-58 cleanup phase): this file is the ~1200-line migration
// plan/apply/rollback/lock/journal engine — almost none of it is on the
// installRuntimeArtifacts call tree. Only `readInstallManifest` and
// `classifyArtifact` are reached (via install-engine.cts's
// _migrateLegacyOpencodeCommandDir and retired-artifact-cleanup.cts's
// pruneRetiredRuntimeArtifacts), so only those two entry points — plus their
// shared `readJsonIfPresent` helper and `classifyArtifact`'s `sha256File`
// hashing helper — are routed through the injectable seam. Everything else
// in this file (locking, journal, apply/rollback, migration discovery)
// keeps using real `fs` directly: it is not reachable from
// installRuntimeArtifacts, so routing it would grow this seam past what
// AC2 actually requires. See install-fs-adapter.cts's module doc.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const installFsAdapter = require("./install-fs-adapter.cjs");
const { installFs } = installFsAdapter;
const MANIFEST_NAME = 'gsd-file-manifest.json';
const INSTALL_STATE_NAME = 'gsd-install-state.json';
const INSTALL_MIGRATION_LOCK_NAME = 'gsd-install-migration.lock';
const DEFAULT_MIGRATIONS_DIR = node_path_1.default.join(__dirname, 'installer-migrations');
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const STRICT_JSON = Symbol('strict-json');
// #2874: routed through installFs()'s openSync/readSync/closeSync trio
// instead of importing `node:fs` directly, so classifyArtifact — reachable
// from installRuntimeArtifacts — can be exercised against an injected
// adapter. This function was briefly converted to a single
// `installFs().readFileSync` call (buffering the whole file); that broke
// tests/installer-migrations.test.cjs's "classifies large files without
// loading the whole file through readFileSync", which monkeypatches real
// fs.readFileSync to throw for the file under test and asserts hashing still
// succeeds — an explicit, pre-existing contract that large files must be
// streamed, not buffered. Restored to the original raw-fd streaming shape,
// now going through the adapter instead of `node:fs` directly. This is the
// ONLY call site of sha256File in this file (confirmed by inspection) — no
// other caller is affected.
function sha256File(filePath) {
    const hash = node_crypto_1.default.createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    const fd = installFs().openSync(filePath, 'r');
    try {
        while (true) {
            const bytesRead = installFs().readSync(fd, buffer, 0, buffer.length, null);
            if (bytesRead === 0)
                break;
            hash.update(buffer.subarray(0, bytesRead));
        }
    }
    finally {
        installFs().closeSync(fd);
    }
    return hash.digest('hex');
}
function sha256Text(value) {
    return node_crypto_1.default.createHash('sha256').update(value).digest('hex');
}
/**
 * Evaluate and, if safe, perform a `remove-empty-dir` action against `fullPath`.
 *
 * This is deliberately WEAKER than a recursive directory-removal primitive
 * (which 003's docblock records as an intentional absence in the ADR-0008
 * design): it only ever calls `fs.rmdirSync` — never `fs.rmSync`, never
 * `{ recursive: true }`, never `{ force: true }` — so a non-empty directory
 * fails the underlying syscall rather than being swept. The emptiness check
 * immediately above the call is what turns that failure mode into a
 * deliberate, non-error "left in place" outcome instead of surfacing ENOTEMPTY.
 *
 * Guards, in order:
 *   - lstat (not stat): a symlinked directory is refused outright, never
 *     followed. A missing target is reported distinctly so callers can tell
 *     "nothing was ever there" from "something was there and is left alone".
 *   - must actually be a directory (not a file masquerading under the relPath).
 *   - containment: the REALPATH of the target must resolve strictly inside the
 *     REALPATH of configDir — never equal to it (removing the config root
 *     itself is never in scope) and never escaping it (e.g. via an ancestor
 *     symlink the lstat check alone would not catch).
 *   - emptiness, re-checked here rather than trusted from planning time: a
 *     directory that still holds any entry (managed-but-undeleted, unknown,
 *     or created between plan and apply) is left in place. This is reported
 *     as 'skipped-not-empty', a successful no-op, not a failure.
 *
 * Any unexpected error along the way (EACCES, EBUSY, a race that removes the
 * target between the lstat and the rmdir, etc.) degrades to 'left-in-place'.
 * This action must never throw out of the executor, matching every sibling
 * action type's failure posture.
 */
function evaluateRemoveEmptyDir(configDir, fullPath) {
    let stat;
    try {
        stat = node_fs_1.default.lstatSync(fullPath);
    }
    catch {
        return 'missing';
    }
    if (stat.isSymbolicLink())
        return 'left-in-place';
    if (!stat.isDirectory())
        return 'left-in-place';
    let resolvedRoot;
    let resolvedTarget;
    try {
        resolvedRoot = node_fs_1.default.realpathSync(configDir);
        resolvedTarget = node_fs_1.default.realpathSync(fullPath);
    }
    catch {
        return 'left-in-place';
    }
    // `resolvedTarget === resolvedRoot` is a DELIBERATE ADDITIONAL rejection,
    // separate from the containment decision: `tryWithinRootLexical` treats
    // target === root as CONTAINED, but removing the config root itself is
    // never in scope for this action (see the doc comment above) — this arm
    // prevents `rmdirSync` from ever being asked to remove `configDir` itself.
    // Kept as its own check per ADR-4650 decision 6 (a wrapper may add its own
    // conditions on top of the canonical predicate, never invert it).
    if (resolvedTarget === resolvedRoot)
        return 'left-in-place';
    if ((0, security_cjs_1.tryWithinRootLexical)(resolvedTarget, resolvedRoot) === null) {
        // Refuses "target escaped configDir".
        return 'left-in-place';
    }
    let entries;
    try {
        entries = node_fs_1.default.readdirSync(fullPath);
    }
    catch {
        return 'left-in-place';
    }
    if (entries.length > 0)
        return 'skipped-not-empty';
    try {
        node_fs_1.default.rmdirSync(fullPath);
        return 'removed';
    }
    catch {
        return 'left-in-place';
    }
}
/**
 * Copy a managed path for the rollback snapshot or the user-facing backup,
 * WITHOUT dereferencing a symlink.
 *
 * `fs.copyFileSync` follows symlinks, so a managed path that has been replaced
 * by a link (tampering, or an unexpected user layout) would have had the
 * LINK TARGET's bytes copied into `gsd-migration-journal/…-backups/` — e.g. a
 * `gsd.cjs` symlinked at `~/.ssh/id_rsa` would land that key's contents in the
 * backup tree. Nothing GSD installs is ever a symlink, so the faithful snapshot
 * of a symlinked managed path is the link itself: recreating it preserves
 * rollback fidelity (restore re-creates the same link) while never reading the
 * referent. Deletion was already safe — `fs.rmSync` unlinks the link, never the
 * target.
 *
 * Windows note: `fs.symlinkSync` can throw EPERM for unprivileged users. That
 * surfaces as an apply failure and triggers the normal rollback path, which is
 * the correct outcome — refusing to proceed beats silently copying referent
 * bytes.
 *
 * #2875 (epic #2866 Phase 6): all five fs calls routed through `installFs()`
 * so this primitive can be reused on the routed install path (by
 * user-artifact-staging.cts) without punching a hole through the seam Phase 5
 * built. Every EXISTING caller of this function is on the migration
 * plan/apply/rollback tree, which never wraps a call in `withInstallFs` — the
 * ambient adapter there resolves to real `node:fs` by default, so this
 * routing is behavior-preserving for them (test-matrix D2).
 */
function copyPreservingSymlink(srcPath, destPath) {
    if (installFs().lstatSync(srcPath).isSymbolicLink()) {
        // symlinkSync fails with EEXIST on an occupied path, so clear it first.
        // Scoped to this branch on purpose: the regular-file path below keeps
        // copyFileSync's overwrite-in-place, so a mid-restore failure cannot leave
        // the destination destroyed.
        installFs().rmSync(destPath, { force: true });
        installFs().symlinkSync(installFs().readlinkSync(srcPath), destPath);
        return;
    }
    installFs().copyFileSync(srcPath, destPath);
}
// Shared by readInstallManifest (on the installRuntimeArtifacts call tree —
// routed) and readInstallState/readJson (not on that call tree — the
// ambient default resolves to real fs for those, unchanged). Routing once
// here is safe for all three callers.
function readJsonIfPresent(filePath, fallback) {
    if (!installFs().existsSync(filePath))
        return fallback;
    try {
        return JSON.parse(installFs().readFileSync(filePath, 'utf8'));
    }
    catch (error) {
        if (fallback === STRICT_JSON) {
            throw new Error(`invalid installer migration state JSON: ${filePath}: ${error.message}`);
        }
        return fallback;
    }
}
/** Lowest manifest schema version that records `runtime`/`scope` (#2872). */
const MANIFEST_SCHEMA_VERSION = 2;
/**
 * Longest `runtime` string this reader will report. Real runtime ids are
 * registry keys (`claude`, `antigravity`, `kimi-code` — 11 chars at the
 * longest), so this loses nothing legitimate; it exists because the manifest
 * is attacker-influenceable (a project-local one lives inside a repository a
 * user may merely have cloned) and the value reaches a consumer that renders
 * it. Same 64-char convention as `truncatePostureValue`
 * (`agent-install-check.cts`), deliberately, so the subsystem caps reported
 * values one way.
 */
const MAX_REPORTED_RUNTIME_LENGTH = 64;
/**
 * A manifest's `runtime` is reported as a FACT about the file — it is
 * deliberately NOT validated against the capability registry, because an
 * unregistered id is exactly the kind of mismatch the Installed Surface
 * Resolver exists to surface (#2872 design row B8). It is, however, LENGTH
 * bounded: "report the fact" never required "report unbounded bytes".
 */
function normalizeReportedRuntime(raw) {
    if (typeof raw !== 'string')
        return null;
    if (raw.trim() === '')
        return null;
    return raw.length > MAX_REPORTED_RUNTIME_LENGTH
        ? `${raw.slice(0, MAX_REPORTED_RUNTIME_LENGTH)}…`
        : raw;
}
/**
 * Normalize a raw `manifestVersion`. Only a finite integer >= 1 is a version
 * claim; everything else (absent, `"2"`, `0`, `-1`, `2.5`, `NaN`, `Infinity`)
 * reads as `1` — a pre-#2872 manifest. Liberal in what it accepts, but the
 * normalization is a stated value rather than a silent guess: a caller can
 * always tell v1 (`1`) from "no manifest at all" (`null`).
 */
function normalizeManifestVersion(raw) {
    if (typeof raw !== 'number')
        return 1;
    if (!Number.isInteger(raw))
        return 1;
    if (raw < 1)
        return 1;
    return raw;
}
function readInstallManifest(configDir) {
    const manifest = readJsonIfPresent(node_path_1.default.join(configDir, MANIFEST_NAME), null);
    // `typeof [] === 'object'` in JS, so a bare `typeof !== 'object'` guard lets
    // a top-level JSON array (valid JSON, but not the manifest's documented
    // object shape) fall through to the field reads below — `m.manifestVersion`
    // reads `undefined` off an array, which `normalizeManifestVersion` then
    // reports as `1` (a v1 manifest), misclassifying "not an object" as
    // "installed". `Array.isArray` closes that gap explicitly rather than
    // relying on the object-shape checks below to catch it incidentally.
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
        return {
            version: null,
            timestamp: null,
            mode: null,
            files: {},
            manifestVersion: null,
            runtime: null,
            scope: null,
        };
    }
    const m = manifest;
    const rawRuntime = m.runtime;
    return {
        version: typeof m.version === 'string' ? m.version : null,
        timestamp: typeof m.timestamp === 'string' ? m.timestamp : null,
        mode: typeof m.mode === 'string' ? m.mode : null,
        // #4544 (review): `typeof [] === 'object'` — a manifest whose `files` is a
        // JSON array passed the object-shape guard, and Object.keys() then yielded
        // "0","1",... as install-relative file paths. Consumers iterate these keys,
        // so an array shape must degrade to the empty set exactly like a
        // non-object shape does.
        files: m.files && typeof m.files === 'object' && !Array.isArray(m.files)
            ? m.files
            : {},
        manifestVersion: normalizeManifestVersion(m.manifestVersion),
        runtime: normalizeReportedRuntime(rawRuntime),
        scope: (0, install_scope_cjs_1.isInstallScopeId)(m.scope) ? m.scope : null,
    };
}
function normalizeHostGeneration(raw) {
    if (!raw || typeof raw !== 'object')
        return undefined;
    const r = raw;
    if (r.runtime !== 'opencode' || (r.generation !== 1 && r.generation !== 2))
        return undefined;
    return { runtime: 'opencode', generation: r.generation, version: typeof r.version === 'string' ? r.version : null };
}
function readInstallState(configDir) {
    const state = readJsonIfPresent(node_path_1.default.join(configDir, INSTALL_STATE_NAME), STRICT_JSON);
    if (!state || typeof state !== 'object') {
        return { schemaVersion: 1, appliedMigrations: [] };
    }
    const s = state;
    const hostGeneration = normalizeHostGeneration(s.hostGeneration);
    return {
        schemaVersion: typeof s.schemaVersion === 'number' ? s.schemaVersion : 1,
        appliedMigrations: Array.isArray(s.appliedMigrations) ? s.appliedMigrations : [],
        ...(hostGeneration ? { hostGeneration } : {}),
    };
}
// Strict atomic write for the install state: must never be left half-written.
// Bypasses the seam because platformWriteSync falls back to a direct write on
// rename failure, which would silently violate this invariant.
function atomicWriteInstallState(configDir, content) {
    node_fs_1.default.mkdirSync(configDir, { recursive: true });
    const filePath = node_path_1.default.join(configDir, INSTALL_STATE_NAME);
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
        node_fs_1.default.writeFileSync(tmpPath, content, 'utf8');
        (0, shell_command_projection_cjs_1.retryRenameSync)(tmpPath, filePath);
    }
    catch (error) {
        try {
            node_fs_1.default.rmSync(tmpPath, { force: true });
        }
        catch { /* best-effort */ }
        throw error;
    }
}
function writeInstallState(configDir, state) {
    atomicWriteInstallState(configDir, JSON.stringify(state, null, 2) + '\n');
    return state;
}
function readJson(configDir, relPath) {
    const { fullPath } = ensureInsideConfig(configDir, relPath);
    if (!node_fs_1.default.existsSync(fullPath)) {
        return { exists: false, value: null, error: null };
    }
    try {
        return { exists: true, value: JSON.parse(node_fs_1.default.readFileSync(fullPath, 'utf8')), error: null };
    }
    catch (error) {
        return { exists: true, value: null, error: error };
    }
}
function normalizeRelPath(relPath) {
    if (typeof relPath !== 'string' || relPath.trim() === '') {
        throw new Error('migration action relPath must be a non-empty string');
    }
    const normalized = (0, shell_command_projection_cjs_1.posixNormalize)(relPath);
    if (node_path_1.default.isAbsolute(normalized) || node_path_1.default.win32.isAbsolute(normalized)) {
        throw new Error(`migration action relPath must stay inside configDir: ${relPath}`);
    }
    const segments = normalized.split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
        throw new Error(`migration action relPath must stay inside configDir: ${relPath}`);
    }
    return segments.join('/');
}
function classifyArtifact(configDir, relPath, manifest) {
    const normalized = normalizeRelPath(relPath);
    const originalHash = manifest.files[normalized] || null;
    const fullPath = node_path_1.default.join(configDir, normalized);
    if (!installFs().existsSync(fullPath)) {
        return { classification: originalHash ? 'managed-missing' : 'missing', originalHash, currentHash: null };
    }
    const currentHash = sha256File(fullPath);
    if (!originalHash) {
        return { classification: 'unknown', originalHash: null, currentHash };
    }
    if (currentHash === originalHash) {
        return { classification: 'managed-pristine', originalHash, currentHash };
    }
    return { classification: 'managed-modified', originalHash, currentHash };
}
function appliedMigrationIds(state) {
    return new Set(state.appliedMigrations
        .filter((entry) => entry && typeof entry.id === 'string')
        .map((entry) => entry.id));
}
function appliedMigrationEntries(state) {
    const entries = new Map();
    for (const entry of state.appliedMigrations) {
        if (entry && typeof entry.id === 'string' && !entries.has(entry.id)) {
            entries.set(entry.id, entry);
        }
    }
    return entries;
}
function migrationChecksum(migration) {
    const checksum = migration.checksum;
    if (typeof checksum === 'string' && checksum)
        return checksum;
    const serializable = {
        id: migration.id,
        title: migration.title || null,
        description: migration.description || null,
        introducedIn: migration.introducedIn || null,
        runtimes: migration.runtimes || null,
        scopes: migration.scopes || null,
        destructive: migration.destructive === true,
        runtimeContract: migration.runtimeContract || null,
        plan: typeof migration.plan === 'function' ? migration.plan.toString() : null,
    };
    return `sha256:${sha256Text(JSON.stringify(serializable))}`;
}
// Rewrite the stored checksum of any already-applied entry whose id drifted, so the
// drift is reconciled durably and not re-detected on every subsequent run (issue #670).
// Returns the number of entries actually changed (so callers know whether a write is needed).
function reconcileDriftedChecksums(appliedEntries, checksumDrift) {
    if (!Array.isArray(checksumDrift) || checksumDrift.length === 0)
        return 0;
    const reconcile = new Map(checksumDrift.map((d) => [d.id, d.currentChecksum]));
    let changed = 0;
    for (let i = 0; i < appliedEntries.length; i++) {
        const existing = appliedEntries[i];
        if (existing && typeof existing.id === 'string' && reconcile.has(existing.id)) {
            const next = reconcile.get(existing.id);
            if (existing.checksum !== next) {
                appliedEntries[i] = { ...existing, checksum: next };
                changed += 1;
            }
        }
    }
    return changed;
}
function collectAppliedChecksumDrift(applied, migrations) {
    const drift = [];
    for (const migration of migrations) {
        const entry = applied.get(migration.id);
        if (!entry || !entry.checksum)
            continue;
        const currentChecksum = migrationChecksum(migration);
        if (entry.checksum !== currentChecksum) {
            // An already-applied migration is never re-run (it is filtered out of `pending`),
            // so a checksum drift here is functionally inert. A prior release may have edited a
            // shipped migration body (see issue #670). Surface it for reconciliation instead of
            // hard-aborting the user's upgrade.
            drift.push({
                id: migration.id,
                storedChecksum: entry.checksum,
                currentChecksum,
            });
        }
    }
    return drift;
}
function migrationMatchesContext(migration, { runtime, scope }) {
    if (Array.isArray(migration.runtimes) && migration.runtimes.length > 0) {
        if (!runtime || !migration.runtimes.includes(runtime))
            return false;
    }
    if (Array.isArray(migration.scopes) && migration.scopes.length > 0) {
        if (!scope || !migration.scopes.includes(scope))
            return false;
    }
    return true;
}
function discoverInstallerMigrations({ migrationsDir }) {
    if (!migrationsDir || !node_fs_1.default.existsSync(migrationsDir))
        return [];
    return node_fs_1.default.readdirSync(migrationsDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.cjs'))
        .map((entry) => entry.name)
        .sort()
        .flatMap((fileName) => {
        const source = node_path_1.default.join(migrationsDir, fileName);
        delete require.cache[require.resolve(source)];
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const exported = require(source);
        const records = Array.isArray(exported) ? exported : [exported];
        return records.map((record) => (0, installer_migration_authoring_cjs_1.validateInstallerMigrationRecord)(record, source));
    });
}
function journalTimestamp(now) {
    return now().replace(/[:.]/g, '-');
}
function migrationRunId(appliedAt) {
    return `${journalTimestamp(() => appliedAt)}-${node_crypto_1.default.randomBytes(8).toString('hex')}`;
}
function sleepSync(ms) {
    const buffer = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}
/**
 * Check whether a given PID is alive on the current host.
 * Uses process.kill(pid, 0) which works on POSIX and Windows (Node's
 * implementation maps it to OpenProcess + GetExitCodeProcess on win32).
 * Returns true if alive or permission-denied (live but not ours),
 * false if ESRCH (no such process).
 */
function isPidAlive(pid) {
    if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true; // alive (or permission denied — treat as live)
    }
    catch (err) {
        return err.code !== 'ESRCH';
    }
}
/**
 * Try to read and parse the lock file JSON. Returns null on any error
 * (missing, invalid JSON, I/O failure).
 */
function readLockFile(lockPath) {
    try {
        const raw = node_fs_1.default.readFileSync(lockPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && typeof parsed.pid === 'number') {
            return parsed;
        }
        return null;
    }
    catch {
        return null;
    }
}
function acquireInstallMigrationLock(configDir, { timeoutMs = DEFAULT_LOCK_TIMEOUT_MS } = {}, clock = clock_cjs_1.realClock) {
    node_fs_1.default.mkdirSync(configDir, { recursive: true });
    const lockPath = node_path_1.default.join(configDir, INSTALL_MIGRATION_LOCK_NAME);
    const started = clock.now();
    while (true) {
        let fd = null;
        let lockCreatedByUs = false;
        try {
            fd = node_fs_1.default.openSync(lockPath, 'wx');
            lockCreatedByUs = true; // we own the file; clean it up on any subsequent error
            // Write the payload through the exclusively-created descriptor: a
            // second open-by-path here would be a TOCTOU window (CWE-367) where a
            // co-writer of the directory could symlink-swap the just-created empty
            // lock file before the payload lands.
            node_fs_1.default.writeFileSync(fd, JSON.stringify({
                pid: process.pid,
                acquiredAt: new Date().toISOString(),
            }) + '\n');
            // Close before returning so no handle stays open across the lock's
            // lifetime — Windows cannot unlink a file with an open handle when the
            // release closure runs.
            node_fs_1.default.closeSync(fd);
            fd = null;
            lockCreatedByUs = false; // release closure owns cleanup from here
            return () => {
                const failures = [];
                // Use unlinkSync (not rmSync with { force: true }) so EPERM errors
                // are NOT silently swallowed. On Windows, if the unlink fails
                // transiently, the error surfaces via releaseError so the caller
                // can observe and surface it rather than leaving a stale lock.
                try {
                    node_fs_1.default.unlinkSync(lockPath);
                }
                catch (error) {
                    failures.push(error);
                }
                if (failures.length > 0) {
                    const releaseError = new Error(`failed to release installer migration lock: ${lockPath}`);
                    releaseError.failures = failures;
                    throw releaseError;
                }
            };
        }
        catch (error) {
            if (fd !== null) {
                try {
                    node_fs_1.default.closeSync(fd);
                }
                catch { /* best-effort */ }
                try {
                    node_fs_1.default.unlinkSync(lockPath);
                }
                catch { /* best-effort */ }
                fd = null;
            }
            else if (lockCreatedByUs) {
                // fd was closed but writeFileSync threw before we returned the release
                // closure — the empty lock file is still on disk and must be removed
                // so it does not orphan as an unreadable (empty/invalid JSON) stale lock.
                try {
                    node_fs_1.default.unlinkSync(lockPath);
                }
                catch { /* best-effort */ }
            }
            const err = error;
            if (err && err.code === 'EEXIST') {
                // Stale-lock reclamation: read the on-disk PID and check liveness.
                // If the PID is dead (ESRCH) or is our own process (same-process
                // re-entry caused by rmSync silently swallowing an unlink error on
                // a previous call in the same invocation — the root cause of #3670),
                // reclaim the lock by removing the stale file and retrying.
                const lockData = readLockFile(lockPath);
                if (lockData !== null) {
                    const holderPid = lockData.pid;
                    const isSameProcess = holderPid === process.pid;
                    const isDeadProcess = !isPidAlive(holderPid);
                    if (isSameProcess || isDeadProcess) {
                        // Reclaim: remove the stale lock and loop back to openSync.
                        // Only continue (retry) when unlink actually succeeds — a silent
                        // continue on reclaim failure recreates the original deadlock:
                        // the lock stays on disk and we spin indefinitely.
                        let reclaimed = false;
                        try {
                            node_fs_1.default.unlinkSync(lockPath);
                            reclaimed = true;
                        }
                        catch { /* unlink failed — fall through to timeout path */ }
                        if (reclaimed)
                            continue;
                    }
                }
                if (clock.now() - started >= timeoutMs) {
                    const holderInfo = lockData ? ` (held by pid ${lockData.pid} since ${lockData.acquiredAt})` : '';
                    throw new Error(`installer migration lock is held: ${lockPath}${holderInfo}`);
                }
                clock.sleep(Math.min(50, Math.max(1, timeoutMs - (clock.now() - started))));
                continue;
            }
            throw error;
        }
    }
}
// DELIBERATELY LEXICAL — the RESOLUTION policy stays lexical, never realpath
// (`assertWithinRoot` / `tryWithinRoot`, src/security.cts).
//
// Reviewed under epic #4636 Phase 3 and reverted after the remote matrix proved
// the realpath collapse wrong. This module's contract is that a symlinked
// managed path is treated AS A LINK and never dereferenced — it is snapshotted
// as a link, restored as a link, and backed up as a link. The realpath-based
// predicate dereferences exactly the symlinks this module exists to preserve
// and then rejects them for escaping configDir
// ("migration path escapes configDir: extensions/gsd.cjs"). Four tests in
// tests/installer-migrations.test.cjs pin that behavior.
//
// The containment DECISION now routes through the canonical LEXICAL predicate
// (`tryWithinRootLexical`, ADR-4650 decision 6) — only the comparison moved;
// the lexical policy itself remains this module's own required choice, and
// the thrown message / returned `fullPath` are unchanged.
//
// `normalizeRelPath` is the pre-gate: it throws on absolute paths and on any
// '..' segment BEFORE this runs, so the check below is defense-in-depth over
// already-traversal-free input rather than the primary boundary.
function ensureInsideConfig(configDir, relPath) {
    const normalized = normalizeRelPath(relPath);
    const fullPath = node_path_1.default.resolve(configDir, normalized);
    if ((0, security_cjs_1.tryWithinRootLexical)(fullPath, configDir) === null) {
        throw new Error(`migration path escapes configDir: ${relPath}`);
    }
    return { normalized, fullPath };
}
function isStructurallyEmpty(value) {
    if (value === null || value === undefined)
        return true;
    if (Array.isArray(value))
        return value.length === 0;
    return typeof value === 'object' && Object.keys(value).length === 0;
}
function journalAction(action, status, extras = {}) {
    const { value: _value, ...safeAction } = action;
    return { ...safeAction, ...extras, status };
}
/**
 * The text a `rewrite-json` action writes. A file with JSONC syntax (comments, trailing commas, or a
 * `.jsonc` name) is edited in place from the action's `edits`, so the user's annotations survive (#5334);
 * everything else, and any edit the text editor cannot place, is written as the action's whole `value`.
 */
function renderRewrittenJson(fullPath, action) {
    if (Array.isArray(action.edits) && action.edits.length > 0) {
        let original = null;
        try {
            original = node_fs_1.default.readFileSync(fullPath, 'utf8');
        }
        catch { /* fall through to the value rewrite */ }
        if (original !== null && (fullPath.endsWith('.jsonc') || (0, jsonc_edit_cjs_1.hasJsoncFeatures)(original))) {
            let text = original;
            for (const edit of action.edits) {
                text = (0, jsonc_edit_cjs_1.setJsoncValue)(text, edit.path, edit.value);
                if (text === null)
                    break;
            }
            if (text !== null)
                return text;
        }
    }
    return JSON.stringify(action.value, null, 2) + '\n';
}
function planInstallerMigrations({ configDir, runtime = null, scope = null, migrations, baselineScan = false, now = () => new Date().toISOString(), }) {
    if (!configDir)
        throw new Error('configDir is required');
    if (!Array.isArray(migrations))
        throw new Error('migrations must be an array');
    const manifest = readInstallManifest(configDir);
    const state = readInstallState(configDir);
    const validatedMigrations = migrations.map((migration) => (0, installer_migration_authoring_cjs_1.validateInstallerMigrationRecord)(migration));
    const scopedMigrations = validatedMigrations.filter((migration) => migrationMatchesContext(migration, { runtime, scope }));
    const applied = appliedMigrationEntries(state);
    const checksumDrift = collectAppliedChecksumDrift(applied, scopedMigrations);
    const pending = scopedMigrations.filter((migration) => !applied.has(migration.id));
    const actions = [];
    const blocked = [];
    const classifications = new Map();
    const classify = (relPath) => {
        const normalized = normalizeRelPath(relPath);
        if (!classifications.has(normalized)) {
            classifications.set(normalized, classifyArtifact(configDir, normalized, manifest));
        }
        return classifications.get(normalized);
    };
    for (const migration of pending) {
        const planFn = migration.plan;
        const plannedActions = planFn({
            configDir,
            runtime,
            scope,
            manifest,
            state,
            baselineScan,
            now,
            classifyArtifact: classify,
            readJson: (relPath) => readJson(configDir, relPath),
        });
        (0, installer_migration_authoring_cjs_1.validateInstallerMigrationActions)(plannedActions, migration);
        const checksum = migrationChecksum(migration);
        for (const rawAction of plannedActions) {
            const relPath = normalizeRelPath(rawAction.relPath);
            const classification = rawAction.classification
                ? {
                    classification: rawAction.classification,
                    originalHash: rawAction.originalHash || null,
                    currentHash: rawAction.currentHash || null,
                }
                : classify(relPath);
            let protectedType = rawAction.type;
            if (rawAction.type === 'remove-managed' && classification.classification === 'managed-modified') {
                protectedType = 'backup-and-remove';
            }
            if (rawAction.type === 'remove-managed' && classification.classification === 'unknown') {
                protectedType = 'preserve-user';
            }
            const action = {
                migrationId: migration.id,
                migrationChecksum: checksum,
                type: protectedType,
                relPath,
                reason: rawAction.reason || migration.description || '',
                classification: classification.classification,
                originalHash: classification.originalHash,
                currentHash: classification.currentHash,
            };
            if (action.type !== rawAction.type) {
                action.requestedType = rawAction.type;
            }
            if (action.type === 'backup-and-remove') {
                action.backupRelPath = null;
            }
            if (action.type === 'rewrite-json') {
                action.value = rawAction.value;
                if (Array.isArray(rawAction.edits))
                    action.edits = rawAction.edits;
                action.deleteIfEmpty = rawAction.deleteIfEmpty === true;
            }
            if (rawAction.prompt)
                action.prompt = rawAction.prompt;
            if (Array.isArray(rawAction.choices))
                action.choices = rawAction.choices;
            if (action.type === 'prompt-user') {
                blocked.push(action);
            }
            else if (action.classification === 'unknown' &&
                action.type !== 'rewrite-json' &&
                action.type !== 'record-baseline' &&
                action.type !== 'baseline-preserve-user') {
                blocked.push(action);
            }
            actions.push(action);
        }
    }
    return {
        generatedAt: now(),
        manifest,
        state,
        pendingMigrationIds: pending.map((migration) => migration.id),
        pendingMigrations: pending,
        actions,
        blocked,
        checksumDrift,
    };
}
function uniqueActionMigrationIds(actions) {
    return [...new Set(actions.map((action) => action.migrationId).filter(Boolean))];
}
function rollbackAppliedMigrationResult({ configDir, journal, journalPath, rollbackRoot, backupRoot, previousInstallStateBytes }) {
    const failures = [];
    for (const action of [...journal.actions].reverse()) {
        if (!action.rollbackRelPath)
            continue;
        const rollbackPath = node_path_1.default.join(configDir, action.rollbackRelPath);
        const dest = node_path_1.default.join(configDir, action.relPath);
        try {
            // lstat-based existence check: a snapshot of a symlinked managed path is
            // itself a link, and existsSync() follows it — a link whose target is
            // gone would read as "missing" and silently skip the restore.
            if (node_fs_1.default.lstatSync(rollbackPath, { throwIfNoEntry: false })) {
                node_fs_1.default.mkdirSync(node_path_1.default.dirname(dest), { recursive: true });
                copyPreservingSymlink(rollbackPath, dest);
            }
        }
        catch (error) {
            failures.push({ relPath: action.relPath, error: error.message });
        }
        if (action.backupRelPath) {
            try {
                node_fs_1.default.rmSync(node_path_1.default.join(configDir, action.backupRelPath), { force: true });
            }
            catch {
                // backup cleanup is best-effort; preserve restore failures above
            }
        }
    }
    try {
        if (previousInstallStateBytes === null) {
            node_fs_1.default.rmSync(node_path_1.default.join(configDir, INSTALL_STATE_NAME), { force: true });
        }
        else {
            atomicWriteInstallState(configDir, previousInstallStateBytes);
        }
    }
    catch (error) {
        failures.push({ relPath: INSTALL_STATE_NAME, error: error.message });
    }
    try {
        node_fs_1.default.rmSync(journalPath, { force: true });
        node_fs_1.default.rmSync(rollbackRoot, { recursive: true, force: true });
        node_fs_1.default.rmSync(backupRoot, { recursive: true, force: true });
    }
    catch {
        // journal cleanup is best-effort; the rollback above is the safety-critical part
    }
    if (failures.length > 0) {
        const error = new Error('migration rollback incomplete');
        error.rollbackFailures = failures;
        throw error;
    }
}
function cleanupMigrationRunArtifacts(journalPath, rollbackRoot, backupRoot) {
    try {
        node_fs_1.default.rmSync(journalPath, { force: true });
    }
    catch { /* best-effort */ }
    try {
        node_fs_1.default.rmSync(rollbackRoot, { recursive: true, force: true });
    }
    catch { /* best-effort */ }
    try {
        node_fs_1.default.rmSync(backupRoot, { recursive: true, force: true });
    }
    catch { /* best-effort */ }
}
function applyInstallerMigrationPlan({ configDir, plan, now = () => new Date().toISOString(), }) {
    if (!configDir)
        throw new Error('configDir is required');
    if (!plan || !Array.isArray(plan.actions))
        throw new Error('plan with actions is required');
    if (Array.isArray(plan.blocked) && plan.blocked.length > 0) {
        throw new Error(`migration plan has ${plan.blocked.length} blocked action(s)`);
    }
    const appliedAt = now();
    const runId = migrationRunId(appliedAt);
    const journalRelPath = node_path_1.default.posix.join('gsd-migration-journal', `${runId}.json`);
    const journalPath = node_path_1.default.join(configDir, journalRelPath);
    const rollbackRootRelPath = node_path_1.default.posix.join('gsd-migration-journal', `${runId}-rollback`);
    const rollbackRoot = node_path_1.default.join(configDir, rollbackRootRelPath);
    const backupRootRelPath = node_path_1.default.posix.join('gsd-migration-journal', `${runId}-backups`);
    const backupRoot = node_path_1.default.join(configDir, backupRootRelPath);
    const journal = {
        schemaVersion: 1,
        appliedAt,
        appliedMigrationIds: uniqueActionMigrationIds(plan.actions),
        actions: [],
    };
    const rollback = [];
    const installStatePath = node_path_1.default.join(configDir, INSTALL_STATE_NAME);
    const previousInstallStateBytes = node_fs_1.default.existsSync(installStatePath)
        ? node_fs_1.default.readFileSync(installStatePath, 'utf8')
        : null;
    try {
        node_fs_1.default.mkdirSync(node_path_1.default.dirname(journalPath), { recursive: true });
        (0, shell_command_projection_cjs_1.platformWriteSync)(journalPath, JSON.stringify(journal, null, 2) + '\n');
        for (const action of plan.actions) {
            if (action.type !== 'remove-managed' &&
                action.type !== 'backup-and-remove' &&
                action.type !== 'rewrite-json' &&
                action.type !== 'record-baseline' &&
                action.type !== 'baseline-preserve-user' &&
                action.type !== 'remove-empty-dir') {
                throw new Error(`unsupported migration action type: ${action.type}`);
            }
            const { normalized, fullPath } = ensureInsideConfig(configDir, action.relPath);
            if (!node_fs_1.default.existsSync(fullPath)) {
                journal.actions.push(journalAction(action, 'missing'));
                continue;
            }
            if (action.type === 'record-baseline' || action.type === 'baseline-preserve-user') {
                journal.actions.push(journalAction(action, action.type === 'record-baseline' ? 'recorded' : 'preserved'));
                continue;
            }
            if (action.type === 'remove-empty-dir') {
                // Directory actions never enter the file-copy/rollback machinery below:
                // there is nothing to snapshot-and-restore for a directory node itself
                // (its former CONTENTS were already snapshotted by their own file-level
                // actions before this one runs), and rollback of a removed empty
                // directory is simply re-creating it, which the rollback path below
                // does not model. Non-recursive by construction (evaluateRemoveEmptyDir
                // only ever calls fs.rmdirSync), so there is nothing destructive to undo
                // beyond an mkdir the next install/migration run will happily redo.
                journal.actions.push(journalAction(action, evaluateRemoveEmptyDir(configDir, fullPath)));
                continue;
            }
            const rollbackPath = node_path_1.default.join(rollbackRoot, normalized);
            node_fs_1.default.mkdirSync(node_path_1.default.dirname(rollbackPath), { recursive: true });
            copyPreservingSymlink(fullPath, rollbackPath);
            rollback.push({ relPath: normalized, rollbackPath });
            if (action.type === 'rewrite-json') {
                if (action.deleteIfEmpty && isStructurallyEmpty(action.value)) {
                    node_fs_1.default.rmSync(fullPath, { force: true });
                    journal.actions.push(journalAction(action, 'removed', {
                        rollbackRelPath: node_path_1.default.posix.join(rollbackRootRelPath, normalized),
                    }));
                }
                else {
                    (0, shell_command_projection_cjs_1.platformWriteSync)(fullPath, renderRewrittenJson(fullPath, action));
                    journal.actions.push(journalAction(action, 'rewritten', {
                        rollbackRelPath: node_path_1.default.posix.join(rollbackRootRelPath, normalized),
                    }));
                }
                continue;
            }
            if (action.type === 'backup-and-remove') {
                const backupRelPath = action.backupRelPath || node_path_1.default.posix.join(backupRootRelPath, normalized);
                const backupPath = node_path_1.default.join(configDir, backupRelPath);
                node_fs_1.default.mkdirSync(node_path_1.default.dirname(backupPath), { recursive: true });
                copyPreservingSymlink(fullPath, backupPath);
                journal.actions.push(journalAction(action, 'removed', {
                    backupRelPath,
                    rollbackRelPath: node_path_1.default.posix.join(rollbackRootRelPath, normalized),
                }));
            }
            else {
                journal.actions.push(journalAction(action, 'removed', {
                    rollbackRelPath: node_path_1.default.posix.join(rollbackRootRelPath, normalized),
                }));
            }
            node_fs_1.default.rmSync(fullPath, { force: true });
        }
        (0, shell_command_projection_cjs_1.platformWriteSync)(journalPath, JSON.stringify(journal, null, 2) + '\n');
        const state = readInstallState(configDir);
        const applied = appliedMigrationIds(state);
        const nextApplied = [...state.appliedMigrations];
        reconcileDriftedChecksums(nextApplied, plan.checksumDrift);
        const actionsByMigrationId = new Map();
        for (const action of plan.actions) {
            if (action.migrationId && !actionsByMigrationId.has(action.migrationId)) {
                actionsByMigrationId.set(action.migrationId, action);
            }
        }
        for (const id of journal.appliedMigrationIds) {
            if (!applied.has(id)) {
                const action = actionsByMigrationId.get(id);
                nextApplied.push({
                    id,
                    appliedAt,
                    journal: journalRelPath,
                    checksum: action && action.migrationChecksum ? action.migrationChecksum : null,
                });
            }
        }
        writeInstallState(configDir, {
            schemaVersion: 1,
            appliedMigrations: nextApplied,
            ...(state.hostGeneration ? { hostGeneration: state.hostGeneration } : {}),
        });
        return {
            appliedMigrationIds: journal.appliedMigrationIds,
            journalRelPath,
            rollback: () => rollbackAppliedMigrationResult({ configDir, journal, journalPath, rollbackRoot, backupRoot, previousInstallStateBytes }),
        };
    }
    catch (error) {
        const rollbackFailures = [];
        for (const entry of rollback.reverse()) {
            const dest = node_path_1.default.join(configDir, entry.relPath);
            try {
                node_fs_1.default.mkdirSync(node_path_1.default.dirname(dest), { recursive: true });
                // Symlink-preserving, same as the forward path: `entry.rollbackPath` is
                // itself a link whenever the managed path was one, so a raw copy here
                // would dereference it and write the referent's bytes back to the LIVE
                // install path — a worse leak than the journal-tree one, since it is
                // user-visible and at a predictable location.
                copyPreservingSymlink(entry.rollbackPath, dest);
            }
            catch (rollbackError) {
                rollbackFailures.push({
                    relPath: entry.relPath,
                    rollbackPath: entry.rollbackPath,
                    error: rollbackError.message,
                });
            }
        }
        if (rollbackFailures.length > 0) {
            const rollbackError = new Error(`migration apply failed and rollback incomplete: ${error.message}`);
            rollbackError.cause = error;
            rollbackError.rollbackFailures = rollbackFailures;
            throw rollbackError;
        }
        cleanupMigrationRunArtifacts(journalPath, rollbackRoot, backupRoot);
        throw error;
    }
}
function markPendingMigrationsApplied({ configDir, plan, now = () => new Date().toISOString(), }) {
    if (!plan)
        return [];
    const hasPending = Array.isArray(plan.pendingMigrationIds) && plan.pendingMigrationIds.length > 0;
    const hasDrift = Array.isArray(plan.checksumDrift) && plan.checksumDrift.length > 0;
    if (!hasPending && !hasDrift)
        return [];
    const appliedAt = now();
    const state = readInstallState(configDir);
    const applied = appliedMigrationIds(state);
    const nextApplied = [...state.appliedMigrations];
    const reconciledCount = reconcileDriftedChecksums(nextApplied, plan.checksumDrift);
    const newlyApplied = [];
    if (hasPending) {
        const checksumsByMigrationId = new Map();
        for (const migration of plan.pendingMigrations || []) {
            checksumsByMigrationId.set(migration.id, migrationChecksum(migration));
        }
        for (const id of plan.pendingMigrationIds) {
            if (applied.has(id))
                continue;
            nextApplied.push({
                id,
                appliedAt,
                journal: null,
                checksum: checksumsByMigrationId.get(id) || null,
            });
            newlyApplied.push(id);
        }
    }
    if (newlyApplied.length > 0 || reconciledCount > 0) {
        writeInstallState(configDir, {
            schemaVersion: 1,
            appliedMigrations: nextApplied,
            ...(state.hostGeneration ? { hostGeneration: state.hostGeneration } : {}),
        });
    }
    return newlyApplied;
}
function runInstallerMigrations({ configDir, runtime = null, scope = null, migrationsDir = DEFAULT_MIGRATIONS_DIR, migrations = discoverInstallerMigrations({ migrationsDir }), baselineScan = false, now = () => new Date().toISOString(), lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS, } = { configDir: '' }) {
    const releaseLock = acquireInstallMigrationLock(configDir, { timeoutMs: lockTimeoutMs });
    let primaryError = null;
    let completed = false;
    try {
        const plan = planInstallerMigrations({ configDir, runtime, scope, migrations, baselineScan, now });
        if (plan.actions.length === 0) {
            const newlyApplied = markPendingMigrationsApplied({ configDir, plan, now });
            completed = true;
            return {
                appliedMigrationIds: newlyApplied,
                journalRelPath: null,
                plan,
            };
        }
        if (plan.blocked.length > 0) {
            completed = true;
            return {
                appliedMigrationIds: [],
                journalRelPath: null,
                plan,
                blocked: plan.blocked,
            };
        }
        const result = applyInstallerMigrationPlan({ configDir, plan, now });
        completed = true;
        return { ...result, plan };
    }
    catch (error) {
        primaryError = error;
        throw error;
    }
    finally {
        try {
            releaseLock();
        }
        catch (releaseError) {
            if (primaryError) {
                primaryError.suppressed = [...(primaryError.suppressed || []), releaseError];
            }
            else if (completed) {
                throw releaseError;
            }
            else {
                throw releaseError;
            }
        }
    }
}
// Unused but kept to satisfy eslint — sleepSync is referenced in the original
// and may be used by test code that patches this module.
void sleepSync;
/**
 * Record which OpenCode generation this install targets (ADR-5331 D2; #5337). Idempotent and
 * atomic; leaves the applied-migrations journal untouched.
 */
function recordHostGeneration(configDir, info) {
    const state = readInstallState(configDir);
    const next = { runtime: 'opencode', generation: info.generation, version: info.version ?? null };
    const prev = state.hostGeneration;
    if (prev && prev.generation === next.generation && prev.version === next.version)
        return;
    writeInstallState(configDir, { ...state, hostGeneration: next });
}
module.exports = {
    DEFAULT_MIGRATIONS_DIR,
    INSTALL_MIGRATION_LOCK_NAME,
    INSTALL_STATE_NAME,
    MANIFEST_NAME,
    acquireInstallMigrationLock,
    applyInstallerMigrationPlan,
    classifyArtifact,
    copyPreservingSymlink,
    discoverInstallerMigrations,
    evaluateRemoveEmptyDir,
    MANIFEST_SCHEMA_VERSION,
    migrationChecksum,
    planInstallerMigrations,
    readInstallManifest,
    readInstallState,
    recordHostGeneration,
    runInstallerMigrations,
    writeInstallState,
};
