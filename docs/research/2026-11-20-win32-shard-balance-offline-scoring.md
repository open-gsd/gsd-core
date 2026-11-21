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

The scores file has every multiplier tried (1.2, 1.4, 1.6 and 2) for each study A table, and the current packer and × 2 for each study B table. Its `packer` column names them `current`, `isolated x 1.2`, `isolated x 1.4`, `isolated x 1.6` and `isolated x concurrency`; the last is × 2, because `--test-concurrency` is 2 on win32.

Study B, tables, scored on the same 21 runs:

| table | daily-check gap | per-run gap, median | long pole, median |
|---|---|---|---|
| committed on `next` at `263c6c45f` | 320 s | 408 s | 14m25s |
| regenerated from run 44559069895 | 62 s | 184 s | 13m04s |
| regenerated from run 44652354632 | 118 s | 174 s | 13m13s |

## Findings

1. **The proposed pricing widens the gap once the table is current.** Charging an isolated file twice its weight gives a wider per-run gap than the current packer in 26 of 26 runs with the table from the three previous runs, 25 of 26 with the table from the previous run, and 29 of 29 with the runs' own times (study A), and in 21 of 21 and 20 of 21 runs with the two regenerated tables of study B. On the stale committed tables it is wider in 17 of 29 runs (study A) and 8 of 21 (study B). Packed chunks reach only 1.45 to 1.9 times parallelism: a chunk cannot finish before its longest file, and its tail runs on one lane. The measured per-file durations already price that closely. Smaller multipliers do not settle on one value:
   - On the stale committed table, × 1.4 narrows the per-run gap in 22 of 29 runs and brings the daily-check gap from 292 s to 171 s.
   - On the table from the three previous runs, × 1.2 gives a daily-check gap of 43 s against 51 s for the current packer.
   - On the table from the previous run and on the runs' own times, every multiplier tried gives a wider daily-check gap than none (× 1.2: 137 s against 30 s, and 55 s against 32 s).
2. **The gap comes from the stale win32 table.** The table committed before #6374 was added on 2026-09-28 by #5097, from three shards; its only later change was #6361 renaming one entry. It had 280 entries, of which only 219 were files in the 344-file tier at `8a2b9be6f`, so 125 tier files were weighed by their Linux time. Regenerating it brings the daily-check gap from about 300 s to 30-120 s and takes 1 to 1.5 minutes off the median long pole.
3. **One run is the right source, as `docs/how-to/regenerate-the-win32-timing-table.md` says.** The generator keeps each file's maximum across the streams it is given, which biases a multi-run table towards slow runs. A table from the single previous run scored a 30 s daily-check gap against 51 s for a table from the three previous runs.
4. **A one-run table carries that run's noise.** Each source run is compared with every file's median over the other 22 study B runs, counting the files that took at least 10 s in the source run:
   - run 44652354632 (the table #6374 ships): 118 such files, 12 of them off their median by a factor beyond 1.5 either way (a ratio above 1.5 or below its inverse, 0.667), summed time 4.5% above the medians;
   - run 44559069895 (#6374's first commit): 131 files, 18 off, summed 6.3% above.

   The two regenerated tables in study B differ by about as much as that noise. In run 44652354632, the 12 files off their median are `installer-migrations` (46.3 s against 13.6 s, × 3.40), `defaults-json-fallback` (× 2.36), `kimi-config-toml-symlink` (× 2.24), `gate-tdd-review-checkpoint.unit` (× 2.23), `agent-install-validation` (× 1.88), `review-lane-availability` (× 1.75), `hermes-skills-migration` (× 1.67), `packaging-shipped-scripts-require-only-shipped` (× 1.54), `verify` (× 0.67: 0.666, just below 0.667), `commands.platform` (× 0.61), `verification-status` (× 0.55) and `context-drift` (× 0.52).

   For the files the #6374 review flagged, the same run gives:
   - `install-write-confinement` × 1.00, `capability-source` × 0.82, `windsurf-hooks-bridge` × 0.74 and `emitted-attribution` × 0.84;
   - the four near-zero files take under 50 ms on every study B run, so a ratio means little at that size. From the unrounded run values, `undo-commit-selection-4465` took 31.7 ms (× 1.40) and `gsd-validate-commit-sigpipe` 10.7 ms (× 1.44); the table rounds them to 32 ms and 11 ms, which give × 1.41 and × 1.49. `opencode-install-notices`, `undo-commit-selection-4465` and `gsd-validate-commit-sigpipe` skip on win32 at file or suite level, and `hook-activation-probe` skips its individual tests on win32.

## Limits

- These are simulations from measured per-file times, validated against the real test step. The regenerated table's first real run is the merge queue's, after which the daily shard-balance check measures it.
- The tier changed several times a day while these runs were collected (344 files at `8a2b9be6f`, 352 at `263c6c45f`). A file added after a regeneration is weighed by its Linux time until the next one (ADR-6315 item 6, #6322, schedules that).
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
