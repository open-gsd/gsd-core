# Regenerate the win32 timing table

On `win32`, `scripts/run-tests.cjs` packs the conformance shards from
`tests/test-timings.win32.json`, a table of per-file durations measured on the
Windows CI runners (#5071). This page shows how to rebuild that table from a
fresh CI run. For what the table does and how its weights relate to the Linux
table, see [Platform-measured timings (win32)](../TESTING-SUITES.md#platform-measured-timings-win32).

**When:** the three `conformance test (windows-latest, …)` shards drift apart
again (a gap of more than a couple of minutes between their durations), or the
conformance tier gains or loses expensive files. Not on a schedule.

Like the Linux table, it is advisory: nothing fails when it goes stale. Files it
does not cover fall back to their Linux weight, or to the 2.2 unmeasured
fallback.

Every `conformance test (windows-latest, …)` job in `test.yml` writes its
per-file durations to a `test-timings-windows-latest-job<N>` artifact, on red
runs too (the macOS job uploads `test-timings-macos-latest-job<N>` the same
way). Artifacts are kept for 14 days.

## Steps

1. Pick one recent, fully completed `Tests` run that ran the conformance jobs: a
   push to `next`, or a `workflow_dispatch` of `test.yml`. Pull-request runs
   skip these jobs unless the change needs the full matrix.
2. Download the three Windows artifacts:

   ```bash
   gh run download <run-id> --repo open-gsd/gsd-core \
     --pattern 'test-timings-windows-latest-*' --dir /tmp/win-timings
   ```

3. Build the table:

   ```bash
   node scripts/gen-test-timings.cjs --platform win32 /tmp/win-timings/*/*.jsonl
   ```

   `--platform win32` writes `tests/test-timings.win32.json` and records
   `"platform": "win32"` in it. `--out` still overrides the path.
4. Commit the regenerated file.
5. Check the next Windows conformance run. Each shard's log carries a line
   right after its `run-tests: shard=` line:

   ```text
   run-tests: platform-timings=win32 weighed=94/94
   ```

   `weighed` near the shard's file count means the table covers the tier. No
   such line means the table did not load, and that shard was packed from
   Linux weights.

## Why one run

Use all three shards of **one** run. Each shard runs a disjoint slice of the
tier, so together they price every file once. The generator keeps the max for a
file seen more than once, so mixing runs biases the table toward each file's
slowest run.

## When something looks wrong

| What you see | What it means |
|---|---|
| ``gen-test-timings: no `test:summary` events…`` and exit 2 | The files are empty or not run-tests exports. A shard that died before its first chunk finished uploads an empty or missing file. |
| An artifact missing for one shard | That job never reached the upload step (cancelled before it started). Pick another run. |
| `run-tests: WARNING: could not append per-file durations…` in a job log | The export path was not writable. That job's artifact is incomplete. |
| `the win32 chunk budget, priced by the committed win32 table, fits the working budget` fails after regenerating | Windows has become slow enough that 22 weight units (`RUN_TESTS_MAX_FILES_PER_CHUNK` on win32) now cost more than the 400s working budget. Re-derive the win32 cap from the new table before committing it. |
