Apply response_language to all user-facing prose — narration between tool calls, status updates, progress notes, and findings included; preserve code, paths, and identifiers.

<step name="worktree_base_check">
`USE_WORKTREES` and `ISOLATION` are also reset for the run when `worktree base-check` detects the
orchestrator HEAD has diverged from the worktree fork base (#683 — e.g. an unmerged milestone
branch). This runs for **any** isolated run, not only Claude: fork-base divergence is a property
of the repository, so it degrades a GSD-created worktree exactly as a harness-created one. The
auto-degrade prints a one-line warning to stderr and falls through to the sequential path so
executors do not hit the exit-42 worktree-branch-check halt. Setting `worktree.baseRef:"head"`
restores parallel execution only where GSD itself creates the worktrees (orchestrator-managed
runtimes — Codex, OpenCode, Kimi, Kimi Code); harness-isolated runtimes (Claude Code, Cursor) do
not read the setting (#48, verified 5/5; upstream claude-code#44965), so there the check compares
against the real fork base and parallel execution returns once HEAD is merged/pushed so
`origin/HEAD` matches it (#3659). The `worktree-branch-check` exit-42 guard inside each executor
remains in place as a backstop.
</step>
