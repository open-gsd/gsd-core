#!/usr/bin/env zsh
# rollout-next-phase2.sh — native zsh, runs under macOS Terminal's default shell.
# DO NOT prefix with `bash`. Run as: ./rollout-next-phase2.sh
#
# Phase 2 of the `next` integration-branch rollout.
# RUN THIS ONLY AFTER THE PHASE-1 PR HAS BEEN MERGED TO main.
#
# What it does:
#   1. Pulls main (which now contains Phase 1).
#   2. Creates the `next` branch from main HEAD, pushes it.
#   3. Applies branch protection rules via the script committed in Phase 1.
#   4. Switches the repo's default branch to `next` via gh api.
#   5. Flips `if: false` → `if: true` in auto-backmerge.yml.
#   6. Flips `WARN_ONLY: 'true'` → `'false'` in pr-target-validator.yml.
#   7. Commits the flips on a small follow-up branch, opens a PR to next.
#
# Idempotent: re-running converges. Each step checks if it's already done.
#
# Usage:
#   cd /Volumes/Mini\ Me/Users/trekkie/projects/gsd-core
#   bash /path/to/rollout-next-phase2.sh
#
# Env overrides:
#   REPO=open-gsd/gsd-core   (default)
#   SKIP_PROTECTION=1                   (skip running setup-branch-protection.sh)
#   SKIP_DEFAULT_FLIP=1                 (skip switching default branch)
#   DRY_RUN=1                           (skip all pushes, PRs, and api writes)

set -euo pipefail

REPO="${REPO:-open-gsd/gsd-core}"
FLIP_BRANCH="chore/flip-next-rollout-flags"
DRY_RUN="${DRY_RUN:-0}"

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
# Step 0: Sanity
# ───────────────────────────────────────────────────────────
step "Sanity checks"

[ -d .git ] || die "Not in a git repo. cd to your gsd-core checkout."
command -v gh >/dev/null || die "gh not found. https://cli.github.com/"
gh auth status >/dev/null 2>&1 || die "gh not authenticated."

REMOTE_URL=$(git remote get-url origin 2>/dev/null || true)
case "$REMOTE_URL" in
  *"$REPO"*) ok "Remote: $REMOTE_URL" ;;
  *) die "Remote 'origin' is $REMOTE_URL — expected to contain $REPO." ;;
esac

# Protect rollout files from the stash sweep.
ROLLOUT_STAGE=$(mktemp -d)
ROLLOUT_FILES=(rollout-next-phase1.sh rollout-next-phase2.sh next-branch-files.tar.gz)
for f in "${ROLLOUT_FILES[@]}"; do
  [ -f "./$f" ] && mv "./$f" "$ROLLOUT_STAGE/"
done
restore_rollout_files() {
  for f in "$ROLLOUT_STAGE"/*; do
    [ -e "$f" ] || continue
    cp "$f" ./ 2>/dev/null || true
  done
  rm -rf "$ROLLOUT_STAGE" 2>/dev/null || true
}
trap restore_rollout_files EXIT

# Stash any in-progress work before switching branches.
CURRENT_BR=$(git rev-parse --abbrev-ref HEAD)
note "Currently on: $CURRENT_BR"
if [ -n "$(git status --porcelain)" ]; then
  STASH_MSG="pre-next-phase2-$(date +%Y%m%d-%H%M%S) (from $CURRENT_BR)"
  git stash push --include-untracked --message "$STASH_MSG" >/dev/null
  ok "Stashed: $STASH_MSG"
  STASHED=1
else
  STASHED=0
fi

restore_rollout_files

# ───────────────────────────────────────────────────────────
# Step 1: Refresh main, ensure Phase 1 is present
# ───────────────────────────────────────────────────────────
step "Switch to main and pull"

git fetch origin --quiet
git checkout main >/dev/null
git pull --ff-only origin main >/dev/null
ok "main is current at $(git log -1 --format='%h %s' | head -c 80)"

# Phase-1 sentinel files must be on main now.
PHASE1_FILES=(
  "docs/branching.md"
  ".github/workflows/auto-backmerge.yml"
  ".github/workflows/pr-target-validator.yml"
  "scripts/setup-branch-protection.sh"
)
for f in "${PHASE1_FILES[@]}"; do
  [ -f "$f" ] || die "Phase 1 file missing on main: $f. Has the Phase 1 PR merged?"
done
ok "Phase 1 files present on main"

# ───────────────────────────────────────────────────────────
# Step 2: Create next branch (idempotent)
# ───────────────────────────────────────────────────────────
step "Create or verify the next branch"

if git ls-remote --exit-code origin next >/dev/null 2>&1; then
  ok "origin/next already exists — leaving as is"
else
  if [ "$DRY_RUN" = "1" ]; then
    warn "DRY_RUN=1 — would create and push next from main HEAD"
  else
    # Create next from current main HEAD locally and push.
    git checkout -b next main 2>/dev/null || git checkout next
    git push -u origin next
    ok "Created and pushed origin/next at $(git log -1 --format='%h')"
    # Switch back to main so subsequent steps don't accidentally edit next.
    git checkout main >/dev/null
  fi
fi

# ───────────────────────────────────────────────────────────
# Step 3: Apply branch protection
# ───────────────────────────────────────────────────────────
step "Apply branch protection to main and next"

if [ "${SKIP_PROTECTION:-0}" = "1" ]; then
  warn "SKIP_PROTECTION=1 — skipping. You will need to run this manually:"
  note "  bash scripts/setup-branch-protection.sh"
elif [ "$DRY_RUN" = "1" ]; then
  warn "DRY_RUN=1 — would run scripts/setup-branch-protection.sh"
  REPO="$REPO" DRY_RUN=1 bash scripts/setup-branch-protection.sh | head -40 || true
else
  REPO="$REPO" bash scripts/setup-branch-protection.sh
  ok "Branch protection applied"
fi

# ───────────────────────────────────────────────────────────
# Step 4: Flip default branch to next
# ───────────────────────────────────────────────────────────
step "Switch default branch to next"

CURRENT_DEFAULT=$(gh api "/repos/$REPO" --jq '.default_branch')
note "Current default: $CURRENT_DEFAULT"

if [ "$CURRENT_DEFAULT" = "next" ]; then
  ok "Default is already next — skip"
elif [ "${SKIP_DEFAULT_FLIP:-0}" = "1" ]; then
  warn "SKIP_DEFAULT_FLIP=1 — leaving default as $CURRENT_DEFAULT"
  note "To flip later: Settings → Branches → Default branch → next"
elif [ "$DRY_RUN" = "1" ]; then
  warn "DRY_RUN=1 — would PATCH /repos/$REPO default_branch=next"
else
  gh api -X PATCH "/repos/$REPO" -f default_branch=next >/dev/null
  ok "Default branch switched to next"
fi

# ───────────────────────────────────────────────────────────
# Step 5 + 6: Flip the two phase-gate flags on a follow-up branch
# ───────────────────────────────────────────────────────────
step "Flip phase-gate flags (auto-backmerge.yml + pr-target-validator.yml)"

# Both edits need to land on a feature branch off `next`, then PR'd back.
# (We can't push directly to main anymore — branch protection forbids it.)

# Create or switch to the flip branch off next.
git fetch origin next --quiet 2>/dev/null || true
if git show-ref --verify --quiet "refs/heads/$FLIP_BRANCH"; then
  git checkout "$FLIP_BRANCH" >/dev/null
  if git rev-parse --verify "origin/$FLIP_BRANCH" >/dev/null 2>&1; then
    warn "origin/$FLIP_BRANCH already exists — pulling to be sure"
    git pull --ff-only origin "$FLIP_BRANCH" >/dev/null || true
  else
    git reset --hard origin/next >/dev/null
  fi
else
  git checkout -b "$FLIP_BRANCH" origin/next >/dev/null
fi

AUTO_BM=".github/workflows/auto-backmerge.yml"
VALID=".github/workflows/pr-target-validator.yml"

# Flip auto-backmerge: `if: false` (the phase-1 gate line) → `if: true`
# The pattern is anchored by the exact comment + indentation so we don't
# accidentally hit a different `if:` line.
if grep -q "    if: false" "$AUTO_BM"; then
  # macOS-compatible in-place edit
  sed -i.rollout-bak "s/^    if: false$/    if: true/" "$AUTO_BM"
  rm -f "$AUTO_BM.rollout-bak"
  grep -q "    if: true" "$AUTO_BM" || die "auto-backmerge.yml flip didn't take"
  ok "auto-backmerge.yml: if: false → if: true"
elif grep -q "    if: true" "$AUTO_BM"; then
  ok "auto-backmerge.yml already flipped (idempotent skip)"
else
  die "Could not find phase-gate 'if:' line in $AUTO_BM"
fi

# Flip validator: WARN_ONLY: 'true' → 'false'
if grep -q "WARN_ONLY: 'true'" "$VALID"; then
  sed -i.rollout-bak "s/WARN_ONLY: 'true'/WARN_ONLY: 'false'/" "$VALID"
  rm -f "$VALID.rollout-bak"
  grep -q "WARN_ONLY: 'false'" "$VALID" || die "validator flip didn't take"
  ok "pr-target-validator.yml: WARN_ONLY 'true' → 'false'"
elif grep -q "WARN_ONLY: 'false'" "$VALID"; then
  ok "pr-target-validator.yml already flipped (idempotent skip)"
else
  die "Could not find WARN_ONLY in $VALID"
fi

# YAML validation
for f in "$AUTO_BM" "$VALID"; do
  python3 -c "import yaml; yaml.safe_load(open('$f'))" || die "YAML invalid after flip: $f"
done
ok "YAML still valid"

# Commit
git add "$AUTO_BM" "$VALID"
if git diff --cached --quiet; then
  warn "Nothing to commit (already committed)"
else
  git commit -m "chore: enable next-branch automation (Phase 2 flips)

- auto-backmerge.yml: enable the job (was if: false in Phase 1)
- pr-target-validator.yml: enforce instead of warn-only

These flips are the operational gate for the next-branch model. The
next branch and branch protection were created/applied before this PR."
  ok "Committed flips"
fi

# ───────────────────────────────────────────────────────────
# Step 7: Push + open follow-up PR against next
# ───────────────────────────────────────────────────────────
step "Push and open follow-up PR (base = next)"

if [ "$DRY_RUN" = "1" ]; then
  warn "DRY_RUN=1 — skipping push and PR"
else
  git push -u origin "$FLIP_BRANCH"
  ok "Pushed $FLIP_BRANCH"

  EXISTING_PR=$(gh pr list --repo "$REPO" --head "$FLIP_BRANCH" --state open --json number --jq '.[0].number' 2>/dev/null || echo "")
  PR_TITLE="chore: enable next-branch automation (Phase 2 flips)"
  PR_BODY="Phase 2 follow-up to the \`next\` integration-branch rollout.

This PR flips the two phase-gate flags that shipped inert in Phase 1:

- \`auto-backmerge.yml\`: \`if: false\` → \`if: true\` (the back-merge job now runs on every push to main)
- \`pr-target-validator.yml\`: \`WARN_ONLY: 'true'\` → \`'false'\` (the validator now fails the check instead of just commenting)

The \`next\` branch and branch-protection rules were created/applied out-of-band by \`scripts/rollout-next-phase2.sh\` before this PR.

After this merges, the model is fully live. New PRs should target \`next\` (it's the default now); the validator will catch mistakes and tell contributors how to retarget."

  if [ -n "$EXISTING_PR" ]; then
    echo "$PR_BODY" | gh pr edit "$EXISTING_PR" --repo "$REPO" --title "$PR_TITLE" --body-file -
    ok "Updated existing PR #$EXISTING_PR"
  else
    PR_URL=$(echo "$PR_BODY" | gh pr create \
      --repo "$REPO" \
      --base next \
      --head "$FLIP_BRANCH" \
      --title "$PR_TITLE" \
      --body-file -)
    ok "Opened PR: $PR_URL"
  fi
fi

# ───────────────────────────────────────────────────────────
# Done
# ───────────────────────────────────────────────────────────
echo
echo "${C_BOLD}${C_GRN}━━━ Phase 2 complete ━━━${C_RST}"
echo
echo "What's live now:"
echo "  • next branch exists, branch protection applied to main + next"
echo "  • Default branch: next (new PRs default to it)"
echo "  • auto-backmerge.yml: enabled — will open main→next PR after each push to main"
echo "  • pr-target-validator.yml: enforcing — fails the check on wrong target"
echo
echo "Follow-up PR to merge: $(gh pr list --repo "$REPO" --head "$FLIP_BRANCH" --state open --json url --jq '.[0].url' 2>/dev/null || echo "(check gh pr list)")"
echo
echo "Phase 3 (when ready, weeks-to-months out): apply the release.yml /"
echo "hotfix.yml / auto-branch.yml patches inlined in the ADR."
if [ "$STASHED" = "1" ]; then
  echo
  echo "Your earlier work is stashed. Recover it with:"
  echo "  git checkout $CURRENT_BR  &&  git stash list  &&  git stash pop stash@{0}"
fi
