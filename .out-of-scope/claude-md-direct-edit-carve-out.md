# A "judge by the change" carve-out that lets agents edit directly outside a GSD workflow

**Source:** [#5036](https://github.com/open-gsd/gsd-core/issues/5036)
**Decision:** wontfix — partially approved; this half was denied, and adding `/gsd-fast` to the entry-point list was approved
**Date:** 2026-09-27

## Proposal summary

#5036 asked for two changes to the generated `## GSD Workflow Enforcement` section that GSD writes into a project's `CLAUDE.md` (built by `buildClaudeMdWorkflowEnforcement` in `src/profile-output.cts`):

1. List `/gsd-fast` as an entry point ahead of `/gsd-quick`.
2. Add a "judge by the change, not the rule" paragraph. It would say that a one-line fix, typo, rename, or doc tweak "should be made directly", and that only changes that arm a destructive path or change guard/safety semantics must always go through a workflow.

Item 1 was approved. **This entry records the denial of item 2.**

## Why GSD does not own this

- **The flat rule is deliberate.** The generated section closes with "Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it." That rule stays. A size-based exemption turns a rule anyone can check into a judgment call made by the same agent the rule constrains.
- **The lightweight path already exists, and it is still a workflow.** `/gsd-fast` (`commands/gsd/fast.md`, `gsd-core/workflows/fast.md`) handles trivial work (at most 3 file edits, no research, no subagents, no PLAN.md). It still gates on scope, commits atomically with a conventional message, and, when STATE.md has a Quick Tasks table, logs a row to it. A direct edit does none of those things. The overhead complaint in #5036 is that agents default to `/gsd-quick` for trivial work. Surfacing `/gsd-fast` fixes that (item 1) without opening a workflow-free lane.
- **The proposal is right about the symptom.** Agents do route trivial changes through `/gsd-quick`'s planner/executor pipeline because `/gsd-fast` is missing from the generated list. That is not a ground for rejection. It is exactly why item 1 was approved.

## What this does NOT cover

This entry denies **only** adding generated text that tells agents to make repo edits directly, outside any GSD workflow, based on how small the change is. It does not deny, and must not be cited against:

- **Listing `/gsd-fast` (or any other shipped command) as an entry point** in the generated section. That is item 1 of #5036, which was approved.
- **Improving how the generated section describes when to use `/gsd-fast` versus `/gsd-quick` versus `/gsd-debug`**, for example by quoting each command's own scope criteria.
- **Changes to `/gsd-fast`'s own scope check** (its edit-count or time thresholds), which are that workflow's concern.
- **The existing escape hatch**: the user explicitly asking to bypass a workflow stays as it is.

## Re-open criteria

- The generated section's workflow rule is removed or made opt-in project-wide by a recorded decision (an ADR), so that a direct-edit lane no longer contradicts a standing rule.
- Or `/gsd-fast` is retired without a lightweight replacement, which would leave no workflow proportionate to trivial changes.

## Related

- [#5036](https://github.com/open-gsd/gsd-core/issues/5036) — source issue (item 1 approved as `approved-enhancement`)
- `commands/gsd/fast.md`, `gsd-core/workflows/fast.md` — the lightweight workflow this entry points to
- [`docs/how-to/handle-quick-and-fast-tasks.md`](../docs/how-to/handle-quick-and-fast-tasks.md) — how to pick between `/gsd-quick` and `/gsd-fast`
