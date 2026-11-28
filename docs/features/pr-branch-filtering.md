---
id: 45
title: PR Branch Filtering
group: v1.27 Features
---

**Command:** `/gsd-pr-branch [target branch]`

**Purpose:** Create a clean branch suitable for pull requests by filtering out `.planning/` commits. Reviewers see only code changes, not GSD planning artifacts.

**Requirements:**
- REQ-PRBRANCH-01: System MUST identify commits that only modify `.planning/` files
- REQ-PRBRANCH-02: System MUST create a new branch with planning commits filtered out
- REQ-PRBRANCH-03: Code changes MUST be preserved exactly as committed
- REQ-PRBRANCH-04: System MUST NOT delete a `.planning/` path the target branch already tracks
- REQ-PRBRANCH-05: Verification MUST assert against the active filter mode's contract, not an unconditional zero

**Filter modes.** `planning.pr_strict` selects what "filtered" means. The default mode treats `.planning/` as two populations: structural state that belongs in review (`STATE.md`, `ROADMAP.md`, `MILESTONES.md`, `PROJECT.md`, `REQUIREMENTS.md`, `milestones/**`) and transient per-phase artifacts that do not (`phases/`, `quick/`, `research/`, `threads/`, `todos/`, `debug/`, `seeds/`, `codebase/`, `ui-reviews/`). Strict mode collapses that distinction: nothing under `.planning/` reaches the PR branch, and a commit is carried over only when it touches at least one file outside `.planning/`.

Both modes filter by forcing the excluded paths back to whatever the target branch already tracks, in the index and the working tree. Strict mode leaves planning committed, so worktrees and revert paths keep working. See [Why PR-branch filtering has a strict mode](../explanation/pr-branch-filtering-design.md) and [Publish PRs without planning artifacts](../how-to/publish-prs-without-planning-artifacts.md).
