# Quick-task archival explained

Why archiving `.planning/quick/` at milestone close works the way it does: opt-in, one bucket, and an index built from disk. What it does and how to run it is in [feature 160 of the feature reference](../FEATURES.md#160-archive-quick-tasks-at-milestone-close).

## Why it is opt-in

 Phase-directory archival is default-ON (#1871) — omitting a phase directory from an archive would silently leave stale execution history in the way of the next milestone's roadmap. Quick tasks carry no such downstream conflict, so archival here defaults OFF: a user who never passes `--archive-quick` sees zero behavior change. This is a deliberate asymmetry with phase archival, not an oversight.

## Why everything goes into one bucket

 `.planning/quick/` is a flat directory with no on-disk record of which milestone a given task belongs to. Splitting tasks per milestone was considered and rejected — inferring provenance from dates (creation time vs. a milestone's shipped date) is a proxy, not a fact, and a wrong inference on a one-way `mv` is silently irreversible. Archival instead buckets everything currently in `.planning/quick/` into the one milestone being completed (or, on the retroactive path, the one milestone chosen), and says so in the confirmation prompt.

## Why the index is built from disk

 The `### Quick Tasks Completed` table is a running log a workflow step appends to — it demonstrably drifts from what's actually in `.planning/quick/` (the motivating case: 53 rows against 49 directories, ~22 rows pointing at directories that no longer existed, 18 directories with no row at all). Building the archive's `README.md` index by scanning the archive directory itself, rather than trusting the table, means the index can never inherit that drift; a re-run's index also naturally includes entries a prior run already archived, since it's re-derived from what's physically present.
