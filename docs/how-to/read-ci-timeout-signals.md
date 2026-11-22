# How to read CI timeout budget signals

Every matrixed CI job (`test`, `test-conformance` in `.github/workflows/test.yml`;
`mutate` in `mutation.yml`; `smoke` in `install-smoke.yml`) now reports how close it ran to its
`timeout-minutes` cap. This page is for a maintainer trying to answer: *is a lane drifting
toward its cap, and where do I look?* (`test-conformance` runs the platform-conformance-tier file
list — `scripts/lib/platform-conformance-tier.generated.cjs` — on `windows-latest` and
`macos-latest`, each sharded as the job's matrix in `test.yml` declares; it is the sole gating
signal for real-OS coverage.)

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
cancelled before they started, with `completed_at` one second before `started_at`. A job cancelled
while it still waited for a runner never ran either, but GitHub gives it a `started_at` (when it was
queued) and a later `completed_at` (when it was cancelled), so its span is queue wait, not run time.
That shape is a `cancelled` conclusion with an empty `steps` list, `runner_id` 0 and an empty
`runner_name`; it has no row (#6177). All three must be present with exactly those values (`steps`
an empty list, `runner_id` the number 0, `runner_name` the empty string): a record that lacks any of
them, or carries another value, is not treated as never-run. A cancelled job that did run, such as one killed at its `timeout-minutes`
cap (it has steps and a runner), is still recorded (#5088).

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
  `tests/test-timings.json`, and on win32 from `tests/test-timings.win32.json` via
  `makeFileWeigher`'s `platformTimings` arm — #5071/#5097). **Never read a balanced packing as a
  balanced runtime:** LPT balances in its own weight units by construction, so it reports a
  perfect split whatever the real durations are. To see the truth, score each shard by summing
  its files' durations from a measured table for that platform. Before #5097 the Windows lane
  was the cautionary case — shards the packer scored identically ran 0.75x / 1.21x / 1.04x of an
  equal split (#5029) — and with win32 measurements in place that imbalance measures 1.01-1.02,
  so a long pole on this lane is now a capacity question rather than a mis-pricing one.
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

- The gap between the slowest and fastest shard's median must be at most `maxMedianGapMs`.
- No shard's p90 may be above its entry in `baselineP90Ms`.

Both values live only in `SHARD_BALANCE`, whose comment gives the rule each was derived by; this
page does not copy them. The runs they were measured on and the margin later runs leave are under
[Where the two thresholds come from](#where-the-two-thresholds-come-from). Since #5029 they
describe the layout `baselineShardTotal` names. The gap limit is
deliberately wider than the 2 minutes #5101 set for the ~30-minute shards of its day: on shorter
shards a single long test file moves one shard by minutes on its own.

**Where you see it.** Every run writes a table to the `shard-balance` step's summary. A breach, or
a baseline mismatch, also opens an issue titled **CI: Windows conformance shard balance
regressed**. If that issue is already open, the check comments on it instead, once per daily run,
until someone closes it.

| Status | What it means | What to do |
|---|---|---|
| `insufficient-data` | Fewer than `minRuns` qualifying runs so far, or fewer than two shards have data. Also right after a re-shard merges: the newest runs still use the old layout while the baseline's layout has fewer than `minRuns` complete runs (a run counts only when every shard of that layout reported a duration). | Nothing. It reports once enough `next` pushes land. |
| `ok` | Both criteria hold. | Nothing. |
| `breach` | The median gap is over `maxMedianGapMs`, or a shard's p90 is over its baseline. The issue lists which. | First find which kind of cost moved. In the slow shard's log, compare the `run-tests: chunk N/M completed in Xms` lines with a fast shard's. **One chunk far longer than the rest** means a single long test file sets that chunk's wall time (a chunk cannot finish before its longest file), and regenerating the timing table will not help; the fix is splitting that file, or packing that accounts for it. **Every chunk uniformly slower** across the run means a slow runner; wait for more runs. **The shard's chunks are all heavier than another shard's** points at weights: regenerate the win32 timing table ([Regenerate the win32 timing table](regenerate-the-win32-timing-table.md)), since a new heavy conformance file or a stale table mis-prices the split. |
| `baseline-mismatch` | The newest run's Windows shard count differs from `baselineShardTotal`, and the baseline's layout has at least `minRuns` complete runs. The lane was re-sharded away from it. | Measure the new layout and update `baselineShardTotal` and `baselineP90Ms` in `SHARD_BALANCE`. Until then, no gap or p90 verdict is given. A re-shard PR should already fail `tests/ci-timeout-report.test.cjs`, which checks this count against `test.yml`. |
| `error` | The GitHub API could not be read. The step logs a warning. | Re-run the workflow once the API is reachable. The per-job report step is unaffected. |

The check reads the newest 40 runs (twice `windowRuns`). So `baseline-mismatch` needs at least
`minRuns` of those to be complete baseline-layout runs: once they age out, a lane that really did move
reads `insufficient-data` and never `baseline-mismatch`. An issue already opened stays open, but
if `insufficient-data` lasts past `minRuns` pushes, compare the newest run's shard count with
`baselineShardTotal`.

The check never fails the workflow and never changes how shards are packed; it only reports.
Closing the tracking issue after a fix is up to you. A later breach opens a new one.

### Where the two thresholds come from

#5029 set both thresholds before `next` had any 6-shard push runs, so they were measured on PR
#5053's runs and on push runs of `test.yml` on the fork tarc/gsd-core. Once `next` has `minRuns`
6-shard push runs, re-derive both from those, by the rules in the `SHARD_BALANCE` comment.

**Gap limit.** Measured on the twelve 6-shard runs of PR #5053 whose heads carry #5097's win32
weights: 36785097774, 37024435915, 37031116287, 37037251805, 37041237415, 37086102648,
37138563782, 37694227292, 37697717410, 38647499912, 38650210804 and 38654860178. Their six
11-17 minute shards have a median gap of 332.5 s (5/6's median is 1011.5 s, 6/6's 679 s); 1.5
times that, rounded up, is `maxMedianGapMs`. The gap comes from single test files of 3.5-6.5
minutes that land in different chunks of different shards: on run 37697717410, `install` took
384 s, `codex-config-agents` 371 s, `verification-status` 219 s and `install-minimal-hooks` 218 s.

Those twelve runs predate #5803, and the margin under the limit depends on the partition. The
gaps measured since, computed as `evaluateShardBalance` computes them:

| Runs | Tier files | Median gap |
|---|---|---|
| the twelve fork runs the baselines come from (below) | 367-375, nine partitions | 229 s |
| PR #5053's 42078639141 and 42087947326, head `77b2d9a09` | 375 | 430.5 s (439 s and 459 s run by run) |
| twelve fork runs on the partitions `next` has had since #6002: 43136204917, 43136204941, 43136205083, 43140668487, 43140668934, 43140669065, 43248156906, 43253932817, 43253932847, 43253934459, 43253938926, 43253940560 | 319-330 | 265.5 s; single runs 328-586 s, and 2/6 is the slow shard (median 938 s, against 672.5 s for 5/6) |
| the newest twenty of those 26, the window the daily check reads | 319-375 | 268 s, `ok` |

So a window spanning the partitions `next` had then leaves about 235 s (47%) to spare, though
single runs there were already over the limit, and a window that sat on one unlucky partition
would leave about 70 s (14%). The limit was kept rather than re-derived because the two honest
re-derivations disagree: the twelve post-#6002 fork runs' gap (265.5 s) times 1.5 would be 398 s, under what one
partition already measures, and that partition's gap times 1.5 would be 646 s, sized to whichever
partition was sampled.

**Baselines.** A shard's time moves with the tree. #5803 refreshed `tests/test-timings.json`, and
`selectShard` re-packs the light files whenever the tier changes, so `next` went through nine
partitions in the 40 commits from #5803 to `d47f196d1`. Baselines measured on the PR runs above
read `breach` on those partitions (2/6's p90 was 957 s against 927.5 s). So the baselines come from
twelve fork push runs, one per partition plus three repeats, each a `next` commit from that span
merged with #5029: 42019488063, 42023851315, 42023856927, 42023862270, 42023868163, 42023874553,
42023879784, 42034547210, 42034552231, 42034559137, 42034565931 and 42034572698. All twelve ran on
one day, so they do not sample day-to-day runner variation. Their nearest-rank p90 of job
wall-clock per shard, which 1.25 times gives `baselineP90Ms`:

| Shard | 1/6 | 2/6 | 3/6 | 4/6 | 5/6 | 6/6 |
|---|---|---|---|---|---|---|
| p90 (ms) | 889000 | 957000 | 1028000 | 993000 | 904000 | 940000 |

The baseline is not the p90 itself because a fresh sample's p90 exceeds it too often: 3/6's own
twelfth value, 1047000, is already above 1028000.

The twelve post-#6002 fork runs in the gap table read `ok` against these baselines. Their p90s are
889000, 1125000, 999000, 973000, 749000 and 1034000 (1/6 to 6/6); 2/6 comes closest to its
baseline. One row of their 71 is above its baseline: 2/6 at 1335000 on run 43248156906, a slow VM
(the `test-conformance` `LANE_COSTS` entry in `tests/ci-test-job-timeout-budget.test.cjs`
describes it). On the 330-file partition 2/6 starts with a chunk that is one 4-5 minute file
(`codex-config-agents`), so it is the shard to watch.

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
