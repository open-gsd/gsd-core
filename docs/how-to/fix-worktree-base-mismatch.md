# How to fix the worktree base-mismatch (exit 42) error

**Goal:** Understand why `/gsd-execute-phase` halts with `FATAL: worktree base mismatch` / exit 42 when your branch is ahead of the default branch, and choose the right fix to restore normal — or parallel — execution.

**Prerequisites:** GSD Core is installed and you have an active project. You have run `/gsd-execute-phase` and either seen the exit-42 error or the one-line `⚠ Worktree base mismatch` warning.

---

## What you will see

When you run `/gsd-execute-phase` on a branch that is ahead of the repository's default branch (for example, an unmerged milestone branch, a long-lived feature branch, or a branch with commits not yet in `origin/HEAD`), you may see one of two messages:

**Automatic-degrade warning (phase still completes):**

```
⚠ Worktree base mismatch: HEAD (abc12345) differs from origin/HEAD (def67890).
Running this phase sequentially on the main working tree.
To keep parallel worktrees, set worktree.baseRef:"head" in
.claude/settings.local.json (or run: gsd-tools worktree set-baseref). See #683.
```

The phase runs to completion sequentially; nothing is blocked. This is the runtime mitigation.

**Exit-42 halt (older installs or misconfigured environments):**

```
FATAL: worktree base mismatch
```

All worktree-isolated executors halt immediately. Zero progress is made.

---

## Why this happens

Claude Code's `isolation="worktree"` forks executor worktrees from the repository's default branch (`origin/HEAD`), not from your current `HEAD`. When your branch contains commits that `origin/HEAD` does not have — plan files, new source files, anything added since the branch diverged — those files are absent inside each worktree. GSD's `worktree-branch-check` safety guard correctly refuses to act on a worktree that does not match the orchestrator's state, and exits with code 42.

This is the guard working as designed: it prevents silent data loss or phantom edits in the wrong tree. The error is a branch-state condition, not an OS-specific or hardware issue.

---

## Option 1 — Do nothing (you are already unblocked)

If you saw the `⚠ Worktree base mismatch` warning rather than an exit-42 halt, GSD has already automatically degraded to sequential execution on the main working tree for this run. The phase will complete. No action is required.

Use this option when:

- You are on a diverged branch temporarily
- You do not care about parallel execution for this phase
- You want to merge back to the default branch soon

---

## Option 2 — Permanent fix: set `worktree.baseRef: "head"` (recommended)

This option restores parallel worktree execution on diverged branches. It tells Claude Code to fork executor worktrees from your current `HEAD` instead of `origin/HEAD`, so the plan files and branch-only commits are present in every worktree.

Run the convenience command from your project root:

```bash
node "$HOME/.claude/gsd-core/bin/gsd-tools.cjs" worktree set-baseref
```

This writes `worktree.baseRef: "head"` into `.claude/settings.local.json` in your project root. It is no-clobber: if you already have an explicit `baseRef` set to something else, it leaves your value in place and tells you.

To verify the result:

```bash
node "$HOME/.claude/gsd-core/bin/gsd-tools.cjs" worktree base-check
```

The output is JSON. When `shouldDegrade` is `false` and `reason` is `"baseref-head"`, parallel worktrees will work on any branch.

Alternatively, set the value by hand in `.claude/settings.local.json`:

```json
{
  "worktree": {
    "baseRef": "head"
  }
}
```

**Note:** Fresh GSD Core installs set this automatically. On upgrade it is opt-in — the installer prints a notice pointing at `worktree set-baseref`.

Use this option when:

- You regularly work on long-lived or milestone branches
- You want parallel phase execution (faster, lower context-window pressure)
- You are a solo developer or team working on a feature branch for an extended period

---

## Option 3 — Fallback: disable worktrees entirely

If worktrees are causing persistent problems beyond the base-mismatch (for example, your environment does not support them), disable them permanently for this project:

Add or edit `.planning/config.json`:

```json
{
  "workflow": {
    "use_worktrees": false
  }
}
```

All executor agents will then run sequentially on the main working tree for every phase. This is equivalent to what the automatic degrade does, but permanent.

Use this option when:

- Worktrees are consistently problematic in your environment
- You prefer sequential execution for auditability or tooling reasons
- You are on a platform or CI setup that does not support git worktrees

See also: [`workflow.use_worktrees`](../CONFIGURATION.md#workflow-toggles) in the configuration reference.

---

## The exit-42 backstop

The `worktree-branch-check` guard (exit 42) remains active in all execution modes as a safety backstop. It fires only when an executor worktree's branch does not match the expected orchestrator state — a condition that should not arise once you have applied one of the options above. If you continue to see exit 42 after setting `worktree.baseRef: "head"`, run `/gsd-forensics` to investigate.

---

## Summary

| Situation | Recommended action |
|-----------|-------------------|
| Saw the warning, phase completed | Nothing — degrade handled it automatically |
| Regularly on diverged branches, want parallel execution | `worktree set-baseref` (Option 2) |
| Worktrees consistently problematic | Set `workflow.use_worktrees: false` (Option 3) |
| Still seeing exit 42 after fixes | Run `/gsd-forensics "exit 42 after fix"` |

---

## Related

- [Recover and troubleshoot](recover-and-troubleshoot.md)
- [Debug a failed execution](debug-a-failed-execution.md)
- [Configuration reference — workflow toggles](../CONFIGURATION.md#workflow-toggles)
- [CLI Tools reference — worktree commands](../CLI-TOOLS.md#worktree-commands)
- [docs index](../README.md)
