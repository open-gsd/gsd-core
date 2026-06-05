# Branching Model

A plain-English guide to where work happens, where it merges, and why
you should almost never need to rebase.

> **Audience:** maintainers and contributors. Aimed at people who can use git
> but don't want to think about it every day. If you came up through CIS in the
> late 90s and never quite warmed to git's mental model — this guide is for you.

---

## TL;DR

```
                    feat/NNN-slug ─┐
                    fix/NNN-slug  ─┤
                    chore/NNN-slug ┼──► next (integration) ──► release/X.Y.0 ──► main ──► v-tag ──► npm @latest
                    docs/NNN-slug ─┘                                      │
                                                                          │
                    hotfix/X.Y.Z ◄── branch from v-tag ──────┐            │
                                  cherry-pick from next ─────┤            │
                                  ──────────────────────────►│──► main ──►v-tag (patch) ──► npm @latest
                                                              │            │
                                                              └─► next  ◄──┘ (auto back-merge)
```

Three rules:

1. **You PR to `next`. Not `main`.** Unless you're cutting a release or a
   hotfix, the answer to "where does my PR go?" is always `next`.
2. **`main` only moves on release.** Maintainers (and the release/hotfix
   workflows) push to `main`. Feature work never touches it.
3. **Hotfixes go to `main` first, then auto-merge back to `next`.** Urgent
   fixes don't wait for the release train.

---

## The two long-lived branches

### `main` — production

- Represents what's on `npm @latest` right now.
- Only changes when a release lands, a hotfix lands, or — rarely — when an
  emergency fix is cherry-picked.
- Tagged with `vX.Y.Z` on every release.
- Branch protection: 2 approvals, CI green, signed commits, linear history
  not required (release back-merges use merge commits to preserve tag context).
- Never push directly. Even maintainers go through PRs.

### `next` — integration for the next release

- Represents what will be in the **next** minor or major release.
- This is where day-to-day feature, fix, chore, docs, and refactor work lands.
- Always at-or-ahead of `main`: contains everything in `main` plus everything
  queued for the next release.
- Branch protection: 1 approval, CI green, auto-deleted source branches.
- Auto-back-merged from `main` whenever `main` advances (via
  `auto-backmerge.yml`) so it never falls behind.

---

## Short-lived branches

These are work branches. Open one, push commits, PR it, merge it, let it auto-delete.

| Prefix | What it's for | PR target | Examples |
|---|---|---|---|
| `feat/` | New feature (approved-feature issue) | `next` | `feat/3201-discuss-mode` |
| `fix/` | Bug fix (confirmed-bug issue) | `next` | `fix/3187-config-corruption` |
| `chore/` | Maintenance, refactors, deps, CI | `next` | `chore/3712-bump-node-actions` |
| `docs/` | Documentation only | `next` | `docs/3485-adr-naming-convention` |
| `refactor/` | Internal restructuring, no behavior change | `next` | `refactor/3500-extract-seam` |
| `test/` | Test-only additions or corrections | `next` | `test/3621-restore-fixture` |
| `perf/` | Performance work, no behavior change | `next` | `perf/3300-skill-index` |
| `ci/` | CI/workflow changes only | `next` | `ci/3801-add-node-26-matrix` |
| `revert/` | Reverting a previously-merged change | `next` (or `main` if urgent) | `revert/3919-bad-merge` |
| `hotfix/X.Y.Z` | Patch release branch (created by `release.yml` with a patch version X.Y.Z) | `main` | `hotfix/1.27.1` |
| `release/X.Y.0` | Minor/major release branch (created by `release.yml`) | `main` | `release/1.28.0` |

> **The branch name rule is enforced** by `.github/workflows/branch-naming.yml`.
> A PR from a non-conforming branch gets a warning comment. Pick a prefix.

---

## Three flows: feature, hotfix, release

### Flow 1 — Feature / fix / chore (the 95% case)

This is what you do every day.

```bash
# 1. Start from a fresh `next`.
git fetch origin
git checkout next
git pull --ff-only origin next

# 2. Branch off `next`.
git checkout -b fix/3187-config-corruption

# 3. Work. Commit. Push.
git add -A && git commit -m "fix: harden config parse for trailing comma"
git push -u origin fix/3187-config-corruption

# 4. Open a PR. Target = next. (Don't change the target.)
gh pr create --base next --repo open-gsd/gsd-core

# 5. CI runs. Reviewer approves. PR squash-merges into `next`.
#    Your branch auto-deletes.
```

**Why this rarely needs a rebase:**

- `next` moves slower than `main` did in the old single-branch model — only
  changes when other PRs to `next` merge.
- Branch protection on `next` does **not** require "up-to-date before merge"
  — only requires CI to be green. So another PR landing on `next` while yours
  is open doesn't force you to rebase.
- Squash-merge means each PR becomes one commit on `next` — easy to revert,
  easy to read, no merge-noise.

### Flow 2 — Hotfix (urgent patch release)

When you need to ship a fix without waiting for the next minor.

```bash
# 1. The fix itself lands on `next` first (or main, for true emergencies).
#    Open the PR exactly like a normal fix.
git checkout next
git pull --ff-only
git checkout -b fix/3919-critical-crash
# ... commit, push, PR to next, merge.

# 2. Trigger the Release workflow (release.yml) from the Actions tab:
#    workflow:  Release
#    action:    create
#    version:   1.27.1   (next patch number, X.Y.Z)
#    auto_cherry_pick: true (default)
```

The workflow:

1. Finds the prior tag (`v1.27.0`) — the cherry-pick base.
2. Creates `hotfix/1.27.1` from that tag.
3. Cherry-picks every `fix:` / `chore:` commit on `next` (or `main`) that
   isn't already in `v1.27.0`, oldest-first.
4. Bumps versions, pushes the branch.
5. You review the branch. Trigger `finalize` when ready.
6. `finalize` publishes to npm `@latest`, tags `v1.27.1`, opens
   merge-back PRs to **both** `main` and `next`.

> See `.github/workflows/release.yml` and `VERSIONING.md` for the deep dive.

### Flow 3 — Minor or major release

When `next` has accumulated enough work to ship a new minor/major.

```
1. Maintainer triggers Actions → Release workflow:
   - action: create
   - version: 1.28.0

2. Workflow cuts release/1.28.0 from `next` (not main).
   `next` keeps moving — new feature PRs can target it.

3. Stabilization on release/1.28.0:
   - Bug fixes can be PR'd to release/1.28.0 directly (`fix/3923-rc-blocker`)
   - Each fix should also be PR'd to `next` so the next release has it too
     (or wait for the auto-back-merge after finalize)
   - Trigger `rc` action to publish RC builds: 1.28.0-rc.1, rc.2, ...

4. When stable: trigger `finalize`.
   - Publishes to npm @latest
   - Tags v1.28.0
   - Opens merge-back PR: release/1.28.0 → main
   - Opens merge-back PR: release/1.28.0 → next (NEW — picks up RC-only fixes)

5. Merge both back-merge PRs. release/1.28.0 branch is deleted.
```

---

## Why this fixes the "constant rebase" pain

The old single-branch model:

- Every PR targets `main`.
- `main` moves every time anything lands.
- Branch protection often requires "branches up to date" — so the moment
  someone else's PR merges, your PR demands a rebase before it can merge.
- 10 PRs in flight = 9 of them need to rebase every time one lands. The
  last one to merge has rebased N times.

The new model removes the pressure in three ways:

1. **`main` rarely moves.** Only release/hotfix merges land. Most days `main`
   doesn't change at all.
2. **`next` does NOT require "up-to-date before merge".** Branch protection
   on `next` only requires CI green. Two PRs to `next` can merge in either
   order without rebasing each other — git will handle the merge as long as
   they don't touch the same lines.
3. **Squash-merge into `next`.** One commit per PR. No "merge main into my
   branch" noise. If you ever do need to bring `next` into your branch
   (because of a real conflict), it's one rebase per conflict, not per PR
   that lands somewhere else.

You'll still occasionally rebase — when your branch genuinely conflicts with
something that landed on `next`. But that's a real conflict you'd have to
resolve anyway. The treadmill is gone.

---

## Cheat sheet: "where does my PR go?"

```
Is it a hotfix release branch?       → main      (cut by release.yml with a patch version X.Y.Z)
Is it a stable release branch?       → main      (cut by release.yml)
Is it an RC-blocker fix?             → release/X.Y.0  (and also next, or rely on back-merge)
Is it everything else?               → next
```

If you're unsure: `next`. The PR target validator (`pr-target-validator.yml`)
will reject PRs that target `main` from non-release/hotfix branches and tell
you to retarget. Use the GitHub UI "Edit" button on the PR title to change
the base branch — no need to recreate the PR.

---

## Maintainer reference

- **First-time bootstrap:** run `scripts/setup-branch-protection.sh` after
  creating the `next` branch for the first time. It applies protection rules
  to both `main` and `next` consistently.
- **Repo Settings → General → Pull Requests:**
  - Allow squash merging — **ON** (default merge strategy)
  - Allow merge commits — **ON** (needed for release/hotfix back-merges)
  - Allow rebase merging — **OFF** (avoids confusion)
  - Default to "Pull request title" for squash commit messages — **ON**
  - Automatically delete head branches — **ON**
  - Allow auto-merge — **ON** (the auto-backmerge workflow uses it)
- **Creating `next` for the first time:**
  ```bash
  git checkout main
  git pull --ff-only
  git checkout -b next
  git push -u origin next
  # Then go to repo Settings → Branches and set `next` as the default branch
  # (so `gh pr create` and the GitHub web UI default to it).
  ```
- **Phasing in:** see the migration notes in
  `docs/adr/230-introduce-next-integration-branch.md`.
- **Updating release.yml:** this workflow currently branches from `main` and
  cherry-picks from `main`. After phase-2 of the migration it should branch
  from `next` (release) and cherry-pick from `next` (hotfix). The patches
  are inlined in the ADR.

---

## When NOT to use `next`

A few exceptions where the rules above bend:

- **True production-down emergency.** Push directly to a `fix/critical-*`
  branch, PR to `main`. The auto-back-merge workflow will replay it onto
  `next` within minutes. Use sparingly — most "urgent" things are fine to go
  through `next` and ship same day via the Release workflow (patch version).
- **Documentation-only typo on a published page.** If the only change is a
  doc fix that's visible right now and shouldn't wait for the next release,
  PR it to `main`. The auto-back-merge will sync `next`. Most doc changes
  should still go through `next` and ship with the next release.
- **CI / workflow files.** Strictly speaking these affect the repo state, not
  the published artifact. They can target `next` or `main`. Convention: PR
  to `next` unless the CI fix unblocks a release in progress.
