# CI redesign — current state, options survey and ranked plan

**Date:** 2026-11-18
**Trigger:** Owner request to redesign the whole CI process: the suite is heavy, slow, cumbersome and prone to timeouts; cheap static gates should catch problems before the expensive matrix.
**Status:** Research input for one GitHub issue and one ADR. No code, workflow, ruleset or setting was changed by this memo. No tests were run to produce it.
**Source labels:** **[M]** measured in this repo (command stated in section 1.9), **[R]** repo file read (`path:line`), **[D]** primary external source (URL), **[I]** inference by the author, **UNVERIFIED** could not be confirmed from a primary source.

---

## 0. Summary

1. **The critical path is not the Linux suite.** On `merge_group` (the run that actually gates merges) the median wall-clock is 34.6 min (n=41 green runs); the longest job is the unsharded macOS conformance lane at a median 34.1 min, then Windows conformance shards at 25-28 min, then Ubuntu unit shards at 19-22 min [M]. Sharding macOS (already approved, #6148, blocked on #5053) is the single largest wall-clock lever.
2. **Static gates do not gate the matrix today.** `lint-tests` (median 2.4 min) runs in parallel with the test lanes, not before them (`.github/workflows/test.yml:191-193` vs `:255-258`). Over the sampled PR runs a lint failure was rare (1 of 45), so the measured saving from reordering is small; the case for a static tier rests on catching hang and workflow defects earlier, not on saved minutes.
3. **Two measured defects burn the most compute per incident:** (a) the "targeted" PR lane fell back to the entire suite (`suite="all" files=1192`) in a single process and ran to its 32-min cap twice in the sample (fixed for one path by #6308, class not closed); (b) `mutation.yml` passes `--incremental` but has no cache step for the incremental file, and one Stryker shard (`state-document`) took 54.0 and 81.8 min in the sample [M][R].
4. **Most of the "usual" options are already built here:** timing-balanced LPT shards (`scripts/run-tests.cjs`), a changed-path scope classifier (`scripts/ci-test-scope.cjs`), an import-graph affected-test selector (`scripts/affected-tests-lib.cjs`), per-file duration artifacts, a daily timeout trend report, a merge queue, a base-branch health gate, and about 30 local ESLint rules. The gaps are wiring and feedback loops, not missing machinery.
5. **Recommended order:** fix the two defects, add a workflow static tier (actionlint, zizmor), shard macOS, dedupe the post-merge `push` run, then run affected-test selection in shadow mode before anyone trusts it. Reject remote-cache build systems, retries, quarantine lanes, `--test-isolation=none` and Dev Drive on standard runners.

---

## 1. Current state (ground truth)

### 1.1 Workflows

All workflows under `.github/workflows/` (37 files [R], plus one dynamic and one experiment file `experiment-5029-windows-shards.yml` that exists on the default branch per `gh api .../actions/workflows`). The CI-relevant ones:

| Workflow | Triggers | Jobs / matrix | Timeouts | Concurrency | Notes |
|---|---|---|---|---|---|
| `test.yml` ("Tests") | `push` to `next`, `main`, `release/**`, `hotfix/**`; `pull_request` to `next`/`main`; `merge_group`; `workflow_dispatch` (`:3-24`) | `preflight` (reusable `pr-mergeable-preflight.yml`), `next-health`, `changes`, `lint-tests`, `plugin-validate`, `test` (ubuntu: 1 targeted + 3 full shards, `:339-385`), `test-inert`, `test-conformance` (windows x3 shards + macos x1, `:696-712`), `coverage-gate`, `qa-loop-walk`, `required-tests`, `publish-emitted-baseline` | `next-health` 2, `changes` 2, `lint-tests` 5, `plugin-validate` 10, `test` 32 (`:293`), `test-inert` 15, `test-conformance` 45 (`:688`), `coverage-gate` 15, `qa-loop-walk` 15, `required-tests` 1 | group `${{ github.workflow }}-${{ github.head_ref \|\| github.run_id }}`; cancel only on non-PR events or a `synchronize` (`:26-33`) | Windows/macOS lane skipped on PRs unless label `full-matrix` while repo variable `GSD_PR_LINUX_ONLY=true` (`:673-678`; variable value read with `gh api .../actions/variables`) [M] |
| `mutation.yml` | PR with `paths:` filter (`:10-26`), `workflow_dispatch` | `detect` -> `mutate` (one shard per changed module) -> `mutation-gate` | per-shard `matrix.timeoutMinutes`, default 15 (`:111-115`) | cancel-in-progress | `npx stryker run --incremental --mutate ...` (`:165`); no `actions/cache` step in the file (grep of `cache` returns only `cache: npm` at `:133`) [R] |
| `install-smoke.yml` | PR with `paths:`, `push`, `workflow_call`, dispatch (`:16-45`) | `smoke` (ubuntu, macos), `smoke-unpacked` | 12, 10 | cancel-in-progress | |
| `security-scan.yml` | PR with `paths:` (`:4-10`) | `security` | 30 | cancel-in-progress | |
| `ci-timeout-report.yml` | cron `15 7 * * *`, dispatch | `report` (writes `tests/ci-timeout-budget-history.jsonl`, shard-balance check) | 10 | no cancel | #4036, #5101 |
| `fix-next-rerun.yml` | `pull_request_target` (label events) | re-runs only "Base branch health" | 90 | cancel | #6076 |
| `pr-mergeable-preflight.yml` | `workflow_call` | `mergeability` | 3 | none by design (`:62-63`) | A conflicted PR provisions no compute |
| `changeset-required.yml`, `docs-required.yml`, `reviewed-or-maintainer.yml`, `self-test-report.yml` | `pull_request`/`pull_request_target` + `merge_group` | one light job each | 1-15 | cancel | `merge_group` wired for queue (#5600) |
| `release.yml` (1075 lines), `auto-backmerge.yml`, others | release and repo automation | not CI-critical for PR latency | | | out of scope except where noted |

**Required checks.** Classic protection on `next` requires: `check-branch`, `changeset-lint`, `docs-lint`, `validate-target`, `Issue link required`, `Pull request template format`, `Required tests`, with `strict: true` (up-to-date branch) [M: `gh api repos/open-gsd/gsd-core/branches/next/protection`]. `docs/branch-protection.md` describes the rulesets; live state: `next-queue` (id 25600238) is `active`; `main-protection`, `release-branches`, `tag-immutability` are `evaluate` [M: `gh api .../rulesets`]. Queue parameters: batched `ALLGREEN`, `max_entries_to_build 2`, `max_entries_to_merge 3`, `min_entries_to_merge 2` with a 15-minute wait, 90-minute check timeout, `SQUASH` [M, matches `.github/rulesets/next-queue.json`].

**The aggregate gate** `Required tests` (`test.yml:969-1087`) is `if: always()`, exits non-zero when any needed job is not success, and accepts `skipped` for `test-conformance`, `coverage-gate`, `qa-loop-walk`. This is the pattern GitHub documents for skipped/path-filtered required checks (see 2.5).

### 1.2 Test layout and runner

- **Files.** 1,204 `tests/*.test.cjs` files [M: `ls tests/*.test.cjs | wc -l`]; the committed timing table has 1,217 entries [M]. Suites are filename-suffix markers: `unit` (default), `integration`, `install`, `security`, `slow`, `qa` (`docs/TESTING-SUITES.md:7-17`). The "~61,000 tests" figure in the request was not independently counted: **UNVERIFIED**.
- **Runner.** `scripts/run-tests.cjs` (2,553 lines) packs files into chunks and spawns one `node --test` per chunk with `--test-force-exit`, `--test-concurrency=<n>` (default 4 on Linux/macOS, 2 on Windows, `run-tests.cjs:1920-1935`, `:2325-2327`) and two reporters. Each chunk has a 600 s timeout (`RUN_TESTS_CHUNK_TIMEOUT_MS`) with a tree-kill watchdog (`:1494-1570`). Per-file weights come from `tests/test-timings.json` (Linux, CI-calibrated per #5805) and `tests/test-timings.win32.json` (#5071); shards use LPT with a reserve for shard 1's aux suites (`RUN_TESTS_SHARD_RESERVE: 1:69`, `test.yml:500`) (`docs/TESTING-SUITES.md:571-640`).
- **Tiers on CI.** Ubuntu full lane = 3 unit shards under c8 (shard 1 also runs integration, security, and on full-matrix runs install and slow); Windows/macOS run only the generated *platform-conformance tier* file list (ADR-4593, ADR-4641) — Windows 3 shards, macOS 1.
- **Scope.** `scripts/ci-test-scope.cjs` classifies changed paths into `code_changed`, `product_changed`, `full_matrix`, `targeted_tests`; CI-YAML-only PRs go to `test-inert` (#6075). `scripts/affected-tests-lib.cjs` builds a forward import graph over `tests/` plus source trees and has a critical-path fallback (`:10-37`); `package.json` exposes `test:affected`. `docs/PARTITION-RULES.md` is about compact-content splits of workflow prose, not CI sharding, and is irrelevant here.
- **Heaviest files (committed Linux table, per-file summed ms) [M].** Total 123.7 runner-minutes across 1,217 files; the top 50 files are 57.7% of it and the top 100 are 73.9%. Slowest: `fragment-single-edit-propagation.install.test.cjs` 575 s, `state.test.cjs` 267 s, `agent-fragments-emission.install.test.cjs` 228 s, `run-tests-harness.test.cjs` 199 s, `custom-phase-readers.test.cjs` 184 s, `phase.test.cjs` 171 s, `release-tarball-smoke.install.test.cjs` 168 s, `roadmap.test.cjs` 141 s, `lint-gate-evidence-drift.test.cjs` 134 s, `config.test.cjs` 126 s. Windows table (280 files, 116.7 min): `state.test.cjs` 476 s, `phase.test.cjs` 350 s, `codex-config-agents.test.cjs` 294 s, `commands.test.cjs` 236 s, `install-runtime-artifacts.test.cjs` 229 s. Live per-job logs were not parsed for per-file times; the table is the artifact that exposes them.
- **Static lints.** `npm run lint:ci` (`package.json`, one `&&` chain of ~55 `node scripts/lint-*.cjs` and `gen-*.cjs --check` invocations plus `eslint . --max-warnings 0`) runs in the single `lint-tests` job (`test.yml:191-226`). ESLint has 15+ `local/*` error-level rules wired in `eslint.config.mjs` and about 34 rule files in `eslint-rules/` including `no-unbounded-spawn`, `require-subprocess-timeout`, `no-magic-sleep-in-tests`, `no-elapsed-assertion`, `no-hardcoded-tmp`, `no-raw-rmsync-in-tests`, `no-source-grep`, `no-tautological-assert`, `require-full-tmpdir-triad`, `require-read-only-git-env`. Type-aware linting (`recommendedTypeChecked`) is enabled only for `src/**/*.cts` (`eslint.config.mjs:491-502`); the `.cjs` tests are not type-checked. `no-floating-promises` does not appear in `eslint.config.mjs` [R: grep]. `eslint --cache` is a no-op in CI because `node_modules/.cache` is never restored (`test.yml:222-224`).
- **Mutation.** `stryker.config.mjs`; per-module shards from `scripts/mutation-matrix.cjs`; TAP runner (#3915); minScore ratchet (`scripts/check-mutation-score-ratchet.cjs`); 80% threshold (ADR-456 b); `stryker.config.mjs` excludes about 48% of lib lines (`docs/TESTING-SUITES.md` "CI matrix").
- **Fallow.** `fallow` is an optional dependency and a `.fallow/` cache exists; no workflow invokes it. Purpose not verified: **UNVERIFIED**.

### 1.3 Existing decisions that constrain this redesign

| Source | Decision | Effect on options |
|---|---|---|
| `docs/adr/452-eslint-lint-harness.md` | ESLint flat config + local AST rules are the single lint enforcement point; homegrown regex lint scripts retired. Phase-in at `warn` then `error`. Note: it cites `scripts/eslint-rules/` and `engines >=22`; the live paths are `eslint-rules/` and `>=24` | New static checks should be ESLint rules where they are about code shape. Workflow YAML is not JS, so actionlint/zizmor do not conflict. |
| `docs/adr/456-test-rigor-architecture.md` | Deterministic over racing (injectable clock seam, `t.mock.timers`); property tests + Stryker as a PR-gating tier; delete-bad-tests policy; **rejects `retries: 3` loops** and "mutation nightly-only"; states Stryker runs with `--since origin/next` | Retries and quarantine lanes conflict. The `--since` flag is not on Stryker's incremental docs page (see 2.9): **UNVERIFIED** that it exists. |
| `docs/adr/4593-macos-conformance-tier-architecture.md` | macOS gets a separate evidence-backed classifier; tier is 196 files | Do not widen tiers to reduce risk; shard instead. |
| `docs/adr/4641-windows-selector-consolidation.md` | One Windows selector (conformance tier); proportional ceiling on the tier; accepted risk "not a rerun of #962" | Any new PR-lane test selection must be argued against this ADR's #962 history. |
| `docs/adr/5057-one-owner-per-workflow-verdict.md` | Single owner per workflow verdict (phase status, gates, runtime activation); product-domain ADR, not CI | No direct CI constraint; relevant only as the "one owner per verdict" principle for the `Required tests` aggregate. |
| `docs/research/merge-queue-on-next-rollout.md`, `merge-queue-red-next-recovery.md` | Queue rollout design and red-`next` recovery | Queue exists; options must keep `merge_group` wiring. |
| `docs/research/subprocess-hang-detection.md`, `2026-10-02-git-probe-timeout-blocking-guards.md`, `2026-08-30-coverage-merge-oom.md` | Hang-detection signals without a wall-clock bound; c8 merge OOM history | Inputs to 2.7. |
| #5473 memo (branch `origin/docs/5473-windows-ci-stall-research`, `docs/research/windows-ci-child-process-stalls.md`) | Windows stalls name no root cause; hypotheses: pipe-holding descendants, direct-child-only kill, whole-VM pauses of 1-14 s on every shard; retry is "NOT acceptable here" | Windows speed-ups must not hide stalls; instrumentation stays. |
| `CLAUDE.md` "Hanging Subprocesses" | Prevent hangs; no wall-clock timeouts on git/npm subprocesses; stall detection, closed stdin, private index | Open #6229 retires the lint rule that demands timeouts. Job-level `timeout-minutes` and the 600 s chunk timeout are not git/npm subprocess timeouts, but the policy's intent is arguably wider: owner decision Q6. |
| `CLAUDE.md` gating | `gsd-test` is the only way to execute tests; doc-only pushes exempt; no local `node --test` | Out of scope for CI redesign except that any CI change must keep `.claude/hooks/pre-pr-gate.sh` semantics (verdict per sha). |

`CONTEXT.md` and `CONTRIBUTING.md` were not read in full for CI rules; CONTRIBUTING forbids `${{ }}` inside `run:` blocks (quoted by `mutation.yml:150-153`). Any statement beyond that is **UNVERIFIED**.

### 1.4 Timeout history log (#4036)

`tests/ci-timeout-budget-history.jsonl` has 6,564 rows, 2026-09-29 to 2026-11-17 [M]. Per job and event (elapsed minutes; "n" = recorded runs; superseded-cancelled samples can be included, see #6177):

| Job | Event | n | Median | p90 | Max | Cap | Runs at >=90% of cap | at >=99% |
|---|---|---|---|---|---|---|---|---|
| ubuntu shard 1/3 | merge_group | 48 | 20.5 | 25.9 | 26.2 | 32 | 0 | 0 |
| ubuntu shard 2/3 | merge_group | 48 | 26.0 | 28.8 | 30.8 | 32 | 5 | 0 |
| ubuntu shard 2/3 | pull_request | 446 | 20.7 | 27.8 | 32.6 | 32 | 22 | 2 |
| ubuntu shard 2/3 | push | 72 | 22.3 | 28.4 | 32.0 | 32 | 6 | 1 |
| ubuntu shard 3/3 | merge_group | 48 | 21.1 | 27.0 | 28.7 | 32 | 0 | 0 |
| macOS conformance | merge_group | 48 | 27.9 | 33.5 | 36.4 | 45 | 0 | 0 |
| macOS conformance | push | 72 | 23.8 | 33.1 | 44.0 | 45 | 1 | 0 |
| windows shard 1/3 | merge_group | 48 | 25.1 | 29.3 | 32.4 | 45 | 0 | 0 |
| windows shard 2/3 | pull_request | 347 | 23.9 | 28.0 | 40.6 | 45 | 1 | 0 |
| windows shard 3/3 | pull_request | 347 | 25.5 | 29.3 | 38.5 | 45 | 0 | 0 |
| Coverage gate | pull_request | 362 | 5.3 | 7.6 | 11.5 | 15 | 0 | 0 |
| ubuntu targeted | pull_request | 446 | 2.5 | 4.7 | 27.1 | 32 | 0 | 0 |

Ubuntu shard 2/3 is the only lane that repeatedly approaches its cap: 33 of 566 recorded runs at >=90% and 3 at >=99%. The `tests/ci-test-job-timeout-budget.test.cjs` rule (`ceil(measured x 1.5) <= cap`, `docs/TESTING-SUITES.md:641-705`) did not prevent it, because it checks hand-recorded costs, not live data.

### 1.5 Fresh sample (last 6 days)

`gh run list --workflow test.yml --limit 400` returned runs from 2026-11-12 to 2026-11-18 [M]. Outcomes: pull_request 153 success / 60 cancelled / 29 action_required / 27 failure / 3 other; merge_group 57 success / 6 failure / 2 cancelled / 2 other; push 56 success / 4 failure / 1 cancelled. Re-run attempts: 3 of 400 runs have `attempt` 2 (all pull_request); re-run is not how failures are being handled. 22% of PR runs end `cancelled`, i.e. superseded by a new push (the cancellation group works as designed).

Job-level data for up to 45 completed runs per event (135 runs; `gh api repos/.../actions/runs/<id>/jobs?filter=latest`), duration = job `completed_at - started_at`, queue = `started_at - created_at`:

| Job | merge_group median / p90 / max | pull_request median / p90 / max | push median / p90 / max |
|---|---|---|---|
| ubuntu targeted | 2.0 / 2.4 / 3.0 | 2.5 / 4.1 / 32.3 (2 cap-cancels) | 1.9 / 2.4 / 2.5 |
| ubuntu shard 1/3 | 19.0 / 26.2 / 27.7 | 17.7 / 24.3 / 27.8 | 20.8 / 24.4 / 27.6 |
| ubuntu shard 2/3 | 21.7 / 29.9 / 31.1 | 20.5 / 29.0 / 29.5 | 21.6 / 29.8 / 30.9 |
| ubuntu shard 3/3 | 20.9 / 27.2 / 30.5 | 22.2 / 30.7 / 31.7 | 20.9 / 30.9 / 31.6 |
| windows shard 1/3 | 28.1 / 32.4 / 40.9 | 25.5 / 31.2 / 31.2 (n=10) | 27.9 / 31.5 / 34.0 |
| windows shard 2/3 | 27.3 / 31.6 / 35.5 | 27.5 / 29.7 / 29.7 (n=10) | 28.1 / 31.4 / 39.0 |
| windows shard 3/3 | 24.9 / 27.9 / 30.7 | 26.4 / 28.4 / 28.4 (n=10) | 23.0 / 27.3 / 32.1 |
| macOS conformance | 34.1 / 37.8 / 45.4 (1 cap-cancel) | 36.3 / 42.5 / 42.5 (n=10) | 35.0 / 40.9 / 45.5 (1 cap-cancel) |
| lint-tests | 2.5 / 3.0 / 3.4 | 2.4 / 3.0 / 3.1 | 2.4 / 3.0 / 3.2 |
| coverage-gate | 1.2 / 1.4 / 1.5 | 1.0 / 1.3 / 1.4 | 1.2 / 1.4 / 1.8 |
| qa-loop-walk | 2.0 / 2.4 / 2.5 | 1.8 / 2.4 / 2.6 | 2.0 / 2.5 / 2.6 |

- **Whole-run wall-clock** (first job created to last job completed), green runs: merge_group median 34.6 min, p90 39.3, max 44.8 (n=41); push median 35.4, p90 41.2 (n=40); pull_request median 30.6, p90 40.9 (n=28; Windows/macOS present only for `full-matrix` PRs).
- **Queue time for runners:** median 0.1 min everywhere; worst 10.2 min (one macOS job in `merge_group`) and 4.0 min (one macOS job on a PR). Runner availability is not a bottleneck; macOS is the only lane that ever waited.
- **Where a shard's time goes (merge_group, green runs):** Ubuntu unit step medians 12.6 / 19.8 / 19.1 min for shards 1/2/3, `Install dependencies` 0.8 min, `Compact raw coverage` 0.4 min; Windows `Run platform-conformance-tier tests` median 24.2 min, install 1.2 min; macOS tests median 32.2 min, install 1.2 min [M]. Test execution is 90%+ of every lane. Dependency install, checkout and setup are not worth optimising for latency.
- **Compute per merge:** summing the per-job medians of one `push` run gives roughly 187 runner-minutes (derived from the table; `push` and `merge_group` are the same shape). The same matrix runs on the merge-group commit and again on the `push` to `next` after merge [R: `test.yml:3-24`].
- **Failures by job** (excluding the aggregate): no single test shard dominates; failed jobs across the 135 sampled runs were spread over ubuntu shards 1 and 2, Windows shards 1-3, macOS conformance (3), and `lint-tests` (1) [M]. A failure-cause breakdown by test file was not extracted (job logs are 230k lines; not parsed).
- **Cap hits.** Four jobs in the sample were cancelled at their cap: two `test (ubuntu-latest, 24)` targeted-lane jobs at 32.2 and 32.3 min, and two macOS conformance jobs at 45.4 and 45.5 min. Both targeted-lane hits were PRs on branch `chore/4036-ci-timeout-budget-history` (runs 44258418022 and 44327517996), whose only change is the data log. The log for run 44327517996 shows `run-tests: suite="all" files=1192` for the "Run scoped tests" step: the targeted lane degraded to the **full suite in one process** and was cancelled at 31 min. Commit `1bef0db56c` (#6308) made that specific path skip the matrix; the degradation mechanism itself is untouched [R: `git show 1bef0db56c --stat` shows only `scripts/ci-test-scope.cjs` and its test].
- **Other workflows (up to 35 runs each):** `mutation.yml` per-module `Stryker (...)` jobs: median 1.4 min, p90 3.7, but `state-document` 54.0 min (run 44343297400) and 81.8 min (run 44205375693) and `frontmatter` 11.6-15.7 min; 9 of 34 `Stryker mutation score` gate jobs failed. `install-smoke` ubuntu 1.4 min median, macOS median 0.1 (mostly skipped), unpacked 1.2. `security-scan` median 1.4 min. `docs-lint` median 1.1, `changeset-lint` 0.2. `ci-timeout-report` median 5.1 min. None of these is a latency problem except the Stryker `state-document` shard.

### 1.6 Windows and macOS specifics

- `windows-latest` and `macos-latest` on a public repo are 4 vCPU / 16 GB and 3 vCPU (M1) / 7 GB respectively; standard runners have a 14 GB disk [D: https://docs.github.com/en/actions/reference/runners/github-hosted-runners]. A `macos-15-intel` 4 vCPU / 14 GB label also exists on that page. macOS being 3 vCPU/7 GB with the same `--test-concurrency=4` default is a plausible reason it is the slowest lane [I]; not measured.
- The #5473 memo: image script disables Defender real-time monitoring and excludes `C:\` and `D:\`; GitHub staff said C: is slower than D: (runner-images#12647, workspace moved back to D: in #12744); Dev Drive for runners is only a request (runner-images#14878).
- Open: #5029 (Windows shard 2/3 30-37 min vs 45 cap), #5162 (balance regressed, 6.0 min gap vs 2.0 limit), #5807 (packer ignores long single files), #6148 (macOS no headroom), #5073 (re-measure `--test-concurrency=2`).

### 1.7 Issue history so the memo does not re-propose rejected ideas

From `gh issue list --repo open-gsd/gsd-core --state all --search ...` (344 distinct hits; CI-relevant ones listed):

| # | Outcome | Subject |
|---|---|---|
| 199, 4068, 4172, 4355, 6140 | Closed | c8 coverage-merge OOM (several recurrences; fixes: `--merge-async`, per-shard compaction). #4068 and #4172 closed NOT_PLANNED as duplicates of the live fix |
| 365, 370, 408 | Closed COMPLETED | Affected tests in PR CI lanes; install/slow suites excluded on PRs |
| 764, 4589-4593, 4641, 6002 | Closed COMPLETED | Skip matrix for docs-only/inert PRs; Linux-primary + conformance tier; one Windows selector; tier ceiling |
| 869, 1051, 1212, 2472, 2952, 4070 (NOT_PLANNED, closed by the version-gate bot, not on merit), 4220, 4434, 4733, 4936, 4949 | Closed | Timeout-cap cancellations, sharding, cost-aware LPT packer, per-chunk watchdog |
| 5071, 5072, 5074, 5101, 5804, 5805 | Closed COMPLETED | Win32 timing table, Defender check, `.platform` siblings, balance report, calibrated tables |
| 4036 | Closed COMPLETED | Timeout trend history + 90% near-cap warning |
| 4241, 4990, 5600, 5604, 5605, 5610, 5746 | Closed COMPLETED | Merge queue wiring, ruleset, Linux-only PR variable |
| 453/474/969/1586/3985/4850/5189/5498/5507/5662 (NOT_PLANNED), 5677, 6005, 6143 | Mixed | Flaky/racing tests; fixed by clock seams or deletion, per ADR-456; no retry mechanism was ever adopted |
| 3623 | Closed NOT_PLANNED | Windows target for local `gsd-test` gate (owner: "a local machine thing, not a code thing") |
| 4244, 4446, 4445 | Closed COMPLETED | ESLint rules for dirname-walk/TMPDIR triad; ad-hoc timeout literal lint; timeout-literal migration epic |
| 4012, 4031, 4104, 4105, 6086 | Closed/Open | Killed-chunk file attribution; `--test-force-exit` default drops executed tests (#4031 duplicate); hang-fixture orphans |
| 4635 (+ Phases 3-8: 6035-6040), 4688 | Open | One real test-isolation helper; installRuntimeFixture spawn-count reduction |
| 4689 (+6058-6063, 6084), 6229 | Open | Migrate timeout constants onto the process seam; supervised spawn that captures diagnostics before kill; replace wall-clock timeouts on git/npm with hang prevention |
| 5029, 5162, 5807, 6148, 5073, 5772-5774, 6130, 6166 | Open | Windows/macOS headroom and balance; scope classifier polish; `check new-tests-fail-on-base` |

No issue proposing actionlint, zizmor, knip/dependency-cruiser, Nx/Turborepo/Bazel/Moon, larger runners, nightly lanes or retry/quarantine was found by title/body search (`gh issue list --search`); that absence is evidence the ideas are unexamined, not rejected. Retry is rejected in ADR-456 (b) and in the #5473 memo section 3 item 6.

### 1.8 What already exists and should not be rebuilt

| Capability | Where |
|---|---|
| Timing-balanced LPT sharding with isolated heavy files and a shard-1 reserve | `scripts/run-tests.cjs` (`selectShard`, `packChunks`), `tests/test-timings*.json` |
| Per-file duration artifacts from CI | `test.yml:521-530` (`test-timings-ubuntu-unit-job*`), `:815-822` (`test-timings-<os>-job*`) |
| Changed-path classifier, inert-CI lane, rename-aware escalation | `scripts/ci-test-scope.cjs` |
| Import-graph affected-test selection with critical-path fallback | `scripts/affected-tests-lib.cjs`, `npm run test:affected` |
| Daily timeout trend + 90% warning + balance check | `ci-timeout-report.yml`, `scripts/ci-check-job-near-cap.cjs` |
| Mergeability preflight, base-branch health gate, rebase check, runner guard | `test.yml:47-130`, `scripts/ci-rebase-check.cjs`, `scripts/ci-guard-runner.cjs` |
| Coverage merge across shards | `coverage-gate` job |
| Spawn-stall records and Windows watcher | `tests/helpers/process-seam.cjs`, `scripts/diagnose-windows-spawn-watcher.cjs` |

### 1.9 Reproducing the measurements

Commands used (all read-only): `gh run list --repo open-gsd/gsd-core --workflow test.yml --limit 400 --json databaseId,event,conclusion,status,createdAt,updatedAt,startedAt,headBranch,attempt,headSha`; `gh api "repos/open-gsd/gsd-core/actions/runs/<id>/jobs?per_page=100&filter=latest"` for 45 completed runs per event; the same for `mutation.yml`, `install-smoke.yml`, `security-scan.yml`, `ci-timeout-report.yml`, `docs-required.yml`, `changeset-required.yml` (35 each); `gh api .../actions/variables`; `gh api .../branches/next/protection`; `gh api .../rulesets`; a Python pass over `tests/ci-timeout-budget-history.jsonl` and `tests/test-timings*.json`. Medians and p90 use the nearest-rank method over all runs returned; they include runs on all branches. Per-file timings from live job logs were not extracted (log of one job is about 232k lines).

---

## 2. Options survey

Verdict key: **adopt** (build it), **trial** (shadow/measure first), **reject** (do not do, reason given). "Applies to" names the repo file the change touches.

### 2.1 Node test runner capabilities (repo targets Node >=24, `package.json` `engines`, `.nvmrc` = 24)

| Capability | Primary-source facts | Fit for this repo | Verdict |
|---|---|---|---|
| `--test-shard=i/n` | Added v20.5.0; "will divide all tests files into `total` equal parts" (https://nodejs.org/api/cli.html) — count-based, not time-based | Repo already has a duration-weighted LPT packer, which is strictly better for a file set with a 575 s outlier and a 57.7%-in-50-files tail (section 1.2). | **reject** (keep `selectShard`) |
| `--test-concurrency` | "defaults to `os.availableParallelism() - 1`"; ignored when `--test-isolation=none` (cli.html) | Repo forces 4 (Linux/macOS) / 2 (Windows) via `TEST_CONCURRENCY` default (`run-tests.cjs:1920-1935`). On macOS (3 vCPU) Node's default would be 2; whether the forced 4 helps or hurts is **unmeasured**. #5073 already tracks the Windows value. | **trial** (A/B on macOS in the shard work, 2.4) |
| `--test-isolation=process\|none` | Added v22.8.0 (renamed from experimental v23.6.0); `process` default; with `none` "all test files run in the same process" and top-level concurrency is one (cli.html; test.html) | Tests mutate env/cwd/tmp, spawn the CLI and rely on a fresh process per file; `none` would serialise everything and cross-contaminate. 1,204 files in one process also defeats timeout attribution. | **reject** |
| `--test-only` | "only execute top level tests that have the `only` option set"; unnecessary when isolation is off (cli.html) | Irrelevant to CI; `.only` already blocked by `no-only-tests/no-only-tests` (`eslint.config.mjs:854`). | **reject** (nothing to gain) |
| `--test-timeout` | Default `Infinity`; subtests inherit (cli.html) | Wall-clock; sits in the same family as the policy question (Q6). A per-test timeout does bound a hung test but kills attribution less than the chunk watchdog does. | **trial** only as a diagnostic in the nightly leak lane (2.7) |
| `--test-force-exit` | "exit the process once all known tests have finished executing even if the event loop would otherwise remain active" (cli.html) | Repo defaults it on, which hides leaked handles; #4031 (duplicate) recorded executed tests being dropped from reports at rc=0. See 2.7. | **adopt** a diagnostic lane that runs without it |
| `--experimental-test-coverage`, `--test-coverage-*` | Stability 1 Experimental (test.html) | Repo uses `c8` with merged V8 dumps and a gate script; moving to Node's experimental coverage would trade a working pipeline for an experimental one. | **reject** |
| `--test-rerun-failures <file>` | Added v24.7.0; persists state so only tests "that have not yet passed" run; requires deterministic order (test.html) | A retry mechanism by another name. ADR-456 (b) rejects retries; #5473 memo marks retry not acceptable. Useful locally for faster dev loops, not as a CI policy. | **reject** for CI; optional local convenience |
| Reporters | `spec`, `tap`, `dot`, `junit`, `lcov`; "exact output ... subject to change" (test.html) | Repo pairs a human reporter with a custom module sink (`run-tests.cjs:2149-2152`). `junit` could feed a flake dashboard (2.8) without new infrastructure. | **trial** (2.8) |
| `mock.module` | "1.0 - Early development", needs `--experimental-test-module-mocks` (test.html) | Not needed; repo tests use real files and a process seam. | **reject** |
| `t.mock.timers` | Stable since v23.1.0; mocks `setTimeout`, `setInterval`, `setImmediate`, `Date` (test.html) | Already the ADR-456 clock seam. | Already adopted |
| Watch mode | Experimental (test.html) | Developer-loop only. | **reject** for CI |
| One-process-per-file cost | Documented model: "each matching test file is executed in a separate child process" bounded by `--test-concurrency` (test.html) | The repo's chunk packing already amortises startup. The real startup tax is *inside* tests that spawn the CLI per assertion (2.9). | see 2.9 |

### 2.2 Test impact analysis for a CommonJS/TypeScript repo

- **Static import graph.** Jest: `--findRelatedTests` and `--onlyChanged` "requires a static dependency graph (ie. no dynamic requires)" (https://jestjs.io/docs/cli). Vitest: `--changed` / `vitest related` use static imports and not `import(filepath)` (https://vitest.dev/guide/cli.html). The repo already has this (`affected-tests-lib.cjs`: regex over `require()` and `from '...'` specifiers, walking `tests/` and source trees).
- **Recorded/coverage-map selection.** Microsoft TIA records which tests touch which code, selects impacted tests, "falls back to running all tests" for files it cannot reason about, and recommends "run all tests at a configured periodicity"; it also tells users to validate by running selected then all tests and comparing failures (https://learn.microsoft.com/en-us/azure/devops/pipelines/test/test-impact-analysis). Nx selects tasks whose declared inputs changed, needs full git history (`fetch-depth: 0`), and pairs with remote cache (https://nx.dev/docs/features/ci-features/affected). Vitest can swap the static graph for recorded module loads via `experimental.recordDependencies` (vitest CLI page above).
- **Applies here.** A large share of this suite reads repo files (prompts, workflows, manifests, generated tables) rather than importing modules, so an import graph under-selects by construction [I]. The repo's own history shows the cost: ADR-4641 "Risk accepted, and why it is not a rerun of #962", and #4421 rescinded a carve-out that skipped macOS when a test file changed because a real regression escaped. A recorded map (which files each test file reads, via an `fs` read ledger in the process seam) would fix under-selection but is new infrastructure.
- **Safe fallback design:** PR lane may select; `merge_group` always runs everything; critical paths (`.github/workflows/`, `package.json`, `scripts/run-tests.cjs`, per `CRITICAL_PATHS` at `affected-tests-lib.cjs:10-17`) force full.
- **Expected benefit:** unmeasured. Upper bound: PR lane today runs all three full shards (about 60 runner-min) for any product change.
- **Verdict: trial in shadow mode** (compute selection on every PR, run the full lane as today, record whether any failing test was outside the selected set). Enforce only after a measured zero-miss window (acceptance criteria in 3.2, item 11). Conflict: ADR-4641 risk language; resolve through the shadow data, not argument.

### 2.3 Sharding strategies

- **Count-based vs timing-balanced.** Node's shard flag is count-based (2.1). Jest's `--shard` splits by a `testSequencer`, which "has to implement a `shard` method" (jest CLI page), i.e. timing-aware sharding is a user-supplied sequencer there too. The repo has the timing-aware variant already.
- **Gaps in the repo's version** (all in open issues): the packer weighs summed file cost but wall time includes isolated heavy files (#5807); tables go stale (#5804 caused a 32-min-cap overrun; #5805 re-calibrated once, by hand); there is no darwin table (#6148 verified). Shard 2/3 on Ubuntu still trends hot (section 1.4).
- **Automated table refresh.** The duration artifacts already exist (`test.yml:521-530`). A scheduled job that downloads the last N successful `push`-run artifacts, runs `scripts/gen-test-timings.cjs`, and opens a data-only PR (the same pattern `ci-timeout-report.yml` uses for the history log) would keep weights fresh. Benefit: keeps shards inside cap (33 of 566 Ubuntu shard-2 runs >=90% today); size unmeasured.
- **Dynamic matrix** (a planner job emitting shard count from total weight): GitHub supports `fromJSON` matrices; the matrix limit (256 jobs) page was not retrieved: **UNVERIFIED**. Fixed counts plus a headroom check are simpler; dynamic counts would also change the required-check surface (job names are `name:` templated and checked in `tests/ci-full-lane-sharding.test.cjs`).
- **Verdict:** **adopt** automated timing refresh (low risk, uses existing artifacts); **adopt** macOS 3-way shard (#6148 after #5053) and Windows packer fix (#5807); **trial** a 4th Ubuntu shard only if shard-2 headroom stays under 10% after refresh (public-repo standard runners are free and unlimited per https://docs.github.com/en/actions/reference/runners/github-hosted-runners, so cost is runner contention, which the sample shows as 0.1 min median queue).

### 2.4 Tiering and merge queue

- **GitHub facts** (https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue): Actions workflows "must use the `merge_group` event" or the required check is never reported; build concurrency 1-100 limits concurrent `merge_group` dispatches; group size min/max 1-100 with a wait time; a status-check timeout; the queue removes a PR on a failing required check, a conflict, a CI timeout or a user request, and rebuilds the rest of the group without it; "Only merge non-failing pull requests" (the repo's `ALLGREEN`). The `merge_group` event documents only `branches`/`branches-ignore` filters, not `paths` (https://docs.github.com/en/actions/writing-workflows/workflow-syntax-for-github-actions). The page states no default values.
- **Current tiering:** PR = Linux only (variable `GSD_PR_LINUX_ONLY=true`), merge_group and push = everything; `push` to `next` repeats the merge-group matrix.
- **Candidate tiers:**
  1. *PR fast tier* — static gates + targeted tests (<5 min) + Linux shards (as today, 20-22 min). Already the shape.
  2. *Merge-queue full tier* — as today, with macOS sharded.
  3. *Post-merge push* — redundant with tier 2 when the tree is unchanged. Skipping it when the merge-group run on the same tree passed would remove about 187 runner-minutes per merge (derived from section 1.5). Dependencies: `next-health` reads the last push-triggered Tests run (`test.yml:63-72`, `scripts/ci-next-health.cjs`) and `publish-emitted-baseline` runs only on `push` to `next` (`:1098`); both would need to read the merge-group result. Whether a squash-merged group's tree is byte-identical to the merge-group commit tree is not established here: **UNVERIFIED** (must be proven with `git rev-parse <sha>^{tree}` on sampled merges before any change).
  4. *Nightly* — long-tail suites (install/slow on every OS, Stryker full, leak-audit lane 2.7, flake ledger 2.8). Today install/slow run only when `full_matrix=true` on shard 1 (`test.yml:557-563`).
- **Queue parameters** (`min_entries_to_merge: 2` with a 15 min wait): a single queued PR may idle up to 15 min before its 35-min run starts [R: ruleset]; whether this wait is incurred in practice was not measured (enqueue-to-merge latency is not in `gh run` data). Owner decision Q5.
- **Verdict:** keep the queue; **trial** push dedup (needs the tree-identity proof); **adopt** a nightly lane only for diagnostic work that today has no home (2.7, 2.8); do not move correctness gates to nightly (ADR-456 (c) rejects nightly-only mutation).

### 2.5 GitHub Actions mechanics

| Topic | Primary-source facts | Applies to | Verdict |
|---|---|---|---|
| `actions/cache` / `setup-node` cache | Repo cache limit "10 GB per repository" by default, oldest-accessed evicted; PR runs restore from the PR's merge ref scope, current/default/base branches, not sibling branches; docs do not mention `merge_group` refs (https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching). `setup-node` `cache: npm` caches the npm cache dir, keyed on the lockfile, "instead of `node_modules`" (https://github.com/actions/setup-node/blob/main/docs/advanced-usage.md). | `test.yml` already uses `cache: npm`; install is 0.8-1.2 min per job (section 1.5) and runs in parallel, so no critical-path gain. | **reject** caching `node_modules` / sharing a built artifact across jobs for latency. **adopt** `actions/cache` for the Stryker incremental file (2.9) and for `node_modules/.cache/eslint` only if lint becomes a bottleneck (2.4 min today; not one). |
| Artifact reuse of one build | `actions/upload-artifact` / `download-artifact` already used for coverage and timings | Per-job `npm ci` includes `build:lib` through `prepare`; building once and downloading would add artifact transfer to save under a minute. | **reject** |
| `concurrency` cancel-in-progress | "specify `cancel-in-progress: true`" to cancel running jobs in the group; `queue: max` cannot combine with it (workflow-syntax page above). | `test.yml:26-33` already encodes the label-race rule (#6092). 22% of PR runs end cancelled (superseded), as intended. | keep |
| Path filters and required checks | A workflow skipped by path/branch filtering leaves its checks "Pending" and blocks merging; "Avoid requiring workflows that can be skipped"; a job skipped by `if:` reports success; a dependent of a failed job is skipped and may not block, so use `always()` + `needs` on the required job (https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/defining-the-mergeability-of-pull-requests/troubleshooting-required-status-checks). | The repo's design (job-level scope classifier + always-running `Required tests` with `if: always()`) is exactly what the page recommends; `mutation.yml`, `install-smoke.yml`, `security-scan.yml` are path-filtered and correctly *not* required checks. | **reject** adding `paths:` to any required workflow; keep the aggregate pattern. |
| Job-level `timeout-minutes` | Step-level maximum is 360 (workflow-syntax page, steps section). The job-level default value was not shown on the fetched segment: **UNVERIFIED** (commonly 360, not confirmed here). | Every job in `test.yml` sets one. | see Q6 |
| Larger / self-hosted runners | Larger runners "available for organizations and enterprises on GitHub Team and GitHub Enterprise Cloud plans"; standard runners are free on public repos (runners page above). The repo guards "GitHub-hosted runner" (`scripts/ci-guard-runner.cjs`). | The org plan is unknown to this memo; macOS lane is the one a bigger machine would help. | **trial** only after Q3 is answered; self-hosted **reject** (the runner guard exists on purpose; hostile-PR surface, and zizmor flags it as `self-hosted-runner` pedantic). |
| Re-run semantics | Re-run failed jobs: dependents re-run, un-re-run jobs keep outputs, same `GITHUB_SHA`/`GITHUB_REF`, max 50 re-runs, 30 days; attempt numbering and `merge_group` re-run not covered on the page (https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-workflow-runs/re-running-workflows-and-jobs). | Re-runs are rare today (3 of 400 runs). | informational (2.8) |
| Reusable workflows / composite actions | Checkout + guard + rebase-check + setup-node + env check + `npm ci` + integrity gate is copy-pasted in `test`, `test-inert`, `test-conformance`, `qa-loop-walk` (`test.yml:391-437`, `:609-638`, `:715-755`, `:924-946`). | Maintainability and parity-drift risk, no speed benefit. | **adopt**, low priority (one composite action; parity already guarded by `tests/ci-*` workflow tests, which would need updating). |
| Windows runner performance | Standard Windows runner: 4 vCPU, 16 GB, **14 GB** SSD (runners page). Dev Drive needs "Minimum 50 GB free disk space", cannot convert an existing volume, and "The C: drive ... cannot be designated as a Dev Drive" (https://learn.microsoft.com/en-us/windows/dev-drive/). Defender is already off on the image per the #5473 memo (`Configure-WindowsDefender.ps1`, runner-images). | A Dev Drive cannot be created on a 14 GB standard runner; Defender cost is already removed. | **reject** Dev Drive on standard runners; revisit only with larger runners (Q3). |

### 2.6 Static gates that replace or pre-empt slow tests

| Gate | What it is (primary source) | Applies to | Benefit | Risk/cost | Verdict |
|---|---|---|---|---|---|
| **actionlint** | Checks workflow syntax, expressions, `needs:` cycles, matrix values, event names, runner labels, action inputs, and runs `shellcheck` on `run:` steps for bash/sh only (https://github.com/rhysd/actionlint/blob/main/docs/checks.md) | new job in `test.yml`, or a step in `lint-tests` | Catches parse-time defects like #437 (`shell: ${{ matrix.shell }}` rejected by GHA) before a run is wasted; seconds to run [I]; the repo has `lint-workflow-shellcheck.cjs` already (in `lint:ci`) so shellcheck overlap exists | New binary dependency; pin by checksum | **adopt** |
| **zizmor** | Static audits of workflows: `template-injection`, `unpinned-uses`, `excessive-permissions`, `dangerous-triggers`, `cache-poisoning`, `artipacked`, `concurrency-limits` (pedantic), `self-hosted-runner` (pedantic) and others (https://docs.zizmor.sh/audits/) | same | Automates CONTRIBUTING's "no `${{ }}` in `run:`" rule; the repo uses `pull_request_target` in 4 workflows, which zizmor audits as `dangerous-triggers` | Findings backlog on first run; fix them (no-defer) | **adopt** (the first run's findings must be fixed in the same PR) |
| ESLint custom rules for test hygiene | Repo already has about 34 rule files (section 1.2) | `eslint-rules/`, `eslint.config.mjs` | Gaps to check: un-awaited promise in a test body, `child_process.spawn` without `stdin` closure or `'ignore'` for async spawns (the #5473 memo section 2.8 notes async spawn needs `child.stdin.end()`), `setInterval`/server listen without `.unref()` or a teardown, `net.listen(0)` vs fixed ports, `fs` writes outside the tmp triad (`require-full-tmpdir-triad` exists), real network use. Each is a rule candidate; which are already covered by `no-unbounded-spawn` was not read (**UNVERIFIED**; the rule files were not opened because the guard routes code reads to CodeGraph and the memo budget did not require it) | Rule-per-bug-class cost; warn-first per ADR-452 | **adopt** per class, evidence-gated (ADR-452 convention) |
| `typescript-eslint` `no-floating-promises` on tests | "Require Promise-like statements to be handled appropriately", requires type information with "performance tradeoffs" (https://typescript-eslint.io/rules/no-floating-promises/) | needs type info for `.cjs` tests: `allowJs`/`checkJs` tsconfig; today type-aware lint covers only `src/**/*.cts` (`eslint.config.mjs:491-502`) | Un-awaited promises are a leak and flake source; benefit unmeasured | Type-aware lint of 1,204 test files: cost unmeasured; `typescript-eslint` perf guide not retrieved | **trial** (measure lint wall time on a branch before enabling) |
| `tsc --noEmit` | `tsconfig.json` is `noEmit` over `src/**/*.cts`; `build:lib` is the emitting type gate and runs in every job via `prepare` | `lint-tests` | Already enforced by build; `tsc --incremental` would help only local loops (CI starts cold) | none | **reject** as a CI change |
| Knip / dead code | "report unused dependencies, exports and files" (https://knip.dev/overview/getting-started); CommonJS and CI pages exist but were not retrievable in the fetch (**UNVERIFIED** handling of this repo's `.cts`/`.cjs` mix) | new script | Reduces tree size over time; no speed claim | Large false-positive surface for a repo whose files are loaded by prompt text and manifests, not imports [I] | **trial** report-only |
| dependency-cruiser / import boundaries | Validates dependencies against rules, covers circular deps and orphans; supports CommonJS and ES6 (https://github.com/sverweij/dependency-cruiser) | `eslint.config.mjs` already has `n/no-missing-require`, `@typescript-eslint/no-restricted-imports` seam rules (`:1024`, `:1048`) and `scripts/lint-seam-enforcement.cjs` | Little incremental value over existing seam lints | extra tool | **reject** |
| Lockfile / changeset / docs lints | `scripts/check-npm-integrity.cjs`, `scripts/changeset/lint.cjs`, `docs-required.yml` exist | | already done | | keep |
| Test-quality lints | `no-only-tests` (error), `no-elapsed-assertion`, `no-magic-sleep-in-tests`, `no-tautological-assert`, `no-source-grep` exist (ADR-452, ADR-456) | | already done | | keep |
| Slow-test budget gate | none exists. Table `tests/test-timings.json` has per-file costs; `docs/TESTING-SUITES.md:586` says the table is "advisory and deliberately un-gated" | new script reading the CI duration artifact | Top 50 files are 57.7% of summed time (section 1.2); a per-file ceiling with a ratcheting allowlist stops new 100 s+ files | A budget needs measured durations from CI, so it runs after tests, not before; allowlist of today's outliers needed | **adopt** as a ratchet (allowlist = current offenders; no new file above the line) |

**Ordering decision (gate before matrix).** `lint-tests` is 2.4 min and in the sample failed 1 of 45 PR runs; the 135-run sample's failures were overwhelmingly in test shards. Making shards depend on a static job saves about 60-190 runner-minutes only on the rare red-static PR but adds a serial 2.4 min to every green PR (all three Ubuntu shards currently start immediately). Unless the static tier is made much faster (parallel jobs, under 1 min), serialising it is a net latency loss. Q1.

### 2.7 Hang and leak prevention instead of timeouts

- `process.getActiveResourcesInfo()` "returns an array of strings containing the types of the active resources that are currently keeping the event loop alive"; added v17.3.0, stable from v24.0.0 / v22.16.0 (https://nodejs.org/api/process.html). Usable in an `after()` hook or a runner-level reporter to name leaked `Timeout`, `TCPSocketWrap`, `ChildProcess` and similar resources at the end of each test file.
- `why-is-node-running` prints the handles keeping Node alive with creation sites; for "tests, local runs, and short-lived debugging" only; preload with `node --import why-is-node-running/include file.js` and send `SIGUSR1` (https://github.com/mafintosh/why-is-node-running). It adds overhead that "grows the busier your application is" — never for the main CI lane.
- `--test-force-exit` masks leaks (2.1); the repo defaults it on (`run-tests.cjs:2325-2327`) after #4031.
- Existing hang defenses: process seam with per-spawn bounds and stall records, per-chunk watchdog, Windows spawn watcher, ESLint `no-unbounded-spawn` and `require-subprocess-timeout` (the latter is the rule open #6229 would retire for git/npm calls).
- Node diagnostic reports: `--report-on-signal` writes JS and native stacks and libuv handle info; usable only for async-supervised children (the repo's `docs/research/subprocess-hang-detection.md` section 4 covers this; the seam is synchronous, #6084 tracks the supervised variant).
- **Options:** (a) **adopt** a nightly "leak audit" lane: the unit suite with `--test-force-exit` off and a per-file `getActiveResourcesInfo()` assertion in a shared test hook, report-only, output a ledger of files that leak; (b) **adopt** ESLint rules for the leak shapes above (2.6); (c) **trial** `--test-timeout` in that lane only so a hung test names itself instead of the chunk; (d) **adopt** #6084 (supervised spawn capturing diagnostics before kill); (e) **reject** `why-is-node-running` in the main lane (overhead). Per-test tmpdir isolation and port 0 allocation are policy already encoded in `require-full-tmpdir-triad`; no new work except the port-allocation rule candidate.
- **Conflict check:** the lane uses no wall-clock timeouts on git/npm, consistent with `CLAUDE.md`.

### 2.8 Flake handling

- Detection: the history log and `ci-timeout-report.yml` track elapsed-vs-cap; per-file duration artifacts exist; no per-file *failure* ledger exists. The Node `junit` reporter (test.html) or the repo's own reporter sink could emit per-test pass/fail to an artifact; a scheduled job aggregates failures per test file across N runs of `next` push/merge_group into a ledger (issue or data PR). Benefit: names the real flaky files instead of reading 230k-line logs; unmeasured.
- Retry policy: rejected by ADR-456 (b) and the #5473 memo. GitHub re-run semantics (above) re-run dependents and keep other outputs; max 50 re-runs. Only 3 of 400 sampled runs were re-run. Bazel treats a fail-then-pass test as FLAKY but still passes it under `--flaky_test_attempts` (cited in `docs/research/subprocess-hang-detection.md` section 6, https://bazel.build/docs/user-manual) — an example of the risk (retry converts a signal into silence).
- Quarantine lane: contradicts "No Deferrals" and ADR-456 (d) delete-bad-tests; a quarantined test is a deferred fix.
- **Verdict:** **adopt** the failure ledger (read-only, no gating); **reject** retry and quarantine.

### 2.9 Test-suite cost reduction

- **Slow-test budget** — see 2.6 (adopt, ratchet).
- **In-process invocation instead of spawning the CLI.** `gsd-tools.cjs` and `bin/install.js` are spawned by many tests (#4688 `installRuntimeFixture` spawn-count reduction; #4635 test-isolation helper epic). The heaviest Linux files are install-class (`fragment-single-edit-propagation.install.test.cjs` 575 s, `agent-fragments-emission.install.test.cjs` 228 s) and state/phase/roadmap/config unit files (126-267 s). Targeting the top 20 files (about 40% of summed time if the pattern holds: the table gives top-50 = 57.7%) is the highest-leverage test change; measured speed-up per conversion is unmeasured. **adopt**, driven by the budget gate (each PR that converts a file lowers its allowlist ceiling).
- **Fixture reuse / snapshot consolidation:** `installRuntimeFixture` (#4688, closed) is the shared helper; further consolidation is per-file work, unmeasured.
- **Property-test budgets.** `fast-check` is used by tests per ADR-456 (b). The count of `numRuns` overrides and the library default could not be verified: the fast-check runner and configuration pages fetched did not state `numRuns` (https://fast-check.dev/docs/core-blocks/runners/ and https://fast-check.dev/docs/configuration/user-definable-values/): **UNVERIFIED** default. A global `fc.configureGlobal({ numRuns })` budget in CI is a candidate; cost/benefit unmeasured. **trial** (measure time share of `*.property.test.cjs` files first from the timing table).
- **Stryker incremental.** Docs: incremental mode "only runs mutation testing on the changed code", stores state in `reports/stryker-incremental.json` by default (`--incrementalFile`), requires the dry run, and tracks changes only in mutated and test files; Command runners report nothing, TAP "per file"; `--force` reruns all; the page does not mention `--since` (https://stryker-mutator.io/docs/stryker-js/incremental/). The repo (a) passes `--incremental` but never persists the file between CI jobs (no cache step in `mutation.yml`), so every shard is cold, and (b) ADR-456 (b) says `--since origin/next`, which the docs page does not list: **UNVERIFIED**. The `state-document` shard took 54.0 and 81.8 min (section 1.5). **adopt:** restore and save the incremental file per module with `actions/cache` keyed on module + base sha (PR scope: restore from base branch cache is allowed by the cache scope rules above); measure; then reassess the `state-document` budget. Caveat from the docs: dependency, environment and `.snap` changes are not detected, so a periodic `--force` run (nightly) is required.
- **Coverage under c8.** Unit shards run under c8 (`test.yml:479-506`: shard 2/3 unit step median 19.8 min); the repo notes c8 makes some files costly (`:504` comment). Running coverage only in the merge-queue/push run would shorten PR shards; the size is unmeasured and needs an A/B on identical shards. The coverage gate itself is 1.0-1.2 min per run (this sample) / 5.3 min median (history log, includes cold installs and other loads — the two sources disagree, **both [M]**, cause not investigated). **trial** (Q7).
- **Coverage gate blind spot:** it measures `gsd-core/bin/lib` only (`docs/TESTING-SUITES.md`); not a speed matter.

### 2.10 Build and test orchestration / remote caching

| Tool | Facts | Fit | Verdict |
|---|---|---|---|
| Turborepo | "designed for scaling monorepos"; Remote Cache "stores the result of all your tasks, meaning that your CI never needs to do the same work twice"; supports single-package workspaces (https://turborepo.dev/docs) | A test-task cache hit requires declared, stable inputs. This suite's tests read prompts, workflows, manifests and generated tables across the repo, so the honest input set is the whole repo and a hit rate near zero [I]. Splitting tasks per test file is the same dependency-knowledge problem as 2.2. | **reject** now; revisit only if a recorded read-ledger (2.2) shows narrow per-file inputs |
| Nx | Task selection by declared inputs, project graph, needs full history, remote cache and distributed execution; single-project workspace behaviour is not covered on the page (https://nx.dev/docs/features/ci-features/affected) | Same limit; adds a graph the repo does not have. | **reject** |
| Bazel | Hermetic, sandboxed, incremental builds; BUILD files in Starlark; the page does not describe remote caching or adoption effort (https://bazel.build/about/intro) | Rewriting a Node/CJS suite into hermetic targets is a re-platform; not proportional. | **reject** |
| Moon | Task runner with hashing, remote caching, incremental builds; multi-project orientation not confirmed as exclusive (https://moonrepo.dev/docs) | Same as Turborepo. | **reject** |

---

## 3. Synthesis

### 3.1 Ranked shortlist (highest benefit per unit of risk first)

| Rank | Item | Phase | Evidence of benefit | Risk |
|---|---|---|---|---|
| 1 | Close the targeted-lane fallback: assert `targeted_tests` count and surface the selected-file count; a targeted lane must never degrade to `suite="all"` without an explicit `full` reason | 0 | Two cap-hits of 32 min in 40 PR samples; ran 1,192 files in one process [M] | Low; `scripts/ci-test-scope.cjs`, `ci-prepare-test-scope.cjs` |
| 2 | Stryker incremental file cached per module; reassess `state-document` budget | 0 | 54.0 and 81.8 min shards; no cache step [M][R] | Low-medium: stale-incremental blind spots; nightly `--force` |
| 3 | Add workflow static tier: actionlint + zizmor (fix all first-run findings) | 1 | Catches parse-time workflow defects (#437 class) and injection class before run; runtime seconds [I] | Low; findings backlog |
| 4 | Shard macOS conformance 3 ways and add the darwin timing table (#6148 after #5053) | 2 | macOS is the critical path: merge_group median 34.1 of 34.6 min wall; #6148 reports 3-shard layout slowest-shard median 13.75 min over 20 runs; expected merge_group wall about the Windows median 28 min (derived) [M][D: issue] | Low-medium: macOS queue waits seen up to 10.2 min [M] |
| 5 | Automated timing-table refresh PR from CI artifacts (+ per-platform) | 2 | Ubuntu shard 2/3 >=90% of cap 33 of 566 runs; #5804 was a stale-table outage [M] | Low |
| 6 | Windows packer accounts for isolated long files (#5807) and #5162 balance | 2 | Windows shards 23-28 min, 6.0 min balance gap on #5162 [M] | Low |
| 7 | Dedup the post-merge `push` matrix when the merge-group run on the same tree passed | 2 | About 187 runner-minutes per merge, removes the third full run per change [M derived] | Medium: `next-health` and `publish-emitted-baseline` depend on push; tree identity unproven |
| 8 | Slow-file budget ratchet + in-process conversions of top-N files | 1/3 | Top 50 files = 57.7% of summed time [M] | Medium: needs CI durations; allowlist maintenance |
| 9 | Leak-audit lane (no force-exit, `getActiveResourcesInfo`) + failure ledger | 3 | Names leaked handles and flaky files with no gating risk; benefit unmeasured | Low (report-only) |
| 10 | Shadow-mode affected-test selection on PRs | 3 | Upper bound: PR full lane about 60 runner-min; benefit unmeasured | Medium: #962/#4421 history; shadow mode removes the risk |
| 11 | Composite action for repeated setup steps in `test.yml` | 4 | No speed benefit; removes 4-way copy drift | Low-medium: workflow-contract tests must be updated |
| 12 | Type-aware `no-floating-promises` on tests; ESLint leak-shape rules | 3 | Unmeasured | Lint wall-time unknown; warn-first |

Rejected: Node `--test-shard`, `--test-isolation=none`, `--test-rerun-failures` as CI policy, Node experimental coverage, `mock.module`, retries, quarantine, Dev Drive on standard runners, Turborepo/Nx/Bazel/Moon, dependency-cruiser, `tsc --incremental` in CI, caching `node_modules` or sharing a build artifact, `paths:` filters on required workflows, self-hosted runners.

### 3.2 Phases, dependencies and acceptance criteria

**Phase 0 — remove measured defects (no semantic change; independent items).**

*Item 1, targeted-lane fallback guard.* Depends on nothing.
- AC1: `node scripts/ci-test-scope.cjs --base <sha> --head <sha>` prints `targeted_tests` and a `reasons` entry whenever the result is "all"; a unit test in `tests/ci-test-scope.test.cjs` feeds a log-data-only change, a docs-only change and an unknown-extension change and asserts none yields the whole suite without a named reason.
- AC2: in the CI log for any PR run, `run-tests: suite=... files=N` for the targeted lane shows N below the full count unless the scope result says `full` with a reason.
- AC3: over the next 30 PR runs on `next`, `gh api` job data shows no `test (ubuntu-latest, 24)` job over 10 minutes (current sample: 2 of 40 at 32 min).

*Item 2, Stryker incremental cache.* Depends on nothing.
- AC1: `mutation.yml` contains an `actions/cache` restore and save step for the incremental file (default `reports/stryker-incremental.json`), keyed per module.
- AC2: A second run of an unchanged module, from `gh api` job data, finishes in under 25% of the first run's duration; record both numbers in the PR.
- AC3: a nightly `workflow_dispatch`/schedule run with `--force` exists, and its failure opens an issue; the `state-document` shard's timeout is re-derived from post-cache measurements (`tests/ci-test-job-timeout-budget.test.cjs` still passes).
- AC4: ADR-456's `--since origin/next` statement is either shown to be a real flag (command output) or amended in the ADR.

**Phase 1 — cheap static gates (independent of Phase 0).**

*Item 3, actionlint + zizmor.*
- AC1: a job (or `lint-tests` step) runs pinned-version actionlint and zizmor on `.github/`; median runtime under 60 s measured over 10 runs.
- AC2: zero findings on `next` at merge time (all first-run findings fixed or, where a finding is a false positive, suppressed with a recorded reason in the zizmor config); the job is part of `Required tests` needs.
- AC3: a deliberately broken workflow on a scratch branch (for example `shell: ${{ matrix.shell }}`, #437) fails the job; the evidence is a run link in the PR body.

*Item 8a, slow-file budget ratchet.* Depends on item 5 (fresh durations) for its data source.
- AC1: a script reads the CI per-file durations artifact and `tests/test-timings.json`, fails when any non-allowlisted file exceeds the configured ceiling, and fails when an allowlisted file's measured time exceeds its recorded ceiling by more than a stated slack.
- AC2: allowlist = today's offenders at their current times (derivable from `tests/test-timings.json`); no new entries without an issue link.

**Phase 2 — critical path and compute.**

*Item 4, macOS shards.* Depends on #5053 merged (per #6148's triage note).
- AC1: `test.yml` `test-conformance` macOS rows have `shard: 1/3, 2/3, 3/3`; a darwin timing table exists and is consumed by the packer.
- AC2: over 20 `merge_group` runs after the change, the macOS shard max is under 25 min and the run-level median wall-clock (first job created to last completed, computed as in section 1.5) is under 30 min (current 34.6).
- AC3: `Required tests` still treats the lane as `success` or `skipped`.

*Item 5, timing refresh.* Depends on nothing.
- AC1: a scheduled workflow downloads the last 3 green `push` runs' duration artifacts, regenerates `tests/test-timings.json` (and win32/darwin tables), and opens a data-only PR via the same mechanism as `ci-timeout-report.yml`.
- AC2: after 14 days, Ubuntu shard 2/3 over 40 `merge_group`/`push` runs has zero runs at >=90% of its cap (current: 11 of 120 in the history log).

*Item 6, Windows packer.* Depends on #5053 only for ordering per #5807 triage.
- AC: the #5162 breach check in `ci-timeout-report.yml` reports `ok` (gap under 2.0 min, p90 below baseline) for two consecutive daily runs.

*Item 7, push dedup.* Depends on items 4-6 (so a wrongly skipped run does not hide a shard problem) and on an owner ruling (Q4).
- AC1: command output proves, on 10 sampled squash merges, whether `git rev-parse <next-sha>^{tree}` equals the tree of the corresponding `merge_group` head sha; the decision rule is recorded in the ADR.
- AC2: `scripts/ci-next-health.cjs` reads the merge-group conclusion (or the push run when the tree differs) with a unit test for both arms; `publish-emitted-baseline` still produces the baseline after every merge.
- AC3: runner-minutes per merge, computed as in section 1.5, drop from about 187 to under 25 on merges where the trees match.

**Phase 3 — selection, diagnostics, deeper static.**

*Item 10, shadow selection.* Depends on item 1 (scope telemetry) and item 5 (timings).
- AC1: on every PR, a non-required job computes the selection with `scripts/affected-tests-lib.cjs` and uploads the list; the full lane still runs and gates.
- AC2: a report job compares failing tests in the full lane with the selected set; the metric "failing test not in the selected set" is published daily.
- AC3: enforcement is considered only after 100 consecutive PR runs with that metric at 0 and every critical path forcing `full`; otherwise the verdict stays "reject".

*Item 9, leak-audit lane + failure ledger.* Depends on nothing.
- AC1: a scheduled workflow runs the unit suite without `--test-force-exit` and with a shared hook that records `process.getActiveResourcesInfo()` after each file; output artifact lists files with non-empty leaked resources; report-only.
- AC2: the ledger job aggregates per-file failures over the last 50 `next` runs and publishes the top 20; each entry becomes an issue (no-defer) or is shown to be a infrastructure failure.

*Item 12, type-aware promise rules and test-hygiene ESLint rules.* Depends on measuring lint cost first.
- AC1: a branch measurement records `npm run lint` wall time with `no-floating-promises` over `tests/**/*.cjs` (before/after in the PR); proceed only if added time is under 60 s.
- AC2: new rules ship at `warn`, flip to `error` after cleanup, per ADR-452.

**Phase 4 — maintainability.** Item 11 composite action: AC: `test.yml` steps for checkout/guard/rebase/setup/install are one `uses: ./.github/actions/...`; all `tests/ci-*.test.cjs` and `tests/workflow-*.test.cjs` pass (evidence via `gsd-test`, run by the implementing agent under the repo's policy).

**Dependency graph:** 1, 2, 3, 5 independent -> 8a needs 5 -> 4 needs #5053 -> 6 after 4 -> 7 needs 4,5,6 and Q4 -> 10 needs 1,5 -> 9, 12 independent -> 11 last.

### 3.3 Open decisions only the owner can make

1. **Q1 — gate ordering.** Should shards wait for a fast static tier? (a) Keep parallel (status quo; best green-path latency); (b) static tier of actionlint, zizmor, ESLint only, under 1 min, blocks shards; (c) full `lint-tests` blocks shards (adds 2.4 min to every green PR for a failure rate of 1 in 45 PRs in the sample). **Recommendation: (b)** only if measured under 60 s; else (a).
2. **Q2 — PR-lane OS coverage.** `GSD_PR_LINUX_ONLY=true` means Windows/macOS first run on the merge-group commit. Keep? (a) keep (current), (b) require a `full-matrix` label automatically for risky scopes (already possible), (c) restore Windows on PRs. **Recommendation: (a)**; the queue exists to absorb this.
3. **Q3 — paid larger runners.** Is a GitHub Team/Enterprise plan available, and may macOS/Windows conformance lanes use larger runners? (a) no spend, (b) larger macOS only, (c) larger macOS and Windows (enables Dev Drive consideration). **Recommendation: (a) now**, decide (b) after the macOS shard result.
4. **Q4 — push dedup.** May the post-merge `push` matrix be skipped when the merge-group run on an identical tree passed? (a) never, (b) skip only after tree-identity proof and updated health gate, (c) always skip. **Recommendation: (b).**
5. **Q5 — queue parameters.** `min_entries_to_merge: 2` with a 15 min wait delays a lone PR up to 15 min. (a) keep for batching economics, (b) set min 1, (c) raise `max_entries_to_build` above 2. **Recommendation: (b)** unless batch ejections are common; enqueue-to-merge latency should be measured first (not available from `gh run`).
6. **Q6 — wall-clock bounds.** `CLAUDE.md` bans wall-clock timeouts on git/npm subprocesses; the repo still has job-level `timeout-minutes`, a 600 s chunk timeout and 30 s probe bounds, and #6229 retires the lint rule demanding git/npm timeouts. Do job-level caps and the chunk watchdog stay as last-resort backstops? (a) yes, backstops only, with the detection work in 2.7 as the primary defense; (b) remove them. **Recommendation: (a)**, written into the ADR so agents do not treat job caps as a fix.
7. **Q7 — coverage location.** Run c8 on every PR shard (today) or only in merge-queue/push runs? **Recommendation:** trial after an A/B measurement; ruling needed because it changes when a coverage regression is first seen.
8. **Q8 — where required checks are enforced.** Live `main-protection` is `evaluate`; classic protection enforces the list and `strict: true` (section 1.1). Should the ruleset replace classic protection before CI redesign changes job names? **Recommendation:** yes, because job and check names are a public contract of this redesign.
9. **Q9 — retry/quarantine.** Confirm that no retry or quarantine lane is ever allowed (ADR-456 b, #5473 memo). **Recommendation:** confirm and record in the ADR.
10. **Q10 — selection ambition.** Is PR-lane test selection acceptable at all given #962 and ADR-4641? **Recommendation:** run shadow mode, decide on data.

### 3.4 Claims that could not be verified against a primary source (UNVERIFIED)

- "~61,000 tests": not counted here (1,204 files counted).
- Stryker `--since origin/next` as a real flag (ADR-456); the incremental docs page does not list it.
- `fast-check` default `numRuns` and `interruptAfterTimeLimit`/`configureGlobal` semantics (pages fetched did not state them).
- GitHub job-level `timeout-minutes` default; the 256-job matrix limit; `merge_group` behaviour of re-runs and of caches (the cache page does not mention `merge_group` refs).
- Whether the squash-merged tree equals the merge-group commit tree (needs the AC in Phase 2 item 7).
- Whether current ESLint rules already catch each listed leak shape (rule bodies not opened); `typescript-eslint` typed-lint performance page content.
- Knip's handling of this repo's `.cts`/`.cjs` mix; the Knip "Using Knip in CI" and CommonJS pages were not retrievable.
- Purpose and use of the optional `fallow` dependency.
- `CONTEXT.md` and `CONTRIBUTING.md` were not read in full for CI rules.
- Whether Node's default concurrency (`availableParallelism() - 1`) would beat the repo's forced 4 on the 3-vCPU macOS runner (not measured).
- That macOS slowness is caused by 3 vCPU/7 GB hardware (inference only).
- That `macos-15-intel` stays available for the repo's runner guard (page lists the label; retirement schedule not read).
- Whether the cause of the two disagreeing coverage-gate durations (1.0-1.2 min in the 135-run sample vs 5.3-5.7 min median in the history log) is cold install, a different step set, or a log definition difference.
- Per-file failure causes behind the red jobs in the sample (logs not parsed).
- Whether `GSD_PR_LINUX_ONLY` has always been `true` over the sample window (only the current value was read).
- All #5473 memo statements are that memo's, with its own UNVERIFIED list in its section 5.
