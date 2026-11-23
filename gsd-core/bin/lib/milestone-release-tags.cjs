"use strict";
/**
 * Milestone Release Tags — #5705 (epic #3628, Phase 1).
 *
 * `gsd-tools milestone release-tags --map <file> [--dry-run]`: preflight and
 * create annotated tags across the repositories listed in `sub_repos` from a
 * caller-supplied map `[{ repo, tag, ref?, message?, skip? }]`.
 *
 * Contract (the result shape is read by Phases 2-3 of the epic, so it is fixed
 * here and pinned by tests):
 *
 *   { ok, phase: 'preflight' | 'apply' | 'dry_run',
 *     repos: { [key]: { status, tag?, commit?, reason?, error?,
 *                       existing_commit?, requested_commit?, detached_head? } },
 *     created: string[],            // "repo:tag" for every tag written
 *     errors: [{ repo?, tag?, reason, error? }] }
 *
 * `key` is the normalized repo path. When one repo receives more than one
 * non-skipped entry (two tags), every entry of that repo is keyed `repo:tag`
 * instead, so no result is overwritten.
 *
 * Every entry is preflighted before the first write, so a predictable failure
 * (unknown repo, bad tag name, unresolved ref, conflicting tag) writes nothing
 * anywhere. Tag creation itself is not transactional across repositories: a
 * failure after the first write is reported with the list of tags already
 * written (`created`), never rolled back, and a re-run with the same map
 * reports those tags as `already_tagged` and retries only the failed ones.
 *
 * Nothing is pushed, no existing tag is ever overwritten, and every git call is
 * an argv array run with the target repository as cwd under a 15 s bound.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RELEASE_TAG_REASONS = exports.MAX_RELEASE_TAG_ENTRIES = void 0;
exports.preflightReleaseTags = preflightReleaseTags;
exports.createReleaseTags = createReleaseTags;
exports.cmdMilestoneReleaseTags = cmdMilestoneReleaseTags;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const shell_command_projection_cjs_1 = require("./shell-command-projection.cjs");
const security_cjs_1 = require("./security.cjs");
const command_arg_projection_cjs_1 = require("./command-arg-projection.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ioMod = require("./io.cjs");
const { output, ERROR_REASON } = ioMod;
const error = ioMod.error;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const configLoaderMod = require("./config-loader.cjs");
const { loadConfig } = configLoaderMod;
// ─── Constants ────────────────────────────────────────────────────────────
/** Maximum entries accepted in one request. Exactly this many are accepted. */
exports.MAX_RELEASE_TAG_ENTRIES = 256;
/** Bound on every git subprocess (ms). */
const RELEASE_TAG_GIT_TIMEOUT_MS = 15000;
/** Largest `--map` file read from disk (bytes). */
const MAX_MAP_FILE_BYTES = 1_048_576;
/** Every reason code this module can emit — a closed set, pinned against CONTEXT.md. */
exports.RELEASE_TAG_REASONS = Object.freeze([
    'no_sub_repos',
    'invalid_request',
    'too_many_entries',
    'repo_not_configured',
    'repo_path_invalid',
    'repo_missing',
    'not_a_git_repo',
    'tag_invalid',
    'ref_unresolved',
    'tag_conflict',
    'duplicate_entry',
    'git_timeout',
    'tag_create_failed',
]);
// ─── Helpers ──────────────────────────────────────────────────────────────
function newResult(phase) {
    // Null prototype: a hostile repo key such as `__proto__` is plain data.
    return { ok: true, phase, repos: Object.create(null), created: [], errors: [] };
}
function topLevelError(reason, message) {
    const result = newResult('preflight');
    result.ok = false;
    result.errors.push({ reason, error: message });
    return result;
}
function isPlainObject(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}
/**
 * Normalize a repository path to a forward-slash relative form, or null when
 * it is absolute, contains a `..` segment (either separator), a NUL, or is
 * empty. Backslashes are converted FIRST so `a\..\b` cannot slip past.
 */
function normalizeRepoPath(raw) {
    const s = raw.replace(/\\/g, '/');
    if (s === '' || s.includes('\0') || s.startsWith('/') || /^[A-Za-z]:/.test(s))
        return null;
    const segments = s.split('/');
    if (segments.includes('..'))
        return null;
    const kept = segments.filter((seg) => seg !== '' && seg !== '.');
    return kept.length === 0 ? null : kept.join('/');
}
function readSubRepos(cwd) {
    const config = loadConfig(cwd);
    const raw = config['sub_repos'];
    const out = new Set();
    if (!Array.isArray(raw))
        return out;
    for (const item of raw) {
        if (typeof item !== 'string')
            continue;
        const n = normalizeRepoPath(item);
        if (n !== null)
            out.add(n);
    }
    return out;
}
/** Validate request shape. Returns a top-level failure, or null when well-formed. */
function validateRequest(entries) {
    if (!Array.isArray(entries)) {
        return topLevelError('invalid_request', 'request must be a JSON array of entry objects');
    }
    if (entries.length > exports.MAX_RELEASE_TAG_ENTRIES) {
        return topLevelError('too_many_entries', `request has ${entries.length} entries; the limit is ${exports.MAX_RELEASE_TAG_ENTRIES}`);
    }
    const result = newResult('preflight');
    entries.forEach((entry, index) => {
        const where = `entry ${index}`;
        if (!isPlainObject(entry)) {
            result.errors.push({ reason: 'invalid_request', error: `${where}: must be an object` });
            return;
        }
        if (typeof entry['repo'] !== 'string') {
            result.errors.push({ reason: 'invalid_request', error: `${where}: "repo" must be a string` });
            return;
        }
        const repo = entry['repo'];
        if (entry['skip'] === true)
            return;
        if (entry['skip'] !== undefined && typeof entry['skip'] !== 'boolean') {
            result.errors.push({ repo, reason: 'invalid_request', error: `${where}: "skip" must be a boolean` });
        }
        if (typeof entry['tag'] !== 'string') {
            result.errors.push({ repo, reason: 'invalid_request', error: `${where}: "tag" must be a string` });
        }
        for (const field of ['ref', 'message']) {
            if (entry[field] !== undefined && typeof entry[field] !== 'string') {
                result.errors.push({ repo, reason: 'invalid_request', error: `${where}: "${field}" must be a string` });
            }
        }
    });
    if (result.errors.length > 0) {
        result.ok = false;
        return result;
    }
    return null;
}
// ─── Preflight ────────────────────────────────────────────────────────────
function runPreflight(cwd, entries, options, phase) {
    const shape = validateRequest(entries);
    if (shape)
        return { result: shape, plans: [] };
    const list = entries;
    const exec = options.execGit ?? shell_command_projection_cjs_1.execGit;
    const timeout = options.timeoutMs ?? RELEASE_TAG_GIT_TIMEOUT_MS;
    const run = (dir, args) => exec(args, { cwd: dir, timeout });
    const subRepos = readSubRepos(cwd);
    if (subRepos.size === 0) {
        return { result: topLevelError('no_sub_repos', 'no sub_repos configured in .planning/config.json'), plans: [] };
    }
    // A repo that receives more than one non-skipped entry is keyed `repo:tag`.
    const perRepo = new Map();
    for (const entry of list) {
        if (entry.skip === true)
            continue;
        const k = normalizeRepoPath(entry.repo) ?? entry.repo;
        perRepo.set(k, (perRepo.get(k) ?? 0) + 1);
    }
    // A repo given both a skip entry and a tag entry is contradictory; the check is
    // order-independent so preflight never reports `skipped` for a repo that gets tagged.
    const skippedRepos = new Set();
    for (const entry of list) {
        if (entry.skip === true)
            skippedRepos.add(normalizeRepoPath(entry.repo) ?? entry.repo);
    }
    const result = newResult(phase);
    const plans = [];
    const seen = new Set();
    for (const entry of list) {
        const rawRepo = entry.repo;
        const normalized = normalizeRepoPath(rawRepo);
        const repo = normalized ?? rawRepo;
        if (entry.skip === true) {
            const skipKey = `skip\0${repo}`;
            if (seen.has(skipKey)) {
                result.ok = false;
                result.errors.push({ repo, reason: 'duplicate_entry' });
            }
            else {
                seen.add(skipKey);
                // When the repo also has a tag entry, that entry records the duplicate_entry error
                // under the same key; writing `skipped` here would overwrite it order-dependently.
                if ((perRepo.get(repo) ?? 0) === 0)
                    result.repos[repo] = { status: 'skipped' };
            }
            continue;
        }
        const tag = entry.tag;
        const key = (perRepo.get(repo) ?? 0) > 1 ? `${repo}:${tag}` : repo;
        const fail = (reason, extra = {}) => {
            result.ok = false;
            result.repos[key] = { status: 'error', tag, reason, ...extra };
            result.errors.push({ repo, tag, reason, ...(extra.error ? { error: extra.error } : {}) });
        };
        if (skippedRepos.has(repo)) {
            fail('duplicate_entry', { error: 'repo has both a skip entry and a tag entry' });
            continue;
        }
        if (normalized === null || (0, security_cjs_1.tryWithinRoot)(normalized, cwd) === null) {
            fail('repo_path_invalid', { error: 'repo path must be relative and stay inside the project root' });
            continue;
        }
        if (!subRepos.has(normalized)) {
            fail('repo_not_configured', { error: 'repo is not listed in sub_repos' });
            continue;
        }
        const pairKey = `${normalized}\0${tag}`;
        if (seen.has(pairKey)) {
            result.ok = false;
            result.errors.push({ repo, tag, reason: 'duplicate_entry' });
            continue;
        }
        seen.add(pairKey);
        const dir = node_path_1.default.join(cwd, normalized);
        let isDir = false;
        try {
            isDir = node_fs_1.default.statSync(dir).isDirectory();
        }
        catch {
            isDir = false;
        }
        if (!isDir) {
            fail('repo_missing', { error: 'repo directory does not exist' });
            continue;
        }
        const top = run(dir, ['rev-parse', '--show-toplevel']);
        if ((0, shell_command_projection_cjs_1.isSpawnTimeout)(top)) {
            fail('git_timeout', { error: 'git rev-parse timed out' });
            continue;
        }
        let isOwnWorkTree = false;
        if (top.exitCode === 0) {
            try {
                // `.native` expands Windows 8.3 short names (RUNNER~1) the way git's long-form path does.
                isOwnWorkTree = node_fs_1.default.realpathSync.native(top.stdout) === node_fs_1.default.realpathSync.native(dir);
            }
            catch {
                isOwnWorkTree = false;
            }
        }
        if (!isOwnWorkTree) {
            fail('not_a_git_repo', { error: 'directory is not the root of a git work tree' });
            continue;
        }
        if (tag === '' || tag.startsWith('-') || tag.includes('\0')) {
            fail('tag_invalid', { error: 'tag name is empty or starts with "-"' });
            continue;
        }
        const fmt = run(dir, ['check-ref-format', `refs/tags/${tag}`]);
        if ((0, shell_command_projection_cjs_1.isSpawnTimeout)(fmt)) {
            fail('git_timeout', { error: 'git check-ref-format timed out' });
            continue;
        }
        if (fmt.exitCode !== 0) {
            fail('tag_invalid', { error: 'tag name rejected by git check-ref-format' });
            continue;
        }
        const refOmitted = entry.ref === undefined;
        const ref = entry.ref ?? 'HEAD';
        if (ref === '' || ref.startsWith('-') || ref.includes('\0')) {
            fail('ref_unresolved', { error: 'ref is empty or starts with "-"' });
            continue;
        }
        const resolved = run(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
        if ((0, shell_command_projection_cjs_1.isSpawnTimeout)(resolved)) {
            fail('git_timeout', { error: 'git rev-parse timed out' });
            continue;
        }
        if (resolved.exitCode !== 0 || resolved.stdout === '') {
            fail('ref_unresolved', { error: `ref "${ref}" does not resolve to a commit` });
            continue;
        }
        const commit = resolved.stdout;
        let detached;
        if (refOmitted) {
            const head = run(dir, ['symbolic-ref', '-q', 'HEAD']);
            if ((0, shell_command_projection_cjs_1.isSpawnTimeout)(head)) {
                fail('git_timeout', { error: 'git symbolic-ref timed out' });
                continue;
            }
            if (head.exitCode === 1)
                detached = true;
        }
        const existing = run(dir, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`]);
        if ((0, shell_command_projection_cjs_1.isSpawnTimeout)(existing)) {
            fail('git_timeout', { error: 'git rev-parse timed out' });
            continue;
        }
        if (existing.exitCode === 0 && existing.stdout !== '') {
            if (existing.stdout === commit) {
                result.repos[key] = { status: 'already_tagged', tag, commit, ...(detached ? { detached_head: true } : {}) };
            }
            else {
                fail('tag_conflict', {
                    error: 'tag already exists at a different commit',
                    existing_commit: existing.stdout,
                    requested_commit: commit,
                });
            }
            continue;
        }
        const anyRef = run(dir, ['show-ref', '--verify', '--quiet', `refs/tags/${tag}`]);
        if ((0, shell_command_projection_cjs_1.isSpawnTimeout)(anyRef)) {
            fail('git_timeout', { error: 'git show-ref timed out' });
            continue;
        }
        if (anyRef.exitCode === 0) {
            fail('tag_conflict', {
                error: 'tag already exists and does not point at a commit',
                existing_commit: null,
                requested_commit: commit,
            });
            continue;
        }
        result.repos[key] = { status: 'would_create', tag, commit, ...(detached ? { detached_head: true } : {}) };
        plans.push({
            key,
            repo: normalized,
            dir,
            tag,
            message: entry.message === undefined || entry.message === '' ? tag : entry.message,
            commit,
            ...(detached ? { detached: true } : {}),
        });
    }
    return { result, plans };
}
/** Validate a request without writing anything. */
function preflightReleaseTags(cwd, entries, options = {}) {
    return runPreflight(cwd, entries, options, 'preflight').result;
}
/**
 * Preflight, then (unless `dryRun`) create each annotated tag in its own repo.
 * A preflight failure returns before any write. A creation failure does not
 * stop the remaining repos; the result lists every tag already written.
 */
function createReleaseTags(cwd, entries, options = {}) {
    const dryRun = options.dryRun === true;
    const { result, plans } = runPreflight(cwd, entries, options, dryRun ? 'dry_run' : 'apply');
    if (!result.ok) {
        result.phase = 'preflight';
        return result;
    }
    if (dryRun)
        return result;
    const exec = options.execGit ?? shell_command_projection_cjs_1.execGit;
    const timeout = options.timeoutMs ?? RELEASE_TAG_GIT_TIMEOUT_MS;
    for (const plan of plans) {
        const r = exec(['tag', '-a', '--message', plan.message, '--', plan.tag, plan.commit], { cwd: plan.dir, timeout });
        if (r.exitCode === 0) {
            result.repos[plan.key] = {
                status: 'created',
                tag: plan.tag,
                commit: plan.commit,
                ...(plan.detached ? { detached_head: true } : {}),
            };
            result.created.push(`${plan.repo}:${plan.tag}`);
            continue;
        }
        const reason = (0, shell_command_projection_cjs_1.isSpawnTimeout)(r) ? 'git_timeout' : 'tag_create_failed';
        const message = r.stderr || r.stdout || ((0, shell_command_projection_cjs_1.isSpawnTimeout)(r) ? 'git tag timed out' : 'git tag failed');
        result.ok = false;
        result.repos[plan.key] = { status: 'failed', tag: plan.tag, commit: plan.commit, reason, error: message };
        result.errors.push({ repo: plan.repo, tag: plan.tag, reason, error: message });
    }
    return result;
}
// ─── CLI adapter ──────────────────────────────────────────────────────────
/**
 * `milestone release-tags --map <file> [--dry-run]`. `args` is the full argv
 * tail (`['milestone', 'release-tags', ...flags]`). Prints the result as JSON
 * and sets a non-zero exit code when `ok` is false.
 */
function cmdMilestoneReleaseTags(cwd, args, raw) {
    const parsed = (0, command_arg_projection_cjs_1.parseNamedArgsOrExit)(args, { valueFlags: ['map'], booleanFlags: ['dry-run'], positionals: 2 }, error);
    const mapArg = parsed['map'];
    if (typeof mapArg !== 'string' || mapArg === '') {
        error('--map <path-to-json-file> required for milestone release-tags', ERROR_REASON.USAGE);
        return;
    }
    // A relative --map is relative to the shell's working directory, not the project root.
    const mapPath = node_path_1.default.resolve(process.cwd(), mapArg);
    let mapStat = null;
    let statError = '';
    try {
        mapStat = node_fs_1.default.statSync(mapPath);
    }
    catch (e) {
        statError = e instanceof Error ? e.message : String(e);
    }
    if (mapStat === null) {
        error(`cannot read --map file: ${statError}`, ERROR_REASON.USAGE);
        return;
    }
    // A FIFO or device reports size 0 and would bypass the size cap on read.
    if (!mapStat.isFile()) {
        error('--map must be a regular file', ERROR_REASON.USAGE);
        return;
    }
    if (mapStat.size > MAX_MAP_FILE_BYTES) {
        error(`--map file exceeds ${MAX_MAP_FILE_BYTES} byte limit (got ${mapStat.size})`, ERROR_REASON.USAGE);
        return;
    }
    let text = '';
    try {
        text = node_fs_1.default.readFileSync(mapPath, 'utf-8');
    }
    catch (e) {
        error(`cannot read --map file: ${e instanceof Error ? e.message : String(e)}`, ERROR_REASON.USAGE);
        return;
    }
    const json = (0, security_cjs_1.safeJsonParse)(text, { maxLength: MAX_MAP_FILE_BYTES, label: '--map file' });
    const result = json.ok
        ? createReleaseTags(cwd, json.value, { dryRun: parsed['dry-run'] === true })
        : topLevelError('invalid_request', json.error);
    output(result, raw);
    if (!result.ok)
        process.exitCode = 1;
}
