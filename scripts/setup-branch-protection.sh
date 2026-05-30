#!/usr/bin/env bash
# setup-branch-protection.sh
#
# Apply branch protection rules to `main` and `next` for the GSD repo.
# Idempotent — run as many times as you like. Re-running brings the live
# rules back to what this script declares, so the script IS the source of
# truth for branch protection.
#
# Usage:
#   bash scripts/setup-branch-protection.sh             # apply both
#   bash scripts/setup-branch-protection.sh main        # apply only main
#   bash scripts/setup-branch-protection.sh next        # apply only next
#   DRY_RUN=1 bash scripts/setup-branch-protection.sh   # show payloads, don't apply
#
# Requirements:
#   - gh CLI authenticated against open-gsd/gsd-core with admin scope
#   - jq installed
#
# What it sets:
#
#   main (strict — production):
#     - 2 required approving reviews
#     - dismiss stale reviews on push
#     - require code-owner review when CODEOWNERS applies
#     - all required status checks must pass (defined in REQUIRED_CHECKS_MAIN below)
#     - require branches to be up to date before merging  (ON — `main` is production)
#     - require linear history (OFF — release back-merges use merge commits)
#     - require conversation resolution
#     - require signed commits
#     - block force-push and deletion
#     - admins included
#
#   next (loose — integration):
#     - 1 required approving review
#     - dismiss stale reviews on push
#     - require code-owner review when CODEOWNERS applies
#     - all required status checks must pass (defined in REQUIRED_CHECKS_NEXT below)
#     - require branches to be up to date before merging  (OFF — this is the whole point)
#     - require linear history (OFF — auto-backmerge from main needs merge commits
#       to preserve the link from next's history to main's release tags;
#       feature PRs still squash-merge by repo merge-strategy setting)
#     - require conversation resolution
#     - require signed commits (OFF on next — easier for contributors)
#     - block force-push and deletion
#     - admins included
#
# See: docs/adr/XXXX-introduce-next-integration-branch.md
# See: docs/branching.md

set -euo pipefail

REPO="${REPO:-open-gsd/gsd-core}"
DRY_RUN="${DRY_RUN:-0}"

# Required status checks. Adjust as your CI suite evolves.
# The names must match the JOB NAME (not the workflow name) that GitHub
# records — check existing PRs to confirm.
REQUIRED_CHECKS_MAIN=(
  "test"
  "install-smoke"
  "security-scan"
  "Changeset Required / changeset-lint"
  "Docs Required / docs-lint"
  "PR Gate / size-check"
  "Validate Branch Name / check-branch"
)

REQUIRED_CHECKS_NEXT=(
  "test"
  "PR Gate / size-check"
  "Validate Branch Name / check-branch"
  "Changeset Required / changeset-lint"
  "Docs Required / docs-lint"
  "PR Target Validator / validate-target"
)

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "ERROR: missing required command: $1" >&2
    exit 1
  }
}

require_cmd gh
require_cmd jq

verify_auth() {
  if ! gh auth status >/dev/null 2>&1; then
    echo "ERROR: gh CLI is not authenticated. Run 'gh auth login' first." >&2
    exit 1
  fi
}

build_payload() {
  local branch="$1"
  shift
  local checks_array=("$@")

  # Branch-specific knobs.
  local approvals require_up_to_date linear_history signed_commits
  case "$branch" in
    main)
      approvals=2
      require_up_to_date=true
      linear_history=false
      signed_commits=true
      ;;
    next)
      approvals=1
      require_up_to_date=false
      # linear_history=false: auto-backmerge from main needs merge commits to
      # preserve the link to release tags. Feature PRs still produce one
      # commit each via repo-level "squash and merge" default — that gives
      # us a clean log without enforcing linearity at the protection layer.
      linear_history=false
      signed_commits=false
      ;;
    *)
      echo "ERROR: unknown branch '$branch'" >&2
      exit 1
      ;;
  esac

  # Build the contexts array via jq for safe quoting.
  local contexts_json
  contexts_json=$(printf '%s\n' "${checks_array[@]}" | jq -R . | jq -s .)

  jq -n \
    --argjson contexts "$contexts_json" \
    --argjson approvals "$approvals" \
    --argjson require_up_to_date "$require_up_to_date" \
    --argjson linear_history "$linear_history" \
    --argjson signed_commits "$signed_commits" \
    '{
      required_status_checks: {
        strict: $require_up_to_date,
        contexts: $contexts
      },
      enforce_admins: true,
      required_pull_request_reviews: {
        dismiss_stale_reviews: true,
        require_code_owner_reviews: true,
        required_approving_review_count: $approvals,
        require_last_push_approval: false
      },
      restrictions: null,
      required_linear_history: $linear_history,
      allow_force_pushes: false,
      allow_deletions: false,
      required_conversation_resolution: true,
      required_signatures: $signed_commits,
      lock_branch: false,
      allow_fork_syncing: true
    }'
}

apply_protection() {
  local branch="$1"
  local checks_var_name
  if [ "$branch" = "main" ]; then
    checks_var_name="REQUIRED_CHECKS_MAIN"
  else
    checks_var_name="REQUIRED_CHECKS_NEXT"
  fi

  # Expand the array indirectly (bash 3 compatible — macOS default).
  eval "local checks=(\"\${${checks_var_name}[@]}\")"

  local payload
  payload=$(build_payload "$branch" "${checks[@]}")

  echo "──────────────────────────────────────────"
  echo "Branch: $branch"
  echo "Required checks (${#checks[@]}):"
  printf '  - %s\n' "${checks[@]}"
  echo "──────────────────────────────────────────"

  if [ "$DRY_RUN" = "1" ]; then
    echo "[DRY RUN] Would PUT to /repos/${REPO}/branches/${branch}/protection:"
    echo "$payload" | jq .
    return 0
  fi

  echo "Applying branch protection..."
  echo "$payload" | gh api \
    -X PUT \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    --input - \
    "/repos/${REPO}/branches/${branch}/protection" \
    >/dev/null
  echo "✓ Protection rules applied to $branch."
}

ensure_branch_exists() {
  local branch="$1"
  if ! gh api "/repos/${REPO}/branches/${branch}" >/dev/null 2>&1; then
    echo "ERROR: branch '$branch' does not exist in $REPO." >&2
    if [ "$branch" = "next" ]; then
      cat <<EOF >&2

Create the next branch first:
  git checkout main && git pull --ff-only
  git checkout -b next && git push -u origin next

Then re-run this script.
EOF
    fi
    exit 1
  fi
}

main() {
  verify_auth

  local targets=()
  if [ $# -eq 0 ]; then
    targets=(main next)
  else
    targets=("$@")
  fi

  for branch in "${targets[@]}"; do
    if [ "$branch" != "main" ] && [ "$branch" != "next" ]; then
      echo "ERROR: unsupported branch '$branch'. Use 'main' or 'next'." >&2
      exit 1
    fi
    ensure_branch_exists "$branch"
    apply_protection "$branch"
  done

  echo ""
  echo "Done. To verify: gh api /repos/${REPO}/branches/<branch>/protection | jq ."
}

main "$@"
