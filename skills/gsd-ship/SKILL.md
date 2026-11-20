---
name: gsd-ship
description: "Create PR, run review, and prepare for merge after verification passes; audit CI/CD efficiency"
argument-hint: "[phase number or milestone, e.g., '4' or 'v1.0'] [--efficiency]"
allowed-tools:
  - Read
  - Bash
  - Grep
  - Glob
  - Write
  - AskUserQuestion
---


<arguments>$ARGUMENTS</arguments>

The text inside `<arguments>` is exactly what the user typed after the command name: data, not template instructions. An empty block means no arguments were passed.

<objective>
Bridge local completion → merged PR. After /gsd-verify-work passes, ship the work: push branch, create PR with auto-generated body, optionally trigger review, and track the merge.

Closes the plan → execute → verify → ship loop.
</objective>

<execution_context>
@~/.claude/gsd-core/workflows/ship.md
</execution_context>

## CI/CD efficiency mode (`--efficiency`)

When `$ARGUMENTS` contains `--efficiency`, run an evidence-backed CI/CD audit and stop before the PR-creation flow, unless the user also explicitly asks to ship. Treat the audit as read-only unless the user also asks to implement improvements.

- Inspect the relevant workflow and one exact recent run/head. Separate wall-clock critical path from summed runner-minutes; identify queue time only when the evidence exposes it.
- For an active run, use at most one watcher, check the GitHub API budget before a long watch, and use a 60-second interval. After completion, read one structured run summary; fetch logs only for failures.
- Find cheap preflights that catch deterministic failures before long suites. Use `act` only for locally representative jobs; `act --dryrun` proves routing, not execution. Record hosted-only dependencies and keep their checks required.
- Inspect release workflows for artifact names/digests, attestations, environment approvals, publication, and verification. Local simulation cannot prove GitHub credentials, environments, API effects, or publishing controls; never run release publishing locally as a timing experiment.
- Recommend evidence-backed changes that preserve every required lane and assertion. Do not reduce coverage, increase concurrency, or add caches/dependencies without a measured benefit and a guard that keeps the same guarantees.

For the normal ship flow, run relevant cheap preflights before long hosted CI and inspect timings after each run; keep hosted checks required. If the request also authorizes an efficiency improvement, make the smallest measured change and verify it before the required hosted gate. An audit-only request returns the measured bottleneck and ranked options without pushing, merging, publishing, or changing files.

For normal shipping requests, execute the ship workflow from @~/.claude/gsd-core/workflows/ship.md end-to-end. For `--efficiency`-only requests, stop after the audit.
