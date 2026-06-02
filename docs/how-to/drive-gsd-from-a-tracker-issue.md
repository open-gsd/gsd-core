# How to drive GSD Core from a tracker issue

**Goal:** Take a single well-scoped GitHub, Linear, or Jira issue through the full GSD pipeline — from isolated workspace to merged PR — using only commands that already exist in GSD Core, with no custom scripts or tracker integrations.

**Prerequisites:** GSD Core is installed. The issue has bounded scope, observable acceptance criteria, and no upstream blockers.

For the concepts and design rationale behind this pattern, see [Issue-driven orchestration explained](../issue-driven-orchestration.md).

---

## Step 1: Map the issue to a phase

Open your tracker issue and decide how it maps onto `ROADMAP.md`:

- **Issue matches an existing phase** → note the phase number and move to Step 2.
- **Issue is standalone new work** → add a phase:

```bash
/gsd-phase "Description matching the issue title"
```

- **Issue is urgent and must slot between existing phases** → insert a decimal phase:

```bash
/gsd-phase --insert 3 "Fix: description from issue"
```

Copy the tracker issue URL. You will paste it into `CONTEXT.md` in Step 3 so traceability survives context compaction.

---

## Step 2: Create an isolated workspace

Every issue gets its own workspace — a git worktree with an independent `.planning/` directory. Partial work, aborted plans, and exploratory commits stay outside `main`.

```bash
/gsd-workspace --new --name my-issue-slug --repos . --strategy worktree
```

Switch into the workspace directory before continuing:

```bash
cd ~/gsd-workspaces/my-issue-slug
```

---

## Step 3: Discuss the phase

Run discuss-phase to lock in implementation decisions before any planning happens. When the session opens, paste the tracker issue URL into the discussion so it is captured in `CONTEXT.md`.

```bash
/gsd-discuss-phase N
```

GSD asks about ambiguities in the issue scope — error handling, edge cases, interface contracts, technology choices. Your answers shape the plan that follows.

If you already know all the answers and want to move quickly:

```bash
/gsd-discuss-phase N --auto
```

---

## Step 4: Plan the phase

```bash
/gsd-plan-phase N
```

GSD spawns research agents, reads your `CONTEXT.md` decisions (including the issue URL), and produces atomic `PLAN.md` files. A plan-checker validates each plan before saving.

If you want peer review from external AI CLIs before execution (recommended for significant changes):

```bash
/gsd-review --phase N
/gsd-plan-phase N --reviews
```

Or run the full plan–review–converge loop until no HIGH concerns remain:

```bash
/gsd-plan-review-convergence N
```

---

## Step 5: Execute the phase

For interactive, phase-at-a-time execution:

```bash
/gsd-execute-phase N
```

For a hands-off run through all remaining phases:

```bash
/gsd-autonomous
```

For an interactive dashboard where you can watch progress and dispatch work across phases:

```bash
/gsd-manager
```

All three approaches update `STATE.md`, commit each task atomically, and run the post-phase verifier.

---

## Step 6: Verify the work

```bash
/gsd-verify-work N
```

GSD walks you through the acceptance criteria from the phase goal (which reflects your tracker issue) one at a time. If anything fails, GSD diagnoses the root cause and creates a fix plan. Re-run execute and re-verify until all checks pass.

Treat `verification_failed` as a blocker even when the code looks correct — the failure usually surfaces a missed acceptance criterion from the original issue.

---

## Step 7: Review and ship

Run a code review before opening the PR:

```bash
/gsd-code-review N
/gsd-code-review N --fix
```

Then create the PR:

```bash
/gsd-ship N
```

GSD assembles the PR body from your planning artifacts: phase goal, changes summary, requirements addressed, verification status, and key decisions. Include `Closes #NNN` or `Fixes #NNN` in the PR body (or set it via `/gsd-config`) so the tracker issue closes automatically when the PR merges.

---

## Step 8: Capture follow-up work

As you work through the issue you will often discover related work. Capture it without losing context:

```bash
/gsd-capture "Follow-up: description of discovered work"      # Add as a todo
/gsd-capture --seed "Idea worth a future phase"               # Preserve for the next milestone
/gsd-capture --backlog "Not urgent but worth tracking"        # Park in the backlog
```

GSD does not post to your tracker automatically. Creating a tracker issue from captured follow-ups is a separate manual step — this keeps human review in the loop.

---

## Conditionals

| Situation | What to do |
|-----------|-----------|
| Issue is very small (typo, config change) | Skip workspace + discuss + plan; use `/gsd-quick` instead |
| Issue has multiple independent sub-tasks | Use `/gsd-manager` to parallelise execution across plans |
| Issue is blocked on another issue | Do not start until the upstream blocker is resolved; GSD has no automatic dependency poller |
| Issue scope turns out larger than expected mid-execution | Stop, run `/gsd-phase --insert N` to add sub-phases, continue |
| You want to skip the interactive discussion | Use `--auto` flag with `/gsd-discuss-phase`, or set `workflow.skip_discuss: true` for project-wide automation |
| Multiple issues form a coherent release | Run `/gsd-new-milestone` to group them and `/gsd-autonomous` to execute in sequence |

---

## Related

- [Issue-driven orchestration explained](../issue-driven-orchestration.md)
- [Isolate work with workspaces](isolate-work-with-workspaces.md)
- [Verify and ship](verify-and-ship.md)
- [docs index](../README.md)
