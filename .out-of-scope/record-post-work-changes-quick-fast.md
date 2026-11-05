# A `--record` mode on `/gsd-quick` and `/gsd-fast` to amend finished task artifacts

**Source:** [#5566](https://github.com/open-gsd/gsd-core/issues/5566)
**Decision:** wontfix — closed as filed; `resume <slug>` already re-enters a quick task and `/gsd-fast` has no artifact to amend
**Date:** 2026-10-20

## Proposal summary

#5566 asked for an opt-in `--record` flag on `/gsd-quick` and `/gsd-fast` (for example
`/gsd-quick --record <task-slug>`) that, after the execution workflow has ended, inspects the
follow-up work the developer did and amends the existing task artifact with an evidence-based
account of it, without starting a new task. The motivation was that edits made after a quick or
fast task finishes are missing from the task's summary, and the workaround is to ask the agent to
edit the summary by hand.

This entry denies **the `--record` flag as filed.** It does not deny the need for accurate task
summaries.

## Why GSD does not own this (as filed)

- **Quick already has a way back into a task.** `/gsd-quick` provides `list`, `status <slug>` and
  `resume <slug>` (`commands/gsd/quick.md`), and writes a per-task `SUMMARY.md` with
  `status: complete` plus a STATE.md "Quick Tasks Completed" row. The remaining gain over editing
  that summary is small.
- **`/gsd-fast` has no artifact to amend, by design.** `gsd-core/workflows/fast.md` forbids
  writing `PLAN.md` or `SUMMARY.md`; fast only appends a STATE.md table row. A `--record` mode
  for fast would need a new durable per-task reference and lifecycle, which the issue itself flags
  as a cost.
- **Forever-cost across runtimes.** A new flag on two commands must stay aligned across every
  runtime's command surface, docs and tests, and a mode that infers what happened from the working
  tree risks recording unsupported claims.

## What this does NOT cover

- Fixing `resume <slug>` if it misbehaves on an already-complete quick task is welcome as a bug
  report.
- Other ways to keep quick/fast records accurate that do not add a flag or a new fast artifact
  remain open to proposal.
- Phase and milestone recording were out of scope of #5566 and are not decided here.

## Re-open criteria

- A reproduction showing `resume <slug>` cannot be used to add follow-up work to a completed quick
  task, with the exact failure; or
- a design for `/gsd-fast` task references that does not add per-task state.

## Related

- [#5566](https://github.com/open-gsd/gsd-core/issues/5566)
- `commands/gsd/quick.md`, `gsd-core/workflows/quick.md`, `gsd-core/workflows/fast.md`
