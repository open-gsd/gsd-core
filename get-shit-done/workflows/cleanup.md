<purpose>

Archive accumulated phase directories from completed milestones into `.planning/milestones/v{X.Y}-phases/`. Prune stale local branches (upstream gone) and orphaned git worktrees (branch merged into main). Identifies candidates, shows a dry-run summary, and executes on confirmation.

</purpose>

<required_reading>

1. `.planning/MILESTONES.md`
2. `.planning/milestones/` directory listing
3. `.planning/phases/` directory listing

</required_reading>

<process>

<step name="identify_completed_milestones">

Read `.planning/MILESTONES.md` to identify completed milestones and their versions.

```bash
cat .planning/MILESTONES.md
```

Extract each milestone version (e.g., v1.0, v1.1, v2.0).

Check which milestone archive dirs already exist:

```bash
ls -d .planning/milestones/v*-phases 2>/dev/null || true
```

Filter to milestones that do NOT already have a `-phases` archive directory.

If all milestones already have phase archives:

```
All completed milestones already have phase directories archived. Nothing to clean up.
```

Stop here.

</step>

<step name="determine_phase_membership">

For each completed milestone without a `-phases` archive, read the archived ROADMAP snapshot to determine which phases belong to it:

```bash
cat .planning/milestones/v{X.Y}-ROADMAP.md
```

Extract phase numbers and names from the archived roadmap (e.g., Phase 1: Foundation, Phase 2: Auth).

Check which of those phase directories still exist in `.planning/phases/`:

```bash
ls -d .planning/phases/*/ 2>/dev/null || true
```

Match phase directories to milestone membership. Only include directories that still exist in `.planning/phases/`.

</step>

<step name="show_dry_run">

Present a dry-run summary for each milestone:

```
## Cleanup Summary

### v{X.Y} — {Milestone Name}
These phase directories will be archived:
- 01-foundation/
- 02-auth/
- 03-core-features/

Destination: .planning/milestones/v{X.Y}-phases/

### v{X.Z} — {Milestone Name}
These phase directories will be archived:
- 04-security/
- 05-hardening/

Destination: .planning/milestones/v{X.Z}-phases/
```

**Stale local branches (upstream gone):**

First, update remote-tracking refs so the candidate list matches the execution list exactly:

```bash
git fetch --prune 2>/dev/null || true
```

Then enumerate candidates (protected branch names are excluded even if their upstream is gone):

```bash
git branch -vv | awk '/: gone\]/ { if ($1 !~ /^\*$|^main$|^next$|^trunk$|^develop$/) print $1 }'
```

Show each branch name. If none, show:

```
No stale local branches detected.
```

**Orphaned worktrees (branch merged into main):**

Enumerate all registered worktrees, skipping the primary worktree (first entry in the list). For each non-primary worktree, check whether its branch has been merged into the default branch:

```bash
# List worktrees: path + branch name, skipping the first (primary) entry
git worktree list | tail -n +2 | awk '{print $1, $3}' | tr -d '[]'
```

This yields lines like `/path/to/wt  branch-name`. For each, test if the branch is merged:

```bash
git branch --merged main 2>/dev/null | sed 's/^[* ]*//' | grep -vE '^(main|trunk|develop|next)$'
```

Cross-reference: a worktree is **orphaned** if its branch appears in the merged list above.

Also check for worktrees whose directory no longer exists (safe to prune without confirmation):

```bash
git worktree prune --dry-run 2>&1
```

Show a summary:

```
**Orphaned worktrees (branch merged into main):**

- worktrees/PD-482/  [branch: PD-482]
- worktrees/feature-auth/  [branch: feature-auth]
  ... (N total)

Also: X worktree(s) with missing directories will be pruned automatically.
```

If none found:

```
No orphaned worktrees detected.
```

If no phase directories remain to archive AND no stale branches exist AND no orphaned worktrees exist:

```
No phase directories found to archive. Phases may have been removed or archived previously.
No stale local branches detected.
No orphaned worktrees detected.
```

Stop here.


**Text mode (`workflow.text_mode: true` in config or `--text` flag):** Set `TEXT_MODE=true` if `--text` is present in `$ARGUMENTS` OR `text_mode` from init JSON is `true`. When TEXT_MODE is active, replace every `AskUserQuestion` call with a plain-text numbered list and ask the user to type their choice number. This is required for non-Claude runtimes (OpenAI Codex, Gemini CLI, etc.) where `AskUserQuestion` is not available.
AskUserQuestion: "Proceed with archiving and pruning?" with options: "Yes — archive phases, prune stale branches, and remove orphaned worktrees" | "Cancel"

If "Cancel": Stop.

</step>

<step name="archive_phases">

For each milestone, move phase directories:

```bash
mkdir -p .planning/milestones/v{X.Y}-phases
```

For each phase directory belonging to this milestone:

```bash
mv .planning/phases/{dir} .planning/milestones/v{X.Y}-phases/
```

Repeat for all milestones in the cleanup set.

</step>

<step name="prune_local_branches">

After phase archival, prune local branches whose upstream has been deleted. Use the same filter as the dry-run so the execution list matches exactly what the user confirmed:

```bash
git branch -vv | awk '/: gone\]/ { if ($1 !~ /^\*$|^main$|^next$|^trunk$|^develop$/) print $1 }' | xargs -r git branch -D
```

Notes:
- `git fetch --prune` already ran in `show_dry_run` — the tracking refs are current and this step enumerates from the same state the user confirmed.
- `!~ /^\*$/` skips the currently checked-out branch (prefixed with `* ` in `git branch -vv` output, so `$1` yields `*`).
- `!~ /^main$|^next$|^trunk$|^develop$/` excludes protected branch names even if their upstream is gone — matches the dry-run exclusion exactly.
- `xargs -r` prevents `git branch -D` from running with no arguments when no stale branches exist.

</step>

<step name="prune_orphaned_worktrees">

Remove worktrees whose branch is merged into main. Use the same candidate list identified in `show_dry_run` — enumerate live worktrees again and cross-reference the merged-branch list so the execution matches exactly what the user confirmed.

```bash
# Compute merged branches (excluding protected names)
MERGED=$(git branch --merged main 2>/dev/null | sed 's/^[* ]*//' | grep -vE '^(main|trunk|develop|next)$')
```

For each non-primary worktree whose branch appears in `$MERGED`:

```bash
# Get worktree path and branch (skip primary worktree — first line)
git worktree list | tail -n +2 | awk '{print $1, $3}' | tr -d '[]' | while IFS=' ' read -r wt_path branch; do
  if echo "$MERGED" | grep -qx "$branch"; then
    # Remove worktree directory and its git metadata
    git worktree remove "$wt_path" --force 2>/dev/null || git worktree remove "$wt_path"
    # Delete the local branch (already confirmed merged, safe to delete)
    git branch -d "$branch" 2>/dev/null || true
  fi
done
```

After the loop, prune dangling metadata entries for worktrees whose directories are already gone:

```bash
git worktree prune
```

Notes:
- `--force` handles worktrees that have uncommitted changes but are confirmed merged — the branch content is already in main.
- `git branch -d` (lowercase) refuses to delete unmerged branches; this is a safety net against races where the merge check and the delete diverge.
- `git worktree prune` cleans up `.git/worktrees/<name>` stubs for any directory that was externally deleted; it is always safe to run.

</step>

<step name="commit">

Commit the changes:

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/get-shit-done/bin/${_GSD_SHIM_NAME}"; if [ -f "$GSD_TOOLS" ]; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${_GSD_RUNTIME_ROOT}/.claude/get-shit-done/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${_GSD_RUNTIME_ROOT}/.claude/get-shit-done/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif command -v gsd-tools >/dev/null 2>&1; then GSD_TOOLS="$(command -v gsd-tools)"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif [ -f "$HOME/.claude/get-shit-done/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="$HOME/.claude/get-shit-done/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd-tools is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi
gsd_run query commit "chore: archive phase directories from completed milestones" --files .planning/milestones/ .planning/phases/
```

</step>

<step name="report">

```
Archived:
{For each milestone}
- v{X.Y}: {N} phase directories → .planning/milestones/v{X.Y}-phases/

Pruned: {N} local branches whose upstream is gone.

Worktrees removed: {N} orphaned worktrees (branch merged into main).

.planning/phases/ and worktrees/ cleaned up.
```

</step>

</process>

<success_criteria>

- [ ] All completed milestones without existing phase archives identified
- [ ] Phase membership determined from archived ROADMAP snapshots
- [ ] Dry-run summary shown and user confirmed (covers archival, branch pruning, and worktree removal)
- [ ] Phase directories moved to `.planning/milestones/v{X.Y}-phases/`
- [ ] Stale local branches pruned (branches whose upstream is gone)
- [ ] Orphaned worktrees removed (branches merged into main)
- [ ] `git worktree prune` run to clean dangling metadata
- [ ] Changes committed

</success_criteria>
