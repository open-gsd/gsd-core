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
- Before starting an item, read its *Depends on* line. Do not start an item whose dependency has not merged.
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

**Item 4 — Slow-file budget ratchet.** Depends on: item 6.
Files: a new script under `scripts/`, an allowlist data file under `tests/`, `ci-timeout-report.yml` or the refresh workflow from item 6.
A budget needs measured durations, so it reads the CI duration artifacts and runs after the tests, on the schedule.

- AC1: the script fails when a test file that is not on the allowlist exceeds the ceiling, and when an allowlisted file exceeds its recorded cost by more than a stated slack.
- AC2: the allowlist is today's offenders at their current cost, taken from `tests/test-timings.json`. A new entry needs an issue link.
- AC3: the ceiling and the slack are constants in one place, each with a comment giving the measurement behind it.
- AC4: child issues exist for converting the ten slowest files to in-process invocation. Each conversion PR lowers that file's allowlist ceiling in the same change.

#### Phase 2 — critical path and compute

**Item 5 — Shard macOS conformance three ways.** Depends on: [#5053](https://github.com/open-gsd/gsd-core/issues/5053) merged. Closes [#6148](https://github.com/open-gsd/gsd-core/issues/6148).
Files: `.github/workflows/test.yml` (`test-conformance` matrix), `scripts/run-tests.cjs`, a new `tests/test-timings.darwin.json`.

- AC1: the macOS rows of `test-conformance` carry `shard: 1/3`, `2/3`, `3/3`, and the packer reads a darwin timing table.
- AC2: over 20 `merge_group` runs after the change, the slowest macOS shard is under 25 min and the median run wall-clock is under 30 min.
- AC3: `Required tests` still accepts `success` or `skipped` for the lane.
- AC4: **decision rule.** Run the same shard at `--test-concurrency` 2, 3 and 4 on the 3-vCPU macOS runner, five runs each. Adopt the value with the lowest median if it beats the current value by more than 10%. Otherwise keep the current value.

**Item 6 — Scheduled timing-table refresh.** Depends on: nothing.
Files: a new scheduled workflow (or a job in `ci-timeout-report.yml`), `scripts/gen-test-timings.cjs`.

- AC1: the job downloads the duration artifacts of the last three green `push` runs, regenerates every per-platform timing table, and opens a data-only PR the same way `ci-timeout-report.yml` does for the history log.
- AC2: the data-only PR is classified so that it skips the test matrix (the class of fix made in #6308), and item 1's guard covers it.
- AC3: 14 days after the first refresh merges, Ubuntu shard 2/3 has zero runs at ≥90% of its cap over 40 `merge_group` and `push` runs.
- AC4: **decision rule.** If AC3 fails after two refreshes, add a fourth Ubuntu shard. Do not raise the cap (I4).

**Item 7 — Windows packer accounts for long single files.** Depends on: item 5 (ordering only). Closes [#5807](https://github.com/open-gsd/gsd-core/issues/5807) and [#5162](https://github.com/open-gsd/gsd-core/issues/5162).
Files: `scripts/run-tests.cjs`.

- AC: the shard-balance check in `ci-timeout-report.yml` reports a gap under 2.0 min for two consecutive daily runs.

**Item 8 — One full matrix per merge.** Depends on: items 5, 6 and 7.
Files: `.github/workflows/test.yml`, `scripts/ci-next-health.cjs`, the `publish-emitted-baseline` job.
Owner ruling (2026-11-18): the post-merge `push` matrix may be skipped only after tree identity is proven.

- AC1 (precondition, its own PR or issue comment): for ten sampled squash merges, command output shows whether `git rev-parse <next-sha>^{tree}` equals the tree of the matching `merge_group` head commit. **Decision rule:** if all ten match, continue. If any differ, stop, record the result in this ADR, and close the item as rejected.
- AC2: on `push` to `next`, a first job compares the pushed tree with the tree of the latest green `merge_group` run. The matrix is skipped only on an exact match. Any other case runs the full matrix as today.
- AC3: `scripts/ci-next-health.cjs` reads the `merge_group` conclusion when the push run skipped, and the push run otherwise. A unit test covers both arms.
- AC4: `publish-emitted-baseline` still produces the baseline after every merge.
- AC5: on merges where the trees match, runner-minutes per merge drop from about 187 to under 25.

#### Phase 3 — diagnostics, selection and deeper static checks

**Item 9 — Leak audit and failure ledger (T3).** Depends on: nothing.
Files: a new scheduled workflow, a shared test hook under `tests/helpers/`, `scripts/run-tests.cjs` (a flag that turns `--test-force-exit` off).

- AC1: a scheduled run executes the unit suite without `--test-force-exit` and records `process.getActiveResourcesInfo()` after each file. The artifact lists every file that leaves resources active. The run is report-only.
- AC2: a ledger job counts failures per test file over the last 50 `next` runs and publishes the top 20.
- AC3: every ledger and leak entry becomes an issue, or is shown to be an infrastructure failure. None is left as a note (I3).

**Item 10 — Affected-test selection in shadow mode.** Depends on: items 1 and 6.
Files: `.github/workflows/test.yml`, `scripts/affected-tests-lib.cjs`, a report script.
Much of this suite reads repo files instead of importing modules, so an import graph selects too few tests. Earlier selection work escaped regressions (see [ADR-4641](4641-windows-selector-consolidation.md)). Selection is therefore measured before it is trusted.

- AC1: on every PR, a job that is not required computes the selection and uploads the list. The full lane still runs and still gates.
- AC2: a daily report publishes the count of failing tests that were outside the selected set.
- AC3: **decision rule.** Enforcement is proposed, in a new issue, only after 100 consecutive PR runs with that count at zero. Until then the PR lane runs the full Ubuntu shards. I2 holds either way.

**Item 11 — Leak-shape lint rules.** Depends on: item 9 (its ledger says which shapes matter).
Files: `eslint-rules/`, `eslint.config.mjs`.

- AC1: first read the existing rules (`no-unbounded-spawn`, `require-full-tmpdir-triad` and the rest) and list which of these shapes they already cover: an un-awaited promise in a test body, an async spawn whose stdin is never closed, a timer or server with no teardown, a fixed port, a write outside the tmp directory, real network use.
- AC2: one rule per uncovered shape that the leak audit actually found. Each ships at `warn` with tests, then moves to `error` (I8).
- AC3: **decision rule.** Measure `npm run lint` with type-aware `no-floating-promises` over `tests/**/*.cjs`. Enable it only if it adds under 60 s and `static-fast` stays inside its target.

**Item 12 — Three measurements with a rule each.** Depends on: item 5.

- **Coverage on PR shards.** A/B the same shard with and without c8, five runs each. If c8 costs more than 15% of the shard's test time, move coverage to `merge_group` and `push` runs and keep the coverage gate there. Otherwise change nothing.
- **Queue minimum group size.** `.github/rulesets/next-queue.json` sets `min_entries_to_merge: 2` with a 15-min wait. Measure the time from enqueue to the start of the `merge_group` run over 30 merges. If the median wait for a lone PR is over 5 min, set the minimum to 1. The ruleset change is applied by the owner.
- **Property-test run counts.** Sum the timing-table cost of `*.property.test.cjs` files. If it is over 5% of the suite, open an issue for a CI-wide `numRuns` budget. Otherwise change nothing.

#### Phase 4 — maintainability

**Item 13 — One composite action for the repeated setup steps.** Depends on: every earlier item that edits `test.yml`.
Files: `.github/actions/`, `.github/workflows/test.yml`, `tests/ci-*.test.cjs`.

- AC: checkout, runner guard, rebase check, Node setup and install are one `uses: ./.github/actions/...` step in `test`, `test-inert`, `test-conformance` and `qa-loop-walk`. The workflow-contract tests are updated and pass.

### 4. Ordering

```text
Phase 0:  1    2            (independent)
Phase 1:  3                 (independent)      4 needs 6
Phase 2:  6                 (independent)
          5 needs #5053     7 after 5          8 needs 5, 6, 7 and its own AC1
Phase 3:  9                 (independent)      10 needs 1, 6
          11 needs 9        12 needs 5
Phase 4:  13 last
```

Items 1, 2, 3, 6 and 9 can start at once. Items 3, 5, 8 and 13 all edit `test.yml`, so they merge one at a time, in that order.

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
- The merge-queue wall-clock target moves from a 34.6-min median to under 30 min. After item 5 the Windows shards become the critical path, at 25–28 min.
- Compute per merged PR drops by about one full matrix once item 8 lands.
- The repo takes on two pinned third-party tools (actionlint, zizmor) and three scheduled jobs that must be kept healthy.
- Stryker results on PRs now depend on a cached file. The scheduled `--force` run is what catches drift.
- T0 becomes a single point of failure for every run. An outage of a pinned tool's download blocks all CI, so the tools are cached or vendored by checksum.
- The slow-file allowlist is new maintained data. It only shrinks.

## Open questions this ADR does not settle

None block the work. Each has a decision rule in an item above: static-tier gating (item 3), macOS concurrency (item 5), a fourth Ubuntu shard (item 6), tree identity (item 8), selection enforcement (item 10), type-aware lint (item 11), coverage placement, queue group size and property-test budgets (item 12).

## Done when

- [ ] Items 1 through 13 are merged, or closed as rejected by their own decision rule with the evidence recorded below.
- [ ] Over 20 `merge_group` runs, the median wall-clock is under 30 min and no job is cancelled at its cap.
- [ ] Over 30 PR runs, no targeted-lane job exceeds 10 min.
- [ ] `static-fast` median is under 60 s and has zero findings on `next`.
- [ ] The scheduled refresh, leak-audit, ledger and Stryker `--force` jobs have each run green for 7 consecutive days.
- [ ] The required check is still named `Required tests`.

## Decision-rule outcomes

*(Empty. Each implementing PR adds a dated entry here: the item, the measurement, and the arm of the rule that applied.)*
