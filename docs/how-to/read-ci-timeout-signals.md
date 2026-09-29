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
run updates one rolling, data-only PR on the branch `automation/ci-timeout-report`, titled
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
