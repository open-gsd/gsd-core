---
id: 160
title: Archive Quick Tasks at Milestone Close
group: v1.7.0 Features
---

**Command:** `/gsd-complete-milestone` (forward path), `/gsd-cleanup` (retroactive path), `gsd-tools milestone complete --archive-quick` / `gsd-tools milestone archive-quick <version>` (#2142)

**Behavior:** `.planning/quick/` otherwise accumulates one directory per `/gsd-quick` task forever. `/gsd-complete-milestone` now offers a Yes/Skip prompt — when accepted, it moves every directory under `.planning/quick/` into `.planning/milestones/<version>-quick/`, (re)writes that archive directory's `README.md` (an index built by scanning the archive directory, one entry per task, linked to its `SUMMARY.md` when one exists), and clears the data rows of `STATE.md`'s `### Quick Tasks Completed` table while preserving its header and detected column variant. `/gsd-cleanup` offers the same archival retroactively, for milestones that were already closed before their quick tasks were swept, via the narrower `milestone archive-quick <version>` command — identical move/index/reset behavior, but without touching `ROADMAP.md`, `REQUIREMENTS.md`, `MILESTONES.md`, or milestone-completion guards, so it can be re-run safely against an already-completed milestone.

The reasoning for each choice (opt-in by default, one bucket per milestone, an index built from disk rather than from `STATE.md`) is in [Quick-task archival explained](explanation/archive-quick-tasks.md).

**Known limits:**
- No per-milestone provenance — bucket-all is the only option (see above).
- A `### Quick Tasks Completed` table whose columns match neither registered variant (with/without a Status column) is left untouched with a warning rather than reset, since clearing it would risk destroying rows under a schema GSD doesn't recognize.
- A `STATE.md` with no `### Quick Tasks Completed` section at all is a normal, silent no-op for the reset step — the section is created lazily by `/gsd-quick`, not present in the project template.

See [Archiving quick tasks](how-to/handle-quick-and-fast-tasks.md#archiving-quick-tasks) for the full walkthrough.
