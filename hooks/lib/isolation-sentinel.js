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
// #5682: the single slot above is last-writer-wins, so two orchestrators sharing one checkout
// overwrote each other's decision and the guard discarded the foreign record. The writer now ALSO
// records each plan-scoped decision at `<cwd>/.gsd/dispatch-isolation/<phase>--<plan>.json`
// (same payload, same cwd-derived location and forgery posture), and `readSentinel` consults the
// record keyed by the dispatch's own phase/plan first, falling back to the single slot.
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
const { parseDispatchIdentity } = require('./dispatch-identity.js');

// Isolation modes ADR-1239 declares (mirrors gsd-tools.cjs
// routeDispatchIsolation / routeRecordDispatchIsolation).
const VALID_ISOLATION = new Set(['harness-worktree', 'orchestrator-worktree', 'none']);

const SENTINEL_RELATIVE_PATH = path.join('.gsd', 'dispatch-isolation-sentinel.json');

// #5682: per-dispatch records, one file per `<phase>--<plan>` under this directory.
const KEYED_SENTINEL_DIR = path.join('.gsd', 'dispatch-isolation');
const SAFE_SENTINEL_KEY_RE = /^[A-Za-z0-9._-]{1,100}$/;

// #5758: a real sentinel payload is under 300 bytes. Anything larger is not one, and the cap bounds
// the read so a hostile or runaway record cannot be pulled into the hook.
const SENTINEL_MAX_BYTES = 4096;

// #6213: executor identity recorded with a dispatch decision. Same bare-name grammar as agent hints
// (no path separators, no `..`, no leading `-`, bounded length). Kept here so the sentinel read path
// needs no gsd-core/bin/lib require; src/executor-type.cts carries the writer-side copy; tests/hinted-executor-record.test.cjs asserts the two stay identical.
const EXECUTOR_TYPE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// #6213: a phase-level record (no plan) names every hinted executor routable within its phase as
// `executor_types`. The reader keeps at most this many valid entries; the writer
// (gsd-tools.cjs writeDispatchIsolationSentinel, via normalizeExecutorTypes) records at most this many.
const MAX_EXECUTOR_TYPES = 64;

// #6213: every non-gsd-executor dispatch's classification scan iterates at most MAX_SCANNED_DIR_ENTRIES directory
// entries and parses at most MAX_SCANNED_RECORDS keyed record files (the newest by mtime among those not
// already past the recency window). When either bound is hit the scan sets `scanOverflow` and
// `isExecutorDispatch` fails closed (see there). The two bounds are equal: every parsed record is a
// directory entry, so the record bound is reached only together with the entry bound, and a heavy day of
// legitimate records (far under 1024 in 24 hours) never trips it. Each record file is still read through
// the SENTINEL_MAX_BYTES bound.
const MAX_SCANNED_DIR_ENTRIES = 1024;
const MAX_SCANNED_RECORDS = MAX_SCANNED_DIR_ENTRIES;

// Tolerance for a record stamped slightly in the future (clock skew between writer and reader).
const CLOCK_SKEW_MS = 5000;

// #6213: the one definition of which `subagent_type` strings identify GSD's executor (verified: only
// agents/gsd-executor.md). A Set so a future sibling executor role is added here once; both isolation
// hooks and `isExecutorDispatch` consume it.
const EXECUTOR_SUBAGENT_TYPES = new Set(['gsd-executor']);

// #6213: every GSD role other than gsd-executor, i.e. the MODEL_PROFILES keys (gsd-core/bin/lib/model-profiles.cjs)
// minus gsd-executor, lower-case. The writer refuses exactly these (as hints in `resolveRoutedExecutor`, and as
// `record-dispatch-isolation --executor-type`), so one is never recorded as an executor; `recordNamesType` also
// never lets a hand-written record classify one. A reader-side copy keeps this hook free of a gsd-core/bin/lib require;
// tests/hinted-executor-isolation.test.cjs asserts the set equals the MODEL_PROFILES keys minus gsd-executor
// in both directions, so a gsd-prefixed custom executor (gsd-rails-executor) is NOT a role here.
const GSD_ROLE_NAMES = Object.freeze(new Set([
  'gsd-planner',
  'gsd-roadmapper',
  'gsd-phase-researcher',
  'gsd-project-researcher',
  'gsd-research-synthesizer',
  'gsd-debugger',
  'gsd-codebase-mapper',
  'gsd-verifier',
  'gsd-plan-checker',
  'gsd-integration-checker',
  'gsd-nyquist-auditor',
  'gsd-pattern-mapper',
  'gsd-ui-researcher',
  'gsd-ui-checker',
  'gsd-ui-auditor',
  'gsd-doc-writer',
  'gsd-doc-verifier',
  'gsd-dom-verifier',
  'gsd-advisor-researcher',
  'gsd-ai-researcher',
  'gsd-assumptions-analyzer',
  'gsd-code-fixer',
  'gsd-code-reviewer',
  'gsd-debug-session-manager',
  'gsd-doc-classifier',
  'gsd-doc-synthesizer',
  'gsd-domain-researcher',
  'gsd-eval-auditor',
  'gsd-eval-planner',
  'gsd-framework-selector',
  'gsd-intel-updater',
  'gsd-mempalace-curator',
  'gsd-security-auditor',
  'gsd-user-profiler',
]));

/**
 * #6213: a GSD role name other than gsd-executor (gsd-verifier, gsd-planner, ...), trimmed and
 * case-folded. A gsd-prefixed name outside GSD_ROLE_NAMES is a custom executor, not a role.
 */
function isGsdRoleName(v) {
  if (typeof v !== 'string') return false;
  return GSD_ROLE_NAMES.has(v.trim().toLowerCase());
}

/**
 * True iff `name` ends in `.json`, folding case by UPPER-casing. Case-insensitive volumes (macOS) also fold
 * U+017F (long s) to `s`, so `02.jſon` opens as `02.json`; toLowerCase() leaves it unchanged but
 * toUpperCase() maps it to `S`, so this match covers every spelling the filesystem resolves to `.json`.
 */
function hasJsonSuffix(name) {
  return typeof name === 'string' && name.toUpperCase().endsWith('.JSON');
}

/** #6213: the name a deny message may show for a `subagent_type`: the name when it is a valid executor type, else a fixed placeholder (an arbitrary, possibly multi-line or oversize string never enters the message). */
function displayAgentName(v) {
  return isValidExecutorType(v) ? v : '<invalid agent name>';
}

/** #6213: true iff `v` is an acceptable recorded executor type. */
function isValidExecutorType(v) {
  return typeof v === 'string' && EXECUTOR_TYPE_RE.test(v) && !v.includes('..');
}

/** #5682: strict allow-list for a phase/plan string that becomes a path segment. */
function isSafeSentinelKey(s) {
  return typeof s === 'string' && SAFE_SENTINEL_KEY_RE.test(s) && s !== '.' && s !== '..';
}

/** #5682: keyed record path for a dispatch, or null unless BOTH phase and plan are safe keys. */
function keyedSentinelPath(root, phase, plan) {
  if (!isSafeSentinelKey(phase) || !isSafeSentinelKey(plan)) return null;
  return path.join(root, KEYED_SENTINEL_DIR, `${phase}--${plan}.json`);
}

/**
 * #5682: phase-level keyed record path (`<phase>.json`, written when a decision carries no plan),
 * or null unless the phase is a safe key. Two orchestrators recording plan-less decisions for
 * different phases each keep their own file.
 */
function phaseSentinelPath(root, phase) {
  if (!isSafeSentinelKey(phase)) return null;
  return path.join(root, KEYED_SENTINEL_DIR, `${phase}.json`);
}

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

// #5479: the longest a recorded sequential degrade keeps governing its own phase after the trust
// window (see agedNoneGovernsDispatch). A single executor run is minutes to a couple of hours; a
// day is a generous bound that still ends a stale or forged record's authority.
const AGED_NONE_MAX_MS = 24 * 60 * 60 * 1000;

function sentinelPath(cwd) {
  return path.join(cwd, SENTINEL_RELATIVE_PATH);
}

/**
 * Resolve the project root a sentinel should be read from/written to, using
 * the SAME derivation gsd-tools.cjs's dispatcher applies to every `--cwd`
 * before invoking a route handler: `resolveProjectContext(cwd).projectRoot`
 * (gsd-core/bin/gsd-tools.cjs main() — `record-dispatch-isolation` and
 * `dispatch-isolation` are not in SKIP_ROOT_RESOLUTION, so every write goes
 * through it).
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
 * `resolveProjectContext` is read from the sibling
 * `gsd-core/bin/lib/*.cjs` modules staged alongside these hooks at install
 * time (same pattern the guard hooks already use for
 * capability-registry.cjs/runtime-name-policy.cjs) — two directories up from
 * `hooks/lib/` (`hooks/lib/isolation-sentinel.js` -> `hooks/` -> repo/install
 * root -> `gsd-core/bin/lib/`), mirroring the one-directory-up requires the
 * top-level `hooks/*.js` guard scripts already use successfully.
 *
 * Never throws; any resolution failure (module missing, git unavailable,
 * git timeout) degrades to the raw `cwd` unchanged — the caller's existing
 * "sentinel absent -> conservative fallback" path already covers that safely.
 */
function resolveSentinelRoot(cwd) {
  try {
    if (fs.existsSync(path.join(cwd, '.planning'))) {
      return cwd;
    }
    // #3582: worktree-safety.cjs / project-root.cjs are tsc build artifacts
    // (ADR-457), gitignored and absent on a raw plugin-marketplace / git-clone
    // install that never ran `npm run build:lib`. Self-heal before either
    // require below; a RuntimeBuildError (or any other failure) falls through
    // to the existing catch's degrade-to-raw-`cwd` — unchanged behavior, just
    // now attempted-healed-first rather than silently degrading on the first
    // cold-tree encounter.
    const { ensureRuntimeBuild } = require('../../gsd-core/bin/ensure-runtime-build.cjs');
    ensureRuntimeBuild();
    // #6043 (ADR-4908): the dispatcher resolves non-skip commands through the
    // same seam, so the reader looks where the writer wrote.
    const { resolveProjectContext } = require('../../gsd-core/bin/lib/project-context.cjs');
    return resolveProjectContext(cwd).projectRoot;
  } catch {
    return cwd;
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
 *   { present: true, stale: true,  malformed: false, isolation, harnessFlag, phase, plan, writtenAt, executorType, executorTypes, executorTypesTruncated }
 *   { present: true, stale: false, malformed: false, isolation, harnessFlag, phase, plan, writtenAt, executorType, executorTypes, executorTypesTruncated }
 *
 * A malformed/unparseable sentinel is treated as STALE, never fatal — the
 * caller's conservative fallback path covers both "absent" and "stale"
 * identically.
 *
 * `clock` is injectable (`{ now(): number }`, defaults to the real `Date`)
 * per the repo's clock-seam convention, so staleness is testable without
 * asserting on wall-clock time.
 */
function readSentinel(cwd, { clock = Date, dispatchIds = null, subagentType = null, readText = readSentinelText } = {}) {
  const root = resolveSentinelRoot(cwd);
  // #6213: the executor-identity scan feeds only `isExecutorDispatch`, which answers true for gsd-executor
  // before it looks at any record, so a gsd-executor dispatch skips the scan; its enforcement read is the
  // pre-#6213 read plus one bounded retry of a refused file. `readText` is a seam for tests (a replacement for `readSentinelText`).
  const classify = !EXECUTOR_SUBAGENT_TYPES.has(subagentType);

  // #5682: candidates are the record keyed by this dispatch's own phase/plan, the phase-level
  // record for its phase, and the single legacy slot. A keyed candidate counts only when it is
  // well-formed and its contents agree with its own filename key; the legacy slot only when it
  // applies to this dispatch. Among FRESH candidates the latest `writtenAt` wins, so a newer
  // phase-level decision is not shadowed by an older plan-scoped one (and vice versa).
  const gsdDir = path.join(root, '.gsd');
  const keyedDirs = [gsdDir, path.join(root, KEYED_SENTINEL_DIR)];
  const keyedCandidates = [];
  if (dispatchIds) {
    const planFile = keyedSentinelPath(root, dispatchIds.phase, dispatchIds.plan);
    if (planFile) {
      const c = parseSentinelFileRetrying(planFile, clock, keyedDirs, readText);
      if (c.present && !c.malformed && c.phase === dispatchIds.phase && c.plan === dispatchIds.plan) keyedCandidates.push(c);
    }
    const phaseFile = phaseSentinelPath(root, dispatchIds.phase);
    if (phaseFile) {
      const c = parseSentinelFileRetrying(phaseFile, clock, keyedDirs, readText);
      if (c.present && !c.malformed && c.phase === dispatchIds.phase && c.plan === null) keyedCandidates.push(c);
    }
  }

  const legacy = parseSentinelFileRetrying(sentinelPath(root), clock, [gsdDir], readText);
  // #6213: a legacy slot that exists and is recent but cannot be used (refused or malformed) may name a
  // type: ENOENT is absent, anything else cannot be ruled out.
  const legacyFuture = legacy.present && !legacy.malformed && legacy.writtenAt - clock.now() > CLOCK_SKEW_MS;
  const legacyUnusable = classify && (!legacy.present || legacy.malformed || legacyFuture) && recentEntryExists(sentinelPath(root), clock);
  const legacyApplies = legacy.present && !legacy.malformed && sentinelAppliesToDispatch(legacy, dispatchIds);
  // #6213: executor-identity classification looks at EVERY recent well-formed record in the project,
  // whatever its phase or plan: the keyed records under `.gsd/dispatch-isolation/` plus the legacy slot.
  // Enforcement (below) is unaffected and still uses the record picked for this dispatch's identity.
  const scanned = classify ? scanRecentKeyedRecords(root, clock, keyedDirs, readText) : [];
  const scanOverflow = scanned.scanOverflow === true || legacyUnusable;

  const fresh = keyedCandidates.filter((c) => !c.stale);
  if (legacyApplies && !legacy.stale) fresh.push(legacy);
  // #6213: every well-formed candidate considered, for executor-identity classification only.
  const considered = [...keyedCandidates, ...scanned, ...(legacy.present && !legacy.malformed ? [legacy] : [])];
  if (fresh.length > 0) return withCandidates(latestWritten(fresh), considered, scanOverflow);

  // Nothing fresh: a stale keyed record still feeds the aged-none path; otherwise the legacy
  // slot is returned exactly as before.
  if (keyedCandidates.length > 0) return withCandidates(latestWritten(keyedCandidates), considered, scanOverflow);
  return withCandidates(legacy, considered, scanOverflow);
}

/**
 * #6213: every well-formed keyed record under `.gsd/dispatch-isolation/` whose contents agree with its
 * own filename key, whatever its phase or plan. Never throws. An mtime-recent `.json` entry that cannot be
 * used (refused by `parseSentinelFile`: oversize, hard-linked, unreadable; malformed; a filename that
 * disagrees with its contents, judged by file identity so a case-insensitive volume is not misread; or a link, FIFO or device) sets `scanOverflow`, because the record may name
 * the type; non-`.json` entries, directories and mtime-aged entries are ignored. A missing `.gsd` or record directory (ENOENT) is empty; a
 * `.gsd` or record directory that exists but is a link, not a directory, or cannot be opened or read sets
 * `scanOverflow` (the records cannot be ruled out). Recency (`AGED_NONE_MAX_MS` by `written_at`) is judged
 * by `isExecutorDispatch`, not here.
 *
 * Bounded without trusting name order: the directory is iterated for at most MAX_SCANNED_DIR_ENTRIES
 * entries (every entry counts); each `.json` regular file whose mtime is already past the recency window
 * (plus the clock-skew allowance) is dropped without being read, so aged records cannot occupy the slots;
 * the survivors are ordered newest mtime first and at most MAX_SCANNED_RECORDS are parsed. A refused parse
 * is retried once (a writer's temp-file rename can straddle a read), and an entry that is gone (ENOENT) after
 * the refusal is absent, not overflow. When the entry bound is hit or a recent entry is unusable (above), the
 * returned array carries a
 * non-enumerable `scanOverflow: true` and `isExecutorDispatch` fails closed.
 */
function scanRecentKeyedRecords(root, clock, keyedDirs, readText = readSentinelText) {
  const out = [];
  const setOverflow = () => Object.defineProperty(out, 'scanOverflow', { value: true, enumerable: false, configurable: true });
  const dir = path.join(root, KEYED_SENTINEL_DIR);
  const survivors = [];
  let overflow = false;
  let handle = null;
  try {
    // `.gsd` first: through a link, the record directory below would lstat as a real directory.
    for (const target of [path.join(root, '.gsd'), dir]) {
      let st;
      try {
        st = fs.lstatSync(target);
      } catch (err) {
        // An absent directory has no records (empty, not overflow); any other failure cannot be enumerated.
        if (err && err.code === 'ENOENT') return out;
        setOverflow();
        return out;
      }
      if (!st.isDirectory() || st.isSymbolicLink()) {
        setOverflow();
        return out;
      }
    }
    handle = fs.opendirSync(dir);
    const now = clock.now();
    let seen = 0;
    for (let ent = handle.readSync(); ent !== null; ent = handle.readSync()) {
      seen += 1;
      if (seen > MAX_SCANNED_DIR_ENTRIES) { overflow = true; break; }
      if (!hasJsonSuffix(ent.name)) continue;
      let st;
      try {
        st = fs.lstatSync(path.join(dir, ent.name));
      } catch (err) {
        // An entry that vanished between readdir and lstat is absent; any other failure (a record directory
        // that is readable but not searchable throws EACCES for every entry) cannot be ruled out.
        if (!err || err.code !== 'ENOENT') overflow = true;
        continue;
      }
      if (now - st.mtimeMs > AGED_NONE_MAX_MS + CLOCK_SKEW_MS) continue;
      if (!st.isFile()) {
        // A recent link, FIFO or device named `.json` is a record the reader refuses: it cannot be ruled out.
        if (!st.isDirectory()) overflow = true;
        continue;
      }
      survivors.push({ name: ent.name, mtimeMs: st.mtimeMs });
    }
  } catch {
    // opendir/read failed (unreadable directory): the records cannot be ruled out, so fail closed.
    setOverflow();
    return out;
  } finally {
    if (handle) {
      try { handle.closeSync(); } catch { /* nothing left to release */ }
    }
  }
  survivors.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  // At most MAX_SCANNED_DIR_ENTRIES entries are iterated and MAX_SCANNED_RECORDS equals it, so the survivors
  // never exceed MAX_SCANNED_RECORDS; the slice keeps the parse bound explicit.
  for (const { name } of survivors.slice(0, MAX_SCANNED_RECORDS)) {
    const file = path.join(dir, name);
    const c = parseSentinelFileRetrying(file, clock, keyedDirs, readText);
    if (!c.present) {
      // An entry renamed or removed since the directory read is gone, not unusable; a refusal of one that
      // is still there (after the retry) cannot be ruled out.
      if (!entryIsGone(file)) overflow = true;
      continue;
    }
    if (c.malformed || !c.phase) { overflow = true; continue; }
    const expected = c.plan ? keyedSentinelPath(root, c.phase, c.plan) : phaseSentinelPath(root, c.phase);
    if (expected && sameKeyedRecord(file, expected)) {
      out.push(c);
      // A recent file claiming a `written_at` beyond the skew allowance is not a usable recent record
      // (`isRecentRecord` skips it), yet it may name the type: it cannot be ruled out.
      if (c.writtenAt - clock.now() > CLOCK_SKEW_MS) overflow = true;
    } else overflow = true;
  }
  if (overflow) setOverflow();
  return out;
}

/**
 * #6213: `parseSentinelFile` with one bounded retry (at most two attempts). A writer replaces a record with
 * an atomic temp-file rename, and a read that straddles the rename is refused for that instant; the second
 * attempt reads the replacement. A file that is gone (ENOENT) after a refusal is absent, so it is not
 * retried. Never throws.
 */
function parseSentinelFileRetrying(file, clock, parentDirs, readText = readSentinelText) {
  const first = parseSentinelFile(file, clock, parentDirs, readText);
  if (first.present || entryIsGone(file)) return first;
  return parseSentinelFile(file, clock, parentDirs, readText);
}

/** #6213: lstat of `file` fails with ENOENT (it is gone). Any other outcome, including success, is false. */
function entryIsGone(file) {
  try {
    fs.lstatSync(file);
    return false;
  } catch (err) {
    return !!(err && err.code === 'ENOENT');
  }
}

/**
 * #6213: is the record at `actual` the file its own contents key to (`expected`)? The same basename is the
 * exact case. Otherwise the two paths must resolve to the same filesystem object (equal dev and ino from
 * lstat), which is how a case-insensitive volume lets `phase1.json` hold a `Phase1` record; on a
 * case-sensitive volume the expected path does not exist and this is false. A zero ino (some Windows
 * volumes) cannot be compared, so it is never a match. Never throws.
 */
function sameKeyedRecord(actual, expected) {
  if (path.basename(expected) === path.basename(actual)) return true;
  try {
    const a = fs.lstatSync(actual, { bigint: true });
    const e = fs.lstatSync(expected, { bigint: true });
    return a.ino !== 0n && a.dev === e.dev && a.ino === e.ino;
  } catch {
    return false;
  }
}

/**
 * #6213: does `file` exist with an mtime inside the recency window (`AGED_NONE_MAX_MS` plus the clock-skew
 * allowance)? ENOENT / ENOTDIR is absent; any other lstat failure cannot be ruled out. Never throws.
 */
function recentEntryExists(file, clock) {
  try {
    const st = fs.lstatSync(file);
    return clock.now() - st.mtimeMs <= AGED_NONE_MAX_MS + CLOCK_SKEW_MS;
  } catch (err) {
    return !(err && (err.code === 'ENOENT' || err.code === 'ENOTDIR'));
  }
}

/**
 * #6213: expose every candidate `readSentinel` considered as a NON-ENUMERABLE `candidates` property,
 * so the winning record's enumerable shape (and every deepEqual on it) is unchanged. A newer record
 * for another plan wins enforcement but must not hide an older applicable record's executor identity.
 * `scanOverflow` (non-enumerable too) says the classification scan hit a bound and did not see every
 * fresh record.
 */
function withCandidates(winner, considered, scanOverflow = false) {
  if (!winner) return winner;
  if (considered.length > 0) Object.defineProperty(winner, 'candidates', { value: considered, enumerable: false, configurable: true });
  if (scanOverflow) Object.defineProperty(winner, 'scanOverflow', { value: true, enumerable: false, configurable: true });
  return winner;
}

/** The candidate with the greatest `writtenAt` (ties keep the earlier-listed, i.e. most specific). */
function latestWritten(candidates) {
  return candidates.reduce((best, c) => (c.writtenAt > best.writtenAt ? c : best));
}

/**
 * lstat of `dir` when it is a real directory, not a link (lstat does not follow); otherwise null.
 * Never throws.
 */
function lstatRealDirectory(dir) {
  try {
    // bigint: an NTFS file id is 64 bits and a JS number keeps 53, so ids are compared exactly.
    const st = fs.lstatSync(dir, { bigint: true });
    return st.isDirectory() && !st.isSymbolicLink() ? st : null;
  } catch {
    return null;
  }
}

/** Same filesystem object: equal dev and ino. A zero ino (some Windows volumes) cannot be compared. */
function sameObject(a, b) {
  return a.ino === 0n || b.ino === 0n || (a.dev === b.dev && a.ino === b.ino);
}

/**
 * #5758: read one sentinel file as a bounded, non-blocking, link-refusing read of a regular file.
 * Returns the text, or null for EVERY refusal (missing, link, FIFO, device, directory, oversized,
 * short read, a hard link to another file, a parent directory that is a link), so a hostile record
 * is exactly as absent as a missing one. `readFileSync` would block forever on a FIFO with no
 * writer, follow a link to an endless device or to a file outside the project, and read without
 * bound. The writers only ever produce a fresh temp file renamed into place (link count 1). A
 * sentinel renamed over between the open and the fstat reads as nlink 0 and is refused on that attempt;
 * callers read through `parseSentinelFileRetrying`, so the second attempt reads the replacement.
 *
 * Parent directories are lstat-checked before the open and re-checked (same dev/ino, still a real
 * directory) after it, and the opened file must be the object the pre-open lstat saw. Node has no
 * openat, so this NARROWS the window for a parent swapped to a link between check and open; it does
 * not close it.
 */
function readSentinelText(file, parentDirs) {
  const parents = [];
  for (const dir of parentDirs) {
    const st = lstatRealDirectory(dir);
    if (!st) return null;
    parents.push({ dir, st });
  }
  let fd;
  try {
    const before = fs.lstatSync(file, { bigint: true });
    if (!before.isFile() || before.size > BigInt(SENTINEL_MAX_BYTES)) return null;
    // O_NONBLOCK makes an open of a FIFO swapped in after the lstat return at once; O_NOFOLLOW
    // refuses a link swapped in. Windows lacks both flags (`|| 0`); lstat/fstat still guard.
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const st = fs.fstatSync(fd, { bigint: true });
    if (!st.isFile() || st.nlink !== 1n || st.size > BigInt(SENTINEL_MAX_BYTES)) return null;
    if (!sameObject(before, st)) return null;
    const size = Number(st.size);
    for (const p of parents) {
      const after = lstatRealDirectory(p.dir);
      if (!after || !sameObject(p.st, after)) return null;
    }
    const buf = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const n = fs.readSync(fd, buf, offset, size - offset, offset);
      if (n === 0) return null;
      offset += n;
    }
    return buf.toString('utf-8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* nothing left to release */ }
    }
  }
}

/**
 * Parse and validate one sentinel file. Never throws. Shape: see `readSentinel`.
 * `parentDirs` are the directories between the project root and the file that must be real
 * directories (not links); a refusal anywhere reads as `{ present: false }`.
 */
function parseSentinelFile(file, clock, parentDirs = [], readText = readSentinelText) {
  const raw = readText(file, parentDirs);
  if (raw === null) return { present: false };

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

  const validTypes = Array.isArray(parsed.executor_types) ? parsed.executor_types.filter(isValidExecutorType) : [];

  const now = clock.now();
  const age = now - parsed.written_at;
  // Negative age beyond a small tolerance means the sentinel claims to be
  // written in the future — never trust it, but still surface the parsed
  // fields so callers can log an actionable reason.
  const stale = age >= SENTINEL_STALE_MS || age < -CLOCK_SKEW_MS;

  return {
    present: true,
    stale,
    malformed: false,
    isolation: parsed.isolation,
    harnessFlag,
    phase,
    plan,
    writtenAt: parsed.written_at,
    // #6213: invalid or absent means "no recorded executor", never a malformed record.
    executorType: isValidExecutorType(parsed.executor_type) ? parsed.executor_type : null,
    // #6213: phase-level record; a non-array is empty, invalid entries are dropped, at most
    // MAX_EXECUTOR_TYPES valid entries are kept.
    executorTypes: validTypes.slice(0, MAX_EXECUTOR_TYPES),
    // #6213: the writer dropped executor_types entries to fit the record (strict `=== true`), or the
    // record lists more than MAX_EXECUTOR_TYPES valid entries so the reader drops the rest.
    executorTypesTruncated: parsed.executor_types_truncated === true || validTypes.length > MAX_EXECUTOR_TYPES,
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
 * Returns the two-field `{ plan, phase }` shape existing callers depend on (its enumerable keys).
 * `parseDispatchIdentity`'s `source` rides along as a NON-enumerable `source` property so
 * `isExecutorDispatch` can tell a canonical marker from a prose fallback (#6213).
 */
function extractDispatchIdentifiers(...texts) {
  const { phase, plan, source } = parseDispatchIdentity(...texts);
  const ids = { plan, phase };
  Object.defineProperty(ids, 'source', { value: source, enumerable: false });
  return ids;
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

function recordNamesType(sentinel, subagentType) {
  // #6213: a GSD role is never an executor, so a hand-written record naming one never classifies it.
  if (isGsdRoleName(subagentType)) return false;
  return sentinel.executorType === subagentType ||
    (Array.isArray(sentinel.executorTypes) && sentinel.executorTypes.includes(subagentType));
}

/**
 * #6213: is this a recent, well-formed dispatch record? `writtenAt` is not future-dated beyond
 * `CLOCK_SKEW_MS` and at most `AGED_NONE_MAX_MS` old. Phase and plan are irrelevant here.
 */
function isRecentRecord(r, clock) {
  if (!r || r.present !== true || r.malformed || typeof r.writtenAt !== 'number') return false;
  const age = clock.now() - r.writtenAt;
  return age >= -CLOCK_SKEW_MS && age <= AGED_NONE_MAX_MS;
}

/**
 * #6213: is this an executor dispatch (both isolation guards ask this one question)? True when ANY of:
 *   (a) `subagentType` is gsd-executor;
 *   (b) ANY well-formed dispatch record in the project (the candidates `readSentinel` considered: keyed
 *       records under `.gsd/dispatch-isolation/` and the legacy slot), at most `AGED_NONE_MAX_MS` old by
 *       `written_at` (a record future-dated beyond `CLOCK_SKEW_MS` is not recent), whatever its phase or
 *       plan, names the type in `executor_type` / `executor_types`;
 *   (c) the dispatch's own prompt carries the canonical `[gsd:dispatch ...]` marker (not the prose
 *       fallback) and `subagentType` is any non-empty string that is not a GSD role (`isGsdRoleName`): only
 *       executor templates emit it.
 * Fail closed (a type that passes `isValidExecutorType` and is not a GSD role, `isGsdRoleName`, is treated
 * as an executor) when the scan overflowed (`scanOverflow`: too many directory entries, a recent `.json`
 * record that cannot be used (refused, malformed, key-mismatched), a recent legacy slot that cannot be used
 * (checked in `readSentinel`, not in the scan), or a `.gsd` / record directory that is a link, not a
 * directory or unreadable), or when any recent record has `executor_types_truncated: true` (names were dropped, by the
 * writer or by the reader's MAX_EXECUTOR_TYPES cap, so its list cannot rule a type out).
 * Once true, the dispatch follows gsd-executor's enforcement path unchanged.
 */
function isExecutorDispatch(subagentType, sentinel, dispatchIds, { clock = Date } = {}) {
  if (EXECUTOR_SUBAGENT_TYPES.has(subagentType)) return true;
  if (typeof subagentType === 'string' && subagentType.length > 0 && !isGsdRoleName(subagentType) && !!dispatchIds && dispatchIds.source === 'marker') return true;
  const records = (sentinel && Array.isArray(sentinel.candidates) ? sentinel.candidates : []).concat(sentinel ? [sentinel] : [])
    .filter((r) => isRecentRecord(r, clock));
  if (isValidExecutorType(subagentType) && !isGsdRoleName(subagentType) &&
    ((sentinel && sentinel.scanOverflow === true) || records.some((r) => r.executorTypesTruncated === true))) return true;
  return typeof subagentType === 'string' && subagentType.length > 0 &&
    records.some((r) => recordNamesType(r, subagentType));
}

/**
 * #5479: does an AGED recorded sequential degrade still govern THIS dispatch?
 *
 * The trust window (`SENTINEL_STALE_MS`) exists so a leftover sentinel cannot authorize an unisolated
 * executor for a LATER, unrelated phase (#3045 F2). It also made the guard forget a legitimate
 * degrade (the #683/#3060 base-check, the project opt-out) the moment the previous executor ran
 * longer than the window: the next flag-less dispatch of the SAME phase was denied because the
 * registry fallback answers "this host CAN isolate" and cannot see the shell-side degrade.
 *
 * True only when ALL of these hold, so the aged path can only ever loosen toward `none` for the exact
 * phase the dispatch itself names:
 *   - the sentinel is present, well-formed, and records `isolation: 'none'` (an aged
 *     `harness-worktree`/`orchestrator-worktree` record authorizes nothing);
 *   - its `written_at` is not more than `CLOCK_SKEW_MS` in the future (a forged or clock-skewed record is never trusted);
 *   - it carries a phase, the dispatch names a phase, and they are equal (a dispatch whose phase
 *     cannot be established is "cannot compare", which keeps today's fallback, never an allow).
 * A plan-scoped record speaks only for its own plan (or a plan-less dispatch): a `none` recorded for
 * a submodule-degraded plan A must not authorize a genuinely isolated plan B of the same phase. The
 * phase-level degrade (the base-check, the project opt-out) is the record with no plan.
 *   - it is at most `AGED_NONE_MAX_MS` old: a static record, forged or left by a long-finished run,
 *     does not govern indefinitely. The normal flow re-records at every phase start and plan gate,
 *     so a live phase is always far younger.
 * A fresh sentinel is handled by the existing path and never reaches here.
 *
 * `clock` is the injectable `{ now(): number }` seam `readSentinel` uses.
 */
function agedNoneGovernsDispatch(sentinel, dispatchIds, { clock = Date } = {}) {
  if (!sentinel || sentinel.present !== true || sentinel.malformed) return false;
  if (sentinel.isolation !== 'none') return false;
  if (typeof sentinel.writtenAt !== 'number') return false;
  const age = clock.now() - sentinel.writtenAt;
  if (age < -CLOCK_SKEW_MS || age > AGED_NONE_MAX_MS) return false;
  if (!sentinel.phase || !dispatchIds || !dispatchIds.phase) return false;
  if (sentinel.plan && dispatchIds.plan && sentinel.plan !== dispatchIds.plan) return false;
  return sentinel.phase === dispatchIds.phase;
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
  EXECUTOR_SUBAGENT_TYPES,
  VALID_ISOLATION,
  SENTINEL_RELATIVE_PATH,
  KEYED_SENTINEL_DIR,
  isSafeSentinelKey,
  isValidExecutorType,
  GSD_ROLE_NAMES,
  isGsdRoleName,
  hasJsonSuffix,
  displayAgentName,
  MAX_EXECUTOR_TYPES,
  MAX_SCANNED_RECORDS,
  MAX_SCANNED_DIR_ENTRIES,
  CLOCK_SKEW_MS,
  isExecutorDispatch,
  keyedSentinelPath,
  phaseSentinelPath,
  SENTINEL_STALE_MS,
  SENTINEL_MAX_BYTES,
  AGED_NONE_MAX_MS,
  sentinelPath,
  resolveSentinelRoot,
  readSentinel,
  extractDispatchIdentifiers,
  sentinelAppliesToDispatch,
  agedNoneGovernsDispatch,
  buildSentinelDiscard,
};
