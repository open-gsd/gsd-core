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

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- config-file-read.cjs is an export= CommonJS module
import configFileReadMod = require('./config-file-read.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- worktree-safety.cjs is an export= CommonJS module
import worktreeSafetyMod = require('./worktree-safety.cjs');
import { execGit as execGitSeam, type SpawnResultOutput } from './shell-command-projection.cjs';
const { readConfigFileBounded } = configFileReadMod;
const { DEFAULT_GIT_TIMEOUT_MS, parseWorktreeEntries } = worktreeSafetyMod;

const FIND_PROJECT_ROOT_MAX_DEPTH = 10;

export interface ProjectContextProvenance {
  readonly source: 'explicit' | 'ancestor' | 'workspace' | 'main-checkout' | 'none';
  readonly reason: string;
  readonly degraded: boolean;
  readonly warnings: readonly string[];
}

export interface ProjectContext {
  /** Directory holding the `.planning` entry. */
  readonly projectRoot: string;
  /** Canonical (realpath) location of `.planning`. */
  readonly planningRoot: string;
  /** Top level of the checkout the process runs in. */
  readonly worktreeRoot: string;
  /** Top level of the main checkout (first non-bare `git worktree list` entry). */
  readonly repoRoot: string;
  /** Absolute `git rev-parse --git-common-dir`; null outside a git repository. */
  readonly gitCommonDir: string | null;
  /** Invariant: isLinkedWorktree ⇔ worktreeRoot !== repoRoot. */
  readonly isLinkedWorktree: boolean;
  readonly provenance: ProjectContextProvenance;
}

type ExecGitFn = (args: string[], opts?: { cwd?: string; env?: Record<string, string>; timeout?: number }) => SpawnResultOutput;

export interface ResolveProjectContextOptions {
  /** `--project-dir`: replaces the start directory for every rule. */
  explicit?: string | null;
  deps?: {
    execGit?: ExecGitFn;
    fs?: { realpathSync?: (p: string) => string };
  };
}

/** What the ancestor walk found, and how. `none` = nothing found; `root` is the start directory. */
export interface PlanningWalk {
  root: string;
  source: 'ancestor' | 'workspace' | 'none';
}

export function walkUpForPlanning(startDir: string): PlanningWalk {
  let resolvedStart: string;
  try {
    resolvedStart = path.resolve(startDir);
  } catch {
    return { root: startDir, source: 'none' };
  }

  const fsRoot = path.parse(resolvedStart).root;
  const home = os.homedir();
  let realHome: string | null = null;
  // A relative `$HOME` (`HOME=.`) would resolve against the process cwd and
  // make that directory count as `$HOME`; keep the spelled comparison for it.
  if (path.isAbsolute(home)) {
    try {
      realHome = fs.realpathSync.native(home);
    } catch {
      // no `$HOME` on disk: only the spelled comparison applies
    }
  }

  // #5624: the `$HOME` stop holds however `$HOME` or the walked path is
  // spelled. With `/home/me -> /data/me`, a cwd spelled `/data/me/...` (what
  // `process.cwd()` reports) never has `/home/me` as a parent, so comparing
  // spellings alone walked past `$HOME`. The isolation hooks resolve through
  // this function too, so they keep the same boundary (#3050).
  function isHome(d: string): boolean {
    if (d === home) return true;
    if (realHome === null) return false;
    try {
      return fs.realpathSync.native(d) === realHome;
    } catch {
      return false;
    }
  }

  // If startDir already contains .planning/, it IS the project root.
  try {
    const ownPlanningDir = resolvedStart + path.sep + '.planning';
    if (fs.existsSync(ownPlanningDir) && fs.statSync(ownPlanningDir).isDirectory()) {
      return { root: startDir, source: 'ancestor' };
    }
  } catch {
    // fall through
  }

  // #5624: started at `$HOME` itself, with no `.planning/` of its own, there is
  // nothing to walk: every ancestor is above `$HOME`.
  if (isHome(resolvedStart)) return { root: startDir, source: 'none' };

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
  function isSymlinkedPlanningDir(d: string): boolean {
    if (path.basename(d) !== '.planning') return false;
    try {
      return fs.lstatSync(d).isSymbolicLink();
    } catch {
      return false;
    }
  }

  // Walk upward, mirroring isInsideGitRepo from the CJS reference.
  function isInsideGitRepo(candidateParent: string): boolean {
    let d = resolvedStart;
    while (d !== fsRoot) {
      try {
        if (!isSymlinkedPlanningDir(d) && fs.existsSync(d + path.sep + '.git')) return true;
      } catch {
        // ignore
      }
      if (d === candidateParent) break;
      const next = path.dirname(d);
      if (next === d) break;
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
  function nearestGitRoot(from: string, upTo: string): string | null {
    let d = from;
    while (d !== fsRoot) {
      if (d === upTo) break;
      try {
        if (!isSymlinkedPlanningDir(d) && fs.existsSync(d + path.sep + '.git')) return d;
      } catch {
        // ignore
      }
      const next = path.dirname(d);
      if (next === d) break;
      d = next;
    }
    return null;
  }

  let dir = resolvedStart;
  let depth = 0;

  while (dir !== fsRoot && depth < FIND_PROJECT_ROOT_MAX_DEPTH) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    if (isHome(parent)) break;

    const parentPlanning = parent + path.sep + '.planning';
    let parentPlanningIsDir = false;
    try {
      parentPlanningIsDir = fs.existsSync(parentPlanning) && fs.statSync(parentPlanning).isDirectory();
    } catch {
      parentPlanningIsDir = false;
    }

    if (parentPlanningIsDir) {
      const configPath = parentPlanning + path.sep + 'config.json';
      let matched = false;
      try {
        // Bounded read (#5759): a FIFO/device/oversized config throws and is skipped like a
        // missing one. An absent file (null) becomes '' so JSON.parse throws into the same catch.
        const raw = readConfigFileBounded(configPath) ?? '';
        const config: unknown = JSON.parse(raw);
        if (config && typeof config === 'object') {
          const cfg = config as Record<string, unknown>;
          const subReposValue =
            cfg['sub_repos'] ??
            (cfg['planning'] && typeof cfg['planning'] === 'object'
              ? (cfg['planning'] as Record<string, unknown>)['sub_repos']
              : undefined);
          const subRepos = Array.isArray(subReposValue) ? (subReposValue as unknown[]) : [];
          if (subRepos.length > 0) {
            const relPath = path.relative(parent, resolvedStart);
            const topSegment = relPath.split(path.sep)[0];
            if (subRepos.includes(topSegment)) {
              return { root: parent, source: 'workspace' };
            }
          }
          if (cfg['multiRepo'] === true && isInsideGitRepo(parent)) {
            matched = true;
          }
        }
      } catch {
        // config.json missing or unparseable — fall through to .git heuristic.
      }
      if (matched) return { root: parent, source: 'ancestor' };
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
        let ancestor = path.dirname(parent);
        let ancestorDepth = 0;
        while (ancestor !== fsRoot && !isHome(ancestor) && ancestorDepth < FIND_PROJECT_ROOT_MAX_DEPTH) {
          const ancestorPlanning = ancestor + path.sep + '.planning';
          try {
            if (fs.existsSync(ancestorPlanning) && fs.statSync(ancestorPlanning).isDirectory()) {
              const ancestorConfig = ancestor + path.sep + '.planning' + path.sep + 'config.json';
              const rawA = readConfigFileBounded(ancestorConfig) ?? ''; // #5759: bounded; '' makes JSON.parse throw into the catch
              const cfgA = JSON.parse(rawA) as Record<string, unknown>;
              const subReposValueA =
                cfgA['sub_repos'] ??
                (cfgA['planning'] && typeof cfgA['planning'] === 'object'
                  ? (cfgA['planning'] as Record<string, unknown>)['sub_repos']
                  : undefined);
              const subReposA = Array.isArray(subReposValueA) ? (subReposValueA as unknown[]) : [];
              if (subReposA.length > 0) {
                const relPathA = path.relative(ancestor, resolvedStart);
                const topSegmentA = relPathA.split(path.sep)[0];
                if (subReposA.includes(topSegmentA)) {
                  return { root: ancestor, source: 'workspace' };
                }
              }
            }
          } catch {
            // ignore — config missing or unparseable, keep walking
          }
          const nextAncestor = path.dirname(ancestor);
          if (nextAncestor === ancestor) break;
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
    const parent2 = path.dirname(dir2);
    if (parent2 === dir2) break;
    try {
      const candidatePlanning = parent2 + path.sep + '.planning';
      if (fs.existsSync(candidatePlanning) && fs.statSync(candidatePlanning).isDirectory()) {
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
    } catch {
      // ignore fs errors and continue walking
    }
    if (isHome(parent2)) break;
    dir2 = parent2;
    depth2 += 1;
  }

  return { root: startDir, source: 'none' };
}
// ─── Git facts ────────────────────────────────────────────────────────────────

interface GitFacts {
  worktreeRoot: string;
  repoRoot: string;
  gitCommonDir: string | null;
  reason: string;
  degraded: boolean;
  warnings: string[];
}

const GIT_TIMED_OUT_WARNING =
  'git timed out while resolving the project context; roots fall back to what git had answered or the start directory';
const GIT_UNAVAILABLE_WARNING =
  'git could not be run while resolving the project context; roots fall back to what git had answered or the start directory';

const GIT_ERROR_WARNING =
  'git failed while resolving the project context; roots fall back to the start directory';
const GIT_WORKTREE_LIST_WARNING =
  'git worktree list failed while resolving the project context; the main checkout is taken to be the current checkout';

function lexicalFacts(start: string, reason: string, degraded: boolean, warnings: string[]): GitFacts {
  return { worktreeRoot: start, repoRoot: start, gitCommonDir: null, reason, degraded, warnings };
}

function readGitFacts(start: string, execGit: ExecGitFn): GitFacts {
  const run = (args: string[]): SpawnResultOutput => {
    try {
      return execGit(args, { cwd: start, timeout: DEFAULT_GIT_TIMEOUT_MS });
    } catch (err) {
      // The seam never throws; an injected stand-in might. Same degradation as a spawn failure.
      return { exitCode: 1, stdout: '', stderr: '', signal: null, error: err instanceof Error ? err : new Error(String(err)), timedOut: false };
    }
  };

  const rev = run(['rev-parse', '--show-toplevel', '--git-dir', '--git-common-dir']);
  if (rev.timedOut) return lexicalFacts(start, 'git_timed_out', true, [GIT_TIMED_OUT_WARNING]);
  if (rev.error) return lexicalFacts(start, 'git_unavailable', true, [GIT_UNAVAILABLE_WARNING]);
  if (rev.exitCode !== 0) {
    // Only git's own "not a git repository" is a claim about the directory; any other
    // failure (dubious ownership, corrupt repo) says nothing, so it degrades.
    if (/not a git repository/i.test(String(rev.stderr || ''))) return lexicalFacts(start, 'not_git_repo', false, []);
    return lexicalFacts(start, 'git_error', true, [GIT_ERROR_WARNING]);
  }
  const [topText = '', gitDirText = '', commonText = ''] = String(rev.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim());
  if (topText === '') return lexicalFacts(start, 'not_git_repo', false, []);
  const worktreeRoot = path.resolve(start, topText);
  const gitCommonDir = commonText !== '' ? path.resolve(start, commonText) : null;
  const linked = gitDirText !== '' && gitCommonDir !== null && path.resolve(start, gitDirText) !== gitCommonDir;

  // A main checkout is its own repo root: no second git process.
  if (!linked) {
    return { worktreeRoot, repoRoot: worktreeRoot, gitCommonDir, reason: 'ok', degraded: false, warnings: [] };
  }

  const listed = run(['worktree', 'list', '--porcelain']);
  if (listed.timedOut) return { worktreeRoot, repoRoot: worktreeRoot, gitCommonDir, reason: 'git_timed_out', degraded: true, warnings: [GIT_TIMED_OUT_WARNING] };
  if (listed.error) return { worktreeRoot, repoRoot: worktreeRoot, gitCommonDir, reason: 'git_unavailable', degraded: true, warnings: [GIT_UNAVAILABLE_WARNING] };
  if (listed.exitCode !== 0) {
    return { worktreeRoot, repoRoot: worktreeRoot, gitCommonDir, reason: 'worktree_list_failed', degraded: true, warnings: [GIT_WORKTREE_LIST_WARNING] };
  }
  const firstNonBare = parseWorktreeEntries(listed.stdout).find((entry) => !entry.bare);
  if (firstNonBare) {
    return { worktreeRoot, repoRoot: path.resolve(start, firstNonBare.path), gitCommonDir, reason: 'ok', degraded: false, warnings: [] };
  }
  return { worktreeRoot, repoRoot: worktreeRoot, gitCommonDir, reason: 'bare_main_worktree', degraded: false, warnings: [] };
}

// ─── Resolver ─────────────────────────────────────────────────────────────────

function sameCheckout(a: string, b: string, realpath: (p: string) => string): boolean {
  if (a === b) return true;
  try {
    return realpath(a) === realpath(b);
  } catch {
    return false;
  }
}

export function resolveProjectContext(startDir: string, opts: ResolveProjectContextOptions = {}): ProjectContext {
  const execGit = opts.deps?.execGit ?? execGitSeam;
  const realpath = opts.deps?.fs?.realpathSync ?? fs.realpathSync.native;
  const explicit = opts.explicit ? path.resolve(opts.explicit) : null;
  const start = explicit ?? path.resolve(startDir);

  const facts = readGitFacts(start, execGit);
  const isLinkedWorktree = !sameCheckout(facts.worktreeRoot, facts.repoRoot, realpath);

  let projectRoot = start;
  let source: ProjectContextProvenance['source'] = 'none';
  if (explicit) {
    projectRoot = explicit;
    source = 'explicit';
  } else {
    const walked = walkUpForPlanning(start);
    if (walked.source !== 'none') {
      projectRoot = walked.root;
      source = walked.source;
    } else if (isLinkedWorktree) {
      const fromMain = walkUpForPlanning(facts.repoRoot);
      if (fromMain.source !== 'none') {
        projectRoot = fromMain.root;
        source = 'main-checkout';
      }
    }
  }

  const lexicalPlanning = path.join(projectRoot, '.planning');
  let planningRoot = lexicalPlanning;
  try {
    planningRoot = realpath(lexicalPlanning);
  } catch {
    // no `.planning` on disk (source: none) or unreadable: the lexical path stands
  }

  const provenance: ProjectContextProvenance = Object.freeze({
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
export function legacyDispatchCwd(
  ctx: Pick<ProjectContext, 'isLinkedWorktree' | 'repoRoot' | 'worktreeRoot'>,
  startDir: string,
): string {
  if (fs.existsSync(path.join(startDir, '.planning'))) return startDir;
  if (!ctx.isLinkedWorktree) return startDir;
  if (fs.existsSync(path.join(ctx.worktreeRoot, '.planning'))) return ctx.worktreeRoot;
  return ctx.repoRoot;
}
