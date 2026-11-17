# How to read CI timeout budget signals

Every matrixed CI job (`test`, `test-conformance` in `.github/workflows/test.yml`;
`mutate` in `mutation.yml`; `smoke` in `install-smoke.yml`) now reports how close it ran to its
`timeout-minutes` cap. This page is for a maintainer trying to answer: *is a lane drifting
toward its cap, and where do I look?* (`test-conformance` runs the platform-conformance-tier file
list — `scripts/lib/platform-conformance-tier.generated.cjs` — on `windows-latest`, sharded three
ways, and `macos-latest`, unsharded; it is the sole gating signal for real-OS coverage.)

## 1. A single run crossed 90% of its budget

Open the job's page in the Actions run — two places show it, both populated by the same
computation (`scripts/lib/ci-job-timing.cjs`):

- **The Checks tab annotation.** A `::warning::` line renders as an expandable warning banner
  on the PR's Checks summary, naming the job, its elapsed time, its cap, and the percentage —
  visible without opening the job's logs.
- **The job's step summary.** The same information, as a Markdown line, appended to the job's
  own summary page (`$GITHUB_STEP_SUMMARY`) by that job's own "Check job budget (near-cap
  advisory)" step — always the job's last step.

Neither signal fails the job. A near-cap warning on an otherwise-green run means exactly what
it says: this run finished, but with less margin than the headroom-factor gate assumes it has.

**If the warning never appears even on a job that was actually cancelled at its cap**, that is
expected — a killed job never reaches its last step, so the in-job check never runs. See §2.

## 2. Checking the accumulated trend

`.github/workflows/ci-timeout-report.yml` runs daily (and on-demand via `workflow_dispatch`). It
polls GitHub's Actions REST API directly — independent of whether any individual job's own
near-cap step ran — so it also catches jobs that were actually cancelled by a timeout breach
(GitHub's Jobs API still reports `started_at`/`completed_at` for a cancelled job).

A job that never ran has no row. That covers a `skipped` job, and any job whose `completed_at` is
missing, unparseable, or not later than its `started_at`. GitHub reports skipped jobs, and jobs
cancelled before they started, with `completed_at` one second before `started_at`. A cancelled job
that did run, such as one killed at its `timeout-minutes` cap, is still recorded (#5088).

Each run's new rows land in `tests/ci-timeout-budget-history.jsonl`, one JSON object per line:

```json
{"runId":123456,"jobName":"test (ubuntu-latest, 24, shard 1/3)","workflowFile":"test.yml","sha":"...","completedAt":"...","elapsedMs":432000,"timeoutMinutes":15,"pct":0.8,"runEvent":"push"}
```

`runEvent` matters for `install-smoke.yml`'s `smoke` job specifically — its `pull_request` runs
use a smaller matrix (no `macos-latest` `full_only` row) than its `push` runs, so a `pct` figure
only means the same thing across rows sharing the same `runEvent`.

Because `next` is a protected branch, the report never pushes directly to it — each scheduled
run updates one rolling, data-only PR on the branch `chore/4036-ci-timeout-budget-history`, titled
`chore(#4036): CI timeout budget history update`. Each run rebuilds that branch on the current
`next` tip with every pending row, so it never conflicts. The workflow approves the PR when it is
provably its own data-only PR, then auto-merges it once required checks pass; until the org
allows GitHub Actions to approve PRs, it waits for one human approval (the run logs a warning).
There is nothing to review beyond "did the numbers land."

## 3. A lane is repeatedly near-cap — what to do

Neither mechanism here decides what to do about a lane that's genuinely trending toward its
cap. That is a maintainer call among three options, each with real tradeoffs:

- **Raise the `timeout-minutes` cap** for that job.
- **Rebalance the shard split** so no single shard carries a disproportionate share of the
  suite (see `scripts/run-tests.cjs`'s `selectShard`, which packs shards by measured cost from
  `tests/test-timings.json`).
- **Trim what runs on the long-pole shard** — for the `test` job, shard 1 also carries the
  unsharded aux suites (integration/security/install/slow); moving one elsewhere changes what
  shard 1 costs.

`tests/ci-test-job-timeout-budget.test.cjs` will keep failing to accept a lowered
`timeout-minutes` beneath 1.5x whatever `LANE_COSTS`/`COVERED[*].timeoutMinutes` records as that
job's last measured cost — raising the cap back down is not something either mechanism will
silently allow.

## 4. The Windows conformance shards drift apart

The same daily workflow runs a second, separate step, `shard-balance` (#5101). It checks the
Windows conformance shards against each other, which the per-job cap check above never does. The
thresholds are the #5071 acceptance criteria, kept in one place: `SHARD_BALANCE` in
`scripts/ci-timeout-report.cjs`.

**What it reads.** Completed `next` push runs of `test.yml` created after 2026-09-28T14:17:51Z
(the #5097 merge), newest 20 first. From each, it reads the durations of the
`conformance test (windows-latest, …, shard i/n)` jobs. A job that never ran is left out, and a
shard cancelled after it ran (killed at its cap) counts.

**What it checks.**

- The gap between the slowest and fastest shard's median must be at most 2 minutes.
- No shard's p90 may be above its baseline: shard 1/3 30.4 min, shard 2/3 34.1 min, shard 3/3
  36.8 min.

**Where you see it.** Every run writes a table to the `shard-balance` step's summary. A breach, or
a baseline mismatch, also opens an issue titled **CI: Windows conformance shard balance
regressed**. If that issue is already open, the check comments on it instead, once per daily run,
until someone closes it.

| Status | What it means | What to do |
|---|---|---|
| `insufficient-data` | Fewer than 10 qualifying runs so far, or fewer than two shards have data. | Nothing. It reports once enough `next` pushes land. |
| `ok` | Both criteria hold. | Nothing. |
| `breach` | The median gap is over 2 minutes, or a shard's p90 is over its baseline. The issue lists which. | Regenerate the win32 timing table ([Regenerate the win32 timing table](regenerate-the-win32-timing-table.md)). A new heavy conformance file, or a stale table, is the usual cause. If the gap persists with a fresh table, look at per-chunk overhead: the shard with more, smaller chunks pays more process startup. |
| `baseline-mismatch` | The newest run's Windows shard count differs from the baseline's (3). The lane was re-sharded. | Measure the new layout and update `baselineShardTotal` and `baselineP90Ms` in `SHARD_BALANCE`. Until then, no gap or p90 verdict is given. |
| `error` | The GitHub API could not be read. The step logs a warning. | Re-run the workflow once the API is reachable. The per-job report step is unaffected. |

The check never fails the workflow and never changes how shards are packed; it only reports.
Closing the tracking issue after a fix is up to you. A later breach opens a new one.

## Line a failing test up against the spawn-stall watcher (#5473)

A bounded child that runs to its timeout used to fail as `null !== 0`. Every spawn made through
`tests/helpers/process-seam.cjs` now records when it started, how long it took and its pid, and a
slow or killed spawn leaves a line in the uploaded `test-timings-<os>-job<n>` artifact.

1. Open the artifact's `.jsonl` and find lines with `"type":"seam:spawn-stall"`. A spawn is
   recorded when it took 2 s or longer (`GSD_SEAM_SLOW_SPAWN_MS` changes the bound), was killed, or used at least half of its own timeout (a near-miss). Every shared bound is 5 s or more, so with the default threshold a near-miss adds no records; it adds the fields below to records already written, and adds records only for a bound under 4 s or a raised `GSD_SEAM_SLOW_SPAWN_MS`. Each record carries `boundFraction` (duration divided by timeout, floored to three decimals) and `nearMiss`. A class creeping toward its bound shows as a rising `boundFraction`.
2. Read `file` (the test file), `command` and `argv` (first three arguments), `outcome`
   (`timed_out`, `killed`, `exited`), `signal`, `durationMs`, `timeoutMs`, `pid`, and the UTC
   `startedAt`/`endedAt`.
3. Compare `startedAt`..`endedAt` with that shard's `spawn-stall watcher` section in the job log
   (also UTC). A loop gap or slow probe inside the window means the VM stalled. None means only the
   child hung. The pid lets you match a process the watcher snapshotted.
4. `gen-test-timings.cjs` ignores these lines; they do not affect the timing tables.

Tests that assert on a seam result can use `assertSeamExit(assert, result, 0)`, which names the
outcome, signal and duration in its failure message, or put `result.summary` in their own message.

## Reproduce the evidence numbers

The CI figures in `tests/helpers/timeouts.cjs` `TIMEOUT_EVIDENCE` (observed max, p50, p99, samples, lanes, unseen sites) come from the `seam:spawn-stall` records above. `scripts/timeout-evidence-from-ci.cjs` recomputes them from the repository and the downloaded artifacts. Downloading is a separate step; the script never contacts the network.

1. List the successful `test.yml` runs of the `push` and `merge_group` events created after the window start, then download each run's timing artifacts into `<dir>/<run id>/`:

   ```sh
   gh run list --workflow test.yml --event push --status success --created ">=2026-10-25" --limit 400 --json databaseId,createdAt
   gh run download <run id> --pattern 'test-timings-*' --dir <dir>/<run id>
   ```

   `2026-10-25` is the window start in `CI_WINDOW` (`tests/helpers/timeouts.cjs`).

   Repeat the list with `--event merge_group`. `gh run download --help` states that when only a single artifact is specified it is extracted into the target directory itself, and otherwise one folder per artifact name is created. The script reads both layouts, `<dir>/<run id>/<artifact name>/*.jsonl` and `<dir>/<run id>/*.jsonl`, and takes the platform from the artifact folder name or, failing that, the file name (`ubuntu`, `windows` or `macos`). It exits 2 when it finds no lane file or a lane whose platform it cannot determine. Expired artifacts cannot be downloaded and are skipped.

2. Run the script from the repository root:

   ```sh
   node scripts/timeout-evidence-from-ci.cjs --artifacts <dir> --format md
   ```

   `--format json` prints the full figures, and `--repo <root>` points it at another checkout. `--raw-sites` prints the call sites that spawn outside the process seam, grouped by constant, as `- [ ] tests/x.test.cjs:LINE (CONSTANT)` lines.

A record is credited to a constant by call site: the record's test file (or a helper it requires) has a seam call site of that constant, the record's `timeoutMs` equals the constant's value, and its command matches the site's callee. A site reached only through a shared helper must also show one of its own string literals in the record's argv, otherwise the record stays unmatched. A record that still matches two constants after narrowing by argv is credited to neither and counted as ambiguous. The script reports any call site it could not classify (`unresolvedSites`) and any manual resolution that matched nothing (`unusedResolutions`); resolve either in `MANUAL_RESOLUTIONS` in the script.
