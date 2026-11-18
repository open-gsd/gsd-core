# ADR-6315: CI redesign — a fast static tier, a sharded critical path, one full matrix per merge, and feedback loops that keep it fast

- **Status:** Proposed — design lock for epic [#6315](https://github.com/open-gsd/gsd-core/issues/6315). It is ratified to `Accepted` when every item in *Phases* has shipped and the *Done when* list at the end holds.
- **Date:** 2026-11-18
- **Issue:** [#6315](https://github.com/open-gsd/gsd-core/issues/6315)
- **Supersedes:** nothing.
- **Relationship to prior work:** this ADR builds on four accepted decisions and changes none of them. [ADR-452](452-eslint-lint-harness.md) makes ESLint the lint enforcement point. [ADR-456](456-test-rigor-architecture.md) rejects retries and keeps mutation testing as a PR gate. [ADR-4593](4593-macos-conformance-tier-architecture.md) and [ADR-4641](4641-windows-selector-consolidation.md) define the macOS and Windows conformance tiers. One statement in ADR-456 (`--since origin/next`) is checked by item 2 and amended there if it is wrong.
- **Research input:** [`docs/research/ci-redesign-options-survey.md`](../research/ci-redesign-options-survey.md). Every figure in this ADR comes from that memo, which records the command behind each one. Section numbers below written as "memo §N" point into it.

## How to use this ADR

This file is the contract for the agents that implement epic #6315.

- Each numbered item in *Phases* is **one child issue and one PR**. Do not combine items.
- **No item waits on another.** Every item can start today. Where one item's result feeds another, the item says what to use until that result exists. The one exception is named in *Ordering*.
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

### Five problems

1. **The critical path is the unsharded macOS lane.** It sets the merge-queue wall-clock and has been cancelled at its cap twice in the sample.
2. **Two defects waste the most compute per incident.**
   - The targeted PR lane can fall back to the whole suite in one process. Runs 44258418022 and 44327517996 logged `run-tests: suite="all" files=1192` and were cancelled at the 32-min cap. [#6308](https://github.com/open-gsd/gsd-core/pull/6308) fixed the one path that triggered it, not the fallback.
   - `mutation.yml:165` passes `--incremental`, but no step restores or saves the incremental file, so every Stryker shard runs cold. The `state-document` shard took 54.0 and 81.8 min.
3. **Static checks do not gate the matrix.** `lint-tests` and `test` both need only `preflight` (`test.yml:191-192`, `:255-257`). A PR with a static defect still runs all shards. No workflow linter runs at all, although workflow defects are the ones that waste whole runs.
4. **The full matrix runs twice per merge:** on the `merge_group` commit and again on the `push` to `next`.
5. **Nothing keeps the suite fast.** The timing tables that balance the shards are refreshed by hand, and there is no darwin table. No gate stops a new slow test file. `--test-force-exit` is on by default, so leaked handles are invisible. No ledger names the files that fail intermittently.

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

### 2. Invariants

These hold for every item in the epic.

- **I1 — The required check name does not change.** `Required tests` stays the single aggregate check. A new gating job is added to its `needs` list. No job that branch protection names is renamed.
- **I2 — The merge queue runs the full suite.** Test selection of any kind applies to PR runs only. `merge_group` never selects.
- **I3 — No retries and no quarantine.** No `--test-rerun-failures`, no retry step, no quarantine lane. [ADR-456](456-test-rigor-architecture.md) rejects retry loops and requires a bad test to be fixed or deleted.
- **I4 — Wall-clock bounds are backstops, not fixes.** Job-level `timeout-minutes` and the 600 s chunk watchdog stay. Raising one is not an acceptable response to a slow or hung lane. The response is to remove the cause. The policy against wall-clock timeouts on git and npm subprocesses is unchanged.
- **I5 — Free GitHub-hosted standard runners only.** No larger runners and no self-hosted runners (owner ruling, 2026-11-18).
- **I6 — No `paths:` filter on a workflow that carries a required check.** Scope is decided at job level by `scripts/ci-test-scope.cjs`.
- **I7 — Correctness gates stay on the PR or in the queue.** T3 holds diagnostics and refresh jobs only. Mutation testing stays a PR gate.
- **I8 — Checks on code shape are ESLint rules.** A new one ships at `warn`, then moves to `error` after cleanup, per [ADR-452](452-eslint-lint-harness.md). Workflow YAML is checked by actionlint and zizmor because it is not JavaScript.
- **I9 — First-run findings are fixed in the PR that adds the check.** A new linter does not land with a backlog. A false positive is suppressed in the tool's config with a recorded reason.
- **I10 — Every new third-party binary or action is pinned** to a version and a checksum or commit SHA.

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
- AC2: one rule per uncovered shape that has a recorded occurrence. Each ships at `warn` with tests, then moves to `error` (I8).
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

Every item starts now. The phases are a priority order, not a queue: when agents are scarce, lower phase numbers go first.

| Item | Issue | Item | Issue |
|---|---|---|---|
| 1 | [#6317](https://github.com/open-gsd/gsd-core/issues/6317) | 7 | [#5807](https://github.com/open-gsd/gsd-core/issues/5807) |
| 2 | [#6318](https://github.com/open-gsd/gsd-core/issues/6318) | 8 | [#6323](https://github.com/open-gsd/gsd-core/issues/6323) |
| 3 | [#6319](https://github.com/open-gsd/gsd-core/issues/6319) | 9 | [#6324](https://github.com/open-gsd/gsd-core/issues/6324) |
| 4 | [#6320](https://github.com/open-gsd/gsd-core/issues/6320) | 10 | [#6325](https://github.com/open-gsd/gsd-core/issues/6325) |
| 5a | PR [#5053](https://github.com/open-gsd/gsd-core/pull/5053) | 11 | [#6326](https://github.com/open-gsd/gsd-core/issues/6326) |
| 5b | [#6321](https://github.com/open-gsd/gsd-core/issues/6321) | 12 | [#6327](https://github.com/open-gsd/gsd-core/issues/6327) |
| 6 | [#6322](https://github.com/open-gsd/gsd-core/issues/6322) | 13 | [#6328](https://github.com/open-gsd/gsd-core/issues/6328) |

- **One real wait:** the macOS concurrency measurement in item 5b needs the sharded lane from item 5a.
- **One blocker to clear first:** item 5a is an open contributor PR that needs a maintainer review. Reviewing it is the first action of the epic.
- **Shared file:** PR #5053 and items 3, 8, 10 and 13 all edit `.github/workflows/test.yml`. They do not wait for each other. Each one rebases on `next` before it is enqueued, and the merge queue serialises them. Items 5b and 7 both edit `scripts/run-tests.cjs` and follow the same rule.
- **Results that feed other items:** item 9's first report sharpens item 11, and item 6's refreshed tables sharpen item 4. Neither is a precondition.

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

None block the work. Each has a decision rule in an item above: static-tier gating (item 3), macOS concurrency (item 5b), a fourth Ubuntu shard (item 6), selection enforcement (item 10), type-aware lint (item 11), coverage placement, queue group size and property-test budgets (item 12).

## Done when

- [ ] Items 1 through 13 are merged, or closed as rejected by their own decision rule with the evidence recorded below.
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
