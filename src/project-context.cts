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
import { requireSafePath, tryWithinRootLexical, PathAcceptance, type PathAcceptancePolicy } from './security.cjs';
const { readConfigFileBounded } = configFileReadMod;
const { DEFAULT_GIT_TIMEOUT_MS, parseWorktreeEntries } = worktreeSafetyMod;

const FIND_PROJECT_ROOT_MAX_DEPTH = 10;

export interface ProjectContextProvenance {
  readonly source: 'explicit' | 'ancestor' | 'workspace' | 'main-checkout' | 'none';
  /**
   * How the git facts were obtained (#6355): `filesystem` when the layout was
   * read from `.git`, `gitdir` and `commondir` with no process started, `git`
   * when `git rev-parse` answered (a layout the reader does not recognise).
   */
  readonly layout: 'filesystem' | 'git';
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
    /**
     * The filesystem reader of the git layout. Returns the facts, or `null`
     * for a layout it does not recognise, which then goes to `execGit`.
     * Default: `readGitLayout`. Pass `() => null` to force the git path.
     */
    readGitLayout?: (start: string) => GitFacts | null;
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

export interface GitFacts {
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

// ─── Git layout from the filesystem (#6355) ───────────────────────────────
//
// `git rev-parse --show-toplevel --git-dir --git-common-dir` costs a process
// per CLI call (about 9 ms of a 10 ms in-process call on macOS, more on
// Windows). For the layouts below the same three answers are on disk. The
// reader is deliberately narrow: it answers only where it can give exactly
// what git gives, and returns `null` for everything else, which then goes to
// git as before. tests/git-layout-parity.process.test.cjs compares it
// with real git over built fixtures.
//
// Recognised: no repository; a main checkout (`.git` is a directory); a
// linked worktree of a non-bare repository; a checkout whose `.git` file
// names a separate git dir. Left to git: a start inside a git dir or a bare
// repository, a worktree of a bare repository, a submodule (`core.worktree`),
// `core.bare`, config includes, a `.git` that is a symlink, a repository
// another user owns, and any of the environment variables that change
// discovery.

/**
 * Variables that change where git looks or what it reports, and that reach
 * git through the seam. GIT_DIR, GIT_WORK_TREE and GIT_COMMON_DIR are not
 * here: the seam removes them before it starts git (`scrubGitLocationEnv`,
 * #5548), so git discovers from the working directory with them set, and so
 * does this reader.
 */
const GIT_DISCOVERY_ENV = Object.freeze([
  'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS',
]);

/** `.git` files, `commondir` and `gitdir` hold one path; a config that is larger than this goes to git. */
const GIT_POINTER_MAX_BYTES = 4096;
const GIT_CONFIG_MAX_BYTES = 256 * 1024;
/** Deeper than any real path; ends the walk if `dirname` ever stopped converging. */
const GIT_WALK_MAX_DEPTH = 256;

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

/**
 * The text of a small regular file, or null when it is missing, not a regular
 * file, or too large.
 *
 * It must never block. Opening a FIFO for reading waits for a writer, and a
 * planted FIFO named `config` or `commondir` would hang every CLI call and
 * hook, where the git process this replaces was bounded by a timeout. So the
 * entry is checked with lstat first (a symlink is not followed either), and
 * the open itself is non-blocking and refuses a link where the platform can.
 */
function readSmallFile(file: string, maxBytes: number): string | null {
  if (!lstatOrNull(file)?.isFile()) return null;
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOFOLLOW ?? 0);
  let fd: number;
  try {
    fd = fs.openSync(file, flags);
  } catch {
    return null;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > maxBytes) return null;
    const buf = Buffer.alloc(st.size);
    let read = 0;
    while (read < st.size) {
      const n = fs.readSync(fd, buf, read, st.size - read, read);
      if (n === 0) break;
      read += n;
    }
    return buf.subarray(0, read).toString('utf8');
  } catch {
    return null;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // nothing to do about a failed close of a file that was only read
    }
  }
}

/** A HEAD that git accepts: a symbolic ref under refs/, or an object id (SHA-1 or SHA-256). */
const VALID_HEAD_RE = /^(?:ref:[ \t]*refs\/\S+|[0-9a-f]{40}(?:[0-9a-f]{24})?)[ \t]*\r?\n?$/;

function isAccessibleDir(dir: string): boolean {
  if (!lstatOrNull(dir)?.isDirectory()) return false;
  try {
    fs.accessSync(dir, fs.constants.R_OK | fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * A directory git would accept as a git dir, checked as strictly as git checks
 * it: a HEAD git can parse, and an `objects` and a `refs` directory it can
 * enter (a linked worktree's git dir has a `commondir` in their place).
 *
 * Strict on purpose. This is what lets the reader stop at a `.git` and call it
 * the repository. A looser check would stop at a planted `.git` that git walks
 * straight past, and report a nearer root than git does.
 */
function isGitDir(dir: string): boolean {
  const head = readSmallFile(path.join(dir, 'HEAD'), GIT_POINTER_MAX_BYTES);
  if (head === null || !VALID_HEAD_RE.test(head)) return false;
  if (lstatOrNull(path.join(dir, 'commondir'))?.isFile()) return true;
  return isAccessibleDir(path.join(dir, 'objects')) && isAccessibleDir(path.join(dir, 'refs'));
}

/**
 * A directory that might be a git dir. Loose on purpose, the other way round:
 * the walk leaves anything that might be one to git, because git has no work
 * tree to report from inside a git dir or a bare repository.
 */
function mightBeGitDir(dir: string): boolean {
  return lstatOrNull(path.join(dir, 'HEAD')) !== null;
}

/** What the reader needs from a git config file, when git would accept the file. */
export interface GitConfigFacts {
  /**
   * git's own name for each key to its last value: `section.key`, or
   * `section.subsection.key` under a `[section "subsection"]` header (section
   * and key lower case, subsection as written). A key with no `=` is `true`.
   * The subsection is kept because `[core "x"] bare = false` is `core.x.bare`
   * to git and must not be read as `core.bare`.
   */
  values: Map<string, string | true>;
  /** Every section name seen, lower case, without its subsection. */
  sections: Set<string>;
}

/**
 * Parse a git config file the way git's own reader does, or return null where
 * git would reject the file. It follows config.c: `#` and `;` comments, a
 * `[section]` or `[section "subsection"]` header that may be followed by a
 * key on the same line, keys of letters, digits and `-`, a value that may be
 * quoted in part, the escapes `\\ \" \n \t \b`, and a backslash at the
 * end of a line continuing the value.
 *
 * The reader must not answer for a repository git refuses to open, and must
 * read `core.bare` and `core.worktree` exactly as git does, so guessing with
 * patterns is not enough. tests/git-layout-parity.process.test.cjs compares
 * this function with `git config --file` over generated files.
 */
export function parseGitConfig(input: string): GitConfigFacts | null {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const values = new Map<string, string | true>();
  const sections = new Set<string>();
  let section: string | null = null;
  let i = 0;
  const n = text.length;
  // git's isspace: these four and no others. A form feed or vertical tab is a bad config line to git.
  const isSpace = (c: string): boolean => c === ' ' || c === '\t' || c === '\r' || c === '\n';

  while (i < n) {
    const c = text[i];
    if (isSpace(c)) { i += 1; continue; }
    if (c === '#' || c === ';') {
      while (i < n && text[i] !== '\n') i += 1;
      continue;
    }
    if (c === '[') {
      i += 1;
      let name = '';
      let subsection: string | null = null;
      for (;;) {
        if (i >= n) return null;
        const h = text[i];
        if (h === ']') { i += 1; break; }
        if (h === ' ' || h === '\t') {
          // a quoted subsection, then the closing bracket
          while (i < n && (text[i] === ' ' || text[i] === '\t')) i += 1;
          if (text[i] !== '"') return null;
          i += 1;
          subsection = '';
          for (;;) {
            if (i >= n || text[i] === '\n') return null;
            if (text[i] === '"') { i += 1; break; }
            if (text[i] === '\\') {
              i += 1;
              if (i >= n || text[i] === '\n') return null;
            }
            subsection += text[i];
            i += 1;
          }
          if (text[i] !== ']') return null;
          i += 1;
          break;
        }
        if (!/[A-Za-z0-9.-]/.test(h)) return null;
        name += h.toLowerCase();
        i += 1;
      }
      if (name === '') return null;
      section = subsection === null ? name : `${name}.${subsection}`;
      // `[a.b]` is git's old spelling of a subsection: the section is `a`.
      sections.add(name.split('.')[0]);
      continue;
    }
    if (!/[A-Za-z]/.test(c)) return null;

    let key = '';
    while (i < n && /[A-Za-z0-9-]/.test(text[i])) { key += text[i].toLowerCase(); i += 1; }
    while (i < n && (text[i] === ' ' || text[i] === '\t')) i += 1;
    // git accepts a key before any section header; it belongs to no section.
    const full = `${section ?? ''}.${key}`;
    if (i >= n || text[i] === '\n' || (text[i] === '\r' && text[i + 1] === '\n')) {
      values.set(full, true);
      continue;
    }
    if (text[i] !== '=') return null;
    i += 1;

    let value = '';
    let quoted = false;
    let pendingSpace = '';
    let started = false;
    for (;;) {
      if (i >= n) {
        if (quoted) return null;
        break;
      }
      const v = text[i];
      if (v === '\n') {
        if (quoted) return null;
        i += 1;
        break;
      }
      if (!quoted && (v === ';' || v === '#')) {
        while (i < n && text[i] !== '\n') i += 1;
        continue;
      }
      if (!quoted && isSpace(v)) {
        if (started) pendingSpace += v;
        i += 1;
        continue;
      }
      if (v === '"') { quoted = !quoted; started = true; i += 1; continue; }
      if (v === '\\') {
        const e = text[i + 1];
        if (e === '\n') { i += 2; continue; }
        if (e === undefined) { i += 1; continue; } // a backslash that ends the file continues onto nothing
        if (e === '\r' && text[i + 2] === '\n') { i += 3; continue; }
        const mapped = e === 't' ? '\t' : e === 'b' ? '\b' : e === 'n' ? '\n' : e === '\\' || e === '"' ? e : null;
        if (mapped === null) return null;
        value += pendingSpace + mapped;
        pendingSpace = '';
        started = true;
        i += 2;
        continue;
      }
      value += pendingSpace + v;
      pendingSpace = '';
      started = true;
      i += 1;
    }
    values.set(full, value);
  }
  return { values, sections };
}

/** Extensions that do not change where the work tree or the common dir is. */
const LAYOUT_NEUTRAL_EXTENSIONS: ReadonlySet<string> = new Set([
  'worktreeconfig', 'objectformat', 'compatobjectformat', 'refstorage', 'noop', 'noop-v1',
  'preciousobjects', 'partialclone', 'relativeworktrees',
]);

/**
 * Whether a git dir's config leaves the layout as the files on disk show it.
 * `false` means "ask git": the config cannot be read, git would reject it,
 * the repository format is one this reader does not know, an extension is
 * unknown, the file includes another, or `core.bare` / `core.worktree` is set
 * to anything but a plain false. Reads `config` and `config.worktree` (the
 * per-worktree file that `extensions.worktreeConfig` turns on; reading it when
 * the extension is off can only make this stricter). A missing file is fine.
 */
function configKeepsLayout(gitDir: string): boolean {
  for (const name of ['config', 'config.worktree']) {
    const file = path.join(gitDir, name);
    if (lstatOrNull(file) === null) continue;
    const text = readSmallFile(file, GIT_CONFIG_MAX_BYTES);
    const config = text === null ? null : parseGitConfig(text);
    if (config === null) return false;
    if (config.sections.has('include') || config.sections.has('includeif')) return false;
    if (config.values.has('core.worktree')) return false;
    const bare = config.values.get('core.bare');
    if (bare !== undefined && (bare === true || !/^(?:false|no|off|0)$/i.test(bare))) return false;
    const version = config.values.get('core.repositoryformatversion');
    if (version !== undefined && version !== '0' && version !== '1') return false;
    for (const key of config.values.keys()) {
      if (key.startsWith('extensions.') && !LAYOUT_NEUTRAL_EXTENSIONS.has(key.slice('extensions.'.length))) return false;
    }
  }
  return true;
}

/**
 * git refuses a repository another user owns (`safe.directory`), and the git
 * path then degrades to the start directory. The reader must not accept what
 * git refuses: a `.git` planted in a directory that others can write to (above
 * the start) would otherwise become the root.
 *
 * Where there is a uid, every path the answer rests on must be this user's.
 * Windows has none to compare, so there the answer must rest only on paths
 * inside this user's home directory, which other accounts cannot write to;
 * a repository anywhere else is left to git.
 */
function ownedByThisUser(...paths: string[]): boolean {
  if (typeof process.getuid === 'function') {
    const uid = process.getuid();
    return paths.every((p) => lstatOrNull(p)?.uid === uid);
  }
  let home: string;
  try {
    home = fs.realpathSync.native(os.homedir());
  } catch {
    return false;
  }
  if (!path.isAbsolute(home) || path.parse(home).root === home) return false;
  const prefix = (home + path.sep).toLowerCase();
  return paths.every((p) => (p + path.sep).toLowerCase().startsWith(prefix));
}

function okFacts(worktreeRoot: string, repoRoot: string, gitCommonDir: string): GitFacts {
  return { worktreeRoot, repoRoot, gitCommonDir, reason: 'ok', degraded: false, warnings: [] };
}

/** `dir` (real) holds a `.git` entry: the facts, or null for a layout left to git. */
function layoutAt(start: string, realStart: string, dir: string, dotGit: string, entry: fs.Stats): GitFacts | null {
  if (entry.isDirectory()) {
    // A main checkout. git prints the common dir relative to the working
    // directory here, and the caller resolves it against `start`, so the
    // spelling of `start` is kept: `<start>/.git`, or `<start>/../../.git`.
    if (!isGitDir(dotGit) || lstatOrNull(path.join(dotGit, 'commondir')) !== null) return null;
    if (!configKeepsLayout(dotGit) || !ownedByThisUser(dir, dotGit)) return null;
    return okFacts(dir, dir, path.resolve(start, path.relative(realStart, dir), '.git'));
  }
  if (!entry.isFile()) return null; // a symlink, or something that is not a git entry

  const pointer = readSmallFile(dotGit, GIT_POINTER_MAX_BYTES);
  const named = pointer === null ? null : /^gitdir: (.+?)\r?\n?$/.exec(pointer);
  if (named === null) return null;
  const gitDir = path.resolve(dir, named[1]);
  // git reports these paths with links resolved. Where that would differ from
  // the path as written, the spelling is git's to choose.
  if (!isRealPath(gitDir) || !isGitDir(gitDir)) return null;

  const commonText = readSmallFile(path.join(gitDir, 'commondir'), GIT_POINTER_MAX_BYTES);
  if (commonText === null) {
    // No commondir: a separate git dir (`git init --separate-git-dir`). A
    // submodule has the same shape plus `core.worktree`, which leaves it to git.
    if (lstatOrNull(path.join(gitDir, 'commondir')) !== null || !path.isAbsolute(named[1])) return null;
    if (!configKeepsLayout(gitDir) || !ownedByThisUser(dir, dotGit, gitDir)) return null;
    return okFacts(dir, dir, gitDir);
  }

  // A linked worktree: <common>/worktrees/<name>, whose `gitdir` file points
  // back at this `.git` file. The main checkout is the common dir's parent,
  // which is what `git worktree list` prints first for a non-bare repository.
  const commonDir = path.resolve(gitDir, commonText.trim());
  if (commonText.trim() === '' || !isRealPath(commonDir)) return null;
  if (path.dirname(gitDir) !== path.join(commonDir, 'worktrees')) return null;
  const back = readSmallFile(path.join(gitDir, 'gitdir'), GIT_POINTER_MAX_BYTES);
  if (back === null || back.trim() === '' || !sameRealPath(path.resolve(gitDir, back.trim()), dotGit)) return null;
  if (path.basename(commonDir) !== '.git' || !lstatOrNull(commonDir)?.isDirectory() || !isGitDir(commonDir)) return null;
  if (!configKeepsLayout(commonDir) || !configKeepsLayout(gitDir)) return null;
  // The main checkout is part of the answer (it is the repo root), so it is checked as well.
  if (!ownedByThisUser(dir, dotGit, gitDir, commonDir, path.dirname(commonDir))) return null;
  return okFacts(dir, path.dirname(commonDir), commonDir);
}

function isRealPath(p: string): boolean {
  try {
    return fs.realpathSync.native(p) === p;
  } catch {
    return false;
  }
}

function sameRealPath(a: string, b: string): boolean {
  try {
    return fs.realpathSync.native(a) === fs.realpathSync.native(b);
  } catch {
    return false;
  }
}

/**
 * The git facts for `start` (an absolute path), read from the filesystem.
 * `null` means "not a layout this reader answers for": ask git.
 */
export function readGitLayout(start: string): GitFacts | null {
  for (const name of GIT_DISCOVERY_ENV) {
    if (process.env[name] !== undefined && process.env[name] !== '') return null;
  }
  let realStart: string;
  try {
    realStart = fs.realpathSync.native(start);
  } catch {
    return null; // not there, or unreadable: git reports that its own way
  }
  // git prints paths in its own spelling on Windows (drive case, short names).
  // Only a start that is already canonical is known to come out the same.
  if (process.platform === 'win32' && realStart !== start) return null;

  let dir = realStart;
  let device: number | null = null;
  for (let depth = 0; depth < GIT_WALK_MAX_DEPTH; depth += 1) {
    let st: fs.Stats;
    try {
      st = fs.statSync(dir);
    } catch {
      return null;
    }
    if (!st.isDirectory()) return null;
    // git does not look past a filesystem boundary (the variable that lets it
    // is one of those checked above), so nothing above here can be the answer.
    if (device !== null && st.dev !== device) return lexicalFacts(start, 'not_git_repo', false, []);
    device = st.dev;
    // Inside a git dir or a bare repository git has no work tree to report.
    if (mightBeGitDir(dir)) return null;

    const dotGit = path.join(dir, '.git');
    const entry = lstatOrNull(dotGit);
    if (entry !== null) return layoutAt(start, realStart, dir, dotGit, entry);

    const parent = path.dirname(dir);
    if (parent === dir) return lexicalFacts(start, 'not_git_repo', false, []);
    dir = parent;
  }
  return null;
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
  const layoutReader = opts.deps?.readGitLayout ?? readGitLayout;
  const realpath = opts.deps?.fs?.realpathSync ?? fs.realpathSync.native;
  const explicit = opts.explicit ? path.resolve(opts.explicit) : null;
  const start = explicit ?? path.resolve(startDir);

  // #6355: the filesystem answers first and no process is started. A layout
  // the reader does not recognise goes to git, as every layout did before.
  const fromFilesystem = layoutReader(start);
  const layout: ProjectContextProvenance['layout'] = fromFilesystem === null ? 'git' : 'filesystem';
  const facts = fromFilesystem ?? readGitFacts(start, execGit);
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
    layout,
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

/** `candidate` relative to `root` when it sits strictly inside it, else null. A child named `..x` is inside. */
function relativeInside(root: string, candidate: string): string | null {
  const inside = tryWithinRootLexical(candidate, root);
  if (inside === null) return null;
  const rel = path.relative(root, inside);
  return rel === '' ? null : rel;
}

/**
 * #6820 (ADR-4908 §3): a planning artifact is contained against the root its
 * content really lives in. Under the `gsd-planning-out-of-repo.md` layout
 * (`.planning -> ../<repo>-planning`) the realpath of `.planning/phases/...`
 * sits outside `ctx.projectRoot`, so a path that is lexically under the
 * project's `.planning` entry (or already under the store's own root) is checked
 * against `ctx.planningRoot`; anything else keeps the project-root containment
 * under the caller's `policy`. Both checks go through `requireSafePath`, so a
 * traversal or a symlink that leaves the chosen root is still refused.
 *
 * Returns the contained path and how it is shown back to the caller
 * (project-relative, `.planning/...` for the store).
 */
export function requirePlanningArtifactPath(
  ctx: ProjectContext,
  filePath: string,
  label: string,
  policy: PathAcceptancePolicy = PathAcceptance.AbsoluteInsideRoot,
): { resolved: string; display: string } {
  const lexical = path.resolve(ctx.projectRoot, filePath);
  const entryDir = path.join(ctx.projectRoot, '.planning');
  const viaEntry = relativeInside(entryDir, lexical);
  if (viaEntry !== null) {
    // The `.planning` entry itself is the containment base: requireSafePath realpaths base and candidate
    // alike, so a `.planning` symlinked into a separate store contains `.planning/phases/...`, and `resolved`
    // is spelled by the same realpath as the old project-root check (a caller that makes it relative to the
    // project root, complete-session's commit path, was written against that spelling). `ctx.planningRoot`
    // comes from `realpathSync.native`, which on Windows expands an 8.3 temp name the JS realpath keeps.
    const resolved = requireSafePath(viaEntry, entryDir, label, PathAcceptance.RelativeOnly);
    return { resolved, display: path.join('.planning', viaEntry) };
  }
  const viaStore = relativeInside(ctx.planningRoot, lexical);
  if (viaStore !== null) {
    const resolved = requireSafePath(viaStore, ctx.planningRoot, label, PathAcceptance.RelativeOnly);
    return { resolved, display: path.join('.planning', viaStore) };
  }
  const resolved = requireSafePath(filePath, ctx.projectRoot, label, policy);
  return { resolved, display: path.relative(ctx.projectRoot, resolved) };
}
