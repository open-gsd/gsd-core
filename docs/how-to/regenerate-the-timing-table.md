# Regenerate the timing table

The packer that splits the suite into chunks reads `tests/test-timings.json`, a table of per-file durations. This page shows how to rebuild it. For what the table does and how its weights are used, see [Chunk packing and the test timing table](../TESTING-SUITES.md#chunk-packing-and-the-test-timing-table); for the Windows table, see [Regenerate the win32 timing table](regenerate-the-win32-timing-table.md).

Regenerate when the suite's cost profile has visibly drifted — after adding or
removing expensive tests, not on a schedule. The input is a `node:test` reporter
event stream from a `gsd-test` run:

```bash
node scripts/gen-test-timings.cjs \
  ~/.local/state/gsd-test/runs/<run-id>/test-events-linux-node24.jsonl \
  ~/.local/state/gsd-test/runs/<run-id>/test-events-macos-node24.jsonl
```

Pass every lane you have. A file's recorded time is the **max** across the
supplied streams, not the mean: the packer exists to keep the *slowest* lane's
slowest chunk away from the timeout, so the conservative bound is the right one.
Keys are sorted so a regeneration diff shows only the files whose cost moved.
