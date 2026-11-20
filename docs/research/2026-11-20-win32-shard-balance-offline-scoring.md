# Windows conformance shard balance: offline scoring of the packer and the win32 table

Date: 2026-11-20. Issue: #5807. PR: #6374.

## Question

#5807 proposed changing `selectShard` in `scripts/run-tests.cjs` so that an isolated test file (one that runs in a chunk of its own) is charged more than its weight, because packed files run two at a time on Windows. This note checks that proposal against measured Windows times, and checks whether the committed win32 timing table (`tests/test-timings.win32.json`) is what sets the gap between the slowest and fastest of the six Windows conformance shards.

## Data

Two sets of `test.yml` runs on `next`, each with all six `conformance test (windows-latest, 24, shard i/6)` jobs complete, and their `test-timings-windows-latest-job*` artifacts (one `test:summary` event per test file with its `duration_ms`):

- **Study A:** 29 runs (14 push, 15 `merge_group`) from #5053's merge (`efe57b498`, 2026-11-18) to `2e443081b` (#6361). Used to compare packers.
- **Study B:** 23 push runs from `8a2b9be6f` to `263c6c45f` (2026-11-19 to 2026-11-20), all after #6361. Used to compare timing tables. Two of them are table sources and are not scored.

Files in `docs/research/data/`:

- `2026-11-20-win32-shard-balance-runs.tsv`: every run, its event, head commit, time and role.
- `2026-11-20-win32-shard-balance-scores.tsv`: one row per study, table, packer and run, with the simulated seconds of each shard, the gap and the long pole.
- `2026-11-20-win32-shard-balance-simulator-validation.tsv`: simulated against real test-step seconds for every shard of every run.

The artifacts expire 14 days after each run, so the per-shard results are recorded here rather than the raw per-file times.

## Method

**Partition.** For each run, the partition is rebuilt with the functions `scripts/run-tests.cjs` exports, from the tier list (`scripts/lib/platform-conformance-tier.generated.cjs`) and both timing tables at the run's head commit. The steps are the ones `main()` takes for `--files-from <tier> --shard i/6` on win32:

1. strip `tests/` and sort;
2. `makeFileWeigher` and `makeMeasuredPredicate`;
3. `selectShard`;
4. `partitionIsolatedFiles`, with the threshold `ISOLATION_BUDGET_FRACTION × CHUNK_WORKING_BUDGET_MS / mean`;
5. `packChunks`, with the win32 caps (22 weight units, 2 unmeasured files per chunk).

**Chunk model.** Chunks run one after another. Inside a chunk, files start in argv order on two lanes (`--test-concurrency=2`), each taking the first free lane, and run for the `duration_ms` that run measured for them. A shard's time is the sum of its chunks' finishing times plus a fixed cost per chunk, fitted by least squares: 3.0 s for study A and 3.3 s for study B.

**Scoring.** Every packer and table is scored against the same run's measured per-file times, so each comparison is paired run by run. "Daily-check gap" is what `evaluateShardBalance` (`scripts/ci-timeout-report.cjs`) computes: the slowest minus the fastest per-shard median over the runs. "Per-run gap" is the slowest minus the fastest shard within one run.

## Validation

| | Study A | Study B |
|---|---|---|
| Shards whose rebuilt file set equals the run's artifact | 174 of 174 | 138 of 138 |
| Simulated against real test step, median absolute error | 0.4% | 0.5% |
| Worst error | 2.0% | 3.8% |
| Slowest shard named correctly | 27 of 29 runs | 23 of 23 runs |

## Results

Study A, packers (each row also gives the table the packer read):

| table | packer | runs | daily-check gap | per-run gap, median | long pole, median |
|---|---|---|---|---|---|
| committed at the run commit (what CI used) | current | 29 | 292 s | 397 s | 15m34s |
| committed at the run commit | isolated file × 2 (the #5807 proposal) | 29 | 315 s | 394 s | 15m37s |
| committed at the run commit | isolated file × 1.4 | 29 | 171 s | 293 s | 15m17s |
| regenerated from the 3 previous runs | current | 26 | 51 s | 168 s | 14m23s |
| regenerated from the 3 previous runs | isolated file × 2 | 26 | 220 s | 298 s | 15m09s |
| regenerated from the previous run | current | 26 | 30 s | 183 s | 14m08s |
| regenerated from the previous run | isolated file × 2 | 26 | 233 s | 283 s | 15m16s |
| regenerated from the previous run | isolated file × 1.4 | 26 | 196 s | 244 s | 14m28s |
| the run's own times | current | 29 | 32 s | 68 s | 13m27s |
| the run's own times | isolated file × 2 | 29 | 182 s | 202 s | 14m18s |

The scores file has every multiplier tried (1.2, 1.4, 1.6, 2) for each table.

Study B, tables, scored on the same 21 runs:

| table | daily-check gap | per-run gap, median | long pole, median |
|---|---|---|---|
| committed on `next` at `263c6c45f` | 320 s | 408 s | 14m25s |
| regenerated from run 44559069895 | 62 s | 184 s | 13m04s |
| regenerated from run 44652354632 | 118 s | 174 s | 13m13s |

## Findings

1. **The proposed pricing makes the shards less even.** With a current table, charging an isolated file twice its weight widens the gap in every run (26 of 26 and 29 of 29 in study A, and again in study B). Packed chunks reach only 1.45 to 1.9 times parallelism: a chunk cannot finish before its longest file, and its tail runs on one lane. The measured per-file durations already price that closely, so the current packer with good weights is the best of the variants tried. A multiplier helps only on the stale table (× 1.4 there), by compensating for wrong weights.
2. **The gap comes from the stale win32 table.** The table committed before #6374 was added on 2026-09-28 by #5097, from three shards; its only later change was #6361 renaming one entry. It had 280 entries, of which only 219 were files in the 344-file tier at `8a2b9be6f`, so 125 tier files were weighed by their Linux time. Regenerating it brings the daily-check gap from about 300 s to 30-120 s and takes 1 to 1.5 minutes off the median long pole.
3. **One run is the right source, as `docs/how-to/regenerate-the-win32-timing-table.md` says.** The generator keeps each file's maximum across the streams it is given, which biases a multi-run table towards slow runs. A table from the single previous run scored a 30 s daily-check gap against 51 s for a table from the three previous runs.
4. **A one-run table carries that run's noise.** In each of the two source runs, 15 to 18 of the roughly 130 files over 10 s differ from their median over the other study B runs by more than × 1.5, while the summed time stays within 4 to 6% of the medians. The two regenerated tables in study B differ by about as much as that noise. The files flagged in the #6374 review are real Windows behaviour: their values in run 44559069895 lie within × 0.6 to 1.2 of their 22-run medians. The four near-zero files (`opencode-install-notices`, `undo-commit-selection-4465`, `hook-activation-probe`, `gsd-validate-commit-sigpipe`) skip their tests on win32.

## Limits

- These are simulations from measured per-file times, validated against the real test step. The regenerated table's first real run is the merge queue's, after which the daily shard-balance check measures it.
- The tier changes with almost every merge. A file added after a regeneration is weighed by its Linux time until the next one (ADR-6315 item 6, #6322, schedules that).
- Per-file times move with the tests themselves (#6361 and the other in-process items of ADR-6315).

## Reproducing

Download a run's Windows artifacts with `gh run download <run id> --repo open-gsd/gsd-core --pattern 'test-timings-windows-latest-*' --dir <dir>`, then rebuild and simulate as below, with `rt = require('./scripts/run-tests.cjs')` at the run's head commit.

```js
// Partition, as main() computes it on win32.
function rebuild(rt, tierFiles, timingsPath, win32TimingsPath, total) {
  const names = [...new Set(tierFiles.map((v) => v.replace(/^tests\//, '')))].sort();
  const timings = rt.loadTestTimings(timingsPath);
  const platformTimings = rt.loadTestTimings(win32TimingsPath);
  const weightOf = rt.makeFileWeigher(timings, 'win32', platformTimings);
  const isMeasured = rt.makeMeasuredPredicate(timings, platformTimings);
  const thresholdWeight = (rt.ISOLATION_BUDGET_FRACTION * rt.CHUNK_WORKING_BUDGET_MS) / timings.mean;
  return Array.from({ length: total }, (_, k) => {
    const slice = rt.selectShard(names, { index: k + 1, total }, weightOf);
    const { isolated, packable } = rt.partitionIsolatedFiles(slice, { weightOf, isMeasured, thresholdWeight });
    return [...isolated.map((f) => [f]), ...rt.packChunks(packable, {
      weightOf, maxWeight: 22, maxChars: 28000, fixedOverhead: 400, isMeasured, maxUnmeasuredPerChunk: 2,
    })];
  });
}

// One shard's seconds: chunks in order, two lanes per chunk, plus a per-chunk cost.
function shardSeconds(chunks, msOf, perChunkMs) {
  let total = 0;
  for (const chunk of chunks) {
    const lanes = [0, 0].slice(0, Math.min(2, chunk.length));
    for (const f of chunk) {
      const i = lanes.indexOf(Math.min(...lanes));
      lanes[i] += msOf(f);
    }
    total += Math.max(...lanes) + perChunkMs;
  }
  return total / 1000;
}
```
