"use strict";
/**
 * Evaluation-scope resolver (#5164, epic #5056, ADR-5057 §4 second bullet): the ONE answer to
 * "which commits and which file set does this gate or workflow step evaluate for this plan,
 * phase or quick task".
 *
 * Before this module every consumer derived its own answer — `HEAD~1..HEAD`, `DIFF_BASE..HEAD`,
 * `git log --all --grep` — and all of them disagreed with each other and with the work they
 * meant to scope. Three constraints from the design lock hold here:
 *
 *   1. The scope is the UNION of each commit's own file set, never a range. A range keeps every
 *      interleaved non-phase commit in its window (measured on a 9,676-commit repo: the range
 *      held 23, 194 and 602 files where the union of the phase's commits held 9, 42 and 69).
 *   2. Only commits reachable from the evaluated ref count (`git log --all` is gone). A commit
 *      that lives only on another branch is NAMED in `unreachable` and contributes nothing.
 *   3. An empty union never becomes an empty scope that reviews nothing and reports success. It
 *      degrades to wider evidence (the phase-directory range) and SAYS so (`status: 'degraded'`,
 *      `reason`). What the union drops is named by path, not counted: `outsideUnion` (range
 *      minus union) and `missingOnDisk` (scoped paths that no longer exist).
 *
 * A phase's commits are the `## Task Commits` rows of its SUMMARY files (path-anchored: no commit
 * message grep, the class re-fixed in #2989/#3191/#3503/#3995). A plan's commits are the
 * reachable commits whose SUBJECT is `<type>(<phase>-<plan>):`, anchored and zero-padding
 * tolerant (#4003). The row parse is a port of the byte-parity model from the closed PR #4127.
 *
 * Every git call goes through the `execGit` seam, which bounds each subprocess (its default
 * budget); a timeout or a missing git is `unresolvable`, never a throw and never an empty scope.
 *
 * A gate module: imports no io module and writes nothing; `evaluateEvaluationScope` returns a
 * `GateResult` the command router formats (`check evaluation-scope`).
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_COMMITS_CEILING = exports.SCOPE_EXCLUSION_PATHSPECS = void 0;
exports.extractTaskCommitRefs = extractTaskCommitRefs;
exports.qualifiedPlanSubjectPattern = qualifiedPlanSubjectPattern;
exports.planSubjectPattern = planSubjectPattern;
exports.isSafeRefArgument = isSafeRefArgument;
exports.isSafeDateArgument = isSafeDateArgument;
exports.commitIsAncestor = commitIsAncestor;
exports.resolveEvaluationScope = resolveEvaluationScope;
exports.parseGitVersion = parseGitVersion;
exports.remergeDiffSupported = remergeDiffSupported;
exports.evaluateEvaluationScope = evaluateEvaluationScope;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const shell_command_projection_cjs_1 = require("./shell-command-projection.cjs");
const gate_verdict_cjs_1 = require("./gate-verdict.cjs");
const gate_phase_context_cjs_1 = require("./gate-phase-context.cjs");
const pattern_cjs_1 = require("./pattern.cjs");
const security_cjs_1 = require("./security.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const planningWorkspaceMod = require("./planning-workspace.cjs");
const { readScopedConfigValue } = planningWorkspaceMod;
const gate_evidence_cjs_1 = require("./gate-evidence.cjs");
// ─── Constants ────────────────────────────────────────────────────────────────
/** Paths that are never part of a code-review or UI scope (planning artifacts, lockfiles). */
exports.SCOPE_EXCLUSION_PATHSPECS = Object.freeze([
    ':!.planning/', ':!ROADMAP.md', ':!STATE.md',
    ':!*-SUMMARY.md', ':!*-VERIFICATION.md', ':!*-PLAN.md',
    ':!package-lock.json', ':!yarn.lock', ':!Gemfile.lock', ':!poetry.lock',
]);
/** 41 chars per sha; 400 of them stay well under the 28K Windows-safe argv chunk. */
const SHA_CHUNK = 400;
const DEFAULT_MAX_COMMITS = 200;
const MAX_PATHSPECS = 20;
const MAX_SUB_REPOS = 64;
const MAX_ID_LOOKUPS = 1024;
// ─── SUMMARY `## Task Commits` extraction (port of the #4127 model) ───────────
const TASK_COMMITS_HEADING = /^## Task Commits[ \t\r]*$/;
const NEXT_HEADING = /^## /;
const TASK_ROW_PREFIX = /^[ \t]*(?:[0-9]+\.|[-*])?[ \t]*\*\*Task[ \t]+[0-9]+:/;
const HEX_TOKEN = /`[0-9a-f]{7,40}`/g;
/**
 * The commit ids a SUMMARY names, in document order, duplicates included. Section-scoped (every
 * `## Task Commits` section), row-scoped (an optional list marker, the `**Task N:` label closed by
 * its FIRST `**`) and backtick-anchored: only backticked lowercase hex AFTER that closing bold
 * counts, so a sha quoted in prose or on the `**Plan metadata:**` line is not a task commit.
 */
function extractTaskCommitRefs(text) {
    const refs = [];
    let inside = false;
    for (const line of text.split('\n')) {
        if (TASK_COMMITS_HEADING.test(line)) {
            inside = true;
            continue;
        }
        if (NEXT_HEADING.test(line)) {
            inside = false;
            continue;
        }
        if (!inside)
            continue;
        const row = TASK_ROW_PREFIX.exec(line);
        if (!row)
            continue;
        const rest = line.slice(row[0].length);
        const close = rest.indexOf('**');
        if (close === -1)
            continue;
        for (const token of rest.slice(close + 2).match(HEX_TOKEN) ?? [])
            refs.push(token.slice(1, -1));
    }
    return refs;
}
// ─── Plan-id → anchored subject pattern ───────────────────────────────────────
/**
 * Tolerate zero padding in the leading integer of a phase or plan segment (#4003, #4619, #4748);
 * everything after the integer (`A`, `.1.2`) is matched literally.
 */
function paddedPattern(value) {
    const m = /^(\d+)(.*)$/.exec(value);
    if (!m)
        return (0, pattern_cjs_1.escapeEre)(value);
    const intPart = (m[1] ?? '').replace(/^0+(?=\d)/, '');
    return `0*${(0, pattern_cjs_1.escapeEre)(intPart)}${(0, pattern_cjs_1.escapeEre)(m[2] ?? '')}`;
}
/**
 * The `<phase>-<plan>` fragment of a plan subject pattern, or null when `id` is not that shape.
 *
 * Zero-padding tolerant in both halves: `03-01` yields `0*3-0*1`, so `feat(03-01):`, `test(3-1):`
 * and `fix(03-01)!:` match while `feat(03-010):` does not (#4003, #4619, #4748).
 */
function phasePlanPattern(id) {
    const dash = id.indexOf('-');
    const phasePart = dash > 0 ? id.slice(0, dash) : '';
    const planPart = dash > 0 ? id.slice(dash + 1) : '';
    if (/^[0-9A-Za-z.]+$/.test(phasePart) && /^[0-9A-Za-z.]+$/.test(planPart)) {
        return `${paddedPattern(phasePart)}-${paddedPattern(planPart)}`;
    }
    return null;
}
/**
 * The anchored subject pattern for a `<phase>-<plan>` ERE fragment, optionally behind one scope
 * qualifier as the group `(<qualifier>-)?`.
 *
 * Every spelling of a plan id goes through this one builder: the bare id, the id carrying the
 * configured project code (#5271), and the workstream-qualified id `<ws>-<phase>-<plan>` that #5177
 * proposes. The qualifier is ERE-escaped, so a workstream name (a path segment, not a project-code
 * token) is matched literally. The group is a real capture group, never `(?:…)`: the pattern goes
 * to `git log --extended-regexp`, and POSIX ERE has no non-capturing group.
 */
function qualifiedPlanSubjectPattern(fragment, qualifier = null) {
    const group = qualifier === null ? '' : `(${(0, pattern_cjs_1.escapeEre)(qualifier)}-)?`;
    return `^[a-z]+\\(${group}${fragment}\\)!?:`;
}
/**
 * The `<CODE>-` prefix of `planId` when it is EXACTLY the project's configured `project_code`
 * followed by a dash — the separator included — else null.
 *
 * The match is CASE-SENSITIVE and anchored to the configured value. The phase-id module's
 * `stripProjectCodePrefix` grammar (case-insensitive, any code before a digit) recognises ANY
 * letter prefix, which is deliberately wider than the project: `AUTH-01-02` and `setup-1-2` are
 * ids this project never assigned a code to, and stripping their prefixes made them resolve
 * another plan's commits (#5271). Only the code the project actually configures may be
 * stripped, so an id that merely LOOKS coded keeps its literal-match guarantee.
 */
function configuredCodePrefix(planId, projectCode) {
    if (projectCode === null || !isUsableProjectCode(projectCode))
        return null;
    const prefix = `${projectCode}-`;
    return planId.startsWith(prefix) ? prefix : null;
}
/**
 * The anchored subject pattern for a plan id, or null when `planId` is empty, over-long or carries a
 * control / whitespace character.
 *
 * A `<phase>-<plan>` id (`03-01`) is zero-padding tolerant: `feat(03-01):`, `test(3-1):` and
 * `fix(03-01)!:` match, `feat(03-010):` does not. An id carrying the CONFIGURED project code
 * (`PRJ-01-01` with `project_code: "PRJ"`, #5271) matches either spelling of the SAME plan —
 * `feat(PRJ-01-01):` and `feat(01-01):` — because the two init verbs hand out different phase
 * tokens for one plan. The code is stripped ONLY when it is the configured one: an id like
 * `AUTH-01-02` or `setup-1-2`, which merely looks coded, is matched LITERALLY — every ERE
 * metacharacter escaped — so it can only match a commit naming that exact id and never widens the
 * pattern to another plan's commits. Any other id (a plan FILE NAME that does not follow the
 * numbering) is matched literally for the same reason.
 *
 * `projectCode` is the project's configured `project_code`; with none (no config, no `planningDir`),
 * every id is matched literally, which is the pre-#5271 behaviour.
 */
function planSubjectPattern(planId, projectCode = null) {
    if (planId.length === 0 || planId.length > 200 || /[\s\x00-\x1f\x7f]/.test(planId))
        return null;
    const direct = phasePlanPattern(planId);
    if (direct)
        return qualifiedPlanSubjectPattern(direct);
    // #5271: `init.execute-phase` returns `phase_number: "PRJ-01"` where `init.plan-phase` returns
    // `padded_phase: "01"`, and every gate builds its `--plan` from the former. Splitting `PRJ-01-01`
    // at its FIRST dash leaves `01-01` as the plan half, which is not a plan number, so the id fell
    // through to the literal pattern that no executor commit can ever carry — an empty scope at exit
    // 0, which is the correct answer for a plan that has NOT started and the wrong one for one that
    // has. Retry on the CONFIGURED project-code-stripped id, with the code OPTIONAL so the commit the
    // executor actually wrote still matches.
    //
    // The `(PRJ-)?` group comes from `qualifiedPlanSubjectPattern`, and it rides ONLY on a remainder
    // that could be a plan number, so an empty or non-numeric remainder keeps the whole id literal —
    // never WIDER than the pre-#5271 pattern.
    const prefix = configuredCodePrefix(planId, projectCode);
    if (prefix !== null) {
        const stripped = planId.slice(prefix.length);
        const coded = phasePlanPattern(stripped);
        // The only remainder `phasePlanPattern` cannot split is the N-segment milestone shape
        // (`01-02-03`), so require that whole shape: a bare `1`, `01-` or a trailing dash would
        // otherwise widen the optional group onto `feat(1):`.
        const planShaped = coded !== null || /^\d[0-9A-Za-z.]*(-[0-9A-Za-z.]+){2,}$/.test(stripped);
        if (!planShaped)
            return qualifiedPlanSubjectPattern((0, pattern_cjs_1.escapeEre)(planId));
        return qualifiedPlanSubjectPattern(coded ?? (0, pattern_cjs_1.escapeEre)(stripped), projectCode);
    }
    return qualifiedPlanSubjectPattern((0, pattern_cjs_1.escapeEre)(planId));
}
/**
 * Whether a configured `project_code` can safely be stripped from a plan id and put in a pattern.
 *
 * `config-set` stores `project_code` unvalidated and docs/CONFIGURATION.md calls it "any short
 * string", so this is a SAFETY check, not the phase-id module's uppercase grammar: a letter first,
 * then letters, digits, `_`, `.` or `-`, at most 32 characters. That admits `gsd` and `AUTH-X`
 * (which the uppercase grammar left in the #5271 symptom) while excluding whitespace, control
 * characters and anything long enough to be a sentence. The value is ERE-escaped by the pattern
 * builder, so no metacharacter it admits can change the pattern.
 */
function isUsableProjectCode(code) {
    return /^[A-Za-z][A-Za-z0-9_.-]{0,31}$/.test(code);
}
/**
 * The project's configured `project_code`, or null when it is absent, non-string or unusable
 * (`isUsableProjectCode`). An unusable value reads as ABSENT: the coded id keeps its LITERAL
 * spelling, which is never WIDER than the pre-#5271 pattern, since a literal id can only match a
 * subject naming that exact id.
 */
function configuredProjectCode(projectDir) {
    const { present, value } = readScopedConfigValue(projectDir, ['project_code']);
    if (!present || typeof value !== 'string')
        return null;
    return isUsableProjectCode(value) ? value : null;
}
// ─── Git plumbing ─────────────────────────────────────────────────────────────
class ScopeUnreadable extends Error {
    reason;
    /** git's exit status when the failure was a plain non-zero exit (not a timeout or a missing git). */
    exitCode;
    constructor(reason, exitCode = null) {
        super(reason);
        this.reason = reason;
        this.exitCode = exitCode;
    }
}
/** The git subcommand of `args`: the first argument after any leading `-c <key=value>` pairs. */
function gitSubcommand(args) {
    let index = 0;
    while (args[index] === '-c')
        index += 2;
    return args[index] ?? '';
}
/**
 * git settings a `planning.sub_repos` workspace's own `.git/config` must not override: a configured
 * repo is checkout content, so no setting that makes a read-only command run a program may apply
 * (an fsmonitor command; `log.showSignature` with a `gpg.program` on a signed commit). Applied to
 * every git call of the sub_repos path, root included; the single-repo path keeps its exact argv.
 * Bounded by construction: at most MAX_SUB_REPOS + 1 repos, each a fixed number of calls, each
 * bounded by the runner's timeout.
 */
const SUB_REPO_GIT_HARDENING = [
    '-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false', '-c', 'gpg.program=false',
];
function makeGit(projectDir, runner, leading = []) {
    return (args, cwd = projectDir) => {
        const result = runner([...leading, ...args], { cwd });
        if (result.timedOut)
            throw new ScopeUnreadable('git-timeout');
        if (result.exitCode === 127)
            throw new ScopeUnreadable('git-unavailable');
        if (result.exitCode !== 0)
            throw new ScopeUnreadable(`git-failed:${gitSubcommand(args)}`, result.exitCode);
        return result.stdout;
    };
}
/**
 * Run a git question whose exit status 1 is a legitimate "no" (`merge-base --is-ancestor`,
 * `rev-parse --verify --quiet`). Exit 1 returns `null`; every other failure — a timeout, a missing
 * git, a bad object (exit 128) — still rethrows, so a hung or broken git is `unresolvable`, never a
 * silent "no".
 */
function gitOrNo(git, args, cwd) {
    try {
        return git(args, cwd);
    }
    catch (error) {
        if (error instanceof ScopeUnreadable && error.exitCode === 1)
            return null;
        throw error;
    }
}
function splitNul(output) {
    return output.split('\0').filter((entry) => entry.length > 0);
}
function chunk(items, size) {
    const out = [];
    for (let i = 0; i < items.length; i += size)
        out.push(items.slice(i, i + size));
    return out;
}
function uniqueSorted(items) {
    return [...new Set(items)].sort();
}
/** True when `candidate` cannot be read as a git option and carries no whitespace or control byte. */
function isSafeRefArgument(candidate) {
    return candidate.length > 0 && candidate.length <= 256 && !candidate.startsWith('-') && !/[\s\x00-\x1f\x7f]/.test(candidate);
}
/** A git approxidate: words, digits and `- : . ,` only, so it can never read as an option or a pathspec. */
function isSafeDateArgument(candidate) {
    return /^[A-Za-z0-9][A-Za-z0-9 .,:+-]{0,63}$/.test(candidate);
}
function isAncestor(git, sha, of) {
    return gitOrNo(git, ['merge-base', '--is-ancestor', sha, of]) !== null;
}
/**
 * Whether commit `sha` is an ancestor of commit `of` (#5275): ancestry, never log position or commit
 * date, so a history merged from worktree branches is judged by what it descends from. `null` means
 * git could not answer (missing, hung, a bad object): the caller must not read that as "no".
 */
function commitIsAncestor(projectDir, sha, of, execGit) {
    if (!isSafeRefArgument(sha) || !isSafeRefArgument(of))
        return null;
    const runner = execGit ?? shell_command_projection_cjs_1.execGit;
    try {
        const names = readSubRepoNames(projectDir);
        if (names.length === 0)
            return isAncestor(makeGit(projectDir, runner), sha, of);
        // #5867: the commits of a `planning.sub_repos` workspace live in the sub-repos (and the
        // workspace root, when it is a repo itself). A repo that does not hold the commit cannot answer
        // (exit 128 -> unanswered). The first repo that holds both commits is authoritative (a clone's
        // answer is the same).
        let rootGit = null;
        try {
            const rootTop = makeGit(projectDir, runner, SUB_REPO_GIT_HARDENING)(['rev-parse', '--show-toplevel']);
            if (realDir(rootTop) === realDir(projectDir))
                rootGit = makeGit(projectDir, runner, SUB_REPO_GIT_HARDENING);
        }
        catch (error) {
            if (!(error instanceof ScopeUnreadable && error.exitCode === 128))
                throw error;
        }
        const gits = [
            ...(rootGit === null ? [] : [rootGit]),
            ...names.map((name) => makeGit(containedSubRepoDir(projectDir, name), runner, SUB_REPO_GIT_HARDENING)),
        ];
        for (const git of gits) {
            try {
                return isAncestor(git, sha, of);
            }
            catch (error) {
                // Only "this repo does not hold the commit" (exit 128) is unanswered; a timeout or a missing
                // git is not an answer and must not let another repo's "no" stand for it.
                if (!(error instanceof ScopeUnreadable && error.exitCode === 128))
                    throw error;
            }
        }
        return null;
    }
    catch (error) {
        if (error instanceof ScopeUnreadable)
            return null;
        throw error;
    }
}
// ─── The resolver ─────────────────────────────────────────────────────────────
function emptyScope(unit) {
    return {
        unit, status: 'resolved', source: 'none', reason: null, commits: [],
        changedFiles: [], files: [], missingOnDisk: [], outsideUnion: [], unreachable: [], rangeBase: null,
    };
}
// ─── planning.sub_repos (#5867) ───────────────────────────────────────────────
/**
 * The configured `planning.sub_repos` names (a legacy top-level `sub_repos` is honored when the
 * nested key is absent, the order `detectSubRepos` and `loadConfig` apply). Empty when none are
 * configured. Read with the scope-aware config reader (no `loadConfig`: it rewrites config.json and
 * spawns git). A blank string is dropped like `detectSubRepos` drops it; any other non-string is
 * `unresolvable`, never silently skipped, because a skipped repo narrows the scope.
 */
function readSubRepoNames(projectDir) {
    const nested = readScopedConfigValue(projectDir, ['planning', 'sub_repos']);
    const raw = nested.present ? nested.value : readScopedConfigValue(projectDir, ['sub_repos']).value;
    if (!Array.isArray(raw))
        return [];
    // Each repo costs several bounded git spawns; refuse rather than amplify.
    if (raw.length > MAX_SUB_REPOS)
        throw new ScopeUnreadable('sub-repo-too-many');
    const names = [];
    raw.forEach((entry, index) => {
        if (typeof entry !== 'string')
            throw new ScopeUnreadable(`sub-repo-invalid:${index}`);
        const trimmed = entry.trim().replace(/\\/g, '/');
        if (trimmed === '')
            return;
        // Canonical spelling (`./x`, `a/../b`, `x/`): it prefixes the paths the scope reports.
        const name = node_path_1.default.posix.normalize(trimmed).replace(/\/+$/, '');
        if (name !== '.' && !names.includes(name))
            names.push(name);
    });
    return names;
}
/** A sub-repo's directory, which must stay inside the project (realpath containment, symlinks included). */
function containedSubRepoDir(projectDir, name) {
    const contained = (0, security_cjs_1.tryWithinRoot)(name, projectDir, security_cjs_1.PathAcceptance.RelativeOnly);
    if (contained === null)
        throw new ScopeUnreadable(`sub-repo-escapes-root:${name}`);
    return contained;
}
/** The real path of a directory git or the config named; one that cannot be resolved is unreadable. */
function realDir(dir) {
    try {
        return node_fs_1.default.realpathSync.native(dir);
    }
    catch {
        throw new ScopeUnreadable('sub-repo-realpath-failed');
    }
}
/**
 * Every repo a `planning.sub_repos` workspace's history lives in: the workspace root when it is
 * itself a repo (its own toplevel), then each configured sub-repo. A configured sub-repo that
 * cannot be read, or is not the root of its own repo (git would otherwise answer from a parent),
 * makes the whole scope `unresolvable` and names the repo.
 */
function openSources(projectDir, names, runner, ref) {
    const sources = [];
    const seen = new Set();
    const rootGit = makeGit(projectDir, runner, SUB_REPO_GIT_HARDENING);
    try {
        const top = rootGit(['rev-parse', '--show-toplevel']);
        if (realDir(top) === realDir(projectDir)) {
            seen.add(realDir(projectDir));
            rootGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
            sources.push({ prefix: '', git: rootGit, repoRoot: top });
        }
    }
    catch (error) {
        // Not a repo (128) or no such commit yet (1): the workspace root contributes nothing. A timeout
        // or a missing git still rethrows.
        if (!(error instanceof ScopeUnreadable && (error.exitCode === 128 || error.exitCode === 1)))
            throw error;
    }
    const rootCovers = seen.has(realDir(projectDir));
    for (const name of names) {
        const dir = containedSubRepoDir(projectDir, name);
        const stat = (0, gate_evidence_cjs_1.statEvidence)(dir);
        if (stat.kind === 'unreadable')
            throw new ScopeUnreadable(`sub-repo-unreadable:${name}:${stat.reason}`);
        if (stat.kind === 'none' || !stat.value.isDirectory())
            throw new ScopeUnreadable(`sub-repo-unreadable:${name}:not-a-directory`);
        const git = makeGit(dir, runner, SUB_REPO_GIT_HARDENING);
        let top;
        try {
            top = git(['rev-parse', '--show-toplevel']);
        }
        catch (error) {
            if (error instanceof ScopeUnreadable)
                throw new ScopeUnreadable(`sub-repo-unreadable:${name}:${error.reason}`, error.exitCode);
            throw error;
        }
        if (realDir(top) !== realDir(dir)) {
            // A plain folder of the workspace root's own repo is already covered by the root source; any
            // other directory would make git answer from a parent repo it does not own.
            if (rootCovers && realDir(top) === realDir(projectDir))
                continue;
            throw new ScopeUnreadable(`sub-repo-unreadable:${name}:not-a-repo-root`);
        }
        if (seen.has(realDir(dir)))
            continue;
        seen.add(realDir(dir));
        try {
            git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
        }
        catch (error) {
            // No such commit in this repo (an empty repo, or a ref only another repo has): it holds nothing
            // to scope. A timeout or a missing git still rethrows.
            if (error instanceof ScopeUnreadable && error.exitCode === 1)
                continue;
            if (error instanceof ScopeUnreadable)
                throw new ScopeUnreadable(`sub-repo-unreadable:${name}:${error.reason}`, error.exitCode);
            throw error;
        }
        sources.push({ prefix: name, git, repoRoot: top });
    }
    // No repo could answer for the ref: the same "could not look" the single-repo path gives.
    if (sources.length === 0)
        throw new ScopeUnreadable('git-failed:rev-parse', 1);
    return sources;
}
const withPrefix = (prefix, file) => (prefix === '' ? file : `${prefix}/${file}`);
/** Committer time (unix seconds) per sha, for ordering commits that come from different repos. */
function commitTimes(git, shas) {
    const times = new Map();
    for (const group of chunk(shas, SHA_CHUNK)) {
        for (const line of git(['log', '--no-walk=unsorted', '--format=%H%x1f%ct', ...group]).split('\n')) {
            const [sha, time] = line.split('\x1f');
            if (sha && time !== undefined && /^[0-9]+$/.test(time))
                times.set(sha, Number(time));
        }
    }
    return times;
}
function splitSince(options, sources) {
    const split = { holders: new Set(), time: null };
    const since = options.since;
    if (since === undefined)
        return split;
    for (const source of sources) {
        const sha = gitOrNo(source.git, ['rev-parse', '--verify', '--quiet', `${since}^{commit}`]);
        if (sha === null)
            continue;
        split.holders.add(source);
        split.time ??= commitTimes(source.git, [sha]).get(sha) ?? null;
    }
    if (split.holders.size === 0)
        throw new ScopeUnreadable('since-not-found');
    if (split.time === null)
        throw new ScopeUnreadable('since-time-unreadable');
    return split;
}
/** `options` for one source: a repo that does not hold the `since` commit is filtered by its time instead. */
function optionsForSource(options, source, split) {
    if (options.since === undefined || split.holders.has(source))
        return options;
    const { since: _since, ...rest } = options;
    void _since;
    return rest;
}
function withSourcePrefix(commit, prefix) {
    return commit.files === undefined ? commit : { ...commit, files: commit.files.map((f) => withPrefix(prefix, f)) };
}
function resolveAcrossSources(projectDir, unit, options, sources, ref) {
    if (unit.kind === 'phase')
        return resolvePhaseAcrossSources(projectDir, unit, options, sources, ref);
    const scope = emptyScope(unit);
    const max = clampMaxCommits(options.maxCommits);
    const split = splitSince(options, sources);
    const found = sources.map((source) => {
        const opts = optionsForSource(options, source, split);
        const lookup = lookupSubjectCommits(projectDir, unit, emptyScope(unit), source.git, ref, opts);
        const times = commitTimes(source.git, lookup.commits.map((c) => c.sha));
        if (split.time !== null && !split.holders.has(source)) {
            const boundary = split.time;
            lookup.commits = lookup.commits.filter((c) => (times.get(c.sha) ?? 0) > boundary);
        }
        return { source, opts, lookup, times };
    });
    scope.source = unit.kind === 'plan' ? 'plan-subjects' : 'quick-subjects';
    // Newest first across repos: a k-way merge that keeps each repo's own log order (a stable pick:
    // ties go to the earlier source); one entry per sha.
    const seenShas = new Set();
    const queues = found.map((entry) => entry.lookup.commits.filter((commit) => {
        if (seenShas.has(commit.sha))
            return false;
        seenShas.add(commit.sha);
        return true;
    }));
    const kept = [];
    const heads = queues.map(() => 0);
    while (kept.length < max) {
        let best = -1;
        let bestTime = -1;
        queues.forEach((queue, index) => {
            const head = queue[heads[index] ?? 0];
            if (head === undefined)
                return;
            const time = found[index]?.times.get(head.sha) ?? 0;
            if (best === -1 || time > bestTime) {
                best = index;
                bestTime = time;
            }
        });
        if (best === -1)
            break;
        const commit = queues[best]?.[heads[best] ?? 0];
        if (commit === undefined)
            break;
        kept.push({ index: best, commit });
        heads[best] = (heads[best] ?? 0) + 1;
    }
    const finished = found.map((entry, index) => {
        const part = emptyScope(unit);
        finishSubjectScope(part, entry.source.git, kept.filter((k) => k.index === index).map((k) => k.commit), entry.lookup.parentsOf, entry.opts, entry.source.repoRoot);
        return part;
    });
    const byRepo = new Map();
    finished.forEach((part, index) => {
        const prefix = found[index]?.source.prefix ?? '';
        for (const commit of part.commits)
            byRepo.set(commit.sha, withSourcePrefix(commit, prefix));
    });
    scope.commits = kept.map((k) => byRepo.get(k.commit.sha) ?? k.commit);
    const gather = (pick) => uniqueSorted(finished.flatMap((part, index) => pick(part).map((f) => withPrefix(found[index]?.source.prefix ?? '', f))));
    scope.changedFiles = gather((part) => part.changedFiles);
    scope.files = gather((part) => part.files);
    scope.missingOnDisk = gather((part) => part.missingOnDisk);
    if (scope.commits.length === 0)
        scope.reason = 'no-matching-commits';
    else if (options.commitsOnly !== true && scope.changedFiles.length === 0) {
        scope.reason = finished.every((part) => part.commits.length === 0 || part.reason === 'merge-only') ? 'merge-only' : 'empty-after-exclusions';
    }
    return scope;
}
function resolvePhaseAcrossSources(projectDir, unit, options, sources, ref) {
    const gathered = gatherPhase(projectDir, unit);
    const primary = sources[0];
    if (primary === undefined)
        throw new ScopeUnreadable('no-sources');
    // A task commit id belongs to the repo that holds it: an id only another repo has is not
    // "unreachable" here. An id no repo holds goes to the primary source, which names it unreachable.
    const ids = [...new Set(gathered.refs)];
    // One lookup per id per repo: bound the aggregate, not just the repo count.
    if (ids.length * sources.length > MAX_ID_LOOKUPS)
        throw new ScopeUnreadable('sub-repo-too-many-lookups');
    const holders = ids.map((id) => sources.filter((source) => {
        try {
            return gitOrNo(source.git, ['rev-parse', '--verify', '--quiet', `${id}^{commit}`]) !== null;
        }
        catch (error) {
            // exit 128 = an ambiguous short id: that repo owns it, and names it unreachable below.
            if (error instanceof ScopeUnreadable && error.exitCode === 128)
                return true;
            throw error;
        }
    }));
    const assigned = new Map();
    ids.forEach((id, i) => {
        const owners = holders[i] ?? [];
        for (const owner of owners.length > 0 ? owners : [primary])
            assigned.set(owner, [...(assigned.get(owner) ?? []), id]);
    });
    const active = sources.filter((source) => assigned.has(source));
    // The workspace root (when it is a repo) always takes part: it may hold the phase-start anchor a
    // sub-repo cannot, so a phase whose task commits add nothing still degrades to its range.
    const run = sources.filter((source) => assigned.has(source) || source.prefix === '');
    if (run.length === 0)
        run.push(primary);
    const split = splitSince(options, sources);
    const parts = run.map((source) => {
        const part = emptyScope(unit);
        const subset = { ...gathered, refs: assigned.get(source) ?? (active.length === 0 ? gathered.refs : []) };
        const notAfter = split.time !== null && !split.holders.has(source) ? split.time : undefined;
        resolvePhase(projectDir, unit, part, source.git, ref, optionsForSource(options, source, split), source.repoRoot, subset, source.prefix === '', true, notAfter);
        return { source, part };
    });
    const merged = emptyScope(unit);
    merged.unreachable = uniqueSorted(parts.flatMap(({ part }) => part.unreachable));
    merged.rangeBase = parts.map(({ part }) => part.rangeBase).find((base) => base !== null) ?? null;
    const taken = parts.filter(({ part }) => part.source === 'task-commits');
    const degraded = parts.find(({ part }) => part.status === 'degraded');
    const pick = taken.length > 0 ? taken : degraded ? [degraded] : [];
    if (pick.length === 0) {
        // Every repo was read and none has task commits for the phase, and a sub-repo has no phase-start
        // anchor to widen to: a loud, empty `degraded` scope, never a pass-shaped empty one and never
        // `unresolvable` (nothing was unreadable).
        merged.status = 'degraded';
        merged.source = 'phase-range';
        merged.reason = `${parts[0]?.part.reason ?? 'no-task-commits'}:no-phase-start-anchor`;
        return merged;
    }
    merged.status = taken.length > 0 ? 'resolved' : 'degraded';
    merged.source = taken.length > 0 ? 'task-commits' : 'phase-range';
    merged.reason = taken.length > 0 ? null : (parts.find(({ source, part }) => source.prefix !== '' && part.reason !== null)?.part.reason ?? degraded?.part.reason ?? null);
    const seenShas = new Set();
    for (const { source, part } of pick) {
        for (const commit of part.commits) {
            if (seenShas.has(commit.sha))
                continue;
            seenShas.add(commit.sha);
            merged.commits.push(withSourcePrefix(commit, source.prefix));
        }
    }
    const gather = (pickFiles) => uniqueSorted(pick.flatMap(({ source, part }) => pickFiles(part).map((f) => withPrefix(source.prefix, f))));
    merged.changedFiles = gather((part) => part.changedFiles);
    merged.files = gather((part) => part.files);
    merged.missingOnDisk = gather((part) => part.missingOnDisk);
    merged.outsideUnion = gather((part) => part.outsideUnion);
    return merged;
}
function resolveEvaluationScope(projectDir, unit, options = {}) {
    const scope = emptyScope(unit);
    const runner = options.execGit ?? shell_command_projection_cjs_1.execGit;
    const git = makeGit(projectDir, runner);
    const ref = options.ref ?? 'HEAD';
    try {
        if (!isSafeRefArgument(ref))
            throw new ScopeUnreadable('unsafe-ref');
        if (options.since !== undefined && !isSafeRefArgument(options.since))
            throw new ScopeUnreadable('unsafe-since');
        // #5867: a `planning.sub_repos` workspace keeps its history in the sub-repos, not at the root.
        const subRepoNames = readSubRepoNames(projectDir);
        if (subRepoNames.length > 0)
            return resolveAcrossSources(projectDir, unit, options, openSources(projectDir, subRepoNames, runner, ref), ref);
        git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
        const repoRoot = git(['rev-parse', '--show-toplevel']);
        if (unit.kind === 'phase')
            resolvePhase(projectDir, unit, scope, git, ref, options, repoRoot);
        else
            resolveBySubject(projectDir, unit, scope, git, ref, options, repoRoot);
        return scope;
    }
    catch (error) {
        const reason = error instanceof ScopeUnreadable ? error.reason : 'resolver-error';
        return { ...emptyScope(unit), status: 'unresolvable', reason };
    }
}
/** First git release with `show --remerge-diff` (#5751). */
const REMERGE_DIFF_MIN_GIT = [2, 36];
/**
 * The first `<major>.<minor>` in `git --version` output ("git version 2.45.1.windows.1",
 * "2.36.0-rc0", "2.54.0 (Apple Git-157)"), or null when there is none.
 */
function parseGitVersion(output) {
    const match = /(\d+)\.(\d+)/.exec(output);
    return match ? { major: Number(match[1]), minor: Number(match[2]) } : null;
}
/** Whether `git --version` output names a git that has `show --remerge-diff`; unparseable reads as no. */
function remergeDiffSupported(output) {
    const version = parseGitVersion(output);
    if (version === null)
        return false;
    return version.major > REMERGE_DIFF_MIN_GIT[0]
        || (version.major === REMERGE_DIFF_MIN_GIT[0] && version.minor >= REMERGE_DIFF_MIN_GIT[1]);
}
/** Per-resolve cache of the `git --version` probe, keyed by the bound git function. */
const remergeSupportCache = new WeakMap();
/**
 * Whether this git can report a merge's own changes (`--remerge-diff`, git >= 2.36). Detected from
 * `git --version`, never from error output: an unknown option exits 128 or 129 depending on where
 * it is parsed. An unparseable version reads as unsupported, the safe side. A timeout still
 * rethrows (unresolvable); any other probe failure reads as unsupported.
 */
function supportsRemergeDiff(git) {
    const cached = remergeSupportCache.get(git);
    if (cached !== undefined)
        return cached;
    let supported = false;
    try {
        supported = remergeDiffSupported(git(['--version']));
    }
    catch (error) {
        if (error instanceof ScopeUnreadable && error.reason === 'git-timeout')
            throw error;
    }
    remergeSupportCache.set(git, supported);
    return supported;
}
/**
 * A commit's own file set. A non-merge commit contributes what it changed. A merge commit
 * contributes only what the merge itself changed (conflict resolutions and edits, from
 * `--remerge-diff`), so a clean merge contributes nothing and both merge orientations agree (#5751).
 * `--first-parent` would report a catch-up merge's whole base branch. On a git without
 * `--remerge-diff`, or for an octopus merge (remerge covers two-parent merges), a merge contributes
 * nothing: it may under-report, and never reports the base branch's work. `parents` is the commit's
 * parent count, read from the log that listed it (no per-commit lookup).
 */
function commitFiles(git, sha, parents) {
    if (parents > 1) {
        if (parents !== 2 || !supportsRemergeDiff(git))
            return [];
        return splitNul(git(['-c', 'core.quotepath=off', 'show', '--remerge-diff', '--pretty=format:', '--name-only', '-z', sha, '--', '.', ...exports.SCOPE_EXCLUSION_PATHSPECS]));
    }
    const out = git(['-c', 'core.quotepath=off', 'show', '--first-parent', '--pretty=format:', '--name-only', '-z', sha, '--', '.', ...exports.SCOPE_EXCLUSION_PATHSPECS]);
    return splitNul(out);
}
function rangeFiles(git, base, tip) {
    const out = git(['-c', 'core.quotepath=off', 'diff', '--name-only', '-z', `${base}..${tip}`, '--', '.', ...exports.SCOPE_EXCLUSION_PATHSPECS]);
    return splitNul(out);
}
function finalizeFiles(scope, repoRoot, changed) {
    scope.changedFiles = uniqueSorted(changed);
    const existing = [];
    const missing = [];
    for (const file of scope.changedFiles) {
        (node_fs_1.default.existsSync(node_path_1.default.join(repoRoot, file)) ? existing : missing).push(file);
    }
    scope.files = existing;
    scope.missingOnDisk = missing;
}
/** `%P` rides every log so a commit's parents come from the listing itself, never a per-commit lookup. */
function logFormat(withBody) {
    return withBody ? '--format=%H%x1f%P%x1f%s%x1f%b%x1e' : '--format=%H%x1f%P%x1f%s%x1e';
}
function parseLog(out, withBody, parentsOut) {
    const commits = [];
    for (const record of out.split('\x1e')) {
        const trimmed = record.replace(/^\n+/, '');
        if (!trimmed)
            continue;
        const [sha, parents, subject, body] = trimmed.split('\x1f');
        if (!sha || !/^[0-9a-f]{40}$/.test(sha))
            continue;
        const commit = { sha, subject: subject ?? '' };
        if (withBody)
            commit.body = (body ?? '').trim();
        commits.push(commit);
        parentsOut?.set(sha, (parents ?? '').split(' ').filter(Boolean));
    }
    return commits;
}
function subjectsFor(git, shas, withBody, chunkSize, parentsOut) {
    const out = [];
    for (const group of chunk(shas, chunkSize)) {
        out.push(...parseLog(git(['log', '--no-walk=unsorted', logFormat(withBody), ...group]), withBody, parentsOut));
    }
    return out;
}
/**
 * Whether every merge-base of `p1` and `p2` is `rangeBase` or one of its ancestors: the second side
 * was forked from history that predates the phase, so it is base work. False when `rangeBase` is the
 * empty tree, when there is no merge-base, and when git cannot answer (a timeout or a failure): the
 * caller then subtracts nothing and the files stay in `outsideUnion`.
 */
function forkedAtOrBeforePhaseStart(git, p1, p2, rangeBase) {
    if (rangeBase === EMPTY_TREE)
        return false;
    try {
        const bases = (gitOrNo(git, ['merge-base', '--all', p1, p2]) ?? '').split('\n').filter(Boolean);
        return bases.length > 0 && bases.every((base) => isAncestor(git, base, rangeBase));
    }
    catch (error) {
        if (error instanceof ScopeUnreadable)
            return false;
        throw error;
    }
}
/**
 * The files a listed two-parent merge brought in from its SECOND parent's side: base work, not the
 * unit's. A merge contributes nothing when ANY of these holds, so unlisted phase work is never hidden:
 * a listed commit sits on that side (`<p2> ^<p1>`: a phase branch merged into its base); a listed
 * non-merge commit is an ancestor of `<p2>` after the phase start (`<p2> ^<rangeBase>`, one walk: a
 * branch forked from the phase, whose unlisted commits are phase work); the fork point
 * (`git merge-base <p1> <p2>`) is not at or before `rangeBase` (a side forked from phase work, or a
 * later catch-up whose fork point is an earlier catch-up's base commit: reported as an advisory
 * false positive, never hidden); `rangeBase` is the empty tree or there is no merge-base; any git
 * call for this merge fails or times out (this merge subtracts nothing, the others are unaffected);
 * or the file was touched by a commit of the phase window (`<rangeBase>..<tip>` minus what `<p2>`
 * reaches, listed or not, before or after the merge, other merge commits included through their own
 * changes against each parent, `git log -m`; the merge itself is not counted). Only files touched
 * solely by the second parent's side are subtracted.
 */
function phaseSideFiles(git, tip, p2, rangeBase, mergeSha) {
    const files = new Set();
    const out = git([
        '-c', 'core.quotepath=off', 'log', '-m', '--format=%x01%H', '--name-only', '-z', tip, `^${p2}`,
        ...(rangeBase === EMPTY_TREE ? [] : [`^${rangeBase}`]), '--', '.', ...exports.SCOPE_EXCLUSION_PATHSPECS,
    ]);
    let own = false;
    for (const raw of out.split('\0')) {
        const token = raw.replace(/^\n+/, '');
        if (token.length === 0)
            continue;
        if (token.startsWith('\x01')) {
            own = token.slice(1) === mergeSha;
            continue;
        }
        if (!own)
            files.add(token);
    }
    return files;
}
function baseSideMergeFiles(git, merges, parentsOf, listed, listedNonMerge, rangeBase, tip) {
    const files = new Set();
    for (const sha of merges) {
        const parents = parentsOf.get(sha) ?? [];
        if (parents.length !== 2)
            continue;
        const [p1 = '', p2 = ''] = parents;
        try {
            const secondSide = git(['rev-list', p2, `^${p1}`]).split('\n').filter(Boolean);
            if (secondSide.some((entry) => listed.has(entry)))
                continue;
            // One walk of the second parent's history after the phase start, intersected with the listed
            // non-merge commits (never one ancestry spawn per listed commit).
            const reachable = new Set(git([
                'rev-list', p2, ...(rangeBase === EMPTY_TREE ? [] : [`^${rangeBase}`]),
            ]).split('\n').filter(Boolean));
            if (listedNonMerge.some((entry) => reachable.has(entry)))
                continue;
            if (!forkedAtOrBeforePhaseStart(git, p1, p2, rangeBase))
                continue;
            // Every commit in the window `<rangeBase>..<tip>` the second parent does not reach, before AND
            // after this merge, minus this merge's own records (its first-parent diff is what is being
            // subtracted from). `-m` lists a merge commit's changes against each parent: another merge's
            // conflict resolution or edit is phase work. Over-inclusion only keeps a file in outsideUnion.
            const phaseSide = phaseSideFiles(git, tip, p2, rangeBase, sha);
            const brought = rangeFiles(git, `${sha}^1`, sha).filter((file) => !phaseSide.has(file));
            for (const file of brought)
                files.add(file);
        }
        catch (error) {
            // A merge whose check could not be answered subtracts nothing (its files stay named).
            if (!(error instanceof ScopeUnreadable))
                throw error;
        }
    }
    return files;
}
/**
 * The tip of `shas`: topological order lists a descendant before its ancestors, so the first
 * commit of a walk started at all of them is one no other listed commit descends from. (Commit
 * DATES are not used — commits made within one second tie, and a tie picks an arbitrary tip.)
 */
function newestOf(git, shas, chunkSize) {
    // More shas than fit one argv chunk are reduced chunk by chunk: the chunks' tips are themselves a
    // (shorter) list, until one chunk holds them all. Nothing is silently dropped.
    if (shas.length > chunkSize) {
        const tips = chunk(shas, chunkSize).map((group) => newestOf(git, group, chunkSize));
        return newestOf(git, tips, chunkSize);
    }
    const tip = git(['rev-list', '--topo-order', '-n', '1', ...shas]).split('\n').filter(Boolean)[0];
    return tip ?? shas[0] ?? 'HEAD';
}
/** One clamp for every commit cap, so the CLI limit and the resolver's ceiling cannot diverge. */
exports.MAX_COMMITS_CEILING = 1000;
function clampMaxCommits(requested) {
    return Math.max(1, Math.min(requested ?? DEFAULT_MAX_COMMITS, exports.MAX_COMMITS_CEILING));
}
/** git's empty tree (SHA-1 repositories): the base a range needs to include a root commit's own files. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
/**
 * The phase-start anchor on `ref`: the parent of the commit that first added anything under the
 * phase dir. A phase directory that arrived with the repository's root commit has no parent, so the
 * anchor is the empty tree — `<empty>..<ref>` then includes the root commit's own files.
 */
function phaseRangeBase(git, phaseDir, ref) {
    const first = git(['log', ref, '--format=%H', '--diff-filter=A', '--', '.'], phaseDir)
        .split('\n').filter(Boolean).pop();
    if (!first)
        return null;
    return gitOrNo(git, ['rev-parse', '--verify', '--quiet', `${first}^`]) ?? EMPTY_TREE;
}
function gatherPhase(projectDir, unit) {
    let phaseDir = unit.phaseDir ?? '';
    if (unit.phaseDir === undefined) {
        const located = (0, gate_phase_context_cjs_1.resolvePhaseDir)(projectDir, unit.phase);
        if (located.kind === 'unreadable')
            throw new ScopeUnreadable(`phase-dir-lookup-failed:${located.reason}`);
        if (located.kind === 'found')
            phaseDir = located.value;
    }
    if (!phaseDir)
        throw new ScopeUnreadable('phase-dir-not-found');
    const refs = [];
    let summaryCount = 0;
    // The canonical LIVE summary set (root + nested, superseded excluded) from its single owner. A scan
    // that did not see every summary (an existing nested plans/ that could not be read) is "could not
    // look": a short summary set would narrow the phase's commits and report success (#5170).
    const planScan = (0, gate_evidence_cjs_1.readPlanScanEvidence)(phaseDir);
    if (planScan.kind === 'unreadable')
        throw new ScopeUnreadable('phase-dir-unreadable');
    const entries = [...planScan.value.summaryFiles].sort();
    for (const name of entries) {
        try {
            refs.push(...extractTaskCommitRefs(node_fs_1.default.readFileSync(node_path_1.default.join(phaseDir, name), 'utf-8')));
            summaryCount += 1;
        }
        catch {
            throw new ScopeUnreadable(`summary-unreadable:${name}`);
        }
    }
    return { phaseDir, refs, summaryCount };
}
/**
 * `gathered` / `anchored` / `partial` serve a `planning.sub_repos` workspace (#5867): the ids are
 * read once and each repo resolves only the ids it holds (`gathered`); only the workspace root can
 * hold the phase directory's history, so a sub-repo has no phase-start anchor (`anchored` false); and
 * a repo whose own ids add nothing returns an empty `none` scope instead of degrading (`partial`),
 * because another repo may have the phase's files.
 */
function resolvePhase(projectDir, unit, scope, git, ref, options, repoRoot, gathered, anchored = true, partial = false, notAfter) {
    const { phaseDir, refs, summaryCount } = gathered ?? gatherPhase(projectDir, unit);
    // Resolve each listed id to a full sha reachable from the ref (and, for wave scoping, newer than `since`).
    const shas = [];
    const unreachable = [];
    let sinceDropped = 0;
    for (const id of [...new Set(refs)]) {
        // Exit 1 = no object answers to the id (rebased away); exit 128 = an ambiguous short id. Both
        // are named below, per id, and neither poisons the phase. A timeout still rethrows.
        let full = '';
        try {
            full = gitOrNo(git, ['rev-parse', '--verify', '--quiet', `${id}^{commit}`]) ?? '';
        }
        catch (error) {
            if (!(error instanceof ScopeUnreadable && error.exitCode === 128))
                throw error;
        }
        if (!full || !isAncestor(git, full, ref)) {
            unreachable.push(id);
            continue;
        }
        if (options.since !== undefined && isAncestor(git, full, options.since)) {
            sinceDropped += 1;
            continue;
        }
        if (notAfter !== undefined && (commitTimes(git, [full]).get(full) ?? 0) <= notAfter) {
            sinceDropped += 1;
            continue;
        }
        shas.push(full);
    }
    scope.unreachable = unreachable.sort();
    scope.rangeBase = options.since ?? (anchored ? phaseRangeBase(git, phaseDir, ref) : null);
    const union = new Set();
    const merges = [];
    const parentsOf = new Map();
    const commits = [];
    const withFiles = options.includeFiles ?? true;
    // At least 2: a chunk of one never shrinks the list `newestOf` reduces.
    const chunkSize = Math.max(2, options.shaChunk ?? SHA_CHUNK);
    for (const meta of subjectsFor(git, [...new Set(shas)], options.includeBody === true, chunkSize, parentsOf)) {
        const parentCount = parentsOf.get(meta.sha)?.length ?? 0;
        const files = commitFiles(git, meta.sha, parentCount);
        if (parentCount > 1)
            merges.push(meta.sha);
        for (const file of files)
            union.add(file);
        commits.push(withFiles ? { ...meta, files: [...files].sort() } : meta);
    }
    // Every listed commit is a merge: a merge carries only its resolutions, so the union is not the
    // phase's work (a SUMMARY that lists just the phase-into-base merge sha). A listed task commit that
    // touched only excluded paths is still a task commit, so it keeps the pre-existing reasons.
    const mergeOnly = merges.length > 0 && merges.length === commits.length;
    if (union.size > 0 && !mergeOnly) {
        scope.source = 'task-commits';
        scope.commits = commits;
        finalizeFiles(scope, repoRoot, union);
        if (scope.rangeBase) {
            const listed = new Set(commits.map((c) => c.sha));
            const tip = newestOf(git, [...listed], chunkSize);
            const window = rangeFiles(git, scope.rangeBase, tip);
            // The window still holds what a listed catch-up merge brought in from the base; that is base
            // work the union deliberately omits, not phase work another commit did.
            const listedNonMerge = commits.filter((c) => (parentsOf.get(c.sha)?.length ?? 0) <= 1).map((c) => c.sha);
            const baseSide = baseSideMergeFiles(git, merges, parentsOf, listed, listedNonMerge, scope.rangeBase, tip);
            scope.outsideUnion = uniqueSorted(window.filter((f) => !union.has(f) && !baseSide.has(f)));
        }
        return;
    }
    // Empty union: the planning-only phase, a phase with no SUMMARY, or one whose ids are all gone.
    const reason = summaryCount === 0 ? 'no-summary'
        : refs.length === 0 ? 'no-task-commit-rows'
            : shas.length === 0 ? (sinceDropped > 0 ? 'no-task-commits-since' : 'no-reachable-task-commits')
                : mergeOnly ? 'merge-only-task-commits'
                    : 'empty-after-exclusions';
    if (!scope.rangeBase) {
        if (partial) {
            scope.reason = reason;
            return;
        }
        throw new ScopeUnreadable(`${reason}:no-phase-start-anchor`);
    }
    scope.status = 'degraded';
    scope.reason = reason;
    scope.source = 'phase-range';
    const max = clampMaxCommits(options.maxCommits);
    scope.commits = parseLog(git(['log', `${scope.rangeBase}..${ref}`, logFormat(options.includeBody === true), '-n', String(max)]), options.includeBody === true);
    finalizeFiles(scope, repoRoot, rangeFiles(git, scope.rangeBase, ref));
}
/** The plan/quick unit's matching commits (newest first, subject-anchored, `since` applied). */
function lookupSubjectCommits(projectDir, unit, scope, git, ref, options) {
    const withBody = options.includeBody === true;
    // Refuse rather than truncate: a silently dropped positive pathspec narrows the match.
    const pathspecs = options.pathspecs ?? [];
    if (pathspecs.length > MAX_PATHSPECS)
        throw new ScopeUnreadable('too-many-pathspecs');
    const max = clampMaxCommits(options.maxCommits);
    let range = ref;
    if (options.milestoneBound === true) {
        let tag = '';
        try {
            tag = git(['describe', '--tags', '--abbrev=0', ref]);
        }
        catch (error) {
            // Exit 128 = no reachable tag → unbounded; a timeout or a missing git still rethrows.
            if (!(error instanceof ScopeUnreadable && error.exitCode === 128))
                throw error;
        }
        if (tag)
            range = `${tag}..${ref}`;
    }
    const grepArgs = [];
    let anchored = null;
    if (unit.kind === 'plan') {
        const pattern = planSubjectPattern(unit.planId, configuredProjectCode(projectDir));
        if (pattern === null)
            throw new ScopeUnreadable('invalid-plan-id');
        grepArgs.push('--extended-regexp', `--grep=${pattern}`);
        anchored = new RegExp(pattern);
        scope.source = 'plan-subjects';
    }
    else {
        if (!isSafeRefArgument(unit.id))
            throw new ScopeUnreadable('invalid-quick-id');
        grepArgs.push('--fixed-strings', `--grep=${unit.id}`);
        scope.source = 'quick-subjects';
    }
    const sinceArgs = [];
    if (options.committedSince !== undefined) {
        if (!isSafeDateArgument(options.committedSince))
            throw new ScopeUnreadable('unsafe-committed-since');
        sinceArgs.push(`--since=${options.committedSince}`);
    }
    const out = git(['log', range, logFormat(withBody), '-n', String(max * 2), ...sinceArgs, ...grepArgs, ...(pathspecs.length > 0 ? ['--', ...pathspecs] : [])]);
    // `--grep` matches ANY message line; a plan lookup is subject-anchored, so filter on the subject.
    const parentsOf = new Map();
    let commits = parseLog(out, withBody, parentsOf).filter((c) => anchored === null || anchored.test(c.subject)).slice(0, max);
    const since = options.since;
    if (since !== undefined)
        commits = commits.filter((c) => !isAncestor(git, c.sha, since));
    return { commits, parentsOf };
}
/** The scope (commits, file sets, reason) of the commits `lookupSubjectCommits` found. */
function finishSubjectScope(scope, git, commits, parentsOf, options, repoRoot) {
    if (options.commitsOnly === true) {
        scope.commits = [...commits];
        if (commits.length === 0)
            scope.reason = 'no-matching-commits';
        return;
    }
    const withFiles = options.includeFiles ?? false;
    const union = new Set();
    const result = [];
    let mergeCount = 0;
    for (const meta of commits) {
        const parentCount = parentsOf.get(meta.sha)?.length ?? 0;
        if (parentCount > 1)
            mergeCount += 1;
        const files = commitFiles(git, meta.sha, parentCount);
        for (const file of files)
            union.add(file);
        result.push(withFiles ? { ...meta, files: [...files].sort() } : meta);
    }
    scope.commits = result;
    finalizeFiles(scope, repoRoot, union);
    // Found nothing: a truthful "none" (status stays `resolved` — git was read), said out loud so a
    // caller can tell "no such commits" from "an empty scope that was never computed". Commits whose
    // every path is excluded (planning-only) are an empty scope too, and say so; so are matches that
    // are all merges (a merge carries only its own resolutions, #5751).
    if (result.length === 0)
        scope.reason = 'no-matching-commits';
    else if (scope.changedFiles.length === 0)
        scope.reason = mergeCount === result.length ? 'merge-only' : 'empty-after-exclusions';
}
function resolveBySubject(projectDir, unit, scope, git, ref, options, repoRoot) {
    const { commits, parentsOf } = lookupSubjectCommits(projectDir, unit, scope, git, ref, options);
    finishSubjectScope(scope, git, commits, parentsOf, options, repoRoot);
}
// ─── The `check evaluation-scope` verb ────────────────────────────────────────
const VALUE_FLAGS = new Set(['--phase', '--phase-dir', '--plan', '--quick', '--since', '--ref', '--pathspec', '--committed-since', '--max-commits']);
const BOOLEAN_FLAGS = new Set(['--milestone-bound', '--include-body', '--include-files', '--commits-only']);
function parseScopeArgs(args) {
    const values = new Map();
    const flags = new Set();
    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i] ?? '';
        if (BOOLEAN_FLAGS.has(arg)) {
            flags.add(arg);
            continue;
        }
        if (!VALUE_FLAGS.has(arg))
            return `unknown argument: ${arg}`;
        const value = args[i + 1];
        if (value === undefined)
            return `${arg} requires a value`;
        i += 1;
        values.set(arg, [...(values.get(arg) ?? []), value]);
    }
    const one = (flag) => values.get(flag)?.[0];
    const phase = one('--phase');
    const phaseDir = one('--phase-dir');
    const plan = one('--plan');
    const quick = one('--quick');
    const given = [phase, phaseDir, plan, quick].filter((v) => v !== undefined).length;
    if (given !== 1)
        return 'exactly one of --phase <phase>, --phase-dir <dir>, --plan <phase>-<plan> or --quick <id> is required';
    let unit;
    if (quick !== undefined)
        unit = { kind: 'quick', id: quick };
    else if (plan !== undefined)
        unit = { kind: 'plan', planId: plan };
    else if (phaseDir !== undefined)
        unit = { kind: 'phase', phase: '', phaseDir };
    else
        unit = { kind: 'phase', phase: phase ?? '' };
    const options = {};
    const ref = one('--ref');
    const since = one('--since');
    const pathspecs = values.get('--pathspec');
    if (ref !== undefined)
        options.ref = ref;
    if (since !== undefined)
        options.since = since;
    if (pathspecs !== undefined)
        options.pathspecs = pathspecs;
    const committedSince = one('--committed-since');
    if (committedSince !== undefined)
        options.committedSince = committedSince;
    const maxCommits = one('--max-commits');
    if (maxCommits !== undefined) {
        if (!/^[1-9][0-9]{0,3}$/.test(maxCommits) || Number(maxCommits) > exports.MAX_COMMITS_CEILING) {
            return `--max-commits must be an integer from 1 to ${exports.MAX_COMMITS_CEILING}, got: ${maxCommits}`;
        }
        options.maxCommits = Number(maxCommits);
    }
    if (flags.has('--milestone-bound'))
        options.milestoneBound = true;
    if (flags.has('--include-body'))
        options.includeBody = true;
    if (flags.has('--include-files'))
        options.includeFiles = true;
    if (flags.has('--commits-only'))
        options.commitsOnly = true;
    return { unit, options };
}
/** `check evaluation-scope` — argv after the verb. A resolver, not a policy: it never blocks. */
function evaluateEvaluationScope(input) {
    const parsed = parseScopeArgs(input.args);
    if (typeof parsed === 'string') {
        return (0, gate_verdict_cjs_1.gateUsageFailure)(gate_verdict_cjs_1.GATE_FAILURE_CODE.USAGE, `check evaluation-scope: ${parsed}`);
    }
    const options = input.execGit ? { ...parsed.options, execGit: input.execGit } : parsed.options;
    let unit = parsed.unit;
    if (unit.kind === 'phase' && unit.phaseDir !== undefined) {
        // `--phase-dir` is caller-supplied: it must stay inside the project (realpath containment).
        const contained = (0, gate_phase_context_cjs_1.resolveContainedPath)(unit.phaseDir, input.projectDir);
        if ((0, gate_verdict_cjs_1.isGateUsageFailure)(contained))
            return contained;
        unit = { kind: 'phase', phase: '', phaseDir: contained };
    }
    const scope = resolveEvaluationScope(input.projectDir, unit, options);
    // An unresolvable scope is "could not look" (a missing git, a timeout): outcome `unreadable`, exit
    // UNAVAILABLE, never a pass-shaped exit 0 (#5170). The payload is unchanged.
    if (scope.status === 'unresolvable')
        return (0, gate_verdict_cjs_1.gateUnreadable)(false, { ...scope });
    // `pass` only for a scope with nothing to explain; an empty-but-resolved scope (it carries a reason) is advisory.
    const outcome = scope.status === 'degraded' || scope.reason !== null ? 'advisory' : 'pass';
    return (0, gate_verdict_cjs_1.gateVerdict)(outcome, false, { ...scope });
}
