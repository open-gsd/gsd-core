# ADR-6315: CI redesign — a fast static tier, a sharded critical path, one full matrix per merge, and feedback loops that keep it fast

- **Status:** Proposed — design lock for epic [#6315](https://github.com/open-gsd/gsd-core/issues/6315). It is ratified to `Accepted` when every item in *Phases* has shipped and the *Done when* list at the end holds.
- **Date:** 2026-11-18
- **Issue:** [#6315](https://github.com/open-gsd/gsd-core/issues/6315)
- **Supersedes:** nothing.
- **Relationship to prior work:** this ADR builds on four accepted decisions and changes none of them. [ADR-452](452-eslint-lint-harness.md) makes ESLint the lint enforcement point. [ADR-456](456-test-rigor-architecture.md) rejects retries and keeps mutation testing as a PR gate. [ADR-4593](4593-macos-conformance-tier-architecture.md) and [ADR-4641](4641-windows-selector-consolidation.md) define the macOS and Windows conformance tiers. One statement in ADR-456 (`--since origin/next`) is checked by item 2 and amended there if it is wrong.
- **Amends:** [ADR-452](452-eslint-lint-harness.md) (item 19), [ADR-456](456-test-rigor-architecture.md) (items 22 to 24), [ADR-4593](4593-macos-conformance-tier-architecture.md) and [ADR-4641](4641-windows-selector-consolidation.md) (item 20). The amendments take effect when this ADR is ratified. Each of the four carries the reciprocal pointer.
- **Amended:** 2026-11-18, the day it was written. The first version redesigned the CI pipeline and left the test suite as it was. The owner's review asked for a redesign of the test architecture and the working rules as well, with nothing deferred. Sections 5 and 6 are that amendment. They take priority over sections 3 and 4.
- **Research input:** three memos. Every figure in this ADR comes from one of them, and each records the command or file behind its numbers.
  - [`ci-redesign-options-survey.md`](../research/ci-redesign-options-survey.md) — CI timings and the options survey ("memo §N" below points into it).
  - [`test-suite-cost-structure-and-lint-conversion.md`](../research/test-suite-cost-structure-and-lint-conversion.md) — where test time goes, and which tests can become lints ("cost memo §N").
  - [`talk-slop-applied-to-ci-redesign.md`](../research/talk-slop-applied-to-ci-redesign.md) — a fact check of a talk on keeping agent-written code trustworthy, and what it implies here.

## How to use this ADR

This file is the contract for the agents that implement epic #6315.

- Each numbered item in *Phases* is **one child issue and one PR**. Do not combine items.
- **Items do not wait on each other unless the code forces it.** Where one item's result only informs another, the item says what to use until that result exists. The real dependencies are few and are listed in *Ordering*.
- A blocker is part of the epic. If an item is held up by an open PR, a missing review or a missing measurement, the implementing agent picks that up as the next step of the item. It does not park the item.
- The *Invariants* section applies to every item. A PR that breaks an invariant is wrong even if its own acceptance criteria pass.
- The acceptance criteria are release blockers. Record the evidence (run links, command output) in the PR body.
- Where an item says "decision rule", the implementing agent measures, applies the rule as written, and records the outcome in a dated section at the end of this file. The rule removes the need for a new ruling.
- Do not rebuild what exists. The table in *What already exists* lists it.

## Context

### The measured state

Measured over `test.yml` runs from 2026-11-12 to 2026-11-18 and over the 6,564-row timeout history log (memo §1.4, §1.5).

| Fact | Value |
|---|---|
| Merge-queue run wall-clock, green runs (n=41) | median 34.6 min, p90 39.3, max 44.8 |
| macOS conformance job (one job, not sharded), `merge_group` | median 34.1 min, p90 37.8, max 45.4 against a 45-min cap |
| Windows conformance shards, `merge_group` | medians 28.1 / 27.3 / 24.9 min |
| Ubuntu unit shards, `merge_group` | medians 19.0 / 21.7 / 20.9 min against a 32-min cap |
| Ubuntu shard 2/3 at ≥90% of its cap | 33 of 566 recorded runs; 3 at ≥99% |
| Share of each lane spent running tests | over 90%; dependency install is 0.8–1.2 min |
| Runner queue time | median 0.1 min; worst 10.2 min (one macOS job) |
| `lint-tests` job | median 2.4 min; failed in 1 of 45 sampled PR runs |
| Runner-minutes for one full `push` or `merge_group` run | about 187 |
| Test files | 1,204; the top 50 are 57.7% of summed test time, the top 100 are 73.9% |

### Eight problems

1. **The critical path is the unsharded macOS lane.** It sets the merge-queue wall-clock and has been cancelled at its cap twice in the sample.
2. **Two defects waste the most compute per incident.**
   - The targeted PR lane can fall back to the whole suite in one process. Runs 44258418022 and 44327517996 logged `run-tests: suite="all" files=1192` and were cancelled at the 32-min cap. [#6308](https://github.com/open-gsd/gsd-core/pull/6308) fixed the one path that triggered it, not the fallback.
   - `mutation.yml:165` passes `--incremental`, but no step restores or saves the incremental file, so every Stryker shard runs cold. The `state-document` shard took 54.0 and 81.8 min.
3. **Static checks do not gate the matrix.** `lint-tests` and `test` both need only `preflight` (`test.yml:191-192`, `:255-257`). A PR with a static defect still runs all shards. No workflow linter runs at all, although workflow defects are the ones that waste whole runs.
4. **The full matrix runs twice per merge:** on the `merge_group` commit and again on the `push` to `next`.
5. **Nothing keeps the suite fast.** The timing tables that balance the shards are refreshed by hand, and there is no darwin table. No gate stops a new slow test file. `--test-force-exit` is on by default, so leaked handles are invisible. No ledger names the files that fail intermittently.
6. **The suite tests logic through real processes.** Files that spawn a process hold 89% of Linux test time and 94% of Windows-tier time. The largest suites (`state`, `phase`, `roadmap`, `config`, `init`) assert JSON fields and file content, and reach them through about 2,800 CLI spawn sites. The 418 files that test logic in-process run 12,560 cases in 3.8% of the time (cost memo §1).
7. **Static checks run as tests.** 190 test files only read repo content and assert on it. Each one costs a process in the test lane, and 29 tests repeat a scan that `lint:ci` already runs (cost memo §3).
8. **The working rules multiply the cost.** PR #5053, the reshard that fixed the critical path, was open from 2026-09-27 to 2026-11-18 and went through at least 14 review rounds, the later ones on comment wording and fixture style. The 230-line follow-up to it (#6329) needed three review rounds and six full-suite runs, because every finding of any size triggers a failing-first run and a passing run of all 61,443 tests.

### What already exists

Do not rebuild these. The redesign wires them together and adds the missing feedback loops.

| Capability | Where |
|---|---|
| Timing-balanced (LPT) sharding with isolated heavy files | `scripts/run-tests.cjs`, `tests/test-timings.json`, `tests/test-timings.win32.json` |
| Per-file duration artifacts from CI | `test.yml` (`test-timings-ubuntu-unit-job*`, `test-timings-<os>-job*`) |
| Changed-path scope classifier and the inert-CI lane | `scripts/ci-test-scope.cjs` |
| Import-graph affected-test selection with a critical-path fallback | `scripts/affected-tests-lib.cjs`, `npm run test:affected` |
| Daily timeout trend, 90% near-cap warning, shard-balance check | `ci-timeout-report.yml`, `tests/ci-timeout-budget-history.jsonl` |
| Aggregate required check that tolerates skipped lanes | `test.yml` job `required-tests` (`Required tests`) |
| Merge queue on `next`, mergeability preflight, base-branch health gate | `.github/rulesets/next-queue.json`, `pr-mergeable-preflight.yml`, `scripts/ci-next-health.cjs` |
| About 34 local ESLint rules for test hygiene and subprocess safety | `eslint-rules/`, `eslint.config.mjs` |

## Decision

### 1. Target shape

CI has four tiers. Each tier has one job to do.

| Tier | Runs on | Contents | Target |
|---|---|---|---|
| **T0 static-fast** | every PR, `merge_group`, `push` | actionlint, zizmor, ESLint | median under 60 s; blocks T1 and T2 |
| **T1 PR lane** | every PR | targeted tests, three Ubuntu unit shards, the rest of `lint:ci` in parallel, mutation on changed modules | as today (20–22 min), no cap hits |
| **T2 merge-queue lane** | `merge_group` | everything in T1 plus Windows and macOS conformance, both sharded | median wall-clock under 30 min |
| **T3 scheduled lane** | cron | timing-table refresh, Stryker `--force`, leak audit, failure ledger | report-only; never a merge gate |

The post-merge `push` run on `next` repeats T2 only when the merged tree differs from the tree the queue tested (item 8).

Section 5 changes what runs inside these tiers. After it, T1 runs in-process tests plus a small process-contract tier, the Windows and macOS lanes in T2 run only the contract tiers, and checks of repo content run in T0 and the static content lane and are no longer tests.

### 2. Invariants

These hold for every item in the epic.

- **I1 — The required check name does not change.** `Required tests` stays the single aggregate check. A new gating job is added to its `needs` list. No job that branch protection names is renamed.
- **I2 — The merge queue runs the full suite.** Test selection of any kind applies to PR runs only. `merge_group` never selects.
- **I3 — No retries and no quarantine.** No `--test-rerun-failures`, no retry step, no quarantine lane. [ADR-456](456-test-rigor-architecture.md) rejects retry loops and requires a bad test to be fixed or deleted.
- **I4 — Wall-clock bounds are backstops, not fixes.** Job-level `timeout-minutes` and the 600 s chunk watchdog stay. Raising one is not an acceptable response to a slow or hung lane. The response is to remove the cause. The policy against wall-clock timeouts on git and npm subprocesses is unchanged.
- **I5 — Free GitHub-hosted standard runners only.** No larger runners and no self-hosted runners (owner ruling, 2026-11-18).
- **I6 — No `paths:` filter on a workflow that carries a required check.** Scope is decided at job level by `scripts/ci-test-scope.cjs`.
- **I7 — Correctness gates stay on the PR or in the queue.** T3 holds diagnostics and refresh jobs only. Mutation testing stays a PR gate.
- **I8 — Checks on code shape are ESLint rules, and a new rule ships at `error`.** `npm run lint` runs with `--max-warnings 0`, so a `warn` rule already fails CI; the cleanup lands in the PR that adds the rule (I9). Workflow YAML is checked by actionlint and zizmor, and other non-JavaScript content by the static content lane (item 19).
- **I9 — First-run findings are fixed in the PR that adds the check.** A new linter does not land with a backlog. A false positive is suppressed in the tool's config with a recorded reason.
- **I10 — Every new third-party binary or action is pinned** to a version and a checksum or commit SHA.
- **I11 — The testing standards change in the PR that changes the rules.** When an item adds or changes a requirement on test authors, or on product code for the sake of testability, the same PR states it in `TESTING-STANDARDS.md`, under "Test architecture policies (ADR 6315)", and, for placement and naming, in `docs/TESTING-SUITES.md`: the rule, its reason, and what enforces it. `CONTRIBUTING.md` ("Testing Standards") keeps the helper tables and setup patterns and points there. A rule known only from a PR description or a review thread is not a rule the next contributor can follow (maintainer instruction, 2026-11-19; [#6367](https://github.com/open-gsd/gsd-core/issues/6367); the file named here was corrected by [#6383](https://github.com/open-gsd/gsd-core/issues/6383)).

### 3. Phases

#### Phase 0 — remove the measured defects

**Item 1 — Targeted-lane fallback guard.** Depends on: nothing.
Files: `scripts/ci-test-scope.cjs`, `scripts/ci-prepare-test-scope.cjs`, `tests/ci-test-scope.test.cjs`.
The targeted lane must never run the whole suite unless the scope result says `full` and names a reason.

- AC1: the scope output carries `targeted_tests` and a `reasons` entry whenever the result is the whole suite. A test feeds a data-log-only change, a docs-only change and an unknown-extension change, and asserts that none yields the whole suite without a named reason.
- AC2: the CI log line `run-tests: suite=... files=N` for the targeted lane shows N below the full count unless the scope result is `full` with a reason.
- AC3: over the next 30 PR runs, no `test (ubuntu-latest, 24)` job runs longer than 10 min.

**Item 2 — Stryker incremental cache.** Depends on: nothing.
Files: `.github/workflows/mutation.yml`, `scripts/mutation-matrix.cjs`.

- AC1: `mutation.yml` restores and saves the Stryker incremental file with `actions/cache`, keyed per module and base commit.
- AC2: a second run of an unchanged module finishes in under 25% of the first run's duration. Both durations are in the PR body.
- AC3: a scheduled run with `--force` exists (T3), and a failure opens an issue. Stryker does not detect dependency or environment changes in incremental mode, so this run is required.
- AC4: the `state-document` shard's timeout is derived again from measurements taken after the cache lands.
- AC5: [ADR-456](456-test-rigor-architecture.md) says Stryker runs with `--since origin/next`. Show from command output that the flag exists, or amend ADR-456 in a dated section to say what the workflow actually passes.

#### Phase 1 — the static tier

**Item 3 — `static-fast` job (T0).** Depends on: nothing.
Files: `.github/workflows/test.yml`, a zizmor config file, `tests/ci-*.test.cjs` workflow-contract tests.
Add one job that runs pinned actionlint, pinned zizmor and `eslint . --max-warnings 0`. The rest of the `lint:ci` chain stays in `lint-tests`, in parallel with the shards.

- AC1: the job's median runtime is under 60 s over 10 runs. Restore the ESLint cache with `actions/cache` if that is what it takes.
- AC2: **decision rule** (owner ruling, 2026-11-18). If AC1 holds, `test`, `test-inert` and `test-conformance` add `static-fast` to `needs`. If the job cannot get under 60 s, it runs in parallel and gates only through `Required tests`. Record which arm applied.
- AC3: zero findings on `next` at merge (I9). The repo uses `pull_request_target` in four workflows. Each zizmor finding on them is fixed, or suppressed with a reason.
- AC4: `static-fast` is in the `needs` list of `required-tests` (I1).
- AC5: a scratch branch with a deliberately broken workflow (for example `shell: ${{ matrix.shell }}`) fails the job. The run link is in the PR body.

**Item 4 — Slow-file budget ratchet.** Depends on: nothing.
Files: a new script under `scripts/`, an allowlist data file under `tests/`, `ci-timeout-report.yml`.
A budget needs measured durations, so it reads the CI duration artifacts that `test.yml` already uploads and runs after the tests, on the schedule. It does not need item 6: the committed timing table seeds the allowlist, and the artifacts exist today.

- AC1: the script fails when a test file that is not on the allowlist exceeds the ceiling, and when an allowlisted file exceeds its recorded cost by more than a stated slack.
- AC2: the allowlist is today's offenders at their current cost, taken from `tests/test-timings.json`. A new entry needs an issue link.
- AC3: the ceiling and the slack are constants in one place, each with a comment giving the measurement behind it.
- AC4: child issues exist for converting the ten slowest files to in-process invocation. Each conversion PR lowers that file's allowlist ceiling in the same change.

#### Phase 2 — critical path and compute

**Item 5a — Land the conformance reshard ([#5053](https://github.com/open-gsd/gsd-core/pull/5053)).** Depends on: nothing. Closes [#5029](https://github.com/open-gsd/gsd-core/issues/5029) and [#6148](https://github.com/open-gsd/gsd-core/issues/6148).
PR #5053 is an open contributor PR that already does this work: macOS conformance goes from one job to three shards, Windows from three shards to six, the cap stays at 45 min, and the lane gets its first `LANE_COSTS` entry. Its own evidence shows long poles of 13 min 34 s (macOS) and 15 min 46 s (Windows) on a green full-matrix run. On 2026-11-18 it was waiting on a maintainer review of head `c06a0c2e4`. That review is the first step of this epic. Do not write a second implementation.

- AC1: #5053 is reviewed at its current head and merged through the queue. If its author stops responding, a maintainer branch carries the same commits forward with the author credited.
- AC2: over 20 `merge_group` runs after the merge, the slowest macOS shard is under 25 min and the median run wall-clock is under 30 min.
- AC3: `Required tests` still accepts `success` or `skipped` for the lane.

**Item 5b — Darwin timing table and macOS concurrency.** Depends on: nothing for the table. The concurrency measurement runs after item 5a merges.
Files: `scripts/run-tests.cjs`, `scripts/gen-test-timings.cjs`, a new `tests/test-timings.darwin.json`.

- AC1: a darwin timing table is generated from the macOS duration artifacts that `test.yml` already uploads, and the packer reads it on macOS the way it reads the win32 table on Windows.
- AC2: **decision rule.** Run the same macOS shard at `--test-concurrency` 2, 3 and 4 on the 3-vCPU runner, five runs each. Adopt the value with the lowest median if it beats the current value by more than 10%. Otherwise keep the current value.

**Item 6 — Scheduled timing-table refresh.** Depends on: nothing.
Files: a new scheduled workflow (or a job in `ci-timeout-report.yml`), `scripts/gen-test-timings.cjs`.

- AC1: the job downloads the duration artifacts of the last three green `push` runs, regenerates every per-platform timing table, and opens a data-only PR the same way `ci-timeout-report.yml` does for the history log.
- AC2: the data-only PR is classified so that it skips the test matrix (the class of fix made in #6308), and item 1's guard covers it.
- AC3: 14 days after the first refresh merges, Ubuntu shard 2/3 has zero runs at ≥90% of its cap over 40 `merge_group` and `push` runs.
- AC4: **decision rule.** If AC3 fails after two refreshes, add a fourth Ubuntu shard. Do not raise the cap (I4).

**Item 7 — Windows packer accounts for long single files.** Depends on: nothing. Closes [#5807](https://github.com/open-gsd/gsd-core/issues/5807) and [#5162](https://github.com/open-gsd/gsd-core/issues/5162).
Files: `scripts/run-tests.cjs`. PR #5053 does not touch this file, so the two do not conflict.

- AC: the shard-balance check in `ci-timeout-report.yml` reports `ok` for two consecutive daily runs, against the baseline of whichever shard layout is live when this item merges.

**Item 8 — One full matrix per merge.** Depends on: nothing. Its precondition is met (see *Decision-rule outcomes*, 2026-11-18).
Files: `.github/workflows/test.yml`, `scripts/ci-next-health.cjs`, the `publish-emitted-baseline` job.
Owner ruling (2026-11-18): the post-merge `push` matrix may be skipped only after tree identity is proven. It is proven, and the result is stronger than tree identity: the queue fast-forwards `next` to the merge-group commit, so the pushed commit has the **same SHA** as the commit the `merge_group` run tested.

- AC1: done. Fourteen of fourteen sampled merges matched.
- AC2: on `push` to `next`, a first job looks for a `merge_group` run of `test.yml` whose head SHA equals the pushed SHA and whose conclusion is `success`. The matrix is skipped only when one exists. Any other case, including a direct push, a bypass merge or a lookup error, runs the full matrix as today.
- AC3: `scripts/ci-next-health.cjs` reads the `merge_group` conclusion when the push run skipped, and the push run otherwise. A unit test covers both arms.
- AC4: `publish-emitted-baseline` still produces the baseline after every merge.
- AC5: on merges that come through the queue, runner-minutes for the post-merge run drop from about 187 to under 25.

#### Phase 3 — diagnostics, selection and deeper static checks

**Item 9 — Leak audit and failure ledger (T3).** Depends on: nothing.
Files: a new scheduled workflow, a shared test hook under `tests/helpers/`, `scripts/run-tests.cjs` (a flag that turns `--test-force-exit` off).

- AC1: a scheduled run executes the unit suite without `--test-force-exit` and records `process.getActiveResourcesInfo()` after each file. The artifact lists every file that leaves resources active. The run is report-only.
- AC2: a ledger job counts failures per test file over the last 50 `next` runs and publishes the top 20.
- AC3: every ledger and leak entry becomes an issue, or is shown to be an infrastructure failure. None is left as a note (I3).

**Item 10 — Affected-test selection in shadow mode.** Depends on: nothing. The job gates nothing, so it can run before items 1 and 6 land.
Files: `.github/workflows/test.yml`, `scripts/affected-tests-lib.cjs`, a report script.
Much of this suite reads repo files instead of importing modules, so an import graph selects too few tests. Earlier selection work escaped regressions (see [ADR-4641](4641-windows-selector-consolidation.md)). Selection is therefore measured before it is trusted.

- AC1: on every PR, a job that is not required computes the selection and uploads the list. The full lane still runs and still gates.
- AC2: a daily report publishes the count of failing tests that were outside the selected set.
- AC3: **decision rule.** Enforcement is proposed, in a new issue, only after 100 consecutive PR runs with that count at zero. Until then the PR lane runs the full Ubuntu shards. I2 holds either way.

**Item 11 — Leak-shape lint rules.** Depends on: nothing. AC1 and AC3 start now. AC2 picks its shapes from item 9's first report, and until that exists, from the stall and leak causes already recorded in closed issues.
Files: `eslint-rules/`, `eslint.config.mjs`.

- AC1: first read the existing rules (`no-unbounded-spawn`, `require-full-tmpdir-triad` and the rest) and list which of these shapes they already cover: an un-awaited promise in a test body, an async spawn whose stdin is never closed, a timer or server with no teardown, a fixed port, a write outside the tmp directory, real network use.
- AC2: one rule per uncovered shape that has a recorded occurrence. Each ships at `error` with tests and with its findings fixed in the same PR (I8, I9).
- AC3: **decision rule.** Measure `npm run lint` with type-aware `no-floating-promises` over `tests/**/*.cjs`. Enable it only if it adds under 60 s and `static-fast` stays inside its target.

**Item 12 — Three measurements with a rule each.** Depends on: nothing.

- **Coverage on PR shards.** A/B the same shard with and without c8, five runs each. If c8 costs more than 15% of the shard's test time, move coverage to `merge_group` and `push` runs and keep the coverage gate there. Otherwise change nothing.
- **Queue minimum group size.** `.github/rulesets/next-queue.json` sets `min_entries_to_merge: 2` with a 15-min wait. Measure the time from enqueue to the start of the `merge_group` run over 30 merges. If the median wait for a lone PR is over 5 min, set the minimum to 1. The ruleset change is applied by the owner.
- **Property-test run counts.** Sum the timing-table cost of `*.property.test.cjs` files. If it is over 5% of the suite, open an issue for a CI-wide `numRuns` budget. Otherwise change nothing.

#### Phase 4 — maintainability

**Item 13 — One composite action for the repeated setup steps.** Depends on: nothing. It rebases on whichever `test.yml` change merges before it.
Files: `.github/actions/`, `.github/workflows/test.yml`, `tests/ci-*.test.cjs`.

- AC: checkout, runner guard, rebase check, Node setup and install are one `uses: ./.github/actions/...` step in `test`, `test-inert`, `test-conformance` and `qa-loop-walk`. The workflow-contract tests are updated and pass.

### 4. Ordering

Every item starts now. The phases are a priority order, not a queue. Sections 5 and 6 (items 14 to 24) go first: they shrink the suite that every item in section 3 schedules. Within section 3, lower phase numbers go first.

| Item | Issue | Item | Issue |
|---|---|---|---|
| 1 | [#6317](https://github.com/open-gsd/gsd-core/issues/6317) | 7 | [#5807](https://github.com/open-gsd/gsd-core/issues/5807) |
| 2 | [#6318](https://github.com/open-gsd/gsd-core/issues/6318) | 8 | [#6323](https://github.com/open-gsd/gsd-core/issues/6323) |
| 3 | [#6319](https://github.com/open-gsd/gsd-core/issues/6319) | 9 | [#6324](https://github.com/open-gsd/gsd-core/issues/6324) |
| 4 | [#6320](https://github.com/open-gsd/gsd-core/issues/6320) | 10 | [#6325](https://github.com/open-gsd/gsd-core/issues/6325) |
| 5a | PR [#5053](https://github.com/open-gsd/gsd-core/pull/5053) | 11 | [#6326](https://github.com/open-gsd/gsd-core/issues/6326) |
| 5b | [#6321](https://github.com/open-gsd/gsd-core/issues/6321) | 12 | [#6327](https://github.com/open-gsd/gsd-core/issues/6327) |
| 6 | [#6322](https://github.com/open-gsd/gsd-core/issues/6322) | 13 | [#6328](https://github.com/open-gsd/gsd-core/issues/6328) |
| 14 | [#6332](https://github.com/open-gsd/gsd-core/issues/6332) | 20 | [#6338](https://github.com/open-gsd/gsd-core/issues/6338) |
| 15 | [#6333](https://github.com/open-gsd/gsd-core/issues/6333) | 21 | [#6339](https://github.com/open-gsd/gsd-core/issues/6339) |
| 16 | [#6334](https://github.com/open-gsd/gsd-core/issues/6334) | 22 | [#6340](https://github.com/open-gsd/gsd-core/issues/6340) |
| 17 | [#6335](https://github.com/open-gsd/gsd-core/issues/6335) | 23 | [#6341](https://github.com/open-gsd/gsd-core/issues/6341) |
| 18 | [#6336](https://github.com/open-gsd/gsd-core/issues/6336) | 24 | [#6342](https://github.com/open-gsd/gsd-core/issues/6342) |
| 19 | [#6337](https://github.com/open-gsd/gsd-core/issues/6337) | 14b | [#6354](https://github.com/open-gsd/gsd-core/issues/6354) |
| 25 | [#6355](https://github.com/open-gsd/gsd-core/issues/6355) | 26 | [#6369](https://github.com/open-gsd/gsd-core/issues/6369) |

- **Real dependencies:** item 15 needs item 14's entry point; item 16 needs item 15; item 20 needs items 15 and 19; the second half of item 24 needs item 19; the macOS concurrency measurement in item 5b needs the sharded lane from item 5a, which has merged.
- **Item 5a is done:** PR #5053 merged on 2026-11-18. Its review findings are tracked in [#6329](https://github.com/open-gsd/gsd-core/issues/6329).
- **Shared file:** PR #5053 and items 3, 8, 10 and 13 all edit `.github/workflows/test.yml`. They do not wait for each other. Each one rebases on `next` before it is enqueued, and the merge queue serialises them. Items 5b and 7 both edit `scripts/run-tests.cjs` and follow the same rule.
- **Results that feed other items:** item 9's first report sharpens item 11, and item 6's refreshed tables sharpen item 4. Neither is a precondition.

### 5. Test architecture

These items come before everything in section 3. They change how tests are written, where sections 3 and 4 change only how they are scheduled.

#### The design

Tests fall into four tiers. The filename says which tier a file is in, and a lint rule holds each file to its tier.

| Tier | Filename | May do | Runs on |
|---|---|---|---|
| Unit | `*.test.cjs` | Call product code in-process. No process spawn of any kind. | Linux, every PR |
| Process contract | `*.process.test.cjs` | Spawn the real CLI, git, hooks or scripts. Asserts only what a process boundary adds: argv parsing, exit code, stdout and stderr framing, signals. | Linux every PR; Windows and macOS in the queue |
| Install contract | `*.install.test.cjs` | Run the real installer, `npm pack`, a global install. | Linux every PR; Windows and macOS in the queue |
| Platform | `*.platform.test.cjs` | OS-specific behaviour (paths, case, mode bits). Already exists (#5074). | Windows and macOS in the queue |

A check that only reads repo content is not a test. It is a lint and runs in the static lanes (item 19).

The reasoning is the correction ladder from the talk memo: remove the bad choice by design first, enforce what is left with a deterministic check, and use prose last. Today "do not spawn a process to test logic" is not even prose. After this section it is a design property (the CLI is callable in-process) held by a lint rule (a unit file cannot import a spawn helper).

#### Phase A — the in-process seam

**Item 14 — An exported, capturable CLI entry point.** Depends on: nothing.
Files: `gsd-core/bin/gsd-tools.cjs`, `src/cli-exit.cts`, `src/io.cts`, the `src/*-command-router.cts` files, a new `src/process-context.cts`.
Today `main` is not exported, reads `process.argv`, `process.env` and `process.cwd()` directly, and writes with `fs.writeSync(1, …)` (cost memo §2).

- AC1: `gsd-tools.cjs` exports `runCli({ argv, cwd, env, stdin })`, which returns `{ exitCode, stdout, stderr }`. It never calls `process.exit`, never writes to the real stdout or stderr, and leaves `process.cwd()`, `process.env` and `process.exitCode` as it found them.
- AC2: the binary's own entry is `runMain(() => runCli(fromRealProcess()))`. There is one code path, used by both the binary and the tests.
- AC3: `argv`, `cwd`, `env`, the output sinks and the exit path reach handlers through one process-context object. A new ESLint rule, `local/no-process-global-outside-context`, fails any read of `process.argv`, `process.cwd()`, `process.exit`, `process.exitCode`, `process.stdout` or `process.stderr` in `src/` outside that module. The rule lands with an allowlist of today's sites (the cost memo counts them) that only shrinks, and reaches zero for every module a command handler can reach before item 15 starts.
- AC4: a property test runs random sequences of `runCli` calls and asserts that process state after each call equals process state before it.

**Item 15 — `runGsdTools` runs in-process.** Depends on: item 14.
Files: `tests/helpers.cjs`, `tests/helpers/process-seam.cjs`, a new `tests/cli-parity.process.test.cjs`.
`runGsdTools` (`tests/helpers.cjs:207`) is the one adapter that builds the `{ success, output, error, exitCode }` shape its callers use. Changing what it does underneath moves every caller at once.

- AC1: `runGsdTools` calls `runCli` in-process and returns the same shape. `runGsdToolsProcess` is the spawning version, and only process-contract files may import it.
- AC2: `tests/cli-parity.process.test.cjs` runs a table of invocations through both and asserts equal exit code, stdout and stderr. The table has at least one success, one usage error and one handler failure for every top-level command (`hostCommandNames()` supplies the list, so a new command without rows fails the test).
- AC3: a full-suite run is green with `runGsdTools` in-process. Any test that fails because it depended on a real process either moves to a `.process.test.cjs` file with that dependency named in its title, or is fixed.
- AC4: the PR body records the summed `gsd-test` time of the 280 CLI-spawning files before and after.

**Item 16 — Split the six command suites.** Depends on: item 15.
Files: `tests/state.test.cjs`, `tests/phase.test.cjs`, `tests/roadmap.test.cjs`, `tests/config.test.cjs`, `tests/init.test.cjs`, `tests/custom-phase-readers.test.cjs`.

- AC1: each file's logic cases run in-process, and its fixtures are built once in `before()` and copied per test.
- AC2: cases that assert the process boundary move to a `.process.test.cjs` sibling. The sibling is the only part of the suite in the Windows and macOS tiers.
- AC3: no case is deleted without a replacement, and each module's mutation score does not drop.
- AC4: the six files' summed Linux time, 974 s today, is under 200 s.

**Item 25 — No git process to resolve the project context.** Depends on: nothing. It pays off fully once item 15 has landed.
Files: `src/project-context.cts`, a new process-contract parity test.
Every CLI call spawns `git rev-parse --show-toplevel --git-dir --git-common-dir`, and a second spawn in a linked worktree. Measured in-process on macOS, a call takes about 10 ms, of which about 9 ms is that spawn and under 1 ms is the CLI's own work (2026-11-18 entry below).

- AC1: `resolveProjectContext` answers the three questions by reading `.git`, `gitdir` and `commondir`. It stays the one resolver ([ADR-4908](4908-project-context.md)).
- AC2: a layout the reader does not recognise still resolves through `git`, and the context's provenance says which path answered.
- AC3: a parity test compares the reader with real `git rev-parse` over built fixtures: plain repo, subdirectory, linked worktree, worktree of a bare repo, submodule, `GIT_DIR` and `GIT_WORK_TREE` set, a relative `gitdir`, a symlinked checkout, and no repo.
- AC4: a test counts subprocesses and finds none for context resolution in a plain repo, a linked worktree and a directory with no repo.

#### Phase B — installer and fixtures

**Item 17 — One install per runtime per run.** Depends on: nothing.
Files: `tests/helpers/install-shared.cjs`, the `*.install.test.cjs` files, `bin/install.js` (generated from its source).
79 files run the installer and hold 26.8% of Linux time. On Windows a single installer spawn averages at least 2.8 s.

- AC1: emitted-content tests read a fixture built once per runtime and scope for the whole run. A test that needs a changed tree copies the fixture. (As first written this said the fixture is built by calling `install()` in-process; measurement replaced that, see "Item 17: the saving is in not installing again" under Decision-rule outcomes.)
- AC2: the real-process installer runs once per runtime in one install-contract file, plus the tarball smoke test.
- AC3: `fragment-single-edit-propagation.install.test.cjs` (575 s) builds its 18-runtime install once and derives each row from it.
- AC4: summed Linux time of the install class drops from 33.2 min to under 10 min, and the count of installer spawns of 2 s or more on a Windows shard drops by at least 80%.

**Item 18 — Git fixtures without git spawns.** Depends on: nothing.
Files: `tests/fixtures/index.cjs`, `tests/helpers.cjs`.
`createTempGitProject` runs six git commands per fixture, and there are about 7,200 git spawn sites.

- AC1: a git fixture is a prebuilt repository directory copied with `fs.cpSync`. Building it costs zero spawns per test.
- AC2: the template is built once per run by one spawn sequence, and its content is asserted by one test.
- AC3: fixture builders run in `before()` or at module scope. A new ESLint rule, `local/no-fixture-build-in-test-body`, fails a temp-project builder called inside a test body or `beforeEach` when the file has more than one test; today's sites are fixed in the PR that adds it.

#### Phase C — static checks leave the test lane

**Item 19 — The static content lane.** Depends on: nothing. Amends [ADR-452](452-eslint-lint-harness.md) (see section 6).
Files: `scripts/lint-*.cjs`, a new single-process runner `scripts/run-static-checks.cjs`, `package.json`, the 190 class-A test files listed in `docs/research/data/2026-11-18-test-file-classification.tsv`.

- AC1: `lint:ci` stops being one `&&` chain of about 55 `node` processes. One runner loads every check as a module, runs them in one process, and reports every failure, not only the first.
- AC2: each class-A test file is deleted and its assertions become a check in that runner, or an ESLint rule when the subject is JavaScript. The PR that deletes a file shows the new check failing on a seeded violation.
- AC3: `portability-rule-disable-ban`, `fold-helper-shadowing` and `emitted-provenance` (126 s between them) are converted first.
- AC4: parity checks between two repo artifacts are replaced by generating one side and checking it with the existing `gen-*.cjs --check` pattern. A hand-written parity check stays only where generation is impossible, and the check says why.
- AC5: the 29 test cases that re-scan the real tree (`docs/research/data/2026-11-18-test-lint-duplicate-pairs.txt`) are deleted. The tests of each lint keep their fixture-based detection cases.
- AC6: the static content lane runs once, on Linux, never on Windows or macOS, and finishes in under 90 s.

**Item 20 — Tier enforcement.** Depends on: items 15 and 19.
Files: `eslint-rules/`, `eslint.config.mjs`, `scripts/run-tests.cjs`, `scripts/lib/platform-conformance-tier.generated.cjs` and its generator, `.github/workflows/test.yml`.

- AC1: `local/no-spawn-in-unit-test` fails any import of `child_process`, the process seam, `runGsdToolsProcess`, the installer runner or a git runner in a file that is not `.process.`, `.install.` or `.platform.`. It lands with an allowlist of the files still to convert, and the allowlist only shrinks.
- AC2: `local/no-repo-content-assertion-in-test` fails a test that reads a tracked repo file outside `tests/fixtures/` and asserts on its content. It replaces the `allow-test-rule` exemption for product text (section 6).
- AC3: the Windows and macOS tiers are generated from the filename suffixes. The evidence-based classifiers of [ADR-4593](4593-macos-conformance-tier-architecture.md) and [ADR-4641](4641-windows-selector-consolidation.md) are retired in the same PR, with a dated section in each.
- AC4: the unit tier has a per-file ceiling of 5 s on Linux, enforced by item 4's ratchet. A unit file over it is slow for a reason the ratchet makes someone state.

#### What this is expected to buy

These are targets, set from the measurements. Each item records its own before and after.

| Measure | Today | Target |
|---|---|---|
| Linux test time, summed over files | 123.7 min | under 45 min |
| Windows conformance time, summed | 116.7 min | under 30 min |
| Files that spawn a process | 540 | under 120 |
| Static checks running as tests | 190 files | 0 |
| Full-suite `gsd-test` run | all 61,443 tests, one process per file | the same tests, about a third of the wall-clock |

When the summed Linux time is under 45 min, the Ubuntu lane drops from three shards to two, and the Windows lane from six to three. Sharding was the answer to a suite that could not be made faster; it is undone as the suite gets faster.

### 6. Process rules

The rules below are how work on this repo is done. They are amended here because problem 8 shows them costing more than they return, and because the owner has ruled that no existing rule is fixed. Each change replaces judgement applied late with a check applied early.

**Item 21 — The correction ladder is the rule for every finding.** Depends on: nothing.
Files: `CONTRIBUTING.md`, `CLAUDE.md`, the review directives.
A finding from review, CI or a bug report is handled at the highest rung that works:

1. Design: change the code so the mistake cannot be written.
2. Deterministic check: an ESLint rule, a static check or a type.
3. Verification: a test.
4. Prose: a line in an instruction file, only when 1 to 3 are impossible, and the line says why.

- AC1: `CONTRIBUTING.md` states the ladder. A review finding of a kind that has been raised before names the rung that will stop it recurring, and that work is part of the fix.
- AC2: every rule in `CLAUDE.md` "Known defects and anti-patterns" and "Test rules and conventions" is listed with its current rung. Each prose-only rule gets a check, or a recorded reason why none is possible. The list lives in `docs/` and a static check fails when a rule is added to `CLAUDE.md` without a row.

**Item 22 — Review is sized to risk, and ends.** Depends on: nothing. Amends the two-review rule in `CLAUDE.md` and the review directive.

- AC1: a change confined to `tests/`, `scripts/`, `eslint-rules/`, `.github/` and `docs/` needs one isolated review pass. A change that touches shipped code (`src/`, `gsd-core/`, `bin/`, `agents/`, `commands/`, `hooks/`) needs the two passes it needs today.
- AC2: only Blocker and Major findings block an approval. Minor and Nit findings are listed once. The author fixes them, and the reviewer checks the delta; no new full review round starts for them.
- AC3: a finding that a lint could have caught is filed as a lint under item 21, not argued in the PR.
- AC4: a review that reaches a third round on the same PR stops, and the maintainer decides between merging with a follow-up issue and taking the branch over.
- AC5: the hooks that gate `gh pr review` and `gh pr create` are updated to this rule in the same PR as the text.

**Item 23 — Failing-first proof at file scope.** Depends on: nothing. Amends the regression protocol in `CLAUDE.md` and `gsd-test-verify`.
Proving that a new test fails does not need the other 61,442 tests.

- AC1: `gsd-test` can run a named list of test files in its disposable container. If it cannot today, that is added first.
- AC2: the failing-first step runs only the changed test files and records the failure the same way a full run records a verdict. The passing step is one full run on the commit that ships.
- AC3: a change that adds tests and a fix in several steps needs one full run, on its final commit.

**Item 24 — Exemptions name an issue, and the product-text exemption ends.** Depends on: item 19 for the second half. Amends [ADR-456](456-test-rigor-architecture.md) and `CONTEXT.md`.

- AC1: one ESLint rule fails any `eslint-disable`, `allow-test-rule` or `allow-unbounded-subprocess` directive that carries no `#NNN` issue reference. Today's bare directives are fixed in that PR.
- AC2: `CONTEXT.md` `RULESET.TESTS.no-source-grep.exemption` is removed when item 19 has converted the files that use it (113 of the 154 class-A4 files). A check of product text is a static check, so the exemption has nothing left to exempt.
- AC3: a comment may explain code. It may not hold measurement logs or the history of a number. Run ids and measured tables live in `docs/research/data/`, and the comment links there. `local/max-comment-block-lines` enforces a ceiling of 15 lines, with today's longer blocks moved in the PR that adds it.

## Considered and rejected

| Option | Why it is rejected |
|---|---|
| Retries, `--test-rerun-failures`, quarantine lanes | A retry turns a failure signal into silence. [ADR-456](456-test-rigor-architecture.md) rejects it, and a quarantined test is a deferred fix. |
| Node `--test-shard` | It splits by file count. The repo's packer splits by measured duration, which matters when one file takes 575 s. |
| `--test-isolation=none` | Tests change env, cwd and temp state and rely on a fresh process per file. One process would also lose timeout attribution. |
| Node experimental coverage, `mock.module` | Experimental. The c8 pipeline works. |
| Turborepo, Nx, Bazel, Moon | A cache hit needs narrow, declared inputs. These tests read prompts, workflows and manifests across the repo, so the honest input set is the whole repo. |
| Paid larger runners, Dev Drive | Owner ruling: no spend. Dev Drive needs 50 GB free and a standard runner has 14 GB. |
| Self-hosted runners | The runner guard exists on purpose. They widen the surface for hostile PRs. |
| `paths:` filters on required workflows | A skipped required workflow stays pending and blocks the merge. The aggregate job is the documented pattern. |
| Caching `node_modules` or sharing one build artifact | Install is 0.8–1.2 min and runs in parallel. Nothing on the critical path is saved. |
| Running the whole `lint:ci` chain before the shards | It adds 2.4 min to every green PR to save compute on about 1 PR in 45. |
| Moving mutation testing or any correctness gate to nightly | A nightly signal arrives after the merge. [ADR-456](456-test-rigor-architecture.md) rejects it. |
| dependency-cruiser | The existing seam lints already cover import boundaries. |
| Windows and macOS lanes on every PR | The merge queue exists to absorb that cost. `GSD_PR_LINUX_ONLY=true` stays, with the `full-matrix` label as the opt-in. |

## Consequences

- A PR with a workflow or lint defect fails in about a minute and starts no test shards.
- The merge-queue wall-clock target moves from a 34.6-min median to under 30 min. After item 5a the Ubuntu unit shards become the critical path, at 19–22 min.
- Compute per merged PR drops by about one full matrix once item 8 lands.
- The repo takes on two pinned third-party tools (actionlint, zizmor) and three scheduled jobs that must be kept healthy.
- Stryker results on PRs now depend on a cached file. The scheduled `--force` run is what catches drift.
- T0 becomes a single point of failure for every run. An outage of a pinned tool's download blocks all CI, so the tools are cached or vendored by checksum.
- The slow-file allowlist is new maintained data. It only shrinks.

## Open questions this ADR does not settle

None, and nothing is deferred. Every item above has an issue and can start now. Where a choice depends on a measurement, the item carries the rule that decides it: static-tier gating (item 3), macOS concurrency (item 5b), a fourth Ubuntu shard (item 6), selection enforcement (item 10), type-aware lint (item 11), coverage placement, queue group size and property-test budgets (item 12).

## Done when

- [ ] Items 1 through 24 are merged, or closed as rejected by their own decision rule with the evidence recorded below.
- [ ] Summed Linux test time is under 45 min and summed Windows conformance time is under 30 min, from the committed timing tables.
- [ ] No test file reads repo content to assert on it, and no unit-tier file spawns a process; both are held by ESLint rules with empty allowlists.
- [ ] Over 20 `merge_group` runs, the median wall-clock is under 30 min and no job is cancelled at its cap.
- [ ] Over 30 PR runs, no targeted-lane job exceeds 10 min.
- [ ] `static-fast` median is under 60 s and has zero findings on `next`.
- [ ] The scheduled refresh, leak-audit, ledger and Stryker `--force` jobs have each run green for 7 consecutive days.
- [ ] The required check is still named `Required tests`.

## Decision-rule outcomes

Each implementing PR adds a dated entry here: the item, the measurement, and the arm of the rule that applied.

### 2026-11-18 — Item 8, AC1: the merged commit is the tested commit

For the 14 most recent green `merge_group` runs of `test.yml`, the run's head SHA was compared with the merge commit of the same PR on `next` (`gh run list --event merge_group --status success`, `gh pr view <n> --json mergeCommit`, `gh api repos/open-gsd/gsd-core/git/commits/<sha> --jq .tree.sha`).

Result: 14 of 14 had the same commit SHA, and therefore the same tree. PRs sampled: 6305, 6309, 6311, 6307, 6308, 6306, 6304, 6290, 6183, 5871, 5639, 5502, 5408, 6094.

Arm applied: continue. Item 8 keys its skip on SHA equality with a green `merge_group` run.

### 2026-11-18 — Item 14: the entry point ships first, as an ambient swap

Item 14 is split in two.

- **Item 14 ([#6332](https://github.com/open-gsd/gsd-core/issues/6332)) delivers AC1, AC2 and AC4.** `runCli` runs the CLI's own `main` in-process. It does not thread a context object. It swaps `process.argv`, the working directory, the environment, the two output streams and `process.exit` for one call and restores them, and it resets the module-level caches that registered with `src/invocation-scope.cts`. That needed no change to any handler, so item 15 can start on it.
- **Item 14b ([#6354](https://github.com/open-gsd/gsd-core/issues/6354)) delivers AC3.** The process-context object, the `local/no-process-global-outside-context` ratchet, and a second ratchet, `local/no-unregistered-module-state`, over the 162 module-level state declarations a scan of `src/` finds.

Two consequences of the swap hold until item 14b lands: in-process calls run one at a time (concurrent calls queue), and a module-level cache that no module registered can carry from one call to the next. Item 15's parity suite is the check on the second.

### 2026-11-18 — Item 15: the helper is synchronous, so the CLI gets a synchronous path

`runGsdTools` is called synchronously at 4,658 sites in 239 test files, and none of them awaits it. `runCli` is asynchronous. Only 7 of the 98 top-level routers are declared `async`. Maintainer ruling: the dispatch chain returns a plain value for a synchronous command and a promise only for an asynchronous one; `runCliSync` serves the former; `runGsdTools` stays synchronous with no call-site change. The alternative, a codemod that makes all 239 files asynchronous, was not taken.

### 2026-11-19 — Item 15: three helpers, none of which spawns unasked; what it saved and what it did not

**The helper.** The first version of the in-process helper spawned a process whenever it could not serve a call. Running the whole suite found that this hides defects: a command refused after its work had started was run a second time in the child (`uat.complete-session` restored its file in the first run and reported nothing to restore in the second). The helper now has three explicit forms and no fallback between them:

| Helper | Runs | Refuses, naming the helper to use |
|---|---|---|
| `runGsdTools` | in the test process, synchronously | a command that finishes asynchronously; a `NODE_OPTIONS`-class variable in the per-call `env`; a working directory that does not exist |
| `await runGsdToolsAsync` | in the test process, any command | the last two of those |
| `runGsdToolsCaptured` (item 16) | in the test process, synchronously; returns `{ exitCode, stdout, stderr }` as written, where `runGsdTools` keeps stderr only for a failed command and trims stdout | the same three as `runGsdTools` |
| `runGsdToolsProcess` | a spawned `node gsd-tools.cjs` | nothing; for `*.process.test.cjs` files |

Sixteen test files that called asynchronous commands (`capability`, `review-lane`, `detect-custom-files`, `prompt-budget`, `classify-confidence`, `package-legitimacy`, `extract-messages`, `profile-sample`) moved to `runGsdToolsAsync`. Three tests that injected a failure by preloading a patch into a child with `NODE_OPTIONS=--require` now mock the function in the test process, which is what running in-process makes possible.

**Defects the in-process suite found in shipped code.** Each was invisible while every call had its own process:

- `extract-messages` and `profile-sample` dropped their router's promise, so their output bypassed `--pick` and `@file:` resolution (fixed in item 14, PR #6359).
- `uat.complete-session` awaited a capture of a synchronous commit and so was asynchronous for no reason.
- The learnings store directory and the GSD temp directory were computed once at module load from `os.homedir()` and `os.tmpdir()`.

**The measurement.** Whole-suite runs on the Linux bench (plex2), one run at a time, wall clock from launch to verdict:

| Head | `runGsdTools` | Wall clock | Tests |
|---|---|---|---|
| item 14 (`ae3010ffa4`) | spawns | 8 min 51 s | 61,549 |
| item 15, fallback-spawn version (`3a78d0e5a2`) | in-process, async commands spawned | 8 min 45 s | 61,670 |
| item 15, three helpers (`30898f1006`) | in-process, async commands in-process | 7 min 19 s | 61,673 |
| item 15, three helpers (`d2c23caf43`) | in-process, async commands in-process | 7 min 08 s | 61,675 |
| item 15, three helpers (`1101be3c0b`) | in-process, async commands in-process | 7 min 05 s | 61,675 |

Summed per-file time, first row against the last:

| | Files | Before | After | |
|---|---|---|---|---|
| Call `runGsdTools` | 238 | 1,988 s | 652 s | −67% |
| Reach `gsd-tools.cjs` by any route | 344 | 2,840 s | 1,368 s | −52% |
| All test files | 1,221 | 5,234 s | 3,408 s | −35% |

These are single runs per head on a shared bench, so they are an indication and not a measurement with a known error. One run in the series showed the files that never call the helper 38% slower and the next showed them 15% faster; that spread is the noise.

What the series does show: moving the synchronous calls in-process did not move the wall clock (rows one and two), and moving the asynchronous commands in-process as well took about a minute and a half off it. On Linux the wall clock is set by the install-class tests, which never call the helper (class E in `docs/research/data/2026-11-18-test-file-classification.tsv`) and are the slowest files in every run. **Item 17 (one install per runtime) is where the Linux wall clock is.** Item 15's larger effect was expected on Windows, where a process spawn costs several times more and the spawning files are 94% of the conformance tier. The merge queue measured it, and the expectation was wrong:

| Windows conformance lane (six shards, job time) | Sum | Slowest shard |
|---|---|---|
| item 14's merge-group run (`44470893686`) | 77 min 10 s | 17 min 37 s |
| item 15's merge-group run that merged it (`44552501419`) | 72 min 55 s | 15 min 34 s |

Single runs, and job time includes checkout, install and build. The difference is a few percent. The helper's spawns are not what makes the Windows lanes slow either; the installer tests are, on every platform.

**What the merge queue taught.** Item 15 was ejected from the queue four times before it merged. None of the four was a defect in the shipped code:

1. Its parity test canonicalised temp directories with `fs.realpathSync`, which keeps a Windows 8.3 short name; the CLI prints the long name.
2. The same test masked a run directory in two spellings of its path; four commands print a third (forward slashes on Windows). The mask now replaces the directory's name.
3. Another PR merged while it was queued and added a synchronous helper call to an asynchronous command, which the new helper refuses.
4. `next`'s own last Tests run was not green at that moment (a cancelled Windows shard), so the base-branch health gate refused every merge.

The first two are Windows-only mistakes in test code, and the Windows lanes run only in the queue, so each cost a full queue cycle to find. Rule 6 of "In-process CLI tests: the rules" in `TESTING-STANDARDS.md` and the mask's own test exist because of them. Nothing in this ADR would have caught them earlier, so item 26 is added ([#6369](https://github.com/open-gsd/gsd-core/issues/6369)): a PR runs the test files it adds or changes on Windows before it can be queued.

### 2026-11-18 — Item 25 added: the git probe is 90% of an in-process call

Profiling 100 in-process calls per case, with every subprocess call timed, on macOS:

| Command | Working directory | Per call | Git spawns | In git | CLI's own work |
|---|---|---|---|---|---|
| `generate-slug` | a linked worktree | 25.0 ms | 2 | 24.0 ms | 1.0 ms |
| `generate-slug` | temp dir, no git | 9.8 ms | 1 | 9.1 ms | 0.7 ms |
| `config-get` | temp dir, no git | 10.3 ms | 1 | 9.4 ms | 0.9 ms |
| `state json` | temp dir, no git | 9.9 ms | 1 | 9.0 ms | 0.9 ms |

A spawned call of the same command takes about 147 ms on the same machine. Item 15 removes the Node spawn; item 25 removes what is left.

### 2026-11-19 — Item 17: the saving is in not installing again

Item 17's first acceptance criterion named a mechanism: call `install()` in-process. Measurement before any code changed the mechanism and kept the goal.

**What was measured.** A commit that logged every installer call (process-seam spawns of `bin/install.js`, and in-process `install()`) ran once on the Linux bench.

| | |
|---|---|
| Installer calls in one run | 1,553 (1,181 spawned, 372 in-process), in 89 test files |
| Time in those calls | 1,568 s of 5,201 s summed file time |
| One call, median | 1.07 s spawned, 0.86 s in-process |
| Distinct configurations (runtime, scope, flags) | 187 |
| Time spent on a repeat of a configuration already installed in that run | 1,383 s |
| A load-only installer process (local) | 0.12 s of a 0.48 to 0.71 s install |
| A copy of an installed tree (local) | 0.11 s against 0.46 s for an install |

**Decision.**

1. An in-process install is still an install. It saves the process start, about a fifth. `bin/install.js` also reads its flags from `process.argv` when the module loads, so one process cannot run two installs with different flags without loading the module again. The in-process route is not taken.
2. The installed tree for a configuration is built once per run by a real spawned install, and every test file reads that tree. `installRuntimeFixture` already did this within one file; it now does it across the run, under the run's temp root. No process waits on another: a process that finds no tree builds one and publishes it with a hard link, and the loser of a race discards its own.
3. A test that changes its tree copies the shared one (`copyRuntimeFixture`). A copy is held equal to a fresh install by a test over every runtime family.
4. A shared tree is read-only, and that is checked: a test process that leaves one changed fails at exit, and a file that starts later and finds it changed fails before reading it. The check is a digest of paths, permission bits, modification times and sizes, not a rule in prose.
5. A shared tree holds the same thing whichever file built it: the helper completes the hooks build first (`ensureHooksDist`), since the installer installs no hooks, or only some, without it.
6. The store adds about 20 MB on disk per shared configuration to the run's temp root for the whole run (410 MB measured for the 19 families; a private copy or a tree that lost a build race is extra until its test or the run ends). The runner's between-chunk sweep spares it and the end-of-run removal takes it. Sharing all 187 configurations would hold about 4 GB, on benches whose temp filesystem has filled before (#4020), so a configuration is shared only when several files read it. The count of shared configurations is a number to watch as files are converted.

**The first conversions, measured.** Every `runMinimalInstall({ runtime, scope })` with no other option became `copyRuntimeFixture` in 36 test files, and two helpers that only read their trees took the shared ones. Two bench runs under different load (the untouched files took 1.51 times as long in the second) put the 38 affected files at 15.8% of summed file time before and 12.2% after: about 147 s at the first run's load. A copy still costs about a third of an install, and the file that happens to build a shared tree first pays for the build. Sharing and copying do not by themselves bring the install class under ten minutes.

**What it does not cover.** A test that puts files in place before installing, or that asserts on the installer's own run, still installs. Those are the upgrade and configuration-merge suites, and they are most of the 372 in-process calls (156 of them `codex` global, in nine files). Converting each remaining file is per-file work that follows this change, measured against the table above.

**Part 3, the sweep suites (#6413).** Two files repeated installs whose result another row already held. `fragment-single-edit-propagation.install.test.cjs` rows 1, 2, 3 and 18 each built an overlay of the same fragment edit and installed it into all 18 runtimes, then only read the emitted step or workflow: 72 installs for one answer. They now read one lazily built install (the shared edit carries both the ASCII and the unicode sentinel), which is read into memory and removed per runtime, so one tree is on disk at a time and a failed install is rethrown to every row. The negative control of `agent-fragments-emission.install.test.cjs` (an identity composer must leak a marker) ended after a full runtime-and-scope sweep although one leaking install proves it; it now stops at the first leak, and row 5 keeps the full sweep. Titles and assertions are unchanged. Still open under #6335: the in-process installs over pre-seeded state (`codex` global), flagged variants used by one file, and the converted sites that only read.

### 2026-11-19 — Item 18: a git fixture is a copy of a template

Measured locally before the change: `createFixture({ git: true })` took 66 ms, six `git` processes; a copy of the 28-file result took 5 ms. Twenty fixtures in one process went from about 1,320 ms to 189 ms including the one template build, and to 96 ms in a second process that found the templates already built.

**Decision.**

1. The four fixture shapes are each built once per run by the same six git commands, into the run-wide store item 17 added, and a fixture is `fs.cpSync` of the template with timestamps kept.
2. A copied repository has new inode numbers and change times, so git's plumbing reads every tracked file as possibly changed: `git diff-files --quiet` exits 1 on a clean copy. The template sets `core.trustctime = false` and `core.checkStat = minimal`, which limits git's comparison to modification time and size. A copy then reads as clean with no refresh, and an edited file still reads as modified. Both are tested.
3. The template is built under a fixed environment (no inherited `GIT_*`, no system config, an empty global config, an empty init template) so its content does not depend on the machine or on which test file built it. The first version kept the machine's init template; review pointed out that its `info/exclude` can ignore `.planning` (#5470), which the tests that isolate their git config had been guarding against by building their fixture after isolating.
4. A fixture needs no `git` on `PATH`: a test makes fixtures with `PATH` emptied.

**What it saves, measured.** A bench run that logged each fixture counted 1,478 git fixtures in 81 test files, so 8,868 `git` processes a run are gone. On Linux that is about 80 s of summed file time at 55 ms a fixture, which two runs on the same bench could not tell from noise (5,117 s before, 5,180 s after). The research note's "about 7,200 git spawn sites" counted call sites in the source, six for each fixture call, and most git calls in tests are not fixture builds. The Windows lanes pay more for each process, and what this saves there is not measured yet: it shows only in the merge queue's shard times.

**Not in this change.** Acceptance criterion 3 of item 18, the ESLint rule against building a fixture inside a test body, with its 3,939 sites. Copying made each of those builds cheap; whether the rule is still worth its churn is to be measured after this lands.

### 2026-11-19 — Item 16: the six suites were already in-process; what was left was spawn wrappers and the tier line

**What the measurement said.** A full run of `next` at `2bb91a8250` (after item 15; `gsd-test`, holodeck, linux-node24, 62,219 passed) put the six suites at 180.4 s of file time: state 56.7, phase 69.1, init 33.7, custom-phase-readers 10.3, roadmap 7.5, config 3.2. The 974 s in the issue was measured before item 15 made `runGsdTools` in-process, so acceptance criterion 4 (under 200 s) already held when item 16 started. The suites had few direct spawn sites (19 `runNode` or `runHook` calls) but they hid behind wrappers that many cases called: `recordSession` 61, `runTool` 30, `run` and `run2853` 47, `gsd` 18, `runSectionManifestCli` 16, `runPhaseComplete` 8. Each wrapper existed because `runGsdTools` keeps stderr only for a failed command, and these cases assert on a warning a successful command writes to stderr, or on stdout's exact bytes.

**Decision.**

1. `runGsdToolsCaptured(args, cwd, env)` returns `{ exitCode, stdout, stderr }` from the same in-process call as `runGsdTools`, with the same refusals. The spawn wrappers in the six suites call it. `GSD_TEST_CLI_MODE=process` runs it through the spawned CLI, so a suspected in-process difference can still be checked.
2. A case moves to a `.process.test.cjs` sibling only when its subject is a process or git: an `ExitError` becoming an exit code with a JSON error on stderr, a reader meeting a named pipe (a hang a timeout isolates), the commit a STATE.md was written against, and phase allocation across linked worktrees. Titles and assertions did not change; the multiset of titles across each file and its sibling is 2,394 before and after.
3. ESLint holds the six unit files to this: they cannot import `tests/helpers/process-seam.cjs` or call `runGsdToolsProcess`. The rule is a block of `no-restricted-syntax` in `eslint.config.mjs`. Git used only to build a repository a case needs stays allowed.
4. The fixture template of criterion 1 was not applied. `createFixture()` measures 0.22 ms and a git fixture 4 to 7 ms since item 18; a copy of a template cannot be cheaper than the build it replaces.

**Not in this change.** Criterion 2's "the only part in the Windows and macOS tiers": the conformance tier lists are chosen by content signals (`realpath`, case sensitivity, `process.platform`), which the unit files keep, so the OS lanes still run them until item 20 chooses tiers by filename. The cost of the 380 phase and state tests that take 100 to 1000 ms each in the container is not explained by a local measurement (a command is about 3 ms, with no fsync).

**What it saved, measured.** The same run on the branch (`gsd-test`, holodeck, linux-node24, 62,286 passed) puts the six files and their siblings at 95.5 s against 180.4 s: state 56.7 to 17.2 plus 5.0 for `state.process`, phase 69.1 to 44.9 plus 3.7, init 33.7 to 5.8, roadmap 7.5 to 5.9, custom-phase-readers 10.3 to 9.2 plus 0.6, config 3.2 unchanged. The six unit files alone take 86.2 s. The wrappers' processes were the saving; the fixtures were not.

### 2026-11-20 — Item 24: two comment rules, held by a baseline that can only shrink

Item 24 asks that an exemption directive name an issue and that a comment block stay at 15 lines, both at `error` with no allowlist. Measured on `next`: 1,114 exemption directives (`eslint-disable*`, `allow-test-rule:`, `allow-unbounded-subprocess:`) name no `#NNN`, and 2,673 comment blocks exceed 15 lines, in 1,166 files. Naming an issue on each of those sites would be inventing references, and moving each long block means reading each one; neither is one reviewable change.

**Decision.** `local/directive-names-issue` and `local/max-comment-block-lines` are live at `error` for every `.cjs`, `.js`, `.mjs` and `src/*.cts` file, held by `eslint-rules/comment-ratchet.baseline.json`: for each file, how many sites of each kind it already has. A file may carry up to its baseline and no more; a file with fewer sites than its entry is not an error (the first version failed it until the entry was lowered, and a PR that merged first and removed a site then ejected #6427 from the merge queue: a shared file cannot require every concurrent PR to regenerate it), so the entry is lowered by running the generator and an empty file is the end state the item names. `scripts/gen-comment-ratchet-baseline.cjs` writes the file from a lint of the whole tree with an empty baseline (`--check` reports an entry above its file's count). A directive is a comment that begins with one of the directive names; a prose mention is not one.

**What is not done here.** Converting the baselined sites (each file converted lowers its entry), removing `RULESET.TESTS.no-source-grep.exemption` from `CONTEXT.md` once item 19 has converted the files that use it, and the ADR-456 amendment. #6342 stays open for them.

**Limits of the item 24 rules.** ESLint applies a directive to the rule's own report, so a bare `eslint-disable` (all rules) and a directive that names `local/directive-names-issue` or `local/max-comment-block-lines` hide their own finding and are not counted by the baseline generator; a test pins the first. The portability static check (item 19) bans blanket and protected-rule disables in tests, `src` and the build files; adding the two rule ids to its `PROTECTED_RULES` follows once that check is on `next`. The baseline is count-only per file: it forgives the first N sites by position, so swapping an old bare directive for a new one passes. The three tsc-emitted files that carried baseline entries are now in the ESLint ignores, so the baseline does not depend on whether the build ran.

### 2026-11-19 — Item 19: the static check runner, and the first check moved into it

`scripts/run-static-checks.cjs` loads every module in `scripts/static-checks/` (each exports `{ name, run({ root }) }` returning findings), runs them all in one process and prints every finding; it exits 1 if any check reports one, and a check that throws is a finding of its own, so a broken check cannot pass silently. It is the last step of `npm run lint:ci` and runs alone as `npm run lint:static` (#6414).

The first check is the ADR-1703 disable-ban. As a test it parsed every test, `src` and build file with espree and took 76 s of Linux test time (`tests/test-timings.json`). As a check it parses only files whose text holds an `eslint-disable` keyword, since a directive is a comment that spells it: 1.4 s on the whole tree locally. A file that holds the keyword and does not parse still fails the run (fail closed). `tests/portability-rule-disable-ban.test.cjs` now holds the detection cases against temporary trees, each with a seeded violation, and no longer reads the repository; `tests/run-static-checks.test.cjs` covers the runner with stub checks.

**Part 2: `fold-helper-shadowing` (#6434).** The 23 s test that parsed every file under `tests/` is `scripts/static-checks/fold-helper-shadowing.cjs`, with its three rows as findings (the reported subject has no shadow; the shadowed set equals the recorded baseline exactly, so a stale entry fails too; every `extractShellBlocks` splits on `/\r?\n/`) and the same minimum corpus size. The corpus scan takes about 3 s with the runner's other check. `tests/fold-helper-shadowing.test.cjs` keeps detection cases on temporary trees: a seeded shadow, a stale baseline entry, a corpus below the minimum, an unparseable file, and each shape of a non-CRLF-safe split.

**What the measurement says about the rest of class A.** `emitted-provenance` (26 s) is not a repo-content check: 29 s is one test, `totality`, whose input is the 19 installed trees (16 s to build them through the run's shared install store, 16 ms to check them), so converting it would move the install cost and not remove it; it belongs with item 17. The other 186 class-A files sum to about 4 s of Linux time, so the time criterion is met by the two conversions above; what remains of "no class-A test file remains" is a long tail, which the owner chose to convert in batches (2026-11-20).

**Part 3: the text-contracts check (#6337, batch 1).** Most of the long tail asserts on the text of command and workflow markdown and docs, each in its own file with its own `read` helper. `scripts/static-checks/text-contracts.cjs` is one check that loads the contracts in `scripts/static-checks/text-contracts/`; a contract is a module that states, through a small context, what a file must say (`doc.has`), must not say (`doc.lacks`), the body of a `<step>` (`doc.step`) and an ordering (`doc.before`). A missing, empty, symlinked or out-of-tree file, a missing marker, a contract that throws, is asynchronous or makes no assertion, an unknown `only` id, and fewer contracts than the pinned count are findings, so nothing passes by absence. Batch 1 converts `tests/adr-15-progress-converge.test.cjs` and `tests/autonomous-converge.test.cjs` (23 cases, both `allow-test-rule` product-text exemptions gone). Their one process case, `gsd-tools review-lane flags` yielding the flags the workflows used to hand-list, stays a test in `tests/review-lane-flags-roster.test.cjs`. `tests/text-contracts.test.cjs` covers the engine on temporary trees and runs each shipped contract against a copy of its files with one contracted phrase removed, to show it fails. The docs-guard registry loses the two entries (the contracts run on every PR in `lint:ci`, not only on docs changes) and the `allow-test-rule` allowlist loses the autonomous-converge entry.

**Part 4: the four `autonomous-*` files (#6337, batch 2, #6460).** `tests/autonomous-allowed-tools.test.cjs`, `autonomous-decomposition`, `autonomous-interactive` and `autonomous-to-flag` become contracts of the same check (their `allow-test-rule` product-text exemptions, allowlist entries and timing entries go). The engine gains three assertions for them: `doc.slice(from, [to…])` ends at the earliest of several closing markers, searched after the opening marker (the `INTERACTIVE` branch of the workflow), `doc.shorterThan(n)` states an exclusive size ceiling (the 40K-character limit on `autonomous.md`), and `doc.frontmatter()` returns the closed frontmatter block through `locateFrontmatterFence`, the one owner of the fence rules (`allowed-tools` of the command). Four assertions were tightened to what the file says: a `--to` grep that must carry the literal `\-\-to\s+[0-9]`, the startup banner line and the already-completed exit message themselves (the success-criteria checklist also names both, so a whole-file phrase would pass with either deleted), and `argument-hint` carrying the flag on its own line; and a missing `<step name="iterate">` marker, which the original test read as "the whole file" (`substring(-1)`), is now a finding. `autonomous.md` is 40,954 characters against the 40,960 ceiling, so the next line added to it fails the contract by design.

**Part 5: five more class-A files (#6337, batch 3, #6478).** `tests/chain-flag-plan-phase.test.cjs` (with the bug-2388 test folded into it), `discuss-checkpoint`, `agent-skills-awareness`, `scan-command` and `analyze-dependencies` become contracts (their product-text exemptions, allowlist entries, timing entries and the `analyze-dependencies` docs-guard registry entry go; `docs/COMMANDS.md` stays covered through the `text-contracts` entry). The engine gains `ctx.docs([rel…])`, one document that is the union of several files and fails as a whole when any of them is missing (a workflow split across a main file and its step files or modes), and `ctx.exists(rel, why)` and `ctx.absent(rel, why)` for file presence, both confined to the repository and counted as assertions. Path confinement now also resolves the parent directory, so a symlinked directory in the middle of a path cannot redirect a read out of the tree (the earlier check looked only at the last component). `analyze-dependencies` is the first contract whose subject is a file that must not exist (the standalone command removed in #2790). The assertions are carried over without tightening, except that a missing optional-looking file is now a finding: the original `analyze-dependencies` test returned silently when `docs/COMMANDS.md` was absent.

**Part 6: five more class-A files (#6337, batch 4, #6481).** `tests/cline-support.test.cjs` (`.clinerules`), `inventory-headings-countfree` (`docs/INVENTORY.md` carries no `(N shipped)` heading), `policy-release-no-npm-self-upgrade` (`release.yml` never self-upgrades npm at runtime, #318), `phase6-capability-docs` (the Capability developer manual and its index link) and `playwright-ui-verify` (the Playwright UI verification step, `ui-review.md` and the ui-auditor agent) become contracts; the engine needs nothing new. The exemptions, allowlist entries, timing entries, two docs-guard registry entries and the `ci-test-scope` entry go, and `tests/text-contracts.test.cjs` takes the `ci-test-scope` workflow-contract slot (a `release.yml` edit reruns its self-upgrade mutation cases) and the docs-guard entries for the three docs it now copies. Two assertions are not carried over verbatim. The `release.yml` pattern is matched against whole-file text with spaces and tabs between the words, which is what the original's per-line matching meant, and its unbounded `[^\r\n]*` is bounded at 2000 characters (the `no-unbounded-quantifier` rule forbids the original; a 300-character bound let a long-flag line past, which the security pass caught, so tests pin 1999, 2000 and 2001); the count-heading pattern bounds its title at 300 characters and its digits at six, and uses spaces and tabs where the original used `\s` (so a no-break space or form feed between `##` and the title, or inside `(N shipped)`, no longer matches); the test file states that a longer heading is outside the bound (the longest `##` line in INVENTORY is 23 characters). The `phase6-capability-docs` regexes whose text is literal (`fragment\.path`, `plan:pre`, `research` and the others) became string assertions, which differ from the original only where its unescaped `.` matched any character. The original `playwright-ui-verify` cases accepted `playwright` or an unrelated phrase (the test's own comment calls the step-file case vacuous); the contracts require `playwright` (case-insensitive), which all three real files carry. The regex self-test of the policy test (sample lines it must and must not match) becomes mutation cases: three self-upgrade spellings added to a copy of `release.yml` fail, four allowed lines pass.

**Part 7: five more class-A files (#6337, batch 5, #6536).** `tests/release-coverage-scope.test.cjs` (the sharded unit-coverage scripts, the `AUDIT_BASELINE_REF` pin and the shard job-cap floor in `release.yml`), `gsd-researcher-flow-diagram` (the phase researcher's data-flow diagram directive and the research template), `import-command` (the `/gsd-import` command and workflow), `gates-taxonomy` (`gates.md` and the files that reference it) and `ios-scaffold-safety` (the iOS scaffold guidance) become contracts. The engine gains `doc.satisfies(fn, why)` for what no pattern states (a count of lines, a loop over sections, a number read out of a job block); a predicate that returns anything but `true` is a finding. The exemptions, allowlist entries, timing entries and the `ci-test-scope` entry go; `tests/text-contracts.test.cjs` already holds the `ci-test-scope` workflow-contract slot. Four assertions are not carried over verbatim, and three patterns are bounded where the test's were not (`no-unbounded-quantifier`): the job-cap digits at six, the whitespace around it at 50 characters, and the text between `argument-hint:` and `--from` at 500. `release-coverage-scope` strips an optional leading `- ` as well as `run: `, so a `- run: npm run test:coverage` step is counted (the test missed that spelling). `import-command` takes `[ \t]` where the test took `\s`, requires the `description` field to have a value, and asks for the word `traversal` the file carries where the test also accepted `validatePath` or any `..`. `ios-scaffold-safety` names the phrase the real file carries (`NEVER use `Package.swift``, `xcodegen generate`, `SwiftUI API availability`, `ios-scaffold.md`) where the test accepted any of several words, one of which (`never`, `iOS 16`, `ios-scaffold`) any unrelated line could satisfy. `gates-taxonomy` keeps the test's reach: `stall detection` may appear anywhere in `gates.md`, not only under the Revision Gate, and each `required_reading` block is the text between the tag on its own line and its closing tag, as the test's pattern was.

**Part 8: five more class-A files (#6337, batch 6, #6538).** `tests/audit-milestone-filename-guard.test.cjs` (the audit report's writer and readers agree on one filename, #3796), `branch-no-track-guard` (every `git checkout -b` from a remote-tracking ref in any workflow passes `--no-track`, #2498), `execute-plan-interrupted-agent-guard` (the interrupted-agent probe precedes the stale-id clear, #3795), `handoff-next-step` (the new-project and new-milestone hand-off names discuss, plan, execute in order in each runtime's form, #5723) and `transition-verification-gate` (unresolved verification blocks the phase gate, #1522) become contracts. The engine gains `ctx.list(dir, suffix, why)`, the sorted repo-relative files under a directory (a symlink is not followed; a directory that is missing or holds none is a finding, so a scan over nothing cannot pass); `branch-no-track-guard` reads every workflow through it. The test-file-count allowlist entry and the timing entries go; these tests had no `ci-test-scope`, docs-guard or `allow-test-rule` allowlist entry. Deviations from the tests: patterns that used `\s+` or `[^`]+` between words on one line are bounded, and a line past a bound is not matched (tests pin the limit - 1, the limit and the limit + 1): `branch-no-track-guard` takes 200 spaces between `git` and `checkout` and 200 characters of variable name before `BRANCH`; `handoff-next-step` takes 500 characters from `execute-phase` to its closing backtick; `transition-verification-gate` takes 20 whitespace characters inside `canonical verification status`. `branch-no-track-guard` also fails when no workflow file exists where the test passed over an empty directory, and `ctx.list` refuses a directory that is itself a symlink (it would read outside the tree).

Still open under #6337: the remaining class-A files (batches), the 29 duplicated real-tree cases, and the ADR-452 amendment.
