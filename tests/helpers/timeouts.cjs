'use strict';

/**
 * Shared CLASS-NORM subprocess timeouts for the test suite (#3145 pre-PR
 * review finding).
 *
 * These four values are not per-suite fixture bindings — each is a fact
 * about how long a CLASS of subprocess call takes, derived from observed
 * bench behavior. Before this module existed, all four were hand-copied
 * across dozens of files with the same justifying comment restated each
 * time (52 copies across this wave's diff alone), so the norm could drift
 * silently the next time it moved — as `INSTALL_TIMEOUT_MS` already did
 * once, from 60000 to 120000, after a real bench `ETIMEDOUT`. Import from
 * here instead of re-declaring.
 *
 * This module is for the shared norms ONLY. A call site that genuinely
 * differs from its class (e.g. a real `tsc` compile in
 * tests/ensure-runtime-build.test.cjs, or a `regen:derived` run in
 * tests/fragment-single-edit-propagation.install.test.cjs) keeps its own
 * local constant with its own justifying comment — do not force those
 * sites onto a shared value that doesn't describe them.
 *
 * One exception to "bench-derived class norm": `SEAM_DEFAULT_TIMEOUT_MS`
 * below is a structural mirror of another module's un-exported default,
 * not an independently bench-measured bound — see its own doc comment for
 * why it still belongs here (shared by ≥2 call sites) rather than as a
 * local constant.
 */

const { DEFAULT_GIT_TIMEOUT_MS, GIT_FIXTURE_TIMEOUT_MS } = require('./git-fixture.cjs');

/**
 * A single short CLI query or `node -e` probe against a temp fixture —
 * e.g. reading back a version string or a small piece of emitted state.
 * 15000ms is well over any observed duration for that class of call.
 */
const PROBE_TIMEOUT_MS = 15000;

/**
 * A git-hook invocation that FANS OUT to nested shell subprocesses — the hook
 * itself under `bash`, plus every helper it shells to. The prepush guard is the
 * worked example: it runs a mock `git` that is also a bash script, so a single
 * `runHook` is roughly four Git Bash spawns.
 *
 * This is a heavier class than `PROBE_TIMEOUT_MS`, and the difference is
 * Windows-shaped. Each spawn there is Defender-scanned, and the first hook test
 * in a file pays cold start on top. CI (PR #3285, `full test (windows-latest,
 * 22, shard 2/3)`) recorded `outcome=timed_out exitCode=null` at exactly the
 * 15000ms probe bound while every other lane — including windows-latest node 24,
 * all three shards — passed the same commit. That is a bound sized for the wrong
 * class, not a slow machine.
 *
 * 60000ms is 4x the bound that failed and half `INSTALL_TIMEOUT_MS`, which is
 * the right order: a hook fan-out is much lighter than a full installer run but
 * far heavier than reading back a version string.
 *
 * Sites that invoke a hook doing NO subprocess fan-out should stay on
 * `PROBE_TIMEOUT_MS` — this norm describes the fan-out shape, not `runHook` in
 * general.
 */
const HOOK_FANOUT_TIMEOUT_MS = 60000;

/**
 * Git plumbing (rev-parse, branch, log, ...) against a small mkdtemp
 * fixture repo. Re-exports `tests/helpers/git-fixture.cjs`'s
 * `DEFAULT_GIT_TIMEOUT_MS` rather than restating the literal, so the two
 * can never disagree.
 */
const GIT_TIMEOUT_MS = DEFAULT_GIT_TIMEOUT_MS;

/**
 * Git fixture CONSTRUCTION calls (init/config/add/commit) — a heavier class
 * than `GIT_TIMEOUT_MS`. See `tests/helpers/git-fixture.cjs`'s
 * `GIT_FIXTURE_TIMEOUT_MS` for the full rationale (PR #3323); re-exported
 * here rather than restated so the two can never disagree.
 */

/**
 * Hooks bundling via `scripts/build-hooks.js` (not a full project build —
 * see per-site comments for sites that run a heavier build and therefore
 * keep a larger local value). 30000ms is well over any observed duration
 * for a hooks-only bundle pass.
 */
const BUILD_TIMEOUT_MS = 30000;

/**
 * A full `bin/install.js` run. Idle runs measure 13-30s; a load-tested
 * bench recorded a real `spawnSync ETIMEDOUT` at a 60000ms cap
 * (tests/install.test.cjs:5505-5513) while another lane passed the SAME
 * commit in 12.7s — 60000 is too tight for this class of spawn under
 * load. 120000ms is the load-tested norm.
 */
const INSTALL_TIMEOUT_MS = 120000;

/**
 * Mirrors `tests/helpers/process-seam.cjs`'s own internal fallback for an
 * omitted `timeoutMs` (#4512, batch 1 of the ad hoc timeout literal
 * migration, epic #4445). That module does not export its fallback —
 * exporting it is out of this batch's scope, since `process-seam.cjs`
 * itself is not one of the batch's files — so this constant restates the
 * SAME pre-existing number under a name, purely so call sites asserting
 * parity with the seam's own fallback (rather than a measured class norm)
 * have something to import instead of a bare literal.
 *
 * Deliberately a separate name from `HOOK_FANOUT_TIMEOUT_MS`, even though
 * the two currently coincide: that constant is a bench-justified bound for
 * a heavier, specific subprocess shape (nested shell fan-out), while this
 * one is only "no unbounded path" — collapsing them would let a future,
 * independent tune of either value silently move the other.
 */
const SEAM_DEFAULT_TIMEOUT_MS = 60000;

/**
 * A cheap, lightweight subprocess/hook invocation whose own work is
 * trivial -- a synchronous in-process guard hook, a fully-mocked shell
 * harness (git/gh functions stubbed out), a small `node -e` snippet, or a
 * lint script scanning a tiny temp fixture -- with no real git/network/
 * fan-out work inside. 10000ms leaves generous headroom over each call
 * site's sub-second observed worst case (#4514, batch 3 of the ad hoc
 * timeout literal migration, epic #4445 -- consolidates 5 call sites
 * across 4 files that had all independently arrived at this exact value).
 *
 * Deliberately NOT the same as `PROBE_TIMEOUT_MS` (15000ms): consolidating
 * onto that would RAISE these sites' bound with no bench citation, which
 * this migration's scope (naming, not tuning) does not permit. This norm
 * is for the even-lighter end of the spectrum PROBE_TIMEOUT_MS occupies.
 */
const QUICK_SPAWN_TIMEOUT_MS = 10000;

/**
 * NOT a subprocess spawn timeout. This is fixture DATA -- the numeric value
 * placed inside a fixture JSON object that mimics a Claude Code
 * `settings.json` hook-entry's own `timeout` field, whose schema expresses
 * that field in SECONDS. Do not pass this into a `spawnSync`/`execFileSync`
 * options object -- every other constant in this file is milliseconds, this
 * one is not.
 *
 * Shared across >=2 files in batch #4515 of the ad hoc timeout literal
 * migration, epic #4445 -- that is why it lives here rather than as a
 * file-local constant.
 */
const FIXTURE_HOOK_TIMEOUT_SECONDS = 5;

/**
 * Spawning ONE already-staged or already-bundled hook script directly --
 * never the full installer, never a fan-out across several hooks -- where
 * the script does a modest amount of real work: a git-root check, a
 * version-cache read/write, or an ESM-vs-CommonJS module load probe under a
 * hostile config root. This is a distinct, heavier class than
 * `QUICK_SPAWN_TIMEOUT_MS` (10000ms, trivial invocations with no real
 * git/network work), since every site using this constant measurably does
 * more than that. It is also distinct from `HOOK_FANOUT_TIMEOUT_MS`, which
 * bounds a different class -- nested shell fan-out across MULTIPLE hooks,
 * not a single script.
 *
 * Shared across 3 files in batch #4516 of the ad hoc timeout literal
 * migration, epic #4445 -- that is why it lives here rather than as a
 * file-local constant.
 */
const STAGED_HOOK_SCRIPT_TIMEOUT_MS = 20000;

module.exports = {
  PROBE_TIMEOUT_MS,
  HOOK_FANOUT_TIMEOUT_MS,
  GIT_TIMEOUT_MS,
  GIT_FIXTURE_TIMEOUT_MS,
  BUILD_TIMEOUT_MS,
  INSTALL_TIMEOUT_MS,
  SEAM_DEFAULT_TIMEOUT_MS,
  QUICK_SPAWN_TIMEOUT_MS,
  FIXTURE_HOOK_TIMEOUT_SECONDS,
  STAGED_HOOK_SCRIPT_TIMEOUT_MS,
};
