# Selecting and starting a second named project in one repository

**Source:** [#5862](https://github.com/open-gsd/gsd-core/issues/5862)
**Decision:** No-go as filed
**Date:** 2026-11-03

## Proposal summary

Add explicit selection of a named project: a `--project <name>` flag on `gsd-tools`, a per-session pointer (`gsd-tools query project set|get|list`), name validation, and changes to `/gsd-new-project` and `/gsd-do` so that a repository with a complete root project can start a second project in `.planning/<slug>/`. The ~47 workflow files that parse `--ws` would also parse `--project`.

## Why GSD does not own this

- **A project is the entire scope of a repository's planning.** A second named project inside the same repository risks planners and agents reading or writing the wrong project's roadmap, state and requirements. The confirmed defects #5858, #5859, #5860 and #5861 already show artifacts landing in the root project while `GSD_PROJECT` points elsewhere.
- **Separate initiatives have a home.** A separate repository, checkout or worktree gives each initiative its own full scope; parallel tracks inside one project are what workstreams are for.
- **Forever-cost.** It adds a second per-session pointer store with its own security rules beside the workstream one, plus edits across dozens of workflow files that must stay in step.
- The reporter was right that `GSD_PROJECT` cannot be selected from a workflow today and that `/gsd-new-project` stops with "already initialized"; that observation is not the ground for rejection.

## What this does NOT cover

- Defects in how the existing `GSD_PROJECT` namespace resolves paths (#5858, #5859, #5860, #5861) remain welcome and are tracked as bugs.
- Workstream selection and workstream-scoped planning are unaffected.
- A proposal that makes the single-project-per-repository model clearer in `/gsd-new-project` and `/gsd-do` messaging is not denied here.

## Re-open criteria

A design showing how planners and agents are kept from crossing project boundaries (a single resolved project context enforced for every read and write, with a test that fails when any workflow touches another project's files), and a use case that a separate checkout or worktree cannot serve.

## Related

- #5650 (closed, split into #5858–#5861), #4908 (epic: one resolved project context)
