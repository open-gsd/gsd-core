<purpose>
Create a clean branch for pull requests by filtering out transient .planning/ commits.
The PR branch contains only code changes and structural planning state — reviewers
don't see GSD transient artifacts (PLAN.md, SUMMARY.md, CONTEXT.md, RESEARCH.md, etc.)
but milestone archives, STATE.md, ROADMAP.md, and PROJECT.md changes are preserved.

Uses git cherry-pick with path filtering to rebuild a clean history.
</purpose>

<process>

<step name="detect_state">
Parse `$ARGUMENTS` for target branch (default: `main`).

```bash
CURRENT_BRANCH=$(git branch --show-current)
TARGET=${1:-main}
```

Check preconditions:
- Must be on a feature branch (not main/master)
- Must have commits ahead of target

```bash
AHEAD=$(git rev-list --count "$TARGET".."$CURRENT_BRANCH" 2>/dev/null)
if [ "$AHEAD" = "0" ]; then
  echo "No commits ahead of $TARGET — nothing to filter."
  exit 0
fi
```

Display:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 GSD ► PR BRANCH
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Branch: {CURRENT_BRANCH}
Target: {TARGET}
Commits: {AHEAD} ahead
```
</step>

<step name="handle_sub_repos">
Read the sub-repo list from config using the canonical key path — `planning.sub_repos`.
A non-zero exit code means the key is absent; treat that as "no sub-repos configured".

```bash
SUB_REPOS_JSON=$(gsd_run query config-get planning.sub_repos 2>/dev/null)
if [ $? -ne 0 ] || [ -z "$SUB_REPOS_JSON" ] || [ "$SUB_REPOS_JSON" = "null" ] || [ "$SUB_REPOS_JSON" = "[]" ]; then
  : # Not configured or empty — skip to analyze_commits
fi
```

Scan each sub-repo for uncommitted changes using node (always available — avoids undeclared
jq dependency). Write dirty repo names to a temp file so the list survives across
subsequent command executions:

```bash
ROOT=$(git rev-parse --show-toplevel)
DIRTY_FILE=$(mktemp)

node -e "
  const repos = JSON.parse(process.argv[1]);
  const { execFileSync } = require('child_process');
  const path = require('path');
  const root = process.argv[2];
  const fs = require('fs');
  const out = [];
  for (const r of repos) {
    try {
      const res = execFileSync('git', ['-C', path.join(root, r), 'status', '--porcelain'],
                               { encoding: 'utf8' });
      if (res.trim()) out.push(r);
    } catch (_) {}
  }
  fs.writeFileSync(process.argv[3], out.join('\n'));
" "$SUB_REPOS_JSON" "$ROOT" "$DIRTY_FILE"

DIRTY_REPOS=$(cat "$DIRTY_FILE")
```

If `$DIRTY_REPOS` is empty, remove the temp file and continue to `analyze_commits`.

Display dirty repos and prompt the user:

```
Sub-repos with uncommitted changes:
  backend
  frontend

How should sub-repo changes be handled?
  1. all    — branch, commit (explicit files only), push -u, open companion PR per repo
  2. select — choose which sub-repos to process
  3. skip   — ignore sub-repos, continue with root repo only
```

If the user chooses **skip**, remove the temp file and continue to `analyze_commits`.

For each selected sub-repo `$REPO_REL`, delegate all git work to the `pr-subrepo` query
seam — it stages explicit changed files (never `git add -A`), creates the branch,
commits, and pushes with `--set-upstream`. Branch names include the repo slug to avoid
colliding with the root `PR_BRANCH` that `create_pr_branch` creates later:

```bash
# Replace path separators to make the name safe as a branch component
REPO_SAFE="${REPO_REL//\//-}"
SUB_BRANCH="${CURRENT_BRANCH}-${REPO_SAFE}-pr"
COMMIT_MSG="fix(${REPO_REL}): sync uncommitted changes for PR"

RESULT=$(gsd_run query pr-subrepo "$COMMIT_MSG" \
  --repo "$REPO_REL" \
  --branch "$SUB_BRANCH")
```

Parse the structured result with node and open the companion PR. If `remote_slug` is null
(non-GitHub remote), skip `gh pr create` and show the push URL instead:

```bash
REMOTE_SLUG=$(node -e "
  try { console.log(JSON.parse(process.argv[1]).remote_slug || ''); } catch(_) {}
" "$RESULT")

if [ -n "$REMOTE_SLUG" ]; then
  # Resolve base branch: use $TARGET if it exists in sub-repo, else fall back to
  # the sub-repo's own default branch
  if git -C "$ROOT/$REPO_REL" ls-remote --exit-code --heads origin "$TARGET" \
       > /dev/null 2>&1; then
    SUB_TARGET="$TARGET"
  else
    SUB_TARGET=$(git -C "$ROOT/$REPO_REL" remote show origin 2>/dev/null \
      | awk '/HEAD branch/ {print $NF}')
    SUB_TARGET="${SUB_TARGET:-main}"
  fi

  gh pr create \
    --repo "$REMOTE_SLUG" \
    --base "$SUB_TARGET" \
    --head "$SUB_BRANCH" \
    --title "$COMMIT_MSG" \
    --body "Companion PR for root repo branch \`$CURRENT_BRANCH\`."
else
  echo "No GitHub remote detected for $REPO_REL — branch pushed, open PR manually."
fi
```

After processing all selected sub-repos, remove the temp file and continue to
`analyze_commits` for the root repo.
</step>

<step name="analyze_commits">
Classify commits:

```bash
# Get all commits ahead of target
git log --oneline "$TARGET".."$CURRENT_BRANCH" --no-merges
```

**Structural planning files** — always preserved (repository planning state):
- `.planning/STATE.md`
- `.planning/ROADMAP.md`
- `.planning/MILESTONES.md`
- `.planning/PROJECT.md`
- `.planning/REQUIREMENTS.md`
- `.planning/milestones/**`

**Transient planning files** — excluded from PR branch (reviewer noise):
- `.planning/phases/**` (PLAN.md, SUMMARY.md, CONTEXT.md, RESEARCH.md, etc.)
- `.planning/quick/**`
- `.planning/research/**`
- `.planning/threads/**`
- `.planning/todos/**`
- `.planning/debug/**`
- `.planning/seeds/**`
- `.planning/codebase/**`
- `.planning/ui-reviews/**`

For each commit, check what it touches:

```bash
# For each commit hash
FILES=$(git diff-tree --no-commit-id --name-only -r $HASH)
NON_PLANNING=$(echo "$FILES" | grep -v "^\.planning/" | wc -l)
STRUCTURAL=$(echo "$FILES" | grep -E "^\.planning/(STATE|ROADMAP|MILESTONES|PROJECT|REQUIREMENTS)\.md|^\.planning/milestones/" | wc -l)
TRANSIENT_ONLY=$(echo "$FILES" | grep "^\.planning/" | grep -vE "^\.planning/(STATE|ROADMAP|MILESTONES|PROJECT|REQUIREMENTS)\.md|^\.planning/milestones/" | wc -l)
```

Classify:
- **Code commits**: Touch at least one non-.planning/ file → INCLUDE
- **Structural planning commits**: Touch only structural .planning/ files (STATE.md, ROADMAP.md, MILESTONES.md, PROJECT.md, REQUIREMENTS.md, milestones/**) → INCLUDE
- **Transient planning commits**: Touch only transient .planning/ files (phases/, quick/, research/, etc.) → EXCLUDE
- **Mixed commits**: Touch code + any planning files → INCLUDE (transient planning changes come along; acceptable in mixed context)

Display analysis:
```
Commits to include: {N} (code changes + structural planning)
Commits to exclude: {N} (transient planning-only)
Mixed commits: {N} (code + planning — included)
Structural planning commits: {N} (STATE/ROADMAP/milestone updates — included)
```
</step>

<step name="create_pr_branch">
```bash
PR_BRANCH="${CURRENT_BRANCH}-pr"

# Create PR branch from target
git checkout -b "$PR_BRANCH" "$TARGET"
```

Cherry-pick code commits and structural planning commits (in order):

```bash
for HASH in $CODE_AND_STRUCTURAL_COMMITS; do
  git cherry-pick "$HASH" --no-commit
  # Remove only transient .planning/ subdirectories that came along in mixed commits.
  # DO NOT remove structural files (STATE.md, ROADMAP.md, MILESTONES.md, PROJECT.md,
  # REQUIREMENTS.md, milestones/) — these must survive into the PR branch.
  for dir in phases quick research threads todos debug seeds codebase ui-reviews; do
    git rm -r --cached ".planning/$dir/" 2>/dev/null || true
  done
  git commit -C "$HASH"
done
```

Return to original branch:
```bash
git checkout "$CURRENT_BRANCH"
```
</step>

<step name="verify">
```bash
# Verify no .planning/ files in PR branch
PLANNING_FILES=$(git diff --name-only "$TARGET".."$PR_BRANCH" | grep "^\.planning/" | wc -l)
TOTAL_FILES=$(git diff --name-only "$TARGET".."$PR_BRANCH" | wc -l)
PR_COMMITS=$(git rev-list --count "$TARGET".."$PR_BRANCH")
```

Display results:
```
✅ PR branch created: {PR_BRANCH}

Original: {AHEAD} commits, {ORIGINAL_FILES} files
PR branch: {PR_COMMITS} commits, {TOTAL_FILES} files
Planning files: {PLANNING_FILES} (should be 0)

Next steps:
  git push origin {PR_BRANCH}
  gh pr create --base {TARGET} --head {PR_BRANCH}

Or use /gsd:ship to create the PR automatically.
```
</step>

</process>

<success_criteria>
- [ ] PR branch created from target
- [ ] Planning-only commits excluded
- [ ] No .planning/ files in PR branch diff
- [ ] Commit messages preserved from original
- [ ] User shown next steps
</success_criteria>
