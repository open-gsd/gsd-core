#!/usr/bin/env zsh
# rollout-next-phase1.sh — native zsh, runs under macOS Terminal's default shell.
# DO NOT prefix with `bash`. Run as: ./rollout-next-phase1.sh
#
# Phase 1 of the `next` integration-branch rollout.
#
# What it does (in order, on YOUR Mac, in your repo dir):
#   1. Stashes any uncommitted work on your current branch (codex/...) with a
#      named stash you can recover with `git stash list` + `git stash pop`.
#   2. Switches to main, pulls --ff-only to be sure you're current.
#   3. Creates branch: chore/introduce-next-integration-branch
#   4. Unpacks the 5 new files from the tarball.
#   5. Applies the 2 edits (branch-naming.yml, CONTRIBUTING.md) programmatically
#      against the clean origin/main versions — no chance of pulling in
#      unrelated commits from your current codex/ branch.
#   6. Sanity-checks YAML + bash syntax.
#   7. Commits with a conventional-commit message.
#   8. Pushes the branch to origin.
#   9. Files a `type: chore` issue using gh.
#  10. Renames the ADR file XXXX-...md → <issue#>-...md and replaces XXXX in
#      the ADR body with the real issue number.
#  11. Amends the commit, force-pushes-with-lease.
#  12. Opens the PR against main with `Closes #<issue#>` in the body.
#
# Idempotent: re-running after a failure converges. Each step checks if it's
# already done.
#
# Usage:
#   cd /Volumes/Mini\ Me/Users/trekkie/projects/gsd-core
#   bash /path/to/rollout-next-phase1.sh
#
# Env overrides:
#   TARBALL=/path/to/next-branch-files.tar.gz   (default: ./next-branch-files.tar.gz)
#   REPO=open-gsd/gsd-core           (default: that)
#   DRY_RUN=1                                   (skip push, issue, PR)

set -euo pipefail

# ───────────────────────────────────────────────────────────
# Config
# ───────────────────────────────────────────────────────────
REPO="${REPO:-open-gsd/gsd-core}"
TARBALL="${TARBALL:-./next-branch-files.tar.gz}"
BRANCH="chore/introduce-next-integration-branch"
DRY_RUN="${DRY_RUN:-0}"

# Colors for readability (no-op if not a tty)
if [ -t 1 ]; then
  C_BOLD=$'\033[1m'; C_GRN=$'\033[32m'; C_YEL=$'\033[33m'; C_RED=$'\033[31m'; C_DIM=$'\033[2m'; C_RST=$'\033[0m'
else
  C_BOLD=''; C_GRN=''; C_YEL=''; C_RED=''; C_DIM=''; C_RST=''
fi

step()  { echo; echo "${C_BOLD}▸ $*${C_RST}"; }
ok()    { echo "${C_GRN}  ✓${C_RST} $*"; }
warn()  { echo "${C_YEL}  ⚠${C_RST} $*"; }
die()   { echo "${C_RED}  ✗ $*${C_RST}" >&2; exit 1; }
note()  { echo "${C_DIM}  $*${C_RST}"; }

# ───────────────────────────────────────────────────────────
# Step 0: Sanity checks
# ───────────────────────────────────────────────────────────
step "Sanity checks"

[ -d .git ] || die "Not in a git repo. cd to your gsd-core checkout first."
command -v gh >/dev/null || die "gh CLI not found. Install from https://cli.github.com/"
command -v jq >/dev/null || die "jq not found. Install: brew install jq"
gh auth status >/dev/null 2>&1 || die "gh not authenticated. Run: gh auth login"
[ -f "$TARBALL" ] || die "Tarball not found at: $TARBALL  (override with TARBALL=/path/to/next-branch-files.tar.gz)"

# Verify we're pointed at the right remote.
REMOTE_URL=$(git remote get-url origin 2>/dev/null || true)
case "$REMOTE_URL" in
  *"$REPO"*) ok "Remote: $REMOTE_URL" ;;
  *) die "Remote 'origin' is $REMOTE_URL — expected to contain $REPO. Wrong checkout?" ;;
esac

# Verify tarball contents look right (fail loudly if user grabbed the wrong tar).
EXPECTED_PATHS=(
  "docs/branching.md"
  "docs/adr/XXXX-introduce-next-integration-branch.md"
  ".github/workflows/auto-backmerge.yml"
  ".github/workflows/pr-target-validator.yml"
  "scripts/setup-branch-protection.sh"
)
TARLIST=$(tar tzf "$TARBALL")
for p in "${EXPECTED_PATHS[@]}"; do
  echo "$TARLIST" | grep -qx "$p" || die "Tarball missing expected file: $p"
done
ok "Tarball contains all 5 expected files"

# ───────────────────────────────────────────────────────────
# Step 1: Stash any uncommitted work (protecting rollout files from the sweep)
# ───────────────────────────────────────────────────────────
step "Stash any uncommitted work on current branch"

CURRENT_BR=$(git rev-parse --abbrev-ref HEAD)
note "Currently on: $CURRENT_BR"

# git stash --include-untracked would otherwise grab the rollout script and
# tarball (they're untracked). Move them aside, stash, move them back.
# trap EXIT guarantees restore even on script failure.
ROLLOUT_STAGE=$(mktemp -d)
ROLLOUT_FILES=(rollout-next-phase1.sh rollout-next-phase2.sh next-branch-files.tar.gz)
for f in "${ROLLOUT_FILES[@]}"; do
  [ -f "./$f" ] && mv "./$f" "$ROLLOUT_STAGE/"
done
restore_rollout_files() {
  # (N) is zsh's nullglob qualifier — empty match expands to nothing
  # instead of erroring with "no matches found".
  for f in "$ROLLOUT_STAGE"/*(N); do
    cp "$f" ./ 2>/dev/null || true
  done
  rm -rf "$ROLLOUT_STAGE" 2>/dev/null || true
}
trap restore_rollout_files EXIT

if [ -n "$(git status --porcelain)" ]; then
  STASH_MSG="pre-next-rollout-$(date +%Y%m%d-%H%M%S) (from $CURRENT_BR)"
  git stash push --include-untracked --message "$STASH_MSG" >/dev/null
  ok "Stashed as: $STASH_MSG"
  note "Recover later with: git stash list   then   git stash pop <stash@{N}>"
else
  ok "Working tree clean — nothing to stash"
fi

# Bring rollout files back into the working tree NOW so subsequent retries can find them.
restore_rollout_files

# ───────────────────────────────────────────────────────────
# Step 2: Switch to main, pull
# ───────────────────────────────────────────────────────────
step "Switch to main and pull"

git fetch origin --quiet
git checkout main >/dev/null 2>&1 || die "Could not checkout main"
git pull --ff-only origin main >/dev/null
ok "main is current at $(git log -1 --format='%h %s' | head -c 80)"

# ───────────────────────────────────────────────────────────
# Step 3: Create or switch to rollout branch
# ───────────────────────────────────────────────────────────
step "Create branch $BRANCH"

# Prune any stale worktree registrations first (e.g. from a prior aborted
# attempt that left .git/worktrees/<name> pointing at a deleted directory).
git worktree prune 2>/dev/null || true

if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  # Detect if a worktree still claims this branch.
  # NB: no `exit` in awk — that would SIGPIPE git and trip pipefail/set -e
  # silently. `head -1 || true` neutralizes the SIGPIPE we inflict ourselves.
  CLAIMING_WT=$( { git worktree list --porcelain 2>/dev/null || true; } | awk -v br="refs/heads/$BRANCH" '
    /^worktree / { wt=$2 }
    $0 == "branch " br { print wt }
  ' | head -1 || true)
  if [ -n "$CLAIMING_WT" ] && [ "$CLAIMING_WT" != "$(pwd)" ]; then
    die "Branch $BRANCH is held by worktree $CLAIMING_WT. Run: git worktree remove --force '$CLAIMING_WT'  (or)  git worktree prune  then re-run."
  fi
  warn "Branch $BRANCH already exists locally. Switching to it."
  git checkout "$BRANCH" >/dev/null
  if git rev-parse --verify "origin/$BRANCH" >/dev/null 2>&1; then
    warn "origin/$BRANCH already exists. Resetting to main would lose remote commits — ABORT."
    die "Delete the remote branch first if you want a clean restart: gh api -X DELETE /repos/$REPO/git/refs/heads/$BRANCH"
  fi
  git reset --hard main >/dev/null
  ok "Reset local $BRANCH to current main"
else
  git checkout -b "$BRANCH" >/dev/null
  ok "Created and switched to $BRANCH"
fi

# ───────────────────────────────────────────────────────────
# Step 4: Unpack the 5 new files
# ───────────────────────────────────────────────────────────
step "Unpack new files from tarball"

tar xzf "$TARBALL"
chmod +x scripts/setup-branch-protection.sh
ok "Unpacked: $(tar tzf "$TARBALL" | wc -l | tr -d ' ') files"

# ───────────────────────────────────────────────────────────
# Step 5: Apply the 2 edits programmatically
# ───────────────────────────────────────────────────────────
step "Apply edit 1/2 — add 'next' to branch-naming.yml alwaysValid"

NAMING=".github/workflows/branch-naming.yml"
if grep -q "alwaysValid = \['main', 'next', 'develop'\]" "$NAMING"; then
  ok "branch-naming.yml already has 'next' in alwaysValid (idempotent skip)"
else
  if ! grep -q "alwaysValid = \['main', 'develop'\]" "$NAMING"; then
    die "Could not find the expected anchor in $NAMING. Maybe upstream changed it. Open the file and add 'next' manually."
  fi
  # BSD sed (macOS default) needs -i ''; GNU sed needs -i. Use -i.bak then remove.
  sed -i.rollout-bak "s/alwaysValid = \['main', 'develop'\]/alwaysValid = ['main', 'next', 'develop']/" "$NAMING"
  rm -f "$NAMING.rollout-bak"
  grep -q "alwaysValid = \['main', 'next', 'develop'\]" "$NAMING" || die "sed didn't take. Aborting."
  ok "branch-naming.yml updated"
fi

step "Apply edit 2/2 — insert 'Where Do I Open My PR?' section into CONTRIBUTING.md"

CONTRIB="CONTRIBUTING.md"
if grep -q "^## Where Do I Open My PR?" "$CONTRIB"; then
  ok "CONTRIBUTING.md already has the section (idempotent skip)"
else
  # Anchor must exist exactly once.
  ANCHOR_COUNT=$(grep -c "^## Pull Request Guidelines\$" "$CONTRIB" || true)
  [ "$ANCHOR_COUNT" -eq 1 ] || die "Expected exactly 1 '## Pull Request Guidelines' anchor in $CONTRIB, found $ANCHOR_COUNT. Insert the section manually."

  # Write section to a temp file. BSD awk (macOS default) rejects newlines in
  # -v variable values, so we pass a filename instead and let awk read it.
  SECTION_FILE=$(mktemp -t gsd-rollout-section.XXXXXX)
  cat > "$SECTION_FILE" <<'EOF'
## Where Do I Open My PR? (Branching Model)

GSD uses two long-lived branches: `main` (production, what's on npm `@latest`)
and `next` (integration for the upcoming release). **Almost every PR targets
`next`.** Full guide: [`docs/branching.md`](docs/branching.md).

| Your branch | PR target | Notes |
|---|---|---|
| `feat/NNN-slug` | `next` | Default for all new features |
| `fix/NNN-slug` | `next` | Default for all bug fixes; ships in next minor or via hotfix cherry-pick |
| `chore/`, `docs/`, `refactor/`, `test/`, `perf/`, `ci/`, `revert/` | `next` | All routine work |
| `fix/critical-NNN-slug` | `main` | Production-down emergencies only; auto-back-merges to `next` |
| `release/X.Y.0` | `main` | Created by `release.yml` — don't make these by hand |
| `hotfix/X.Y.Z` | `main` | Created by `hotfix.yml` — don't make these by hand |
| Stabilization PR for an in-flight release | `release/X.Y.0` | Fix a regression found during the RC cycle |

**Day-to-day commands:**

```bash
git fetch origin
git checkout next
git pull --ff-only origin next
git checkout -b fix/3187-config-corruption
# ... commit, push
gh pr create --base next --repo open-gsd/gsd-core
```

If you target the wrong branch by accident, the `PR Target Validator`
workflow will post a comment with the one-line fix (click "Edit" by the PR
title and change the base branch — no need to recreate the PR).

**Why this matters:** Under the old single-branch model, every PR required
rebasing onto `main` because branch protection required "up-to-date before
merging" and `main` moved on every merge. With `next` as the integration
branch and that flag disabled on `next`, concurrent PRs can merge in any
order as long as they don't conflict on the same lines. The rebase
treadmill is gone for the 95% case.

---
EOF
  # Trailing blank line so awk emits a blank between our closing rule and
  # the next H2 (CommonMark requires blank before any header).
  echo "" >> "$SECTION_FILE"

  awk -v sectionfile="$SECTION_FILE" '
    /^## Pull Request Guidelines$/ && !inserted {
      while ((getline line < sectionfile) > 0) print line
      close(sectionfile)
      inserted = 1
    }
    { print }
  ' "$CONTRIB" > "$CONTRIB.tmp"
  mv "$CONTRIB.tmp" "$CONTRIB"
  rm -f "$SECTION_FILE"
  grep -q "^## Where Do I Open My PR?" "$CONTRIB" || die "awk insertion failed."
  ok "CONTRIBUTING.md section inserted"
fi

# ───────────────────────────────────────────────────────────
# Step 6: Sanity-check YAML + bash
# ───────────────────────────────────────────────────────────
step "Validate YAML + bash"

for f in .github/workflows/auto-backmerge.yml \
         .github/workflows/pr-target-validator.yml \
         .github/workflows/branch-naming.yml; do
  python3 -c "import yaml,sys; yaml.safe_load(open('$f'))" \
    || die "YAML invalid: $f"
done
ok "All 3 workflow YAMLs parse"

bash -n scripts/setup-branch-protection.sh || die "Bash syntax error: setup-branch-protection.sh"
ok "setup-branch-protection.sh syntax OK"

# ───────────────────────────────────────────────────────────
# Step 7: Commit
# ───────────────────────────────────────────────────────────
step "Commit"

git add docs/branching.md \
        docs/adr/XXXX-introduce-next-integration-branch.md \
        .github/workflows/auto-backmerge.yml \
        .github/workflows/pr-target-validator.yml \
        .github/workflows/branch-naming.yml \
        CONTRIBUTING.md \
        scripts/setup-branch-protection.sh

if git diff --cached --quiet; then
  warn "Nothing to commit (already committed from a previous run?)"
else
  git commit -m "chore: introduce \`next\` integration branch (Phase 1 — additive)

Adds:
  - docs/branching.md              — beginner contributor guide
  - docs/adr/XXXX-...md            — ADR (will be renamed with issue#)
  - .github/workflows/auto-backmerge.yml      — disabled in Phase 1
  - .github/workflows/pr-target-validator.yml — warn-only in Phase 1
  - scripts/setup-branch-protection.sh        — idempotent gh api script

Modifies:
  - .github/workflows/branch-naming.yml  — recognize 'next'
  - CONTRIBUTING.md                       — 'Where Do I Open My PR?' section

Phase 1 is additive: nothing operational changes until Phase 2 flips
auto-backmerge.yml's if:false→true, flips pr-target-validator.yml's
WARN_ONLY→false, creates the next branch, and switches the default
branch. See the ADR for the migration plan."
  ok "Committed"
fi

# ───────────────────────────────────────────────────────────
# Step 8: Push
# ───────────────────────────────────────────────────────────
step "Push branch"

if [ "$DRY_RUN" = "1" ]; then
  warn "DRY_RUN=1 — skipping push"
else
  git push -u origin "$BRANCH"
  ok "Pushed $BRANCH"
fi

# ───────────────────────────────────────────────────────────
# Step 9: File the issue (or reuse if one already exists)
# ───────────────────────────────────────────────────────────
step "File or reuse the chore issue"

ISSUE_TITLE="chore: introduce \`next\` integration branch to end rebase treadmill"
ISSUE_BODY=$(cat <<'EOF'
## Problem

Every contributor branch is cut from `main` and PR'd back to `main`. Combined
with branch protection's "Require branches to be up to date before merging",
this produces a rebase treadmill: every time another PR merges, every
in-flight PR demands a rebase. With ~315 unreleased changesets queued and
multiple PRs at any time, this is constant.

## Proposed change

Introduce `next` as a long-lived integration branch. Routine PRs target
`next`; `main` only changes on release / hotfix / emergency fix. An
auto-back-merge workflow keeps `next` aligned with `main`.

Full design: see the ADR in this PR (`docs/adr/XXXX-introduce-next-integration-branch.md`).
Contributor-facing guide: `docs/branching.md`.

## Scope

This issue covers Phase 1 of the rollout (additive infrastructure — no
operational change until the workflow flags are flipped in Phase 2).

- New: `docs/branching.md`, ADR, `auto-backmerge.yml` (disabled),
  `pr-target-validator.yml` (warn-only), `setup-branch-protection.sh`.
- Modified: `branch-naming.yml` (recognize `next`), `CONTRIBUTING.md`
  ("Where Do I Open My PR?" section).
- Not yet touched: `release.yml`, `hotfix.yml`, `auto-branch.yml` — these
  are Phase 3, with patches inlined in the ADR.

## Acceptance criteria

- All 7 files land via this PR.
- CI is green.
- `docs/branching.md` renders correctly on GitHub.
- ADR filename is renamed from `XXXX-` to `<this-issue#>-`.

## Phase 2 follow-up (separate PR)

After Phase 1 merges, a small follow-up PR will:
- Create the `next` branch from `main` HEAD.
- Apply branch protection via the new script.
- Switch the default branch to `next`.
- Flip `if: false` → `if: true` in `auto-backmerge.yml`.
- Flip `WARN_ONLY: 'true'` → `'false'` in `pr-target-validator.yml`.
EOF
)

# Look for an existing open issue with this exact title to support idempotent re-runs.
EXISTING_ISSUE=$(gh issue list --repo "$REPO" --search "in:title \"$ISSUE_TITLE\"" --state open --json number --jq '.[0].number' 2>/dev/null || echo "")

if [ -n "$EXISTING_ISSUE" ]; then
  ISSUE_NUM="$EXISTING_ISSUE"
  ok "Reusing existing open issue #$ISSUE_NUM"
elif [ "$DRY_RUN" = "1" ]; then
  ISSUE_NUM="DRYRUN"
  warn "DRY_RUN=1 — skipping issue creation; ISSUE_NUM=$ISSUE_NUM"
else
  ISSUE_URL=$(echo "$ISSUE_BODY" | gh issue create \
    --repo "$REPO" \
    --title "$ISSUE_TITLE" \
    --label "type: chore" \
    --body-file -)
  ISSUE_NUM=$(echo "$ISSUE_URL" | sed 's|.*/||')
  ok "Filed issue #$ISSUE_NUM — $ISSUE_URL"
fi

# ───────────────────────────────────────────────────────────
# Step 10: Rename ADR with issue number, replace XXXX in body
# ───────────────────────────────────────────────────────────
step "Rename ADR and substitute issue number"

OLD_ADR="docs/adr/XXXX-introduce-next-integration-branch.md"
NEW_ADR="docs/adr/${ISSUE_NUM}-introduce-next-integration-branch.md"

if [ -f "$OLD_ADR" ]; then
  git mv "$OLD_ADR" "$NEW_ADR"
  ok "Renamed: $OLD_ADR → $NEW_ADR"
elif [ -f "$NEW_ADR" ]; then
  ok "ADR already renamed (idempotent skip)"
else
  die "Neither $OLD_ADR nor $NEW_ADR exists. Something is off."
fi

# Replace XXXX inside ADR with real issue number (only in the placeholder context).
if [ "$ISSUE_NUM" != "DRYRUN" ]; then
  sed -i.rollout-bak "s/XXXX-introduce-next-integration-branch/${ISSUE_NUM}-introduce-next-integration-branch/g" "$NEW_ADR"
  sed -i.rollout-bak "s/placeholder \`XXXX\` prefix/placeholder (now resolved to \`${ISSUE_NUM}\`)/g" "$NEW_ADR"
  rm -f "$NEW_ADR.rollout-bak"
  ok "Substituted XXXX → ${ISSUE_NUM} in ADR body"
fi

# Also patch the references in the new workflow files which mention XXXX-introduce-next-integration-branch.
for f in .github/workflows/auto-backmerge.yml .github/workflows/pr-target-validator.yml docs/branching.md CONTRIBUTING.md; do
  if [ -f "$f" ] && grep -q "XXXX-introduce-next-integration-branch" "$f"; then
    sed -i.rollout-bak "s/XXXX-introduce-next-integration-branch/${ISSUE_NUM}-introduce-next-integration-branch/g" "$f"
    rm -f "$f.rollout-bak"
    ok "Updated cross-reference in $f"
  fi
done

# ───────────────────────────────────────────────────────────
# Step 11: Amend commit + force-push
# ───────────────────────────────────────────────────────────
step "Amend commit and force-push"

git add -A
if git diff --cached --quiet; then
  ok "No changes to amend (idempotent skip)"
else
  git commit --amend --no-edit
  ok "Amended commit"
fi

if [ "$DRY_RUN" = "1" ]; then
  warn "DRY_RUN=1 — skipping force-push"
else
  git push --force-with-lease origin "$BRANCH"
  ok "Force-pushed (with lease)"
fi

# ───────────────────────────────────────────────────────────
# Step 12: Open the PR (or reuse if one already exists)
# ───────────────────────────────────────────────────────────
step "Open PR against main"

PR_TITLE="chore: introduce \`next\` integration branch (Phase 1 — additive)"
PR_BODY=$(cat <<EOF
Closes #${ISSUE_NUM}

Phase 1 of the \`next\` integration-branch rollout. See ADR:
\`docs/adr/${ISSUE_NUM}-introduce-next-integration-branch.md\`.

## What's in this PR

**New files**
- \`docs/branching.md\` — contributor-facing how-to-use-it guide
- \`docs/adr/${ISSUE_NUM}-introduce-next-integration-branch.md\` — the ADR
- \`.github/workflows/auto-backmerge.yml\` — opens \`main → next\` PR on each push to main. **Currently disabled** (\`if: false\`); flipped in Phase 2.
- \`.github/workflows/pr-target-validator.yml\` — blocks PRs targeting main except release/hotfix/critical. **Currently warn-only**; enforced in Phase 2.
- \`scripts/setup-branch-protection.sh\` — idempotent gh-api script that applies the two protection rule sets.

**Edits**
- \`.github/workflows/branch-naming.yml\` — adds \`next\` to \`alwaysValid\`.
- \`CONTRIBUTING.md\` — new "Where Do I Open My PR? (Branching Model)" section above Pull Request Guidelines.

## Why nothing breaks today

Both new workflows ship inert (\`if: false\` on the back-merge job, \`WARN_ONLY: 'true'\` on the validator). The validator will post a friendly comment on out-of-pattern PRs but won't fail the check until Phase 2.

## After this merges

A small Phase 2 PR will:
1. Create the \`next\` branch from \`main\` HEAD and push it.
2. Apply branch protection via \`scripts/setup-branch-protection.sh\`.
3. Switch the default branch to \`next\` (GitHub repo setting).
4. Flip the two phase-gate flags above.

Phase 3 (separate PR after a few releases under the new model) updates \`release.yml\`, \`hotfix.yml\`, and \`auto-branch.yml\` to branch from / cherry-pick from \`next\`. Inlined patches in the ADR.
EOF
)

EXISTING_PR=$(gh pr list --repo "$REPO" --head "$BRANCH" --state open --json number --jq '.[0].number' 2>/dev/null || echo "")

if [ -n "$EXISTING_PR" ]; then
  ok "Reusing existing PR #$EXISTING_PR"
  if [ "$DRY_RUN" != "1" ]; then
    echo "$PR_BODY" | gh pr edit "$EXISTING_PR" --repo "$REPO" --title "$PR_TITLE" --body-file -
    ok "Updated PR #$EXISTING_PR title and body"
  fi
elif [ "$DRY_RUN" = "1" ]; then
  warn "DRY_RUN=1 — skipping PR creation"
else
  PR_URL=$(echo "$PR_BODY" | gh pr create \
    --repo "$REPO" \
    --base main \
    --head "$BRANCH" \
    --title "$PR_TITLE" \
    --body-file -)
  ok "Opened PR: $PR_URL"
fi

# ───────────────────────────────────────────────────────────
# Done.
# ───────────────────────────────────────────────────────────
echo
echo "${C_BOLD}${C_GRN}━━━ Phase 1 complete ━━━${C_RST}"
echo
echo "Issue:  #${ISSUE_NUM}"
echo "Branch: $BRANCH"
echo "PR:     $(gh pr list --repo "$REPO" --head "$BRANCH" --state open --json url --jq '.[0].url' 2>/dev/null || echo "(check gh pr list)")"
echo
echo "Next steps:"
echo "  1. Review CI on the PR. The Changeset Required check may ask for a"
echo "     changeset fragment — drop one if needed:"
echo "       npm run changeset -- --type Changed --pr <PR#> \\"
echo "         --body \"Introduce \\\`next\\\` integration branch (Phase 1 — additive infrastructure).\""
echo "  2. Get an approval, merge."
echo "  3. Run Phase 2: bash /path/to/rollout-next-phase2.sh"
echo
echo "Recovering your stashed work on $CURRENT_BR (if you had any):"
echo "  git checkout $CURRENT_BR"
echo "  git stash list   # find the 'pre-next-rollout-...' entry"
echo "  git stash pop stash@{N}"
