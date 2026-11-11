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
 *
 * Reading an evidence entry. CI figures come from seam:spawn-stall records, which the process seam
 * emits only for spawns that were killed or ran at or above the slow-spawn threshold (2000ms by
 * default), so p50Ms and p99Ms are percentiles of the WORST platform's recorded spawns, not of every
 * spawn. `samples` counts records per platform; `lanes` counts the CI lanes per platform that ran
 * the class's seam sites, so a platform with lanes and no samples ran and recorded nothing at or
 * above the threshold. A class with no record at all is censored: observedMaxMs is the threshold,
 * not a measurement. `unmeasuredPlatforms` lists platforms with neither samples nor lanes.
 * `unseenSites` counts call sites of the class that spawn outside the seam (raw child_process); the
 * CI log cannot see them, and `unseenSitesTrackedBy` names the issues moving them onto the seam.
 * SCAN_USAGE_ERROR, MALFORMED_INPUT_HOOK and REAL_REPO_GIT were moved onto the seam in the change
 * that added this evidence, so the CI lanes in the window ran their previous form and cannot count:
 * those three use the local harness only.
 */

const { DEFAULT_GIT_TIMEOUT_MS, GIT_FIXTURE_TIMEOUT_MS } = require('./git-fixture.cjs');
const { DEFAULT_TIMEOUT_MS: SEAM_FALLBACK_TIMEOUT_MS } = require('./process-seam.cjs');

/**
 * A single short CLI query or `node -e` probe against a temp fixture —
 * e.g. reading back a version string or a small piece of emitted state.
 * The observed range is in the evidence entry below.
 *
 * Evidence (TIMEOUT_EVIDENCE.PROBE_TIMEOUT_MS): worst observed 7424ms on darwin (p50 111ms, p99 3411ms of recorded spawns),
 * margin 2.02x; CI seam spawn-stall records, 188 runs since 2026-10-25.
 * 125 call sites spawn outside the seam and are not covered; tracked in #6058 #6059.
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
 * Evidence (TIMEOUT_EVIDENCE.HOOK_FANOUT_TIMEOUT_MS): worst observed 23514ms on win32 (p50 2326ms, p99 7563ms of recorded spawns),
 * margin 2.55x; CI seam spawn-stall records, 188 runs since 2026-10-25.
 */
const HOOK_FANOUT_TIMEOUT_MS = 60000;

/**
 * Git plumbing (rev-parse, branch, log, ...) against a small mkdtemp
 * fixture repo. Re-exports `tests/helpers/git-fixture.cjs`'s
 * `DEFAULT_GIT_TIMEOUT_MS` rather than restating the literal, so the two
 * can never disagree.
 *
 * Evidence (TIMEOUT_EVIDENCE.GIT_TIMEOUT_MS): worst observed 4669ms on win32 (p50 2344ms, p99 4669ms of recorded spawns),
 * margin 3.21x; CI seam spawn-stall records, 188 runs since 2026-10-25.
 * darwin and linux lanes ran these sites and recorded nothing at or above the slow-spawn threshold.
 * 58 call sites spawn outside the seam and are not covered; tracked in #6060.
 */
const GIT_TIMEOUT_MS = DEFAULT_GIT_TIMEOUT_MS;

/**
 * Git fixture CONSTRUCTION calls (init/config/add/commit) — a heavier class
 * than `GIT_TIMEOUT_MS`. See `tests/helpers/git-fixture.cjs`'s
 * `GIT_FIXTURE_TIMEOUT_MS` for the full rationale (PR #3323); re-exported
 * here rather than restated so the two can never disagree.
 *
 * Evidence (TIMEOUT_EVIDENCE.GIT_FIXTURE_TIMEOUT_MS): worst observed 10114ms on win32 (p50 2558ms, p99 7180ms of recorded spawns),
 * margin 5.93x; CI seam spawn-stall records, 188 runs since 2026-10-25.
 * No record matched sites of this constant and another, so none is left uncredited for that reason.
 * 10 call sites spawn outside the seam and are not covered; tracked in #6060.
 */

/**
 * Hooks bundling via `scripts/build-hooks.js` (not a full project build —
 * see per-site comments for sites that run a heavier build and therefore
 * keep a larger local value). The observed range is in the evidence entry below.
 *
 * Evidence (TIMEOUT_EVIDENCE.BUILD_TIMEOUT_MS): no seam spawn of this class reached 2000ms across 1181 lanes (win32 564, darwin 188,
 * linux 429); margin at least 15x. CI seam spawn-stall records, 188 runs since 2026-10-25.
 * Every call site of this class runs through the seam.
 */
const BUILD_TIMEOUT_MS = 30000;

/**
 * A full `bin/install.js` run. Idle runs measure 13-30s; a load-tested
 * bench recorded a real `spawnSync ETIMEDOUT` at a 60000ms cap
 * (tests/install.test.cjs:5505-5513) while another lane passed the SAME
 * commit in 12.7s — 60000 is too tight for this class of spawn under
 * load. 120000ms is the load-tested norm.
 *
 * Evidence (TIMEOUT_EVIDENCE.INSTALL_TIMEOUT_MS): worst observed 49839ms on win32 (p50 2864ms, p99 7842ms of recorded spawns),
 * margin 2.40x; CI seam spawn-stall records, 188 runs since 2026-10-25.
 * 16 call sites spawn outside the seam and are not covered; tracked in #6062.
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
 * Evidence (TIMEOUT_EVIDENCE.SEAM_DEFAULT_TIMEOUT_MS): mirror — mirror of tests/helpers/process-seam.cjs DEFAULT_TIMEOUT_MS.
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
 * Evidence (TIMEOUT_EVIDENCE.QUICK_SPAWN_TIMEOUT_MS): no seam spawn of this class reached 2000ms across 863 lanes (win32 389, darwin 188,
 * linux 286); margin at least 5x. CI seam spawn-stall records, 188 runs since 2026-10-25.
 * 26 call sites spawn outside the seam and are not covered; tracked in #6061.
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
 * Evidence (TIMEOUT_EVIDENCE.FIXTURE_HOOK_TIMEOUT_SECONDS): fixture-data — seconds value inside a settings.json hook-entry fixture, not a spawn timeout.
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
 * Evidence (TIMEOUT_EVIDENCE.STAGED_HOOK_SCRIPT_TIMEOUT_MS): worst observed 5232ms on darwin (p50 4889ms, p99 5217ms of recorded spawns),
 * margin 3.82x; CI seam spawn-stall records, 188 runs since 2026-10-25.
 * 4 call sites spawn outside the seam and are not covered; tracked in #6061.
 */
const STAGED_HOOK_SCRIPT_TIMEOUT_MS = 20000;

/**
 * A single `gsd-tools.cjs` CLI subcommand invocation, spawned directly (never
 * via an intermediate shell script): the loop/hook-point e2e tests, and
 * `runGsdTools` in tests/helpers.cjs, the shared helper behind every other
 * single direct gsd-tools.cjs subcommand spawn without fan-out. The
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
 * value: this norm's sites spawn `gsd-tools.cjs` and nothing beneath it,
 * `runGsdTools` included.
 * Distinct from `SEAM_DEFAULT_TIMEOUT_MS` (the seam's own fallback for an
 * omitted `timeoutMs`): `runGsdTools` always passes this class bound
 * explicitly and no longer relies on that fallback.
 * Distinct from `PROBE_TIMEOUT_MS`: the same underlying `loop render-hooks`
 * command is ALSO called at `PROBE_TIMEOUT_MS` (15000ms) elsewhere in the
 * suite against lighter temp-project fixtures -- the two bounds are kept
 * separate rather than equalized, since this migration never raises or
 * lowers a value without a fresh bench citation.
 *
 * Evidence (TIMEOUT_EVIDENCE.LOOP_HOOK_POINT_CLI_TIMEOUT_MS): worst observed 39655ms on win32 (p50 2555ms, p99 20684ms of recorded spawns),
 * margin 2.01x; CI seam spawn-stall records, 188 runs since 2026-10-25.
 * No record matched sites of this constant and another, so none is left uncredited for that reason.
 * 14 call sites spawn outside the seam and are not covered; tracked in #6063.
 */
const LOOP_HOOK_POINT_CLI_TIMEOUT_MS = 80000;

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
 * Evidence (TIMEOUT_EVIDENCE.SCAN_USAGE_ERROR_TIMEOUT_MS): worst observed 108ms on darwin (p50 7ms, p99 46ms of 400 harness spawns),
 * margin 46.29x; local harness on darwin and linux, 400 spawns per platform; win32 not measured.
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
 * Evidence (TIMEOUT_EVIDENCE.MALFORMED_INPUT_HOOK_TIMEOUT_MS): worst observed 170ms on darwin (p50 78ms, p99 163ms of 150 harness spawns),
 * margin 29.41x; local harness on darwin and linux, 150 spawns per platform; win32 not measured.
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
 * Evidence (TIMEOUT_EVIDENCE.GENERATOR_SCRIPT_TIMEOUT_MS): no seam spawn of this class reached 2000ms across 359 lanes (darwin 188,
 * linux 171); margin at least 15x. CI seam spawn-stall records, 188 runs since 2026-10-25.
 * win32 not measured: no win32 lane ran these sites in the window.
 * 8 call sites spawn outside the seam and are not covered; tracked in #6063.
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
 * Evidence (TIMEOUT_EVIDENCE.REAL_REPO_GIT_TIMEOUT_MS): worst observed 262ms on darwin (p50 37ms, p99 195ms of 350 harness spawns),
 * margin 114.50x; local harness on darwin and linux, 350 spawns per platform; win32 not measured.
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
 * Evidence (TIMEOUT_EVIDENCE.PATHOLOGICAL_INPUT_TEST_TIMEOUT_MS): test-backstop — node:test per-test hang backstop around an algorithmic bound, not a spawn timeout.
 */
const PATHOLOGICAL_INPUT_TEST_TIMEOUT_MS = 60000;

/**
 * A single `gsd-tools.cjs` CLI subcommand invocation, spawned directly
 * (execFileSync/spawnSync, or the process seam's runNode wrapping the same
 * shape -- never via an intermediate shell script), with no confirmed
 * nested-subprocess fan-out. A distinct, heavier tier than
 * `PROBE_TIMEOUT_MS` (15000ms, the lighter CLI-query/probe class) but well
 * under `LOOP_HOOK_POINT_CLI_TIMEOUT_MS` (80000ms) -- not equalized to either
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
 * Evidence (TIMEOUT_EVIDENCE.GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS): worst observed 2270ms on win32 (p50 2036ms, p99 2270ms of recorded spawns),
 * margin 13.21x; CI seam spawn-stall records, 188 runs since 2026-10-25.
 * darwin and linux lanes ran these sites and recorded nothing at or above the slow-spawn threshold.
 * 4 call sites spawn outside the seam and are not covered; tracked in #6063.
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
 * Evidence (TIMEOUT_EVIDENCE.TASK_RESOLVER_INVOKE_TIMEOUT_MS): fixture-data — invoke.timeoutMs value inside a task-content-resolver manifest fixture, not a spawn timeout.
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
 * Evidence (TIMEOUT_EVIDENCE.HTTP_REACHABLE_PROBE_TIMEOUT_FIXTURE_MS): fixture-data — timeoutMs value inside an http-reachable reviewer-lane declaration fixture, schema-validated only, not a spawn timeout.
 */
const HTTP_REACHABLE_PROBE_TIMEOUT_FIXTURE_MS = 2000;

// Reproduce the CI figures below (CI_SOURCE and CI_WINDOW entries) with scripts/timeout-evidence-from-ci.cjs
// against downloaded test-timings artifacts:
//   node scripts/timeout-evidence-from-ci.cjs --artifacts <dir> --format md
const CI_SOURCE = 'seam:spawn-stall records (every seam spawn that ran >= 2000ms or was killed) in CI test-timings-<os>-job<N> artifacts, credited to a constant by call site: the record\'s test file (or a helper it requires) has a seam call site of that constant, its timeoutMs equals the value, and its command/argv match that site; records matching sites of two constants are credited to neither';
const CI_WINDOW = 'test.yml runs (push and merge_group events, status success) created after 2026-10-25: 188 runs contained test-timings data (of 228 run directories downloaded), 1181 lane artifacts (win32 564, darwin 188, linux 429), spawn startedAt 2026-10-25T22:57:17.847Z to 2026-11-08T21:29:42.912Z';
const HARNESS_SOURCE = 'local harness through the process seam, 50 spawns per entry (a script and invocation variant, or a git subcommand): SCAN_USAGE_ERROR 8 entries, MALFORMED_INPUT_HOOK 3 entries, REAL_REPO_GIT 7 entries; these call sites were moved onto the seam in this change, so CI lanes in the window ran their previous form and are not counted';
const HARNESS_WINDOW = 'run 2026-11-08: darwin node v26.13.0; linux node v24.22.2; win32 not measured';

/**
 * Evidence for every numeric constant in this module, checked by
 * tests/timeout-evidence.test.cjs against tests/helpers/timeout-evidence.cjs.
 * Rules: TESTING-STANDARDS.md "Every new or changed timeout constant states its evidence".
 */
const TIMEOUT_EVIDENCE = Object.freeze({
  PROBE_TIMEOUT_MS: { kind: 'measured', observedMaxMs: 7424, worstPlatform: 'darwin', p50Ms: 111, p99Ms: 3411, samples: { win32: 9, darwin: 490, linux: 311 }, lanes: { win32: 564, darwin: 188, linux: 429 }, unmeasuredPlatforms: [], unseenSites: 125, unseenSitesTrackedBy: '#6058 #6059', source: CI_SOURCE, window: CI_WINDOW },
  HOOK_FANOUT_TIMEOUT_MS: { kind: 'measured', observedMaxMs: 23514, worstPlatform: 'win32', p50Ms: 2326, p99Ms: 7563, samples: { win32: 266, darwin: 978, linux: 173 }, lanes: { win32: 564, darwin: 188, linux: 429 }, unmeasuredPlatforms: [], unseenSites: 0, source: CI_SOURCE, window: CI_WINDOW },
  GIT_TIMEOUT_MS: { kind: 'measured', observedMaxMs: 4669, worstPlatform: 'win32', p50Ms: 2344, p99Ms: 4669, samples: { win32: 12 }, lanes: { win32: 551, darwin: 188, linux: 429 }, unmeasuredPlatforms: [], unseenSites: 58, unseenSitesTrackedBy: '#6060', source: CI_SOURCE, window: CI_WINDOW },
  GIT_FIXTURE_TIMEOUT_MS: { kind: 'measured', observedMaxMs: 10114, worstPlatform: 'win32', p50Ms: 2558, p99Ms: 7180, samples: { win32: 116, darwin: 4, linux: 148 }, lanes: { win32: 564, darwin: 188, linux: 429 }, unmeasuredPlatforms: [], unseenSites: 10, unseenSitesTrackedBy: '#6060', source: CI_SOURCE, window: CI_WINDOW },
  INSTALL_TIMEOUT_MS: { kind: 'measured', observedMaxMs: 49839, worstPlatform: 'win32', p50Ms: 2864, p99Ms: 7842, samples: { win32: 56561, darwin: 6476, linux: 734 }, lanes: { win32: 564, darwin: 188, linux: 429 }, unmeasuredPlatforms: [], unseenSites: 16, unseenSitesTrackedBy: '#6062', source: CI_SOURCE, window: CI_WINDOW },
  STAGED_HOOK_SCRIPT_TIMEOUT_MS: { kind: 'measured', observedMaxMs: 5232, worstPlatform: 'darwin', p50Ms: 4889, p99Ms: 5217, samples: { win32: 3, darwin: 180 }, lanes: { win32: 562, darwin: 188, linux: 429 }, unmeasuredPlatforms: [], unseenSites: 4, unseenSitesTrackedBy: '#6061', source: CI_SOURCE, window: CI_WINDOW },
  LOOP_HOOK_POINT_CLI_TIMEOUT_MS: { kind: 'measured', observedMaxMs: 39655, worstPlatform: 'win32', p50Ms: 2555, p99Ms: 20684, samples: { win32: 2176, darwin: 1117, linux: 714 }, lanes: { win32: 564, darwin: 188, linux: 429 }, unmeasuredPlatforms: [], unseenSites: 14, unseenSitesTrackedBy: '#6063', source: CI_SOURCE, window: CI_WINDOW },
  BUILD_TIMEOUT_MS: { kind: 'measured', observedMaxMs: 2000, censoredBelowMs: 2000, worstPlatform: null, lanes: { win32: 564, darwin: 188, linux: 429 }, unmeasuredPlatforms: [], unseenSites: 0, source: CI_SOURCE, window: CI_WINDOW },
  QUICK_SPAWN_TIMEOUT_MS: { kind: 'measured', observedMaxMs: 2000, censoredBelowMs: 2000, worstPlatform: null, lanes: { win32: 389, darwin: 188, linux: 286 }, unmeasuredPlatforms: [], unseenSites: 26, unseenSitesTrackedBy: '#6061', source: CI_SOURCE, window: CI_WINDOW },
  GENERATOR_SCRIPT_TIMEOUT_MS: { kind: 'measured', observedMaxMs: 2000, censoredBelowMs: 2000, worstPlatform: null, lanes: { darwin: 188, linux: 171 }, unmeasuredPlatforms: ['win32'], unseenSites: 8, unseenSitesTrackedBy: '#6063', source: CI_SOURCE, window: CI_WINDOW },
  GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS: { kind: 'measured', observedMaxMs: 2270, worstPlatform: 'win32', p50Ms: 2036, p99Ms: 2270, samples: { win32: 2 }, lanes: { win32: 188, darwin: 8, linux: 221 }, unmeasuredPlatforms: [], unseenSites: 4, unseenSitesTrackedBy: '#6063', source: CI_SOURCE, window: CI_WINDOW },
  SCAN_USAGE_ERROR_TIMEOUT_MS: { kind: 'measured', observedMaxMs: 108, worstPlatform: 'darwin', p50Ms: 7, p99Ms: 46, samples: { darwin: 400, linux: 400 }, unmeasuredPlatforms: ['win32'], unseenSites: 0, source: HARNESS_SOURCE, window: HARNESS_WINDOW },
  MALFORMED_INPUT_HOOK_TIMEOUT_MS: { kind: 'measured', observedMaxMs: 170, worstPlatform: 'darwin', p50Ms: 78, p99Ms: 163, samples: { darwin: 150, linux: 150 }, unmeasuredPlatforms: ['win32'], unseenSites: 0, source: HARNESS_SOURCE, window: HARNESS_WINDOW },
  REAL_REPO_GIT_TIMEOUT_MS: { kind: 'measured', observedMaxMs: 262, worstPlatform: 'darwin', p50Ms: 37, p99Ms: 195, samples: { darwin: 350, linux: 350 }, unmeasuredPlatforms: ['win32'], unseenSites: 0, source: HARNESS_SOURCE, window: HARNESS_WINDOW },
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
