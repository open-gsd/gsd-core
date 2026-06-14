"use strict";
/**
 * Git Base-Branch Resolver — issue #1146.
 *
 * Single source of truth for detecting the repository's default branch.
 * Replaces the duplicated per-workflow bash detection that only consulted
 * `refs/remotes/origin/HEAD` then hardcoded `:-main`, which silently
 * returned "main" for repos whose default branch is "master" whenever
 * origin/HEAD was unset (git init + remote add / fetch without set-head /
 * most CI checkouts / many worktrees).
 *
 * Precedence ladder (highest to lowest):
 *   1. `git.base_branch` config override from .planning/config.json
 *   2. `git symbolic-ref --short refs/remotes/origin/HEAD`  (fast, no network)
 *   3. `git remote show origin` HEAD branch  ← AUTHORITATIVE; works when #2 unset
 *   4. Local branch existence: "master" present + "main" absent → "master";
 *      "main" present → "main"
 *   5. "main"  (last-resort default)
 *
 * Every git subprocess is bounded with a timeout (≤ 30 s); on timeout/error
 * the resolver degrades gracefully to the next tier — it never throws.
 *
 * Pure/testable: all I/O is injectable via the `deps` argument so unit
 * tests can run without touching the real filesystem or spawning real git.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.readConfigBaseBranch = readConfigBaseBranch;
exports.trySymbolicRef = trySymbolicRef;
exports.tryRemoteShow = tryRemoteShow;
exports.tryLocalBranch = tryLocalBranch;
exports.resolveBaseBranch = resolveBaseBranch;
exports.cmdGitBaseBranch = cmdGitBaseBranch;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const shell_command_projection_cjs_1 = require("./shell-command-projection.cjs");
// ─── Helpers ──────────────────────────────────────────────────────────────────
/**
 * Safely look up `git.base_branch` from the project's config.json.
 * Returns the configured value (a non-empty, non-null string) or null.
 */
function readConfigBaseBranch(planningDir, deps) {
    const readFile = deps?.readFile ??
        ((p) => { try {
            return node_fs_1.default.readFileSync(p, 'utf8');
        }
        catch {
            return null;
        } });
    const configPath = node_path_1.default.join(planningDir, 'config.json');
    const raw = readFile(configPath);
    if (!raw)
        return null;
    let cfg;
    try {
        cfg = JSON.parse(raw);
    }
    catch {
        return null;
    }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg))
        return null;
    const top = cfg;
    // Support both "git.base_branch" (nested) and "base_branch" (flat legacy)
    const gitSection = top.git;
    if (gitSection && typeof gitSection === 'object' && !Array.isArray(gitSection)) {
        const nested = gitSection.base_branch;
        if (typeof nested === 'string' && nested.trim())
            return nested.trim();
    }
    const flat = top.base_branch;
    if (typeof flat === 'string' && flat.trim())
        return flat.trim();
    return null;
}
/**
 * Try `git symbolic-ref --short refs/remotes/origin/HEAD` (no network).
 * Strips the `origin/` prefix to return just the branch name.
 * Returns null if unset or on error/timeout.
 */
function trySymbolicRef(cwd, execGit) {
    try {
        const r = execGit(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { cwd, timeout: 5_000 });
        if (r.exitCode !== 0 || !r.stdout)
            return null;
        // Output is e.g. "origin/main" — strip the prefix
        const branch = r.stdout.trim().replace(/^origin\//, '');
        return branch || null;
    }
    catch {
        return null;
    }
}
/**
 * Try `git remote show origin` to read the HEAD branch.
 * This is authoritative when origin/HEAD is unset locally.
 * Requires network access but succeeds in the common CI case where
 * origin/HEAD was never set after `git init && git remote add origin`.
 *
 * Parses the line:  `HEAD branch: <name>`
 * Returns null on error, timeout, or if the output is malformed.
 */
function tryRemoteShow(cwd, execGit) {
    try {
        const r = execGit(['remote', 'show', 'origin'], { cwd, timeout: 15_000 });
        if (r.exitCode !== 0 || !r.stdout)
            return null;
        // The line looks like: "  HEAD branch: master"
        const m = r.stdout.match(/^\s*HEAD branch:\s*(\S+)\s*$/m);
        if (!m)
            return null;
        const branch = m[1];
        // git emits "(unknown)" when the remote is offline but the local cache
        // resolved it; treat that as non-authoritative and fall through.
        if (!branch || branch === '(unknown)')
            return null;
        return branch;
    }
    catch {
        return null;
    }
}
/**
 * Detect local branch existence as a tie-breaker when no remote info is available.
 *
 * Rules:
 *   - "master" present AND "main" absent → "master"
 *   - "main" present → "main"
 *   - Neither → null (fall through to default)
 *
 * Returns null on error/timeout.
 */
function tryLocalBranch(cwd, execGit) {
    try {
        const r = execGit(['branch', '--list', 'main', 'master'], { cwd, timeout: 5_000 });
        if (r.exitCode !== 0 || !r.stdout)
            return null;
        // `git branch --list main master` outputs one line per matching branch
        const lines = r.stdout.split('\n').map(l => l.trim().replace(/^\*\s*/, ''));
        const hasMain = lines.includes('main');
        const hasMaster = lines.includes('master');
        if (hasMaster && !hasMain)
            return 'master';
        if (hasMain)
            return 'main';
        return null;
    }
    catch {
        return null;
    }
}
/**
 * Resolve the default/base branch for the repository at `cwd`.
 *
 * Consults the full precedence ladder and always returns a non-empty string.
 * Never throws.
 */
function resolveBaseBranch(cwd, deps) {
    const execGit = deps?.execGit ?? shell_command_projection_cjs_1.execGit;
    // Derive .planning dir relative to cwd (mirrors planningDir() in core.cjs)
    const planningDir = node_path_1.default.join(cwd, '.planning');
    // 1. Config override
    const configured = readConfigBaseBranch(planningDir, deps);
    if (configured)
        return configured;
    // 2. symbolic-ref (fast, no network)
    const symref = trySymbolicRef(cwd, execGit);
    if (symref)
        return symref;
    // 3. git remote show origin (authoritative when origin/HEAD unset)
    const remoteShow = tryRemoteShow(cwd, execGit);
    if (remoteShow)
        return remoteShow;
    // 4. Local branch existence
    const local = tryLocalBranch(cwd, execGit);
    if (local)
        return local;
    // 5. Last-resort default
    return 'main';
}
// ─── CLI entry point ──────────────────────────────────────────────────────────
/**
 * CLI command: `gsd-tools git base-branch`
 * Resolves the default branch and writes it to stdout (raw string, newline-terminated).
 * Called by workflows via `gsd_run query git.base-branch`.
 */
function cmdGitBaseBranch(cwd, _args, deps) {
    const branch = resolveBaseBranch(cwd, deps);
    const write = deps?.write ?? ((s) => process.stdout.write(s));
    write(branch + '\n');
    return branch;
}
