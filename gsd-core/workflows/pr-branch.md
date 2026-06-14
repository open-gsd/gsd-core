<purpose>
Create a clean branch for pull requests by filtering out transient .planning/ commits.
The PR branch contains only code changes and structural planning state — reviewers
don't see GSD transient artifacts (PLAN.md, SUMMARY.md, CONTEXT.md, RESEARCH.md, etc.)
but milestone archives, STATE.md, ROADMAP.md, and PROJECT.md changes are preserved.

Uses git cherry-pick with path filtering to rebuild a clean history.
</purpose>

<process>

<step name="detect_state">
Parse `$ARGUMENTS` for target branch. If no argument is supplied, detect the
default branch via the single resolver (#1146).

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; if [ -f "$GSD_TOOLS" ]; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif command -v gsd-tools >/dev/null 2>&1; then GSD_TOOLS="$(command -v gsd-tools)"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif [ -f "$HOME/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="$HOME/.claude/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd-tools is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
CURRENT_BRANCH=$(git branch --show-current)
TARGET=${1:-$(gsd_run query git.base-branch)}
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
