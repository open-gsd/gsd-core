# How to fix the worktree base-mismatch (exit 42) error

**Goal:** Understand why `/gsd-execute-phase` or `/gsd-quick` halts with `FATAL: worktree base mismatch` / exit 42 when your branch is ahead of the default branch, and choose the right fix to restore normal — or parallel — execution.

**Prerequisites:** GSD Core is installed and you have an active project. You have run `/gsd-execute-phase` or `/gsd-quick` and either seen the exit-42 error or the one-line `⚠ Worktree base mismatch` warning.

---

## What you will see

When you run `/gsd-execute-phase` or `/gsd-quick` on a branch that is ahead of the repository's default branch (for example, an unmerged milestone branch, a long-lived feature branch, or a branch with commits not yet in `origin/HEAD`), you may see one of two messages:

**Automatic-degrade warning (phase or quick task still completes):**

```
⚠ Worktree base mismatch: HEAD (abc12345) differs from origin/HEAD (def67890).
Running this phase sequentially on the main working tree. Parallel worktrees
return once HEAD is merged/pushed so origin/HEAD matches it, or set
worktree.baseRef:"head" to fork worktrees from HEAD instead (honored by
GSD-created worktrees and by the Claude Code harness; #683, #4588).
```

The phase or quick task runs to completion sequentially; nothing is blocked. This is the runtime mitigation (`/gsd-execute-phase`: #683/#1369; `/gsd-quick`: #1941).

**Exit-42 halt (older installs or misconfigured environments):**

```
FATAL: worktree base mismatch
```

All worktree-isolated executors halt immediately. Zero progress is made.

---

## Why this happens

Unless `worktree.baseRef` is set to `"head"`, Claude Code's `isolation="worktree"` forks executor worktrees from the repository's default branch (`origin/HEAD`), not from your current `HEAD`. When your branch contains commits that `origin/HEAD` does not have — plan files, new source files, anything added since the branch diverged — those files are absent inside each worktree. GSD's `worktree-branch-check` safety guard correctly refuses to act on a worktree that does not match the orchestrator's state, and exits with code 42.

This is the guard working as designed: it prevents silent data loss or phantom edits in the wrong tree. The error is a branch-state condition, not an OS-specific or hardware issue.

---

## Option 1 — Do nothing (you are already unblocked)

If you saw the `⚠ Worktree base mismatch` warning rather than an exit-42 halt, GSD has already automatically degraded to sequential execution on the main working tree for this run. The phase will complete. No action is required.

Use this option when:

- You are on a diverged branch temporarily
- You do not care about parallel execution for this phase
- You want to merge back to the default branch soon

---

## Option 2 — Set `worktree.baseRef: "head"` (restores parallel execution on a diverged branch)

**What this setting does (#3659, #4588):** it makes new worktrees fork from your current `HEAD`
instead of `origin/HEAD`, so the files your branch added are present inside each executor
worktree and the wave can run in parallel. It is honored by GSD-created worktrees by construction
and, as measured, by Claude Code's harness:

- **Runtimes where GSD itself runs `git worktree add <path> <start-point>`** (Codex, OpenCode,
  Kimi, Kimi Code) — by construction; the check suppresses on it (`reason: "baseref-head"`).
- **Claude Code's `Agent(isolation="worktree")`** — because the harness reads the setting and
  forks from `HEAD`. This was measured on current Claude Code from the project-local,
  project-shared and user/global settings layers on macOS, Windows and Linux (#4588). Cursor,
  the other runtime whose harness creates the worktree, has not been measured — see below. An earlier finding that the harness did *not* read it (#48,
  verified against the Claude Code of the time; upstream claude-code#44965) was fixed upstream in
  claude-code#54940, but until #4588 GSD's pre-dispatch check still assumed it and degraded every
  wave on an unmerged branch regardless of the setting — the `baseref-head-ignored-by-harness`
  reason you may have seen on older installs.

Run the convenience command from your project root:

```bash
node "$HOME/.claude/gsd-core/bin/gsd-tools.cjs" worktree set-baseref
```

This writes `worktree.baseRef: "head"` into `.claude/settings.local.json` in your project root. It is no-clobber: if you already have an explicit `baseRef` set to something else, it leaves your value in place and tells you.

To verify the result, pass the dispatch mode the runtime uses:

```bash
node "$HOME/.claude/gsd-core/bin/gsd-tools.cjs" worktree base-check --mode harness-worktree
```

The output is JSON. With the setting in place expect `shouldDegrade: false` with
`reason: "baseref-head"` in either mode — the check does not compare `HEAD` against
`origin/HEAD` when the fork base is `HEAD` by configuration. Without the setting, on a diverged
branch, expect `shouldDegrade: true` with `reason: "head-diverged-from-fork"`.

**If you configure a Claude Code `WorktreeCreate` hook**, the setting does not reach the worktrees
Claude Code dispatches: the hook creates them from the directory it emits, and Claude Code does not
apply `worktree.baseRef` on that path. The check looks for such a hook in the same three settings
files it reads `worktree.baseRef` from. When it finds one, or when one of those files does not
parse, it compares `HEAD` against `origin/HEAD` as if the setting were absent, and a mismatch
returns `shouldDegrade: true` with `reason: "baseref-head-bypassed-by-hook"` and a message naming
the file (#4588). That fallback is the comparison the check makes without the setting, and it does
not know where your hook forks either: when `HEAD` matches `origin/HEAD` the check does not degrade,
and the exit-42 guard below still catches a hook that forks elsewhere. For a measured verdict, pass the
commit a hook-created worktree starts at as `--observed-fork-base` (described next), or remove the
hook. Hooks from managed policy settings, a `--settings` file, plugins, agent frontmatter or SDK
registrations are not visible to the check; there the exit-42 guard below is the backstop.

If you have a real measurement of what a worktree on this host forked from (`git rev-parse HEAD`
inside a freshly created isolated worktree, before any commit — the full sha, not an abbreviation),
pass it and the check evaluates that instead of inferring:

```bash
node "$HOME/.claude/gsd-core/bin/gsd-tools.cjs" worktree base-check --observed-fork-base <sha>
```

A match returns `reason: "observed-fork-matches-head"`; a mismatch with `"head"` set returns
`reason: "baseref-head-ignored-by-harness"` — that worktree was not forked from HEAD despite the
setting — and the run degrades to sequential as before.

**Measured on Claude Code only.** Cursor also declares harness-created worktrees; whether it honors
`worktree.baseRef` has not been measured. There the pre-dispatch check trusts the setting the same
way, and a host that does not honor it is caught by the exit-42 guard below. If you are on Cursor
and see exit 42 with the setting in place, the SHA the halted executor prints is exactly the
observation to pass here, and worth reporting.

Alternatively, set the value by hand in `.claude/settings.local.json`:

```json
{
  "worktree": {
    "baseRef": "head"
  }
}
```

**Note:** Fresh installs and upgrades of GSD Core both set `worktree.baseRef:"head"` automatically in `.claude/settings.local.json` (no-clobber) when `workflow.use_worktrees` is enabled (the default). If you see the degrade warning on a fresh install, check that the key is still present — a hand-edited `settings.local.json` is the usual reason it is not.

Use this option when:

- You regularly work on long-lived or milestone branches, on any worktree-capable runtime
- You want parallel phase execution there (faster, lower context-window pressure)

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

The `worktree-branch-check` guard (exit 42) remains active in all execution modes as a safety backstop. It fires only when an executor worktree's branch does not match the expected orchestrator state — a condition that should not arise once you have applied one of the options above. It is also the observation-based check behind Option 2: with `worktree.baseRef: "head"` set, the pre-dispatch check trusts the setting and does not compare, so a host that does *not* honor it is caught here — the mismatched executors of that dispatch halt (every one of them, in a concurrent wave), and nothing is merged. If you continue to see exit 42 after setting `worktree.baseRef: "head"`, your runtime is forking from somewhere other than `HEAD`; run `/gsd-forensics` to investigate, and pass the SHA the halted executor printed as `--observed-fork-base` to `worktree base-check` to see the verdict GSD would reach with that measurement.

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
