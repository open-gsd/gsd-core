"use strict";
/**
 * Project Context Module — ADR-4908 §1-§3 (#6043, Phase 1 of #4908).
 *
 * `resolveProjectContext(startDir, { explicit })` is the only code that decides
 * which root a process acts in. It answers four questions once and returns a
 * frozen value: where the `.planning` entry is (`projectRoot`), where its
 * content really lives (`planningRoot`), which checkout the process runs in
 * (`worktreeRoot`) and which checkout is the main one (`repoRoot`).
 *
 * Git is consulted through the shell-projection seam, bounded by
 * `DEFAULT_GIT_TIMEOUT_MS`, and never throws: a timeout or spawn failure
 * degrades to the lexical answer and is reported in `provenance`.
 *
 * The `.planning` ancestor walk (`walkUpForPlanning`) is the algorithm that
 * lived in `project-root.cts` (#1362, #1414, #1422, #2843, #4815, #5624, #5759),
 * moved here unchanged apart from the provenance tag it returns. It never
 * spawns git: `findProjectRoot` in `project-root.cts` still delegates to it
 * and is called per tool call from the isolation-sentinel hook.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.walkUpForPlanning = walkUpForPlanning;
exports.resolveProjectContext = resolveProjectContext;
exports.legacyDispatchCwd = legacyDispatchCwd;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const node_os_1 = __importDefault(require("node:os"));
// eslint-disable-next-line @typescript-eslint/no-require-imports -- config-file-read.cjs is an export= CommonJS module
const configFileReadMod = require("./config-file-read.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports -- worktree-safety.cjs is an export= CommonJS module
const worktreeSafetyMod = require("./worktree-safety.cjs");
const shell_command_projection_cjs_1 = require("./shell-command-projection.cjs");
const { readConfigFileBounded } = configFileReadMod;
const { DEFAULT_GIT_TIMEOUT_MS, parseWorktreeEntries } = worktreeSafetyMod;
const FIND_PROJECT_ROOT_MAX_DEPTH = 10;
function walkUpForPlanning(startDir) {
    let resolvedStart;
    try {
        resolvedStart = node_path_1.default.resolve(startDir);
    }
    catch {
        return { root: startDir, source: 'none' };
    }
    const fsRoot = node_path_1.default.parse(resolvedStart).root;
    const home = node_os_1.default.homedir();
    let realHome = null;
    // A relative `$HOME` (`HOME=.`) would resolve against the process cwd and
    // make that directory count as `$HOME`; keep the spelled comparison for it.
    if (node_path_1.default.isAbsolute(home)) {
        try {
            realHome = node_fs_1.default.realpathSync.native(home);
        }
        catch {
            // no `$HOME` on disk: only the spelled comparison applies
        }
    }
    // #5624: the `$HOME` stop holds however `$HOME` or the walked path is
    // spelled. With `/home/me -> /data/me`, a cwd spelled `/data/me/...` (what
    // `process.cwd()` reports) never has `/home/me` as a parent, so comparing
    // spellings alone walked past `$HOME`. The isolation hooks resolve through
    // this function too, so they keep the same boundary (#3050).
    function isHome(d) {
        if (d === home)
            return true;
        if (realHome === null)
            return false;
        try {
            return node_fs_1.default.realpathSync.native(d) === realHome;
        }
        catch {
            return false;
        }
    }
    // If startDir already contains .planning/, it IS the project root.
    try {
        const ownPlanningDir = resolvedStart + node_path_1.default.sep + '.planning';
        if (node_fs_1.default.existsSync(ownPlanningDir) && node_fs_1.default.statSync(ownPlanningDir).isDirectory()) {
            return { root: startDir, source: 'ancestor' };
        }
    }
    catch {
        // fall through
    }
    // #5624: started at `$HOME` itself, with no `.planning/` of its own, there is
    // nothing to walk: every ancestor is above `$HOME`.
    if (isHome(resolvedStart))
        return { root: startDir, source: 'none' };
    // A `.planning` that is itself a symlink is a deliberate hop into a separate
    // tree (the documented "keep planning content out of the tracked repo"
    // convention: `.planning -> ~/.gsd-external-planning/<project>/`, its own git
    // repo). `fs.existsSync(d + '/.git')` DEREFERENCES `d`, so at `d ===
    // <the .planning symlink path>` it finds the EXTERNAL store's `.git`, and
    // both isInsideGitRepo/nearestGitRoot misread it as a crossed nested-child-
    // repo boundary (#2843's guard). `fs.lstatSync` does not dereference its
    // final path component, so it answers "is `d` ITSELF a symlink" (#4815).
    //
    // Deliberately scoped to a symlink named `.planning`, NOT any symlinked
    // directory: a nested child repo reached through some other symlinked
    // ancestor is still a real repo boundary, and skipping it would reopen
    // #2843 through a different trigger.
    function isSymlinkedPlanningDir(d) {
        if (node_path_1.default.basename(d) !== '.planning')
            return false;
        try {
            return node_fs_1.default.lstatSync(d).isSymbolicLink();
        }
        catch {
            return false;
        }
    }
    // Walk upward, mirroring isInsideGitRepo from the CJS reference.
    function isInsideGitRepo(candidateParent) {
        let d = resolvedStart;
        while (d !== fsRoot) {
            try {
                if (!isSymlinkedPlanningDir(d) && node_fs_1.default.existsSync(d + node_path_1.default.sep + '.git'))
                    return true;
            }
            catch {
                // ignore
            }
            if (d === candidateParent)
                break;
            const next = node_path_1.default.dirname(d);
            if (next === d)
                break;
            d = next;
        }
        return false;
    }
    // #2843: nearest ancestor (including `from` itself) that contains a `.git`,
    // bounded by `upTo` (exclusive). Returns the git-repo root, or null if none
    // exists before `upTo` / the filesystem root. Used to detect a NESTED child
    // repo whose root is strictly below a candidate ancestor `.planning/` — in
    // that case the caller's repo boundary sits between start and the ancestor,
    // so trusting the ancestor's `.planning/` would silently cross into a
    // different project. (No `git` subprocess — fs walk only, matching
    // isInsideGitRepo's deliberate no-spawn contract.)
    function nearestGitRoot(from, upTo) {
        let d = from;
        while (d !== fsRoot) {
            if (d === upTo)
                break;
            try {
                if (!isSymlinkedPlanningDir(d) && node_fs_1.default.existsSync(d + node_path_1.default.sep + '.git'))
                    return d;
            }
            catch {
                // ignore
            }
            const next = node_path_1.default.dirname(d);
            if (next === d)
                break;
            d = next;
        }
        return null;
    }
    let dir = resolvedStart;
    let depth = 0;
    while (dir !== fsRoot && depth < FIND_PROJECT_ROOT_MAX_DEPTH) {
        const parent = node_path_1.default.dirname(dir);
        if (parent === dir)
            break;
        if (isHome(parent))
            break;
        const parentPlanning = parent + node_path_1.default.sep + '.planning';
        let parentPlanningIsDir = false;
        try {
            parentPlanningIsDir = node_fs_1.default.existsSync(parentPlanning) && node_fs_1.default.statSync(parentPlanning).isDirectory();
        }
        catch {
            parentPlanningIsDir = false;
        }
        if (parentPlanningIsDir) {
            const configPath = parentPlanning + node_path_1.default.sep + 'config.json';
            let matched = false;
            try {
                // Bounded read (#5759): a FIFO/device/oversized config throws and is skipped like a
                // missing one. An absent file (null) becomes '' so JSON.parse throws into the same catch.
                const raw = readConfigFileBounded(configPath) ?? '';
                const config = JSON.parse(raw);
                if (config && typeof config === 'object') {
                    const cfg = config;
                    const subReposValue = cfg['sub_repos'] ??
                        (cfg['planning'] && typeof cfg['planning'] === 'object'
                            ? cfg['planning']['sub_repos']
                            : undefined);
                    const subRepos = Array.isArray(subReposValue) ? subReposValue : [];
                    if (subRepos.length > 0) {
                        const relPath = node_path_1.default.relative(parent, resolvedStart);
                        const topSegment = relPath.split(node_path_1.default.sep)[0];
                        if (subRepos.includes(topSegment)) {
                            return { root: parent, source: 'workspace' };
                        }
                    }
                    if (cfg['multiRepo'] === true && isInsideGitRepo(parent)) {
                        matched = true;
                    }
                }
            }
            catch {
                // config.json missing or unparseable — fall through to .git heuristic.
            }
            if (matched)
                return { root: parent, source: 'ancestor' };
            // Heuristic (3): parent has .planning/ and we're inside a git repo.
            // Before returning, check if any further ancestor has sub_repos that explicitly
            // claims our startDir — explicit sub_repos config takes precedence over the
            // implicit .git signal. (#1422)
            if (isInsideGitRepo(parent)) {
                // #2843: do NOT cross a git-repo boundary. If the caller is inside its
                // OWN nested repo whose root is strictly below `parent`, trusting
                // `parent`'s .planning/ would silently resolve to a DIFFERENT project.
                // isInsideGitRepo only proved SOME .git exists between start and parent;
                // verify that .git is parent's own (or absent between), not a nested
                // child repo. If nearestGitRoot finds a .git strictly below parent,
                // the boundary is crossed — fall through (do not return parent).
                if (nearestGitRoot(resolvedStart, parent) !== null) {
                    dir = parent;
                    depth += 1;
                    continue;
                }
                // Lookahead: walk ancestors above `parent` to find a sub_repos claim.
                let ancestor = node_path_1.default.dirname(parent);
                let ancestorDepth = 0;
                while (ancestor !== fsRoot && !isHome(ancestor) && ancestorDepth < FIND_PROJECT_ROOT_MAX_DEPTH) {
                    const ancestorPlanning = ancestor + node_path_1.default.sep + '.planning';
                    try {
                        if (node_fs_1.default.existsSync(ancestorPlanning) && node_fs_1.default.statSync(ancestorPlanning).isDirectory()) {
                            const ancestorConfig = ancestor + node_path_1.default.sep + '.planning' + node_path_1.default.sep + 'config.json';
                            const rawA = readConfigFileBounded(ancestorConfig) ?? ''; // #5759: bounded; '' makes JSON.parse throw into the catch
                            const cfgA = JSON.parse(rawA);
                            const subReposValueA = cfgA['sub_repos'] ??
                                (cfgA['planning'] && typeof cfgA['planning'] === 'object'
                                    ? cfgA['planning']['sub_repos']
                                    : undefined);
                            const subReposA = Array.isArray(subReposValueA) ? subReposValueA : [];
                            if (subReposA.length > 0) {
                                const relPathA = node_path_1.default.relative(ancestor, resolvedStart);
                                const topSegmentA = relPathA.split(node_path_1.default.sep)[0];
                                if (subReposA.includes(topSegmentA)) {
                                    return { root: ancestor, source: 'workspace' };
                                }
                            }
                        }
                    }
                    catch {
                        // ignore — config missing or unparseable, keep walking
                    }
                    const nextAncestor = node_path_1.default.dirname(ancestor);
                    if (nextAncestor === ancestor)
                        break;
                    ancestor = nextAncestor;
                    ancestorDepth += 1;
                }
                return { root: parent, source: 'ancestor' };
            }
        }
        dir = parent;
        depth += 1;
    }
    // Heuristic (4): nearest ancestor .planning/ — last resort before fallback.
    // Runs only after heuristics (1)–(3) have been exhausted without a match,
    // ensuring sub_repos / multiRepo / .git-based resolution always wins when
    // applicable. Walks upward again within the same FIND_PROJECT_ROOT_MAX_DEPTH
    // bound; returns the nearest ancestor directory that contains a .planning/
    // subdirectory so config resolves correctly when invoked from a plain
    // descendant of a single-repo project. (#1414)
    let dir2 = resolvedStart;
    let depth2 = 0;
    while (dir2 !== fsRoot && depth2 < FIND_PROJECT_ROOT_MAX_DEPTH) {
        const parent2 = node_path_1.default.dirname(dir2);
        if (parent2 === dir2)
            break;
        try {
            const candidatePlanning = parent2 + node_path_1.default.sep + '.planning';
            if (node_fs_1.default.existsSync(candidatePlanning) && node_fs_1.default.statSync(candidatePlanning).isDirectory()) {
                // #2843: do not cross a git-repo boundary. If the caller is inside its
                // own nested repo (a .git strictly below parent2), parent2's .planning/
                // belongs to a DIFFERENT project — keep walking is wrong; stop and fall
                // through to the startDir fallback instead of silently resolving to the
                // ancestor project. (Reached only when no .git exists anywhere in the
                // chain per the triage, but guard defensively.)
                if (nearestGitRoot(resolvedStart, parent2) !== null) {
                    break;
                }
                return { root: parent2, source: 'ancestor' };
            }
        }
        catch {
            // ignore fs errors and continue walking
        }
        if (isHome(parent2))
            break;
        dir2 = parent2;
        depth2 += 1;
    }
    return { root: startDir, source: 'none' };
}
const GIT_TIMED_OUT_WARNING = 'git timed out while resolving the project context; roots fall back to what git had answered or the start directory';
const GIT_UNAVAILABLE_WARNING = 'git could not be run while resolving the project context; roots fall back to what git had answered or the start directory';
const GIT_ERROR_WARNING = 'git failed while resolving the project context; roots fall back to the start directory';
const GIT_WORKTREE_LIST_WARNING = 'git worktree list failed while resolving the project context; the main checkout is taken to be the current checkout';
function lexicalFacts(start, reason, degraded, warnings) {
    return { worktreeRoot: start, repoRoot: start, gitCommonDir: null, reason, degraded, warnings };
}
function readGitFacts(start, execGit) {
    const run = (args) => {
        try {
            return execGit(args, { cwd: start, timeout: DEFAULT_GIT_TIMEOUT_MS });
        }
        catch (err) {
            // The seam never throws; an injected stand-in might. Same degradation as a spawn failure.
            return { exitCode: 1, stdout: '', stderr: '', signal: null, error: err instanceof Error ? err : new Error(String(err)), timedOut: false };
        }
    };
    const rev = run(['rev-parse', '--show-toplevel', '--git-dir', '--git-common-dir']);
    if (rev.timedOut)
        return lexicalFacts(start, 'git_timed_out', true, [GIT_TIMED_OUT_WARNING]);
    if (rev.error)
        return lexicalFacts(start, 'git_unavailable', true, [GIT_UNAVAILABLE_WARNING]);
    if (rev.exitCode !== 0) {
        // Only git's own "not a git repository" is a claim about the directory; any other
        // failure (dubious ownership, corrupt repo) says nothing, so it degrades.
        if (/not a git repository/i.test(String(rev.stderr || '')))
            return lexicalFacts(start, 'not_git_repo', false, []);
        return lexicalFacts(start, 'git_error', true, [GIT_ERROR_WARNING]);
    }
    const [topText = '', gitDirText = '', commonText = ''] = String(rev.stdout || '')
        .split(/\r?\n/)
        .map((line) => line.trim());
    if (topText === '')
        return lexicalFacts(start, 'not_git_repo', false, []);
    const worktreeRoot = node_path_1.default.resolve(start, topText);
    const gitCommonDir = commonText !== '' ? node_path_1.default.resolve(start, commonText) : null;
    const linked = gitDirText !== '' && gitCommonDir !== null && node_path_1.default.resolve(start, gitDirText) !== gitCommonDir;
    // A main checkout is its own repo root: no second git process.
    if (!linked) {
        return { worktreeRoot, repoRoot: worktreeRoot, gitCommonDir, reason: 'ok', degraded: false, warnings: [] };
    }
    const listed = run(['worktree', 'list', '--porcelain']);
    if (listed.timedOut)
        return { worktreeRoot, repoRoot: worktreeRoot, gitCommonDir, reason: 'git_timed_out', degraded: true, warnings: [GIT_TIMED_OUT_WARNING] };
    if (listed.error)
        return { worktreeRoot, repoRoot: worktreeRoot, gitCommonDir, reason: 'git_unavailable', degraded: true, warnings: [GIT_UNAVAILABLE_WARNING] };
    if (listed.exitCode !== 0) {
        return { worktreeRoot, repoRoot: worktreeRoot, gitCommonDir, reason: 'worktree_list_failed', degraded: true, warnings: [GIT_WORKTREE_LIST_WARNING] };
    }
    const firstNonBare = parseWorktreeEntries(listed.stdout).find((entry) => !entry.bare);
    if (firstNonBare) {
        return { worktreeRoot, repoRoot: node_path_1.default.resolve(start, firstNonBare.path), gitCommonDir, reason: 'ok', degraded: false, warnings: [] };
    }
    return { worktreeRoot, repoRoot: worktreeRoot, gitCommonDir, reason: 'bare_main_worktree', degraded: false, warnings: [] };
}
// ─── Resolver ─────────────────────────────────────────────────────────────────
function sameCheckout(a, b, realpath) {
    if (a === b)
        return true;
    try {
        return realpath(a) === realpath(b);
    }
    catch {
        return false;
    }
}
function resolveProjectContext(startDir, opts = {}) {
    const execGit = opts.deps?.execGit ?? shell_command_projection_cjs_1.execGit;
    const realpath = opts.deps?.fs?.realpathSync ?? node_fs_1.default.realpathSync.native;
    const explicit = opts.explicit ? node_path_1.default.resolve(opts.explicit) : null;
    const start = explicit ?? node_path_1.default.resolve(startDir);
    const facts = readGitFacts(start, execGit);
    const isLinkedWorktree = !sameCheckout(facts.worktreeRoot, facts.repoRoot, realpath);
    let projectRoot = start;
    let source = 'none';
    if (explicit) {
        projectRoot = explicit;
        source = 'explicit';
    }
    else {
        const walked = walkUpForPlanning(start);
        if (walked.source !== 'none') {
            projectRoot = walked.root;
            source = walked.source;
        }
        else if (isLinkedWorktree) {
            const fromMain = walkUpForPlanning(facts.repoRoot);
            if (fromMain.source !== 'none') {
                projectRoot = fromMain.root;
                source = 'main-checkout';
            }
        }
    }
    const lexicalPlanning = node_path_1.default.join(projectRoot, '.planning');
    let planningRoot = lexicalPlanning;
    try {
        planningRoot = realpath(lexicalPlanning);
    }
    catch {
        // no `.planning` on disk (source: none) or unreadable: the lexical path stands
    }
    const provenance = Object.freeze({
        source,
        reason: facts.reason,
        degraded: facts.degraded,
        warnings: Object.freeze([...facts.warnings]),
    });
    return Object.freeze({
        projectRoot,
        planningRoot,
        worktreeRoot: facts.worktreeRoot,
        repoRoot: facts.repoRoot,
        gitCommonDir: facts.gitCommonDir,
        isLinkedWorktree,
        provenance,
    });
}
/**
 * Transitional cwd for SKIP_ROOT_RESOLUTION commands and the workstream
 * resolution input (Phase 2 deletes this as it migrates skip commands to named
 * fields). Equivalent to the retired `resolveMainWorktreeCwd` remap for
 * non-bare, non-submodule layouts; for bare-main and submodule layouts it uses
 * the first non-bare `git worktree list` entry (the old `dirname(git-common-dir)`
 * pointed at a non-checkout there). The remap: the start
 * directory when it owns `.planning/`; otherwise, inside a linked worktree,
 * that worktree's top level when it owns `.planning/`, else the main checkout;
 * outside a linked worktree the start directory unchanged.
 */
function legacyDispatchCwd(ctx, startDir) {
    if (node_fs_1.default.existsSync(node_path_1.default.join(startDir, '.planning')))
        return startDir;
    if (!ctx.isLinkedWorktree)
        return startDir;
    if (node_fs_1.default.existsSync(node_path_1.default.join(ctx.worktreeRoot, '.planning')))
        return ctx.worktreeRoot;
    return ctx.repoRoot;
}
