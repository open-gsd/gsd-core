'use strict';
// hooks/lib/isolation-sentinel.js — shared sentinel reader for the #3045
// agent-dispatch isolation guards (hooks/gsd-agent-isolation-guard.js,
// hooks/gsd-cursor-subagent-start.js).
//
// #3045 BLOCKER: the guards previously keyed enforcement on the capability
// REGISTRY's `dispatch.isolation` ("this host CAN isolate"), not the
// workflow's resolved per-dispatch ISOLATION ("this dispatch SHOULD be
// isolated"). Sequential ISOLATION=none legitimately happens on a
// harness-worktree-capable host — project-level `workflow.use_worktrees:
// false`, the #2474 per-plan submodule degrade, and the #683/#3060
// base-check auto-degrade all resolve to `none` and are NOT bugs
// (gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md:
// "Sequential mode … Omit isolation=\"worktree\" from the Agent call").
//
// The workflow already computes ISOLATION deterministically in shell before
// any executor dispatch. CORE REDESIGN (two-review follow-up): the PRIMARY
// write path is now `dispatch-isolation` itself (gsd-tools.cjs
// routeDispatchIsolation) — it persists mode + harnessFlag + phase/plan
// identifiers to the sentinel as an unconditional side effect of resolving
// them, since the workflow must call it to learn ISOLATION at all.
// `record-dispatch-isolation` (routeRecordDispatchIsolation) remains as an
// explicit fallback for the per-plan submodule-degrade override and shares
// the exact same atomic-write implementation.
//
// Sentinel path: `<cwd>/.gsd/dispatch-isolation-sentinel.json`. The writer
// seeds `.gsd/.gitignore` so this stays ignored in user projects too,
// and lives inside the checkout that ran the workflow — concurrent worktrees
// of the same repo are separate directories on disk, so each gets its own
// sentinel with no cross-worktree collision, no lock file needed.
//
// #3045 SECURITY F3 (LOW, accepted risk — documented, not redesigned for):
// the sentinel lives at a fixed, predictable, gitignored path inside the
// PRIMARY checkout. An agent already running inside a legitimately isolated
// worktree (i.e. one that has shell/filesystem access to the primary
// checkout's absolute path, which every worktree-isolated agent does by
// construction) could write a fabricated fresh `{isolation:"none"}` sentinel
// into the primary checkout to silence this guard for that checkout's next
// dispatch.
//   - This grants NO NEW write privilege: that same agent could already edit
//     any file in the primary checkout directly (worktree isolation protects
//     the primary checkout from an UNTRUSTED executor's own dispatch, not
//     from a trusted orchestrator process choosing to reach across).
//   - It DOES add an evasion path: silencing the guard via the sentinel
//     leaves no trace in `git status` (`.gsd/` is gitignored), where a direct
//     edit to a tracked file would.
// Accepted because the threat model this guard defends against is an
// UNCONSENTED, UNVERIFIED dispatch — not a deliberately adversarial
// orchestrator process, which already has strictly more direct means to
// cause harm than forging this one file. If that threat model changes (e.g.
// executors become mutually distrusting / sandboxed from the orchestrator's
// own filesystem), the hardening path is a SESSION-KEYED sentinel written
// outside any worktree the executor can reach (e.g. under the harness's own
// config dir, keyed by a session/run id neither the executor nor a forged
// file can predict) rather than a path derivable from `cwd`.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { classifyGitProbe, BLOCKING_GUARD_PROBE_TIMEOUT_MS } = require('./git-probe.js');
const { parseDispatchIdentity } = require('./dispatch-identity.js');

// Isolation modes ADR-1239 declares (mirrors gsd-tools.cjs
// routeDispatchIsolation / routeRecordDispatchIsolation).
const VALID_ISOLATION = new Set(['harness-worktree', 'orchestrator-worktree', 'none']);

const SENTINEL_RELATIVE_PATH = path.join('.gsd', 'dispatch-isolation-sentinel.json');

// #3045 SECURITY F2 fix: how long a written sentinel is trusted as "this
// dispatch's decision" before a reader falls back to the conservative
// registry+config check.
//
// Previously 4h, on the theory that a slow multi-wave phase execution could
// span well over an hour. That reasoning no longer holds: the #3045 CORE
// REDESIGN makes `dispatch-isolation` (gsd-tools.cjs routeDispatchIsolation)
// the sole write path, called as a side effect of resolving ISOLATION — and
// the workflow now re-resolves (and therefore re-records) immediately before
// EVERY plan's dispatch, at the per-plan worktree gate
// (execute-phase/steps/per-plan-worktree-gate.md), not once per phase. A long
// trust window no longer buys the workflow anything and only widens the
// window in which a stale sentinel from an EARLIER, DIFFERENT phase/plan
// (e.g. one that legitimately degraded to `none`) could be misread as
// authorizing a LATER dispatch that never got its own fresh record (a model
// skipping the kwarg on a harness-worktree phase while a same-session
// same-project stale `none` from a prior phase is still "fresh" by the old
// 4h window).
//
// 10 minutes generously covers the real latency between a per-plan gate's
// resolve call and that same plan's `Agent()`/`Task()` dispatch (worktree
// creation, orphan-worktree sweep, base-check, prompt composition) — all
// bounded, sub-minute operations per their own repo-mandated subprocess
// timeouts — while being far too short for a sentinel to survive into a
// later, unrelated phase.
const SENTINEL_STALE_MS = 10 * 60 * 1000; // 10 minutes

function sentinelPath(cwd) {
  return path.join(cwd, SENTINEL_RELATIVE_PATH);
}

/**
 * Resolve the project root a sentinel should be read from/written to, using
 * the SAME derivation gsd-tools.cjs's dispatcher applies to every `--cwd`
 * before invoking a route handler: `findProjectRoot(resolveMainWorktreeCwd(cwd))`
 * (gsd-core/bin/gsd-tools.cjs main(), :3506/:3603 — `record-dispatch-isolation`
 * and `dispatch-isolation` are not in SKIP_ROOT_RESOLUTION, so every write
 * goes through both steps).
 *
 * #3045 MINOR fix: the guard hooks previously read the sentinel from the raw
 * `data.cwd` / `workspace_roots[i]` the harness reports, with NO equivalent
 * resolution. For a linked worktree that does not itself own a `.planning/`
 * (the common shape — `.planning/` lives in the main worktree only), the
 * writer resolves up to the MAIN worktree and writes there, while the reader
 * checked `.planning/config.json` at the raw (unresolved) linked-worktree
 * path, found nothing, and silently treated the dispatch as "not a GSD
 * project" (inert allow) — the guard was reading a sentinel that was never
 * written where it looked. Deriving both sides through this one function
 * closes that divergence.
 *
 * `findProjectRoot`/`resolvePlanningWorktreeRoot` are read from the sibling
 * `gsd-core/bin/lib/*.cjs` modules staged alongside these hooks at install
 * time (same pattern the guard hooks already use for
 * capability-registry.cjs/runtime-name-policy.cjs) — two directories up from
 * `hooks/lib/` (`hooks/lib/isolation-sentinel.js` -> `hooks/` -> repo/install
 * root -> `gsd-core/bin/lib/`), mirroring the one-directory-up requires the
 * top-level `hooks/*.js` guard scripts already use successfully.
 *
 * Never throws; any resolution failure (module missing, git unavailable,
 * git timeout) degrades to the raw `cwd` unchanged. That is safe for
 * `readSentinel` alone — a sentinel not found there is "absent", and the
 * caller's conservative fallback covers it — and ONLY for that: a raw `cwd`
 * is no answer to "is this dispatch in a GSD project", so the guards decide
 * that through `resolveGuardProject`, which reports a failure instead
 * (#4885 review).
 */
function resolveSentinelRoot(cwd) {
  try {
    if (fs.existsSync(path.join(cwd, '.planning'))) {
      return cwd;
    }
    return resolveProjectRootOrThrow(cwd).root;
  } catch {
    return cwd;
  }
}

/**
 * The derivation `resolveSentinelRoot` and `resolveGuardProject` share —
 * gsd-tools' own `findProjectRoot(resolvePlanningWorktreeRoot(cwd))` — after
 * self-healing the runtime library it needs. THROWS on any failure (a
 * RuntimeBuildError, a missing module, git unavailable): `resolveSentinelRoot`
 * degrades that to the raw `cwd`, while a guard must not (#4885 review).
 *
 * #3582: worktree-safety.cjs / project-root.cjs are tsc build artifacts
 * (ADR-457), gitignored and absent on a raw plugin-marketplace / git-clone
 * install that never ran `npm run build:lib`, so the build is ensured before
 * either require.
 */
function resolveProjectRootOrThrow(cwd) {
  const { ensureRuntimeBuild } = require('../../gsd-core/bin/ensure-runtime-build.cjs');
  ensureRuntimeBuild();
  const { root, reason } = planningWorktreeRoot(require('../../gsd-core/bin/lib/worktree-safety.cjs'), cwd);
  const projectRootLib = require('../../gsd-core/bin/lib/project-root.cjs');
  return { root: projectRootLib.findProjectRoot(root), reason, maxDepth: projectRootLib.FIND_PROJECT_ROOT_MAX_DEPTH };
}

/**
 * #4885: the resolver gsd-tools' root resolution uses, so a linked worktree
 * carrying its own `.planning/` is read where it was written. A lib staged
 * without that export (hooks newer than the lib) keeps the pre-#4885
 * main-worktree resolution rather than failing.
 */
function planningWorktreeRoot(worktreeSafety, cwd) {
  return typeof worktreeSafety.resolvePlanningWorktreeRoot === 'function'
    ? worktreeSafety.resolvePlanningWorktreeRoot(cwd)
    : worktreeSafety.resolveWorktreeRoot(cwd);
}

/** The nearest directory at or above `cwd`, at any depth, holding `.planning/config.json`, else null. Pure fs: no git, no build. */
function nearestProjectConfigDir(cwd) {
  let dir = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.planning', 'config.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * #4885 review (2026-10-10): the project a dispatch guard evaluates for
 * `cwd`, as a verdict rather than a path — a guard has to tell "no GSD
 * project here" from "could not tell" (#3050: a guard that cannot verify must
 * not answer "safe"):
 *
 *   { project: false }                          no project applies to `cwd`
 *   { project: true, root, sentinelRoot: root } evaluate the project at `root`
 *   { project: true, root: null, error }        `cwd` is inside a GSD project,
 *                                               but which root governs it
 *                                               could not be verified — deny
 *
 * The root is always the one gsd-tools writes the sentinel under
 * (`resolveProjectRootOrThrow`): the sentinel and the config are read from the
 * same place, and no other root's configuration is ever substituted.
 *
 * A pure-fs probe runs first — the lexical path, then (only when that finds
 * nothing, so a `.planning` symlink to an external store keeps its #4815
 * lexical meaning) the canonical one. With no `.planning/config.json` at or
 * above either, nothing is built, git never runs, and the dispatch is not a
 * GSD project's — the pre-#4885 answer. `cwd` itself holding one is its own
 * root, as before. Otherwise:
 *   - a resolution failure or git timeout is unresolved (deny);
 *   - the writer's root holding `.planning/config.json` is the project;
 *   - `cwd` in a different repository from the project above (an independent
 *     nested repository, #2843) is not that project's;
 *   - the writer's root holding a `.planning/` with no config, or `cwd` past
 *     the ancestor bound `findProjectRoot` walks (so it found nothing), is a
 *     directory inside a GSD project whose governing configuration cannot be
 *     read — unresolved (deny), never an inert "not a project";
 *   - anything else is the resolver's own deliberate "not a project" (`$HOME`).
 */
function resolveGuardProject(cwd) {
  // `from` is the spelling the project was found under: the lexical cwd, or —
  // when only the canonical path leads to a project (a symlinked alias) — the
  // canonical one, so resolution walks the same path the probe did.
  let base = path.resolve(cwd);
  let from = cwd;
  let anchor = nearestProjectConfigDir(base);
  if (anchor === null) {
    try {
      base = fs.realpathSync.native(cwd);
    } catch {
      return { project: false };
    }
    anchor = nearestProjectConfigDir(base);
    if (anchor === null) return { project: false };
    from = base;
  }
  if (anchor === base) return { project: true, root: from, sentinelRoot: from };
  const unresolved = (message) => ({ project: true, root: null, error: new Error(message) });
  // #2843: an independent repository nested in the project is not the
  // project's. Decided by git directly — before any runtime build, so an
  // unbuildable runtime never turns that boundary into a denial. The project's
  // own `.planning` is never such a boundary, even when it is a symlink to an
  // external store with a repository of its own (#4815, as findProjectRoot).
  const inPlanning = path.relative(path.join(anchor, '.planning'), base);
  if (inPlanning.startsWith('..') || path.isAbsolute(inPlanning)) {
    const ownRepo = gitCommonDirOf(base);
    const projectRepo = gitCommonDirOf(anchor);
    if (ownRepo.undetermined || projectRepo.undetermined) {
      return unresolved(`git could not say which repository '${cwd}' belongs to (${ownRepo.undetermined || projectRepo.undetermined}).`);
    }
    if (ownRepo.dir !== projectRepo.dir) return { project: false };
  }
  let resolved;
  try {
    resolved = resolveProjectRootOrThrow(from);
  } catch (error) {
    return { project: true, root: null, error };
  }
  if (resolved.reason === 'git_timed_out') return unresolved(`git timed out resolving which checkout '${cwd}' belongs to.`);
  const root = resolved.root;
  if (fs.existsSync(path.join(root, '.planning', 'config.json'))) return { project: true, root, sentinelRoot: root };
  if (isDirectory(path.join(root, '.planning'))) {
    return unresolved(`'${root}' holds a .planning/ with no config.json, inside the GSD project at '${anchor}'.`);
  }
  const levels = path.relative(anchor, base).split(path.sep).length;
  if (levels > (resolved.maxDepth ?? 10)) {
    return unresolved(`'${cwd}' is ${levels} directories below the GSD project at '${anchor}', past the ${resolved.maxDepth ?? 10} that project-root resolution walks.`);
  }
  return { project: false };
}

/**
 * The canonical git common directory `dir` belongs to — the repository itself,
 * shared by a checkout and every worktree linked to it — or `null` outside any
 * repository; `undetermined` (a reason) when git did not answer. git reports a
 * relative common dir against the PHYSICAL cwd, so it is resolved against
 * `dir`'s realpath, never its lexical spelling (an alias would misplace it).
 */
function gitCommonDirOf(dir) {
  const result = spawnSync('git', ['rev-parse', '--git-common-dir'], {
    cwd: dir, encoding: 'utf8', timeout: BLOCKING_GUARD_PROBE_TIMEOUT_MS, windowsHide: true,
  });
  const probe = classifyGitProbe(result);
  if (!probe.determined) return { dir: null, undetermined: probe.reason };
  if (result.status !== 0) return { dir: null, undetermined: null };
  try {
    return { dir: fs.realpathSync.native(path.resolve(fs.realpathSync.native(dir), String(result.stdout).trim())), undetermined: null };
  } catch {
    return { dir: null, undetermined: null };
  }
}

/** Whether `p` is a directory (through a symlink, as findProjectRoot's check is). */
function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Read and validate the dispatch-isolation sentinel for `cwd`. Never throws.
 * `cwd` is resolved through `resolveSentinelRoot` first (#3045 MINOR — see
 * its doc comment), so callers may pass the raw, unresolved dispatch cwd
 * directly.
 *
 * Returns one of:
 *   { present: false }
 *   { present: true, stale: true,  malformed: true }
 *   { present: true, stale: true,  malformed: false, isolation, harnessFlag, phase, plan, writtenAt }
 *   { present: true, stale: false, malformed: false, isolation, harnessFlag, phase, plan, writtenAt }
 *
 * A malformed/unparseable sentinel is treated as STALE, never fatal — the
 * caller's conservative fallback path covers both "absent" and "stale"
 * identically.
 *
 * `clock` is injectable (`{ now(): number }`, defaults to the real `Date`)
 * per the repo's clock-seam convention, so staleness is testable without
 * asserting on wall-clock time.
 */
function readSentinel(cwd, { clock = Date } = {}) {
  const root = resolveSentinelRoot(cwd);
  let raw;
  try {
    raw = fs.readFileSync(sentinelPath(root), 'utf-8');
  } catch {
    return { present: false };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { present: true, stale: true, malformed: true };
  }

  if (
    !parsed || typeof parsed !== 'object' ||
    !VALID_ISOLATION.has(parsed.isolation) ||
    typeof parsed.written_at !== 'number' || !Number.isFinite(parsed.written_at)
  ) {
    return { present: true, stale: true, malformed: true };
  }

  const harnessFlag = typeof parsed.harness_flag === 'string' && parsed.harness_flag.length > 0
    ? parsed.harness_flag
    : null;
  const phase = typeof parsed.phase === 'string' && parsed.phase.length > 0 ? parsed.phase : null;
  // #3045 SECURITY F2: `plan` was not previously part of the sentinel shape.
  // Recorded so a phase-level-only sentinel (plan: null) is distinguishable
  // from a plan-scoped one — see the guards' dispatch-matching logic, which
  // treats a plan/phase MISMATCH (both sides present and disagreeing) as "no
  // applicable sentinel", not an allow.
  const plan = typeof parsed.plan === 'string' && parsed.plan.length > 0 ? parsed.plan : null;

  const now = clock.now();
  const age = now - parsed.written_at;
  // Negative age beyond a small tolerance means the sentinel claims to be
  // written in the future — never trust it, but still surface the parsed
  // fields so callers can log an actionable reason.
  const stale = age >= SENTINEL_STALE_MS || age < -5000;

  return {
    present: true,
    stale,
    malformed: false,
    isolation: parsed.isolation,
    harnessFlag,
    phase,
    plan,
    writtenAt: parsed.written_at,
  };
}

/**
 * #3045 SECURITY F2 / #4594: extract the `{plan, phase}` a specific
 * Agent()/Task() dispatch is FOR. Variadic — accepts any number of text
 * sources (short description, full prompt body, etc) and delegates to
 * `hooks/lib/dispatch-identity.js::parseDispatchIdentity`, the one canonical
 * owner of both the `[gsd:dispatch phase="…" plan="…"]` marker format and its
 * prose fallback (see `.gsd/phase/fix-4594-dispatch-identity-seam/40-design.md`).
 *
 * MARKER-FIRST CONTRACT: producers embed a structured marker carrying the
 * exact shell values the sentinel itself records (`$PHASE_NUMBER`,
 * `$plan_id`), so producer and consumer agree by construction, independent
 * of how the prose reads or whether a model paraphrases the dispatch
 * sentence. Only when no marker is found anywhere in the supplied texts does
 * this fall back to scanning for the prose frame "execute plan <token> of
 * phase <PHASE TOKEN>".
 *
 * The prose fallback is now CORRECT-OR-ABSENT rather than possibly-wrong:
 * the phase token is bounded by the same grammar `src/phase-id.cts` owns
 * (ADR-2121), so a directory-name slug or trailing punctuation can no longer
 * leak into the phase value, and the prose plan token is never reported at
 * all (it lives in a different namespace than the sentinel's phase-prefixed,
 * slugged `plan_id` — reporting it was the #4594 false-mismatch bug).
 *
 * This is still a best-effort, NOT a guaranteed, extraction: a dispatch that
 * carries neither a marker nor a matching prose frame in ANY supplied text
 * returns `{ plan: null, phase: null }`, and the caller MUST NEVER treat
 * that as a mismatch — see `sentinelAppliesToDispatch`, whose whole
 * contract depends on "missing" and "wrong" being distinguishable.
 *
 * Returns only the two-field `{ plan, phase }` shape existing callers
 * depend on — `parseDispatchIdentity`'s `source` field is discarded here.
 */
function extractDispatchIdentifiers(...texts) {
  const { phase, plan } = parseDispatchIdentity(...texts);
  return { plan, phase };
}

/**
 * #3045 SECURITY F2: does a fresh, non-malformed sentinel apply to THIS
 * dispatch? `dispatchIds` is the `{plan, phase}` extracted from the
 * dispatch's own text via `extractDispatchIdentifiers` (or manually supplied
 * by a caller with a more reliable source).
 *
 * Returns false (mismatch — "no applicable sentinel") ONLY when both sides
 * carry a value for the SAME identifier and they disagree. Any side missing
 * a value (sentinel predates this fix, or the dispatch text didn't match the
 * expected shape) is treated as "cannot compare" and does NOT itself produce
 * a mismatch — this stays a defense-in-depth narrowing of an otherwise-fresh
 * sentinel's applicability, not a new fail-open/fail-closed axis on its own.
 */
function sentinelAppliesToDispatch(sentinel, dispatchIds) {
  if (!sentinel || !dispatchIds) return true;
  if (sentinel.phase && dispatchIds.phase && sentinel.phase !== dispatchIds.phase) return false;
  if (sentinel.plan && dispatchIds.plan && sentinel.plan !== dispatchIds.plan) return false;
  return true;
}

/**
 * #4594 F3: build the structured "a fresh sentinel was present but did not
 * apply to this dispatch" descriptor, mirroring the exact comparison
 * `sentinelAppliesToDispatch` performs. Returns `null` when the sentinel is
 * absent, stale, malformed, or DOES apply — i.e. exactly when there is
 * nothing to report as discarded. Otherwise returns the nested
 * `{ sentinel: {phase, plan}, dispatch: {phase, plan} }` shape, reusing the
 * `{phase, plan}` pair already flowing through this module end to end rather
 * than renaming its fields into an ad hoc `sentinelPhase`/`dispatchPlan` bag
 * (previously rebuilt identically at two call sites in the guard hooks).
 */
function buildSentinelDiscard(sentinel, dispatchIds) {
  if (!sentinel || !sentinel.present || sentinel.stale) return null;
  if (sentinelAppliesToDispatch(sentinel, dispatchIds)) return null;
  return {
    sentinel: { phase: sentinel.phase ?? null, plan: sentinel.plan ?? null },
    dispatch: {
      phase: dispatchIds ? (dispatchIds.phase ?? null) : null,
      plan: dispatchIds ? (dispatchIds.plan ?? null) : null,
    },
  };
}

module.exports = {
  VALID_ISOLATION,
  SENTINEL_RELATIVE_PATH,
  SENTINEL_STALE_MS,
  sentinelPath,
  resolveSentinelRoot,
  resolveGuardProject,
  readSentinel,
  extractDispatchIdentifiers,
  sentinelAppliesToDispatch,
  buildSentinelDiscard,
};
