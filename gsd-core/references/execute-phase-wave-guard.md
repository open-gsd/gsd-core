0.5. **Inter-wave worktree base re-check (wave N+1 guard — #1369):**

   After Wave N merges and tracking commits advance orchestrator HEAD, Claude Code's
   `isolation="worktree"` forks new worktrees from `origin/HEAD` (the "fresh" base) unless
   `worktree.baseRef:"head"` is set — not the live HEAD. Without the setting, Wave N+1
   worktrees would be created from the stale pre-Wave-N base, causing the
   `worktree_branch_check` guard inside each executor to halt with a base-mismatch fatal.

   **Run this check at the start of every wave when `USE_WORKTREES != "false"` and
   `ISOLATION = "harness-worktree"`** (#2652 — the harness caches the fork base, so this is a
   property of the isolation model, not of the runtime name; Cursor declares it too),
   including Wave 1 (where it mirrors the initialize-step check):

   ```bash
   if [ "$ISOLATION" = "harness-worktree" ] && [ "${USE_WORKTREES:-true}" != "false" ]; then
     _WAVE_DEGRADE=$(gsd_run query worktree.base-check --mode "$ISOLATION" --pick shouldDegrade 2>/dev/null || true)
     if [ "$_WAVE_DEGRADE" = "true" ]; then
       _WAVE_DEGRADE_MSG=$(gsd_run query worktree.base-check --mode "$ISOLATION" --pick message 2>/dev/null || true)
       [ -n "$_WAVE_DEGRADE_MSG" ] && printf '%s\n' "$_WAVE_DEGRADE_MSG" >&2
       echo "⚠ [#1369] Worktree fork base diverged from orchestrator HEAD (wave merges advanced HEAD past origin/HEAD). Auto-degrading to sequential mode for this wave to avoid base-mismatch halts." >&2
       # Both must move together (#2652): dispatch keys on ISOLATION.
       USE_WORKTREES=false
       ISOLATION=none
     fi
   fi
   ```

   If `shouldDegrade` is `true`, override `USE_WORKTREES=false` for **this wave only** —
   all plans in this wave execute sequentially on the main working tree. Later waves re-run
   this check and may re-enable worktree isolation once `origin/HEAD` matches HEAD again
   (e.g. via `git fetch` or a push that advances it).

   **How `worktree.baseRef:"head"` interacts with this degrade (#3659, #4588):** with the
   setting in place the check trusts it and does not compare — the worktree creator forks from the
   orchestrator HEAD (GSD's own `git worktree add` by construction; the Claude Code harness as
   measured from all three settings layers, #4588; Cursor unmeasured), so outside the two
   exceptions below this guard only fires when the setting
   is absent and HEAD has diverged from `origin/HEAD`. Parallel worktrees then return once HEAD
   is merged/pushed so `origin/HEAD` matches it, or once the setting is applied. The exceptions
   (#4588): a supplied `--observed-fork-base` is compared against HEAD instead of trusted, in
   both modes; and on a harness-created run with no observation, a Claude Code `WorktreeCreate`
   hook in any of those settings files — or one of them that does not parse, so a hook cannot be
   ruled out — withholds the trust: the hook creates the worktree without applying the setting,
   so the check compares against `origin/HEAD` anyway and a mismatch degrades with
   `baseref-head-bypassed-by-hook`. The #4868 prior-worktree observation does not lift that
   degrade: a worktree at HEAD records nothing about which creator left it there, so one the
   plain harness created before the hook was configured reads the same as one the hook created
   (#4881). On a hook host only `--observed-fork-base` restores a trusted verdict. The exit-42
   guard in each executor remains the backstop on a host that does not honor the setting.
   See #683 for the base-ref configuration detail.
