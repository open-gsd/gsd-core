# Publish PRs without planning artifacts

You want GSD's `.planning/` tree versioned in git on your own branch — so parallel executors can
read their plans and `/gsd-undo` has something to restore — while the pull request your team
reviews contains none of it.

This is the opposite trade to
[Keep planning docs out of a shared repo](keep-planning-docs-private.md), which removes planning
from git entirely and loses worktree isolation in the process. Use this guide when you want the
history and want the remote clean.

Five steps, and the fourth is the one that decides whether the guarantee actually holds.

## 1. Keep planning artifacts committed

```bash
gsd-tools config-set planning.commit_docs true
```

This is already the default. Set it explicitly if someone previously turned it off, or if
`.planning/` is listed in `.gitignore` — a gitignored `.planning/` auto-resolves `commit_docs` to
`false` no matter what `config.json` says, and `planning.pr_strict` cannot filter what was never
committed.

If `.planning/` is currently in `.gitignore`, remove that line before continuing.

## 2. Turn on strict PR filtering

```bash
gsd-tools config-set planning.pr_strict true
```

Confirm it took:

```bash
gsd-tools query config-get planning.pr_strict --raw
```

`true` means every `.planning/` path will be filtered out of the generated PR branch —
`STATE.md` and `ROADMAP.md` included, not only the per-phase artifacts.

## 3. Do the work normally

Nothing about the phase loop changes. `/gsd-plan-phase` and `/gsd-execute-phase` commit planning
artifacts exactly as they always have, executor worktrees find their `PLAN.md`, and your working
branch carries the full planning history.

## 4. Generate the PR branch — and push *that* branch

```bash
/gsd-pr-branch
```

The command creates `<your-branch>-pr` from the target branch and rebuilds the history without any
`.planning/` path. **Push the generated `-pr` branch, never your working branch** — the working
branch is where the planning history lives, and it is the one thing that must not reach the remote.

```bash
git push origin <your-branch>-pr
gh pr create --base main --head <your-branch>-pr
```

Run it again after more commits: each run picks only the commits since the last `-pr` branch that
was merged into the target, so earlier rounds are not replayed. A plain merge always counts; a squash or rebase merge counts when the target still holds the `-pr` content, or when `gh` confirms the merged PR. `/gsd-pr-branch` records that point in `refs/gsd/*`, per mode and target.

Requirements before it will run:

- **A clean working tree.** Uncommitted changes are rejected up front. Commit or stash first.
- **Commits since the last published tip** (or ahead of the target when nothing was published). With none, the command exits without creating a branch.

### How repeat publishes work

`/gsd-pr-branch` keeps its repeat-publish state in local refs that are never pushed:

- **Markers.** The last built tip is recorded in `refs/gsd/pr-built/<mode>/<target>/<working-branch>` (plus the `-pr` tip in `refs/gsd/pr-built-head/<mode>/<target>/<working-branch>`) and promoted to `refs/gsd/pr-published/<mode>/<target>/<working-branch>` once that `-pr` tip is merged, even if the local branch was deleted. `<mode>` is `strict` or `default` (`planning.pr_strict`), so switching it between runs starts from the target instead of reusing the other mode's marker. Target and branch names are percent-encoded into one ref component by the workflow, so `feat` and `feat/sub` never collide.
- **What counts as merged.** The `-pr` tip is an ancestor of the target; or, for a squash or rebase merge, the target holds the `-pr` content for every path it changed; or, when the target has since edited those paths, `gh` reports a merged PR for the `-pr` branch into the target whose head is the `-pr` tip. `gh` is queried only as an executable (never a shell function or alias), bounded to 10 seconds. `gh` uses its default repository, so under a fork-first setup set it with `gh repo set-default`.
- **A leftover `-pr` branch.** Merged and still holding the build: replaced. Not merged, or merged but changed after the build (amended or rebased): refused by name with the commands to re-anchor or discard it. Gone, or merged with no commit after the build but without the built tip (reset to the target), when the build's own merge is unprovable: announced as dropped, with the re-anchor command.
- **A rebased working branch.** Commits are compared by their patch over the paths the `-pr` branch keeps (the filter drops `.planning/` in strict mode and the transient planning directories in default mode), so a mixed commit that `git rebase` rewrote still matches its published copy. A published commit that a rebase dropped after a squash merge counts too when the target holds the files it touched. The base is the last commit of the leading run of commits that are published or that the pick list skips (such as a `.planning/config.json`-only commit in default mode). When the target already holds every published patch (a rebase merge, then `git rebase`), the run starts from the target with no warning. If a published commit has no match and the target lacks its files (folded or conflict-resolved), or a matched commit sits above an unpublished one (reordered), or a commit the pick list takes has no patch (a failed or timed-out lookup), or the published side holds only merge commits, the run warns and starts from the target; re-anchor with `git update-ref <published-ref> <rebased commit equivalent to last published tip>`.
- **Re-anchoring.** After a dropped-build warning, or a refusal that prints a `published (re-anchor)` line, run the `git update-ref` that it prints. `<published-ref>` is the `refs/gsd/pr-published/...` ref from the Markers bullet.

## 5. Read the verification summary

The run ends with a summary. Two lines carry the guarantee:

```
Mode: strict
Planning paths in diff: 0 (allowed 0, forbidden 0 — must be 0)
```

`forbidden` is the number that matters. In strict mode it counts every `.planning/` path that
survived into the branch, and it must be `0`. `allowed` is always `0` in strict mode — there is no
allowed population.

### What each outcome means

| Summary line | Meaning | What to do |
|---|---|---|
| `Mode: strict` … `forbidden 0` | The guarantee held. | Push the `-pr` branch. |
| `Mode: default` | `planning.pr_strict` did not resolve to `true`. | Re-run step 2; the key is read from the project's `.planning/config.json`, so check you are in the right project root. |
| `forbidden` greater than `0` | The filter did not remove everything it promised. | Do **not** push. This is a bug — report it with the listed paths. |
| `<branch>-pr exists and is not merged into <target>` | The previous `-pr` branch is not merged yet, or it was merged on the remote and your local `<target>` is behind, or it was squash/rebase merged and the run could not confirm it. | If it was merged on the remote, update `<target>` (for example `git pull` on it) and re-run. Else run a printed command: re-anchor if it was merged (offered when a build is pending), or discard it. Then re-run. |
| `<branch>-pr is merged into <target> but no longer holds the pending build` | The previous `-pr` branch was merged but was amended or rebased after the build, so the run cannot tell which commits were published. | Run a printed command: re-anchor if the build was published (offered when a build is pending), or discard it. Then re-run. |
| `WARNING: dropped the pending build` | The run could not prove that the previous build was merged (its `-pr` branch is gone, or no longer holds the build), so its commits will be replayed. A local `<target>` that is behind the remote also causes this. | If it was merged, update `<target>` first when it is behind the remote. Then run the `git update-ref` the warning prints, re-run, and take the discard command that run prints for the rebuilt `-pr` (a conflict halt already deleted it: then only re-anchor and re-run). |
| `Conflict outside the .planning/ filter` | A real content conflict between your commits and the target branch. | Resolve it on your working branch, then re-run `/gsd-pr-branch`. If it came from replaying commits you already published, re-anchor instead (the `git update-ref` the earlier WARNING printed). |
| `WARNING: <published-ref> is not an ancestor of <branch> ... (history rewritten)` | A rebase or reword left a published commit with no matching patch, a matched commit above an unpublished one, or only merge commits on the published side, or a patch lookup failed, so the run starts from the target. | If an earlier round was published, run the `git update-ref` the warning prints with the commit that matches the last published tip, then re-run. |
| `WARNING: <branch>-pr is merged into <target> but nothing is recorded as published` | The `-pr` branch was merged by a run that recorded nothing for this mode and target, so every commit is picked again. | If an earlier publish is merged, run the `git update-ref` the warning prints with the last published commit, then re-run. |
| `Working tree has uncommitted changes` | Step 4's precondition failed. | Commit or stash, then re-run. |
| `Refusing target <target>: it starts with -.` | The target (from `git.base_branch` or the argument) looks like a git option. The run stops before any git call uses it. | Set `git.base_branch` to a branch name, or pass one, then re-run. |
| `Unknown target: <target>` | No commit has that name in this repository. | Fetch or create the target branch, or fix `git.base_branch`, then re-run. |
| `Cannot list .planning/milestones; fix its permissions and re-run.` | The run cannot read `.planning/milestones`, so it cannot find the milestone phase directories to filter. | Make the directory readable, then re-run. |
| `Cannot check <published-ref>; re-run.` | The check whether the last published tip is still in your branch failed or timed out. The run stops and changes nothing. | Re-run. |
| `Cannot list the commits to pick; re-run.` | The commit list failed or timed out. The run stops before it creates the `-pr` branch. | Re-run. |
| `could not create <branch>-pr from <target>` | Git could not create the `-pr` branch, for example because a ref named `<branch>-pr/...` exists. | Remove the blocking ref, then re-run. |
| `Cannot read <branch>-pr (deleted); re-run.` or `(not deleted)` | A read of the built `-pr` branch failed or timed out, so the run cannot check it. The run tries to delete that branch and records nothing as pending. | Re-run. After `(not deleted)`, delete the branch by hand first. |
| `WARNING: could not record <ref>; next run will replay commits.` | Git could not write the published or pending ref, for example because a ref blocks its path. | Remove the blocking ref. Else the next run replays the commits of this round. |
| `No commits ahead of the last published tip (or <target>)` | There is nothing to filter. | Not an error — you have not committed anything since the last publish (or since the target, on a first run), or the target is wrong. |

An `ℹ️` advisory listing `.planning/` paths appears only in **default** mode, naming paths that are
neither transient nor structural (`config.json`, `intel/`, `workstreams/`) and therefore kept. Strict
mode removes those too, so the advisory never appears — if you see it, you are not in strict mode.

## Verify it for yourself

Before trusting the setup on a real review, confirm the generated branch is clean:

```bash
git diff --name-only main..<your-branch>-pr | grep '^\.planning/'
```

No output is the expected result. Any output means step 2 did not take effect, or the run reported
a non-zero `forbidden` count you should not push past.

## Related

- [Keep planning docs out of a shared repo](keep-planning-docs-private.md) — the other posture:
  planning never enters git, at the cost of parallel executor worktrees
- [Planning settings reference](../CONFIGURATION.md#planning-settings) — `planning.pr_strict`,
  `planning.commit_docs`, and the rest of the `planning.*` keys
- [`/gsd-pr-branch` reference](../COMMANDS.md#gsd-pr-branch)
