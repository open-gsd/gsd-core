'use strict';

/**
 * Shared CLASS-NORM subprocess timeouts for the test suite (#3145 pre-PR
 * review finding).
 *
 * These values are not per-suite fixture bindings — each is a fact
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
 * below is a re-export of `process-seam.cjs`'s own fallback, not an
 * independently bench-measured bound — see its own doc comment for
 * why it still belongs here (shared by ≥2 call sites) rather than as a
 * local constant.
 *
 * Every numeric export carries a TIMEOUT_EVIDENCE entry (observed range, worst platform, margin,
 * source, or an exempt kind with a reason); tests/timeout-evidence.test.cjs enforces it. A
 * file-local constant must not reuse one of these export names.
 */

const { DEFAULT_GIT_TIMEOUT_MS, GIT_FIXTURE_TIMEOUT_MS } = require('./git-fixture.cjs');
const { DEFAULT_TIMEOUT_MS: SEAM_FALLBACK_TIMEOUT_MS } = require('./process-seam.cjs');

/**
 * A single short CLI query or `node -e` probe against a temp fixture —
 * e.g. reading back a version string or a small piece of emitted state.
 * 15000ms is well over any observed duration for that class of call.
 *
 * Evidence (TIMEOUT_EVIDENCE.PROBE_TIMEOUT_MS): worst observed 7424ms on darwin,
 * margin 2.02x; CI seam spawn-stall log, 228 runs of next since 2026-10-25.
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
 *
 * Evidence (TIMEOUT_EVIDENCE.HOOK_FANOUT_TIMEOUT_MS): worst observed 23514ms on win32,
 * margin 2.55x; CI seam spawn-stall log, 228 runs of next since 2026-10-25.
 */
const HOOK_FANOUT_TIMEOUT_MS = 60000;

/**
 * Git plumbing (rev-parse, branch, log, ...) against a small mkdtemp
 * fixture repo. Re-exports `tests/helpers/git-fixture.cjs`'s
 * `DEFAULT_GIT_TIMEOUT_MS` rather than restating the literal, so the two
 * can never disagree.
 *
 * Evidence (TIMEOUT_EVIDENCE.GIT_TIMEOUT_MS): worst observed 4669ms on win32,
 * margin 3.21x; CI seam spawn-stall log, 228 runs of next since 2026-10-25.
 */
const GIT_TIMEOUT_MS = DEFAULT_GIT_TIMEOUT_MS;

/**
 * Git fixture CONSTRUCTION calls (init/config/add/commit) — a heavier class
 * than `GIT_TIMEOUT_MS`. See `tests/helpers/git-fixture.cjs`'s
 * `GIT_FIXTURE_TIMEOUT_MS` for the full rationale (PR #3323); re-exported
 * here rather than restated so the two can never disagree.
 *
 * Evidence (TIMEOUT_EVIDENCE.GIT_FIXTURE_TIMEOUT_MS): worst observed 7958ms on darwin,
 * margin 7.53x; CI seam spawn-stall log, 228 runs of next since 2026-10-25.
 */

/**
 * Hooks bundling via `scripts/build-hooks.js` (not a full project build —
 * see per-site comments for sites that run a heavier build and therefore
 * keep a larger local value). 30000ms is well over any observed duration
 * for a hooks-only bundle pass.
 *
 * Evidence (TIMEOUT_EVIDENCE.BUILD_TIMEOUT_MS): no CI record at or above the 2000ms slow-spawn
 * threshold across 188 darwin / 556 win32 / 429 linux lanes since 2026-10-25, so the
 * observed bound is under 2000ms; margin at least 15x.
 */
const BUILD_TIMEOUT_MS = 30000;

/**
 * A full `bin/install.js` run. Idle runs measure 13-30s; a load-tested
 * bench recorded a real `spawnSync ETIMEDOUT` at a 60000ms cap
 * (tests/install.test.cjs:5505-5513) while another lane passed the SAME
 * commit in 12.7s — 60000 is too tight for this class of spawn under
 * load. 120000ms is the load-tested norm.
 *
 * Evidence (TIMEOUT_EVIDENCE.INSTALL_TIMEOUT_MS): worst observed 49839ms on win32,
 * margin 2.40x; CI seam spawn-stall log, 228 runs of next since 2026-10-25.
 */
const INSTALL_TIMEOUT_MS = 120000;

/**
 * IS `tests/helpers/process-seam.cjs`'s own fallback for an omitted
 * `timeoutMs`, re-exported rather than restated, so it cannot drift from the
 * seam. Call sites asserting parity with the seam's fallback (rather than a
 * measured class norm) import this instead of a bare literal.
 *
 * Deliberately a separate name from `HOOK_FANOUT_TIMEOUT_MS`, even though
 * the two currently coincide: that constant is a bench-justified class norm
 * for a heavier, specific subprocess shape (nested shell fan-out), while this
 * one is a mirror of the seam's default ("no unbounded path") — collapsing
 * them would let a future, independent tune of either value silently move
 * the other.
 */
const SEAM_DEFAULT_TIMEOUT_MS = SEAM_FALLBACK_TIMEOUT_MS;

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
 *
 * Evidence (TIMEOUT_EVIDENCE.QUICK_SPAWN_TIMEOUT_MS): no CI record at or above the 2000ms slow-spawn
 * threshold across 188 darwin / 389 win32 / 286 linux lanes since 2026-10-25, so the
 * observed bound is under 2000ms; margin at least 5x.
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
 *
 * Evidence (TIMEOUT_EVIDENCE.STAGED_HOOK_SCRIPT_TIMEOUT_MS): worst observed 5232ms on darwin,
 * margin 3.82x; CI seam spawn-stall log, 228 runs of next since 2026-10-25.
 */
const STAGED_HOOK_SCRIPT_TIMEOUT_MS = 20000;

/**
 * A single `gsd-tools.cjs` CLI subcommand invocation, spawned directly (never
 * via an intermediate shell script), used by a loop/hook-point e2e test. The
 * command does real in-process work -- capability/config resolution, project
 * scaffolding, or (for the `check` verbs that inspect git-tracked state) real
 * git plumbing calls -- but as ONE process with no confirmed nested-subprocess
 * fan-out, verified per-site by reading each file's own runner function, not
 * assumed from "hook" in the filename. Representative verbs seen at this
 * norm's 7 sites: `loop render-hooks <point>`, `check <check-id>`,
 * `execute <hook-point>`, and `init new-project` (tests/loop-walk.qa.test.cjs's
 * concurrency test) -- the norm describes the CALL SHAPE (single direct
 * gsd-tools.cjs spawn, no fan-out), not one specific verb family, so this list
 * is illustrative, not exhaustive.
 *
 * Distinct from `HOOK_FANOUT_TIMEOUT_MS` (a bash-hosted script that itself
 * shells out to further subprocesses) despite the coincidentally-matching
 * value: this norm's sites spawn `gsd-tools.cjs` and nothing beneath it.
 * Distinct from `PROBE_TIMEOUT_MS`: the same underlying `loop render-hooks`
 * command is ALSO called at `PROBE_TIMEOUT_MS` (15000ms) elsewhere in the
 * suite against lighter temp-project fixtures -- the two bounds are kept
 * separate rather than equalized, since this migration never raises or
 * lowers a value without a fresh bench citation.
 *
 * Shared across 7 files in batch #4518 of the ad hoc timeout literal
 * migration, epic #4445 -- every site independently arrived at this exact
 * value -- that is why it lives here rather than as a file-local constant.
 *
 * Evidence (TIMEOUT_EVIDENCE.LOOP_HOOK_POINT_CLI_TIMEOUT_MS): worst observed 16895ms on win32,
 * margin 3.55x; CI seam spawn-stall log, 228 runs of next since 2026-10-25.
 */
const LOOP_HOOK_POINT_CLI_TIMEOUT_MS = 60000;

/**
 * A security-scan shell script (secret-scan.sh, secret-scan-lint.sh,
 * prompt-injection-scan.sh, base64-scan.sh) invoked with missing or invalid
 * CLI arguments -- exits almost instantly with a usage error, no scan work
 * performed at all. A distinct, lighter-weight class than a real scan of
 * even a single tiny fixture (`QUICK_SPAWN_TIMEOUT_MS`, 10000ms) -- this is
 * the fast-fail path, not the scan path.
 *
 * Deliberately a separate name from `MALFORMED_INPUT_HOOK_TIMEOUT_MS`, even
 * though the two currently coincide at the same value: that constant bounds
 * a Node hook script fed malformed input (a different runtime, a different
 * failure shape), not a bash scan script given no arguments. Collapsing them
 * would let a future, independent tune of either value silently move the
 * other -- the same reasoning `SEAM_DEFAULT_TIMEOUT_MS` documents for its own
 * coincidence with `HOOK_FANOUT_TIMEOUT_MS`.
 *
 * Shared across 2 files in batch #4519 of the ad hoc timeout literal
 * migration, epic #4445 -- every site independently arrived at this exact
 * value -- that is why it lives here rather than as a file-local constant.
 *
 * Evidence (TIMEOUT_EVIDENCE.SCAN_USAGE_ERROR_TIMEOUT_MS): worst observed 108ms on darwin,
 * margin 46.29x; harness, 50 runs per site, darwin + linux; win32 not yet measured.
 */
const SCAN_USAGE_ERROR_TIMEOUT_MS = 5000;

/**
 * A Node hook script (gsd-prompt-guard-hook.js, gsd-read-injection-scanner.js)
 * spawned directly and fed malformed JSON on stdin -- expected to fail closed
 * gracefully, no subprocess fan-out, no real scan work. A different operation
 * family from `SCAN_USAGE_ERROR_TIMEOUT_MS` (a bash scan script given no
 * arguments) despite the coincidentally-matching value -- see that constant's
 * own doc comment for why the two are kept separate rather than merged.
 *
 * Shared across 2 files in batch #4519 of the ad hoc timeout literal
 * migration, epic #4445 -- every site independently arrived at this exact
 * value -- that is why it lives here rather than as a file-local constant.
 *
 * Evidence (TIMEOUT_EVIDENCE.MALFORMED_INPUT_HOOK_TIMEOUT_MS): worst observed 170ms on darwin,
 * margin 29.41x; harness, 50 runs per site, darwin + linux; win32 not yet measured.
 */
const MALFORMED_INPUT_HOOK_TIMEOUT_MS = 5000;

/**
 * A single `scripts/*.cjs` generator or lint script (gen-adr-index.cjs,
 * check-glossary-refs.cjs, gen-context-index.cjs, and siblings), spawned
 * directly and once against a small temp fixture repo -- no fan-out.
 *
 * Deliberately NOT `BUILD_TIMEOUT_MS`, despite the coincidentally-matching
 * value: that constant's own doc comment scopes it specifically to
 * `scripts/build-hooks.js` ("not a full project build"), and none of this
 * norm's sites run that script. Reusing a constant for its number while
 * ignoring what its comment actually describes is exactly the trap this
 * migration exists to avoid -- see `SEAM_DEFAULT_TIMEOUT_MS` and
 * `SCAN_USAGE_ERROR_TIMEOUT_MS` for the same reasoning applied elsewhere in
 * this file.
 *
 * Shared across 7 files in batch #4520 of the ad hoc timeout literal
 * migration, epic #4445 -- every site independently arrived at this exact
 * value -- that is why it lives here rather than as a file-local constant.
 *
 * Evidence (TIMEOUT_EVIDENCE.GENERATOR_SCRIPT_TIMEOUT_MS): no CI record at or above the 2000ms slow-spawn
 * threshold across 188 darwin / 0 win32 / 171 linux lanes since 2026-10-25, so the
 * observed bound is under 2000ms; margin at least 15x.
 * win32 lanes did not run these sites in the window.
 */
const GENERATOR_SCRIPT_TIMEOUT_MS = 30000;

/**
 * A git plumbing command (or a short scratch-index sequence of them) run
 * against the REAL, current repo tree -- never a throwaway mkdtemp fixture.
 * Distinct from `GIT_TIMEOUT_MS` (15000ms, plumbing reads against a small
 * fixture repo) and `GIT_FIXTURE_TIMEOUT_MS` (60000ms, the shared helper's
 * own multi-spawn fixture-CONSTRUCTION sequence) -- this norm's sites
 * either read the real object database directly (`git ls-files`) or build a
 * synthetic commit on a scratch index against it, which is heavier than a
 * tiny-fixture read but not the shared helper's own six-spawn construction
 * class. Explicitly NOT for fixture-repo CONSTRUCTION (init/config/add/commit
 * against a throwaway mkdtemp repo) -- tests/emitted-attribution.test.cjs's
 * own file-local `FRESH_FIXTURE_GIT_TIMEOUT_MS` covers that shape instead,
 * after an earlier pass conflated the two and a Standards-axis review caught
 * it.
 *
 * Shared across 2 files in batch #4520 of the ad hoc timeout literal
 * migration, epic #4445 -- every site independently arrived at this exact
 * value -- that is why it lives here rather than as a file-local constant.
 *
 * Evidence (TIMEOUT_EVIDENCE.REAL_REPO_GIT_TIMEOUT_MS): worst observed 262ms on darwin,
 * margin 114.50x; harness, 50 runs per site, darwin + linux; win32 not yet measured.
 */
const REAL_REPO_GIT_TIMEOUT_MS = 30000;

/**
 * NOT a subprocess spawn timeout. This is `node:test`'s own per-test
 * `{ timeout }` option (the second positional argument to `test(name,
 * options, fn)`), used as a hang BACKSTOP -- not an assertion -- for tests
 * that exercise a pathological, adversarially-large input against an
 * algorithmic bound (ADR-612 bracket-coherence and read-tolerance) rather
 * than a wall-clock ceiling. If the bound holds, the test finishes in
 * milliseconds; this only turns a genuine runaway into a deterministic
 * failure instead of a suite that never returns.
 *
 * Shared across 2 files in batch #4522 of the ad hoc timeout literal
 * migration, epic #4445 -- every site independently arrived at this exact
 * value -- that is why it lives here rather than as a file-local constant.
 */
const PATHOLOGICAL_INPUT_TEST_TIMEOUT_MS = 60000;

/**
 * A single `gsd-tools.cjs` CLI subcommand invocation, spawned directly
 * (execFileSync/spawnSync, or the process seam's runNode wrapping the same
 * shape -- never via an intermediate shell script), with no confirmed
 * nested-subprocess fan-out. A distinct, heavier tier than
 * `PROBE_TIMEOUT_MS` (15000ms, the lighter CLI-query/probe class) but half
 * of `LOOP_HOOK_POINT_CLI_TIMEOUT_MS` (60000ms) -- not equalized to either
 * without bench data. Coincides numerically with `BUILD_TIMEOUT_MS`,
 * `GENERATOR_SCRIPT_TIMEOUT_MS`, and `REAL_REPO_GIT_TIMEOUT_MS`, none of
 * which describe this call shape (a `build-hooks.js` bundle, a
 * `scripts/*.cjs` generator, and real-repo git plumbing respectively) --
 * disclosed, not merged.
 *
 * Shared across 2 files in batch #4522 of the ad hoc timeout literal
 * migration, epic #4445 -- every site independently arrived at this exact
 * value -- that is why it lives here rather than as a file-local constant.
 *
 * Evidence (TIMEOUT_EVIDENCE.GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS): no CI record at or above the 2000ms slow-spawn
 * threshold across 8 darwin / 0 win32 / 143 linux lanes since 2026-10-25, so the
 * observed bound is under 2000ms; margin at least 15x.
 * win32 lanes did not run these sites in the window.
 */
const GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS = 30000;

/**
 * NOT a subprocess spawn timeout. Fixture DATA -- the default, plausible-
 * looking `invoke.timeoutMs` value for a well-formed task-content-resolver
 * manifest, used as the base fixture across most "valid resolver" tests on
 * the RESOLUTION side of that system (tests/task-content-resolution.cjs and
 * its grammar-parity sibling). Coincides in value and role with epic #4445
 * batch 10's file-local `TASK_RESOLVER_FIXTURE_TIMEOUT_MS` in
 * tests/capability-validator-task-content-resolver.test.cjs (the VALIDATION
 * side of the same resolver system, a different file, not exported) --
 * disclosed, not merged; both independently describe the same manifest
 * field's plausible default, unsurprising for two suites covering the same
 * resolver.
 *
 * Shared across 2 files in batch #4524 of the ad hoc timeout literal
 * migration, epic #4445 -- every site independently arrived at this exact
 * value -- that is why it lives here rather than as a file-local constant.
 */
const TASK_RESOLVER_INVOKE_TIMEOUT_MS = 10000;

/**
 * NOT a subprocess spawn timeout. Fixture DATA -- the default `timeoutMs`
 * value for an `http-reachable`-kind reviewer-lane probe declaration,
 * validated by `validateReviewerBody()` (pure schema validation, never a
 * real HTTP call or spawn in these tests).
 *
 * Shared across 2 files in batch #4527 of the ad hoc timeout literal
 * migration, epic #4445 -- every site independently arrived at this exact
 * value -- that is why it lives here rather than as a file-local constant.
 */
const HTTP_REACHABLE_PROBE_TIMEOUT_FIXTURE_MS = 2000;

const CI_SOURCE = 'seam:spawn-stall records in CI test-timings-<os>-job<N> artifacts; a record counts for a constant when its file names the constant at a timeout property and its timeoutMs equals the value';
const CI_WINDOW = 'next CI runs since 2026-10-25: 228 runs, 1181 lane artifacts (darwin 188, win32 564, linux 429)';
const HARNESS_SOURCE = 'local harness: each call site run 50 times through the process seam';
const HARNESS_WINDOW = '2026-11-08: darwin node v26.13.0; linux node:24 v24.22.2; win32 not yet measured';

/**
 * Evidence for every numeric constant in this module, checked by
 * tests/timeout-evidence.test.cjs against tests/helpers/timeout-evidence.cjs.
 * Rules: TESTING-STANDARDS.md "Every new or changed timeout constant states its evidence".
 */
const TIMEOUT_EVIDENCE = Object.freeze({
  PROBE_TIMEOUT_MS: { kind: 'measured', observedMaxMs: 7424, worstPlatform: 'darwin', samples: { darwin: 490, win32: 45, linux: 311 }, source: CI_SOURCE, window: CI_WINDOW },
  HOOK_FANOUT_TIMEOUT_MS: { kind: 'measured', observedMaxMs: 23514, worstPlatform: 'win32', samples: { darwin: 1365, win32: 649, linux: 459 }, source: CI_SOURCE, window: CI_WINDOW },
  GIT_TIMEOUT_MS: { kind: 'measured', observedMaxMs: 4669, worstPlatform: 'win32', samples: { darwin: 0, win32: 12, linux: 0 }, source: CI_SOURCE, window: CI_WINDOW },
  GIT_FIXTURE_TIMEOUT_MS: { kind: 'measured', observedMaxMs: 7958, worstPlatform: 'darwin', samples: { darwin: 4, win32: 40, linux: 143 }, source: CI_SOURCE, window: CI_WINDOW },
  INSTALL_TIMEOUT_MS: { kind: 'measured', observedMaxMs: 49839, worstPlatform: 'win32', samples: { darwin: 5314, win32: 42609, linux: 1160 }, source: CI_SOURCE, window: CI_WINDOW },
  STAGED_HOOK_SCRIPT_TIMEOUT_MS: { kind: 'measured', observedMaxMs: 5232, worstPlatform: 'darwin', samples: { darwin: 180, win32: 3, linux: 0 }, source: CI_SOURCE, window: CI_WINDOW },
  LOOP_HOOK_POINT_CLI_TIMEOUT_MS: { kind: 'measured', observedMaxMs: 16895, worstPlatform: 'win32', samples: { darwin: 4, win32: 38, linux: 0 }, source: CI_SOURCE, window: CI_WINDOW },
  BUILD_TIMEOUT_MS: { kind: 'measured', observedMaxMs: 2000, censoredBelowMs: 2000, worstPlatform: null, samples: { darwin: 188, win32: 556, linux: 429 }, source: CI_SOURCE, window: CI_WINDOW },
  QUICK_SPAWN_TIMEOUT_MS: { kind: 'measured', observedMaxMs: 2000, censoredBelowMs: 2000, worstPlatform: null, samples: { darwin: 188, win32: 389, linux: 286 }, source: CI_SOURCE, window: CI_WINDOW },
  GENERATOR_SCRIPT_TIMEOUT_MS: { kind: 'measured', observedMaxMs: 2000, censoredBelowMs: 2000, worstPlatform: null, samples: { darwin: 188, win32: 0, linux: 171 }, source: CI_SOURCE, window: CI_WINDOW },
  GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS: { kind: 'measured', observedMaxMs: 2000, censoredBelowMs: 2000, worstPlatform: null, samples: { darwin: 8, win32: 0, linux: 143 }, source: CI_SOURCE, window: CI_WINDOW },
  SCAN_USAGE_ERROR_TIMEOUT_MS: { kind: 'measured', observedMaxMs: 108, worstPlatform: 'darwin', samples: { darwin: 200, linux: 200 }, source: HARNESS_SOURCE, window: HARNESS_WINDOW },
  MALFORMED_INPUT_HOOK_TIMEOUT_MS: { kind: 'measured', observedMaxMs: 170, worstPlatform: 'darwin', samples: { darwin: 75, linux: 75 }, source: HARNESS_SOURCE, window: HARNESS_WINDOW },
  REAL_REPO_GIT_TIMEOUT_MS: { kind: 'measured', observedMaxMs: 262, worstPlatform: 'darwin', samples: { darwin: 175, linux: 175 }, source: HARNESS_SOURCE, window: HARNESS_WINDOW },
  SEAM_DEFAULT_TIMEOUT_MS: { kind: 'mirror', of: { module: 'tests/helpers/process-seam.cjs', export: 'DEFAULT_TIMEOUT_MS' } },
  PATHOLOGICAL_INPUT_TEST_TIMEOUT_MS: { kind: 'test-backstop', reason: 'node:test per-test hang backstop around an algorithmic bound, not a spawn timeout' },
  FIXTURE_HOOK_TIMEOUT_SECONDS: { kind: 'fixture-data', reason: 'seconds value inside a settings.json hook-entry fixture, not a spawn timeout' },
  TASK_RESOLVER_INVOKE_TIMEOUT_MS: { kind: 'fixture-data', reason: 'invoke.timeoutMs value inside a task-content-resolver manifest fixture, not a spawn timeout' },
  HTTP_REACHABLE_PROBE_TIMEOUT_FIXTURE_MS: { kind: 'fixture-data', reason: 'timeoutMs value inside an http-reachable reviewer-lane declaration fixture, schema-validated only, not a spawn timeout' },
});

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
  LOOP_HOOK_POINT_CLI_TIMEOUT_MS,
  SCAN_USAGE_ERROR_TIMEOUT_MS,
  MALFORMED_INPUT_HOOK_TIMEOUT_MS,
  GENERATOR_SCRIPT_TIMEOUT_MS,
  REAL_REPO_GIT_TIMEOUT_MS,
  PATHOLOGICAL_INPUT_TEST_TIMEOUT_MS,
  GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS,
  TASK_RESOLVER_INVOKE_TIMEOUT_MS,
  HTTP_REACHABLE_PROBE_TIMEOUT_FIXTURE_MS,
  TIMEOUT_EVIDENCE,
};
