Apply response_language to all user-facing prose — narration between tool calls, status updates, progress notes, and findings included; preserve code, paths, and identifiers.

<step name="worktree_base_check">
`USE_WORKTREES` and `ISOLATION` are also reset for the run when `worktree base-check` detects the
orchestrator HEAD has diverged from the worktree fork base (#683 — e.g. an unmerged milestone
branch). This runs for **any** isolated run, not only Claude: fork-base divergence is a property
of the repository, so it degrades a GSD-created worktree exactly as a harness-created one. The
auto-degrade prints a one-line warning to stderr and falls through to the sequential path so
executors do not hit the exit-42 worktree-branch-check halt. Setting `worktree.baseRef:"head"`
restores parallel execution on both isolation models: GSD-created worktrees (Codex, OpenCode,
Kimi, Kimi Code) fork from the orchestrator HEAD by construction, and harness-created ones do so
where the harness honors the setting — measured on Claude Code from all three settings layers
(#4588; #48's earlier finding that it did not predates upstream claude-code#54940), unmeasured on
Cursor. On a harness-created run with no observation, a Claude Code `WorktreeCreate` hook in any
of those three settings files, or one of them that does not parse, withholds that trust and the
check compares against `origin/HEAD` as before. The #4868 prior-worktree observation is withheld
there rather than consulted — a worktree at HEAD does not record which creator left it, so one the
plain harness created before the hook reads the same as one the hook created (#4881), and only
`--observed-fork-base` restores a trusted verdict. A supplied `--observed-fork-base` is never trusted
either: HEAD is compared against the observation, in both modes. Without the setting the fork
base is `origin/HEAD` and parallel execution returns once HEAD is merged/pushed so it matches
(#3659). The `worktree-branch-check` exit-42 guard inside each executor remains in place as the
backstop on a host that does not honor the setting; step 0.5 of
`gsd-core/references/execute-phase-wave-guard.md` carries the measurement detail.
</step>
