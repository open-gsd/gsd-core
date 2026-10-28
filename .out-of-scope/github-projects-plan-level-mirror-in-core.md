# A plan/task-level GitHub Projects mirror built into core

**Source:** [#2763](https://github.com/open-gsd/gsd-core/issues/2763)
**Decision:** wontfix — redirected to [projects-sync-capability#2](https://github.com/The-Artificer-of-Ciphers-LLC/projects-sync-capability/issues/2); delivered as v2 of the external capability
**Date:** 2026-10-25

## Proposal summary

#2763 asked for a `github-sync` capability in core (`capabilities/github-sync/`) that extends the delivered v1 mirror from phase level to plan/task level: bootstrap a GitHub Projects v2 board (fields, views, labels, milestones), mirror each `PLAN.md` as a sub-issue of its phase issue with status taken from disk, render `<task>` blocks as checklists, and keep node IDs in `.planning/.github-sync.json`. The same work was offered as a v2 of the external capability. The maintainer chose the external placement.

## Why GSD does not own this

- **The capability already exists outside core, with an install path and a docs dependency.** v1 is [`projects-sync-capability`](https://github.com/The-Artificer-of-Ciphers-LLC/projects-sync-capability), installed with `gsd capability install`, and `docs/how-to/import-a-capability-from-a-url.md` uses it as its worked example. A second, in-core implementation would write the same `<!-- gsd-phase:N -->` markers to the same issues and would need its own `init` guard to avoid double-writing.
- **Core would own a permanent external API surface for one consumer.** The mirror depends on GitHub's Projects v2 GraphQL surface (views, fields, sub-issues). Placing it in core adds a capability directory to the install matrix and the capability schema for a feature with no recorded demand at decision time (no reactions on #2763 or #1010; v1 had 4 stars and no issues).
- **Core's plan data does not need to move.** The read seam the issue named, `phase list-plans`, returns paths and counts only. The documented plan index is `phase-plan-index` (`docs/CLI-TOOLS.md`), and plan status is owned by `scanPhasePlans` (`src/plan-scan.cts`): superseded plans, blocked summaries and stray summaries are excluded there. An external capability consumes that through the CLI exactly as an in-core one would.
- **What the proposal got right is not a ground for rejection.** The feasibility concern was unfounded (the GraphQL schema exposes `createProjectV2View`, `createProjectV2Field` and `addSubIssue`), and the contributor was correct that ADR-1244 does not forbid in-tree placement. This is a placement and cost decision, not an ADR ruling.

## What this does NOT cover

This entry denies only an **in-core** plan/task-level GitHub Projects mirror. It does not deny, and must not be cited against:

- **Building the same features in the external `projects-sync-capability`.** That is the chosen route (projects-sync-capability#2).
- **Documenting and pinning the JSON shape of `phase-plan-index`** (or another plan-level read surface) so external capabilities have a contract. That is welcome core work.
- **Loop Extension Points, capability-manifest fields or CLI verbs that a third-party tracker capability needs.** Requests for those are judged on their own.
- **Read-side tracker integration that core itself consumes**, such as the per-task content resolvers (#3646) and tracker-aware audit (#5482).
- **A capability that core consumes the output of**, as with `capabilities/external-job`.

## Re-open criteria

- Core itself begins to read the mirror's output (for example a core loop step consumes the sync map), so that core owns a producer/consumer pair rather than a one-way projection.
- Or a recorded decision (an ADR) makes GitHub Projects a first-party surface.
- Or the external capability is left without maintenance (no release or merged change for 12 months) while a request for these features remains open.

## Related

- [#2763](https://github.com/open-gsd/gsd-core/issues/2763) — source issue and the 2026-10-25 re-review
- [#1010](https://github.com/open-gsd/gsd-core/issues/1010) — the original request, delivered as the external v1
- [projects-sync-capability#2](https://github.com/The-Artificer-of-Ciphers-LLC/projects-sync-capability/issues/2) — where v2 is tracked
- [`docs/adr/1244-capability-ecosystem.md`](../docs/adr/1244-capability-ecosystem.md) — third-party capabilities; D2 requires a core id to differ from `projects-sync`
- [`docs/how-to/import-a-capability-from-a-url.md`](../docs/how-to/import-a-capability-from-a-url.md) — the worked example
