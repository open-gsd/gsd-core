@~/.claude/gsd-core/references/response-language-directive.md

<purpose>
Create a clean branch for pull requests by filtering .planning/ paths out of the
cherry-picked history. Two modes, selected by the `planning.pr_strict` config key:

- **default** (`planning.pr_strict: false`) — the PR branch contains code changes and
  structural planning state. Reviewers don't see GSD transient artifacts (PLAN.md,
  SUMMARY.md, CONTEXT.md, RESEARCH.md, etc.), but milestone archives, STATE.md,
  ROADMAP.md, and PROJECT.md changes are preserved.
- **strict** (`planning.pr_strict: true`) — *every* .planning/ path is filtered out,
  structural files included. This is what makes `planning.commit_docs: true` safe for a
  project that versions its planning tree locally but publishes none of it: planning state
  keeps real git history (so `/gsd:undo` and revert paths have something to restore) and
  executor worktrees still find their PLAN.md, while the public PR carries nothing from
  `.planning/`.

Uses git cherry-pick with path filtering to rebuild a clean history.
</purpose>

<process>

<step name="detect_state">
Parse `$ARGUMENTS` for target branch. If no argument is supplied, detect the
default branch via the single resolver (#1146).

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; _gsd_id_ok() { case "$("$1" runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') return 0;; *) return 1;; esac; }; _gsd_homes() { set -- "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}" "$HOME/.gemini/antigravity-ide" "$HOME/.gemini/antigravity-cli" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}" "${CLINE_CONFIG_DIR:-$HOME/.cline}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}" "${CODEX_HOME:-$HOME/.codex}" "${COPILOT_CONFIG_DIR:-${COPILOT_HOME:-$HOME/.copilot}}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}" "${HERMES_HOME:-$HOME/.hermes}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}" "${KIMI_CONFIG_DIR:-$HOME/.config/agents}" "$HOME/.agents" "${KIMI_CODE_HOME:-$HOME/.kimi-code}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}" "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}" "${TRAE_CONFIG_DIR:-$HOME/.trae}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}" "${ZCODE_CONFIG_DIR:-$HOME/.zcode}" "${GROK_AGENTS_HOME:-$HOME/.agents}"; for _h; do _gsd_at "$_h/gsd-core/bin/${_GSD_SHIM_NAME}" && return 0; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif _gsd_homes; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; [ -n "$_G" ] && _gsd_id_ok "$_G"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and no identity-proving gsd_run is on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; _gsd_id_ok gsd_run && GSD_IDENTITY_STATUS=ok; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
CURRENT_BRANCH=$(git branch --show-current)
TARGET=${1:-$(gsd_run query git.base-branch)}
```

Check preconditions. Run the bash blocks of this step and of the later steps in one shell session, in order (they share variables):
- Must be on a feature branch (not main/master)
- Must have commits since the last published tip (or ahead of target when nothing was published)
- Working tree must be clean

```bash
# Every path below is root-relative.
cd "$(git rev-parse --show-toplevel)" || exit 1
# Resolve the filter mode from config. A non-zero exit or an unset key means the default
# mode; only the literal string `true` selects strict.
PR_STRICT=$(gsd_run query config-get planning.pr_strict --raw 2>/dev/null)
if [ "$PR_STRICT" = "true" ]; then PR_MODE="strict"; else PR_MODE="default"; PR_STRICT="false"; fi
```

**Canonical path declarations.** These three lines are the single source of truth for the
whole command. `create_pr_branch` derives *which paths it removes* from them, and `verify`
derives *which paths must not appear* from the same three lines — so the two steps cannot
disagree about what the filter promised. Declare them exactly once; do not restate either
list anywhere else in this file. Their literal values are drift-guarded (`npm run lint:ci`,
`scripts/lint-pr-branch-pattern-drift.cjs`) against the canonical `src/pr-branch-patterns.cts`
constants — change one side and update the other, or the guard fails.

```bash
# Transient planning subdirectories — reviewer noise (PLAN.md, SUMMARY.md, CONTEXT.md,
# RESEARCH.md, and friends). Filtered out in BOTH modes.
TRANSIENT_DIRS="phases quick research threads todos debug seeds codebase ui-reviews"

# Structural planning files — repository planning state. Preserved in default mode,
# filtered out in strict mode. Anchored on both alternatives so `.planning/STATEX.md`
# and `.planning/STATE.md.bak` are NOT treated as structural. The milestones
# alternative matches only FILES directly under `.planning/milestones/` (e.g.
# `v1.0-ROADMAP.md`) — not a `<milestone>-phases/` subdirectory nested there. That
# subdirectory is reviewer noise, not structural state (#4605); it falls through to
# `$MILESTONE_PHASES_RE` below instead.
STRUCTURAL_RE="^\.planning/(STATE|ROADMAP|MILESTONES|PROJECT|REQUIREMENTS)\.md$|^\.planning/milestones/[^/]+\.md$"

# Milestone-scoped phase-plan directories — the same reviewer noise as
# `$TRANSIENT_DIRS`'s `phases` entry, but nested per-milestone once a project has
# passed at least one milestone: `.planning/milestones/<milestone>-phases/`. The
# milestone slug (`v1.0`, `m2`, ...) varies per project, so this is declared as a
# shape, not a literal path — a single path segment standing in for the slug,
# anchored the same way `$STRUCTURAL_RE`'s alternatives are (#4605).
MILESTONE_PHASES_RE="^\.planning/milestones/[^/]+-phases/"
```

Derive the mode's two projections — `FILTER_PATHS` (what `create_pr_branch` removes from
each cherry-picked commit) and `FORBIDDEN_RE` (what `verify` asserts is absent):

```bash
if [ "$PR_STRICT" = "true" ]; then
  FILTER_PATHS=".planning/"
  FORBIDDEN_RE="^\.planning/"
else
  # One path per LINE, not per space (#4605) — see create_pr_branch's consumption
  # loop: a discovered `<milestone>-phases/` directory can contain a space, so
  # whitespace cannot be the delimiter. Rewrapped through unquoted command
  # substitution (gsd-core#4109): a bare `$VAR` word-splits under bash but not
  # zsh, collapsing every element onto one iteration there.
  FILTER_PATHS=$(for d in $(printf '%s' "$TRANSIENT_DIRS"); do printf '.planning/%s/\n' "$d"; done)
  FORBIDDEN_RE="^\.planning/($(echo "$TRANSIENT_DIRS" | tr ' ' '|'))/|$MILESTONE_PHASES_RE"

  # $MILESTONE_PHASES_RE is a shape, not a path — create_pr_branch's filter loop
  # needs concrete paths to `git rm`, so resolve which `<milestone>-phases/`
  # directories actually exist in this worktree (#4605). A project with no
  # milestones yet (`.planning/milestones/` absent) yields nothing here, same as
  # any other empty FILTER_PATHS entry. `-exec printf ... \;` rather than
  # `for D in $(find ...)`: a `for` over unquoted `find` output word-splits a
  # milestone slug containing a space into two spurious entries (ShellCheck
  # SC2044) — the exact class of bug #4109 already fixed once in this file.
  MILESTONE_PHASE_DIRS=""
  if [ -d .planning/milestones ]; then
    MILESTONE_PHASE_DIRS=$(find .planning/milestones -mindepth 1 -maxdepth 1 -type d -name '*-phases' -exec printf '%s/\n' {} \;) || { echo "Cannot list .planning/milestones; fix its permissions and re-run." >&2; exit 1; }
  fi
  # Appended as its own LINE, and only when non-empty so no blank entry is
  # introduced. The separator is a literal newline inside the quotes — `$(...)`
  # has already stripped the trailing one off each side.
  if [ -n "$MILESTONE_PHASE_DIRS" ]; then
    FILTER_PATHS="${FILTER_PATHS}
${MILESTONE_PHASE_DIRS}"
  fi
fi
```

The preconditions below read the filter projections above, so they come first.

```bash
# TARGET comes from config: refuse an option-like name; git gets only its sha.
case $TARGET in -*) echo "Refusing target $TARGET: it starts with -." >&2; exit 1 ;; esac
TARGET_SHA=$(git rev-parse -q --verify "refs/heads/$TARGET^{commit}" || git rev-parse -q --verify "$TARGET^{commit}") || { echo "Unknown target: $TARGET" >&2; exit 1; }
PR_BRANCH="${CURRENT_BRANCH}-pr"
CUR=refs/heads/$CURRENT_BRANCH
TIP=$(git rev-parse "$CUR")
# Keyed by mode (strict skips what default publishes). refkey STR: one valid ref component, injective, never a
# key prefix: %, /, control, non-ASCII and git-forbidden bytes become %XX.
refkey() { printf %s "$1" | od -An -v -tu1 | LC_ALL=C awk 'BEGIN{ORS=""}{for(i=1;i<=NF;i++){b=$i;c=sprintf("%c",b);if(b<32||b>126||index("%/ ~^:?*[\\.@",c))printf "%%%02X",b;else printf "%s",c}}'; }
REF_KEY="$PR_MODE/$(refkey "$TARGET")/$(refkey "$CURRENT_BRANCH")"
MARKER_REF="refs/gsd/pr-published/$REF_KEY"
PENDING_REF="refs/gsd/pr-built/$REF_KEY"
PR_TIP_REF="refs/gsd/pr-built-head/$REF_KEY"
PR_BRANCH_TIP=$(git rev-parse -q --verify "refs/heads/$PR_BRANCH")
# gh --base: TARGET without its leading remote name (any configured remote).
PR_BASE=$TARGET
for _r in $(git remote); do [ "${TARGET#"$_r"/}" != "$TARGET" ] && PR_BASE=${TARGET#"$_r"/}; done

# shq STR — STR shell-quoted for printed commands (a branch name may hold ; $ ( ) & `).
shq() { case "$1" in ''|*[!A-Za-z0-9._/@%+=:,-]*) printf "'%s'" "$(printf %s "$1" | sed "s/'/'\\\\''/g")" ;; *) printf %s "$1" ;; esac; }

# _to CMD... — CMD capped at ${TO:-10}s by gsd_run run-with-timeout; walks and checkout use TO=60.
_to() { gsd_run run-with-timeout "${TO:-10}" -- "$@"; }
# picked SHA — rc 0 when the pick step would pick SHA, or its lookup fails.
picked() { local F; F=$(set -o pipefail; _to git diff-tree -z --no-commit-id --name-only -r "$1" | tr '\0' '\n') || return 0; [ -n "$F" ] && { grep -qv '^\.planning/' <<<"$F" || { [ "$PR_STRICT" != true ] && grep -Eq "$STRUCTURAL_RE" <<<"$F"; }; }; }

# pr_merged TIP — TIP is in $TARGET: an ancestor, or $TARGET holds TIP's content for each path TIP changed
# since their fork (squash/rebase), or gh reports $PR_BRANCH merged into it with head TIP.
pr_merged() {
  local _sha _fork _top _g
  _top=$(_to git rev-parse --show-toplevel) || return 1 # --name-only paths are root-relative
  _to git merge-base --is-ancestor "$1" "$TARGET_SHA" 2>/dev/null && return 0
  _sha=$(_to git rev-parse -q --verify "$1") || return 1
  # pipefail: a path list cut short by a failure or timeout proves nothing.
  if _fork=$(_to git merge-base "$_sha" "$TARGET_SHA" 2>/dev/null) && [ -n "$(_to git -C "$_top" diff --name-only "$_fork" "$_sha")" ] &&
    ( set -o pipefail; _to git -C "$_top" diff --name-only --no-renames -z "$_fork" "$_sha" | _to xargs -0 git -C "$_top" --literal-pathspecs diff --quiet "$_sha" "$TARGET_SHA" -- ); then
    return 0
  fi
  # Last proof: gh, only as an executable (a function or alias cannot be bounded). No answer means not merged.
  _g=$(command -v gh) || return 1
  case $_g in /*) ;; *) return 1 ;; esac
  _to gh pr list --state merged --head "$PR_BRANCH" --base "$PR_BASE" --json headRefOid --jq '.[].headRefOid' 2>/dev/null | grep -qx "$_sha"
}

# The last build counts as published once its -pr tip (PR_TIP_REF) is merged, even with the -pr deleted.
PENDING_TIP=$(git rev-parse -q --verify "$PENDING_REF")
# One verdict for the leftover -pr branch (each lookup may call gh); the refusal below reads it.
PR_BRANCH_MERGED=
PENDING_VERDICT=
KEEP=
[ -n "$PR_BRANCH_TIP" ] && pr_merged "$PR_BRANCH_TIP" && PR_BRANCH_MERGED=1
# drop_pending runs the printed discard command.
DISCARD_PENDING="git update-ref -d $(shq "$PENDING_REF") && git update-ref -d $(shq "$PR_TIP_REF")"
drop_pending() { eval "$DISCARD_PENDING"; }
if [ -n "$PENDING_TIP" ]; then
  # The built tip must be merged; the -pr verdict counts only while the -pr holds it (amended).
  PR_BUILT_TIP=$(git rev-parse -q --verify "$PR_TIP_REF")
  BUILT_MERGED=
  if pr_merged "$PR_TIP_REF"; then BUILT_MERGED=1
  elif [ -n "$PR_BRANCH_TIP" ] && _to git merge-base --is-ancestor "$PR_BUILT_TIP" "$PR_BRANCH_TIP" 2>/dev/null; then BUILT_MERGED=$PR_BRANCH_MERGED; fi
  # settle_pending applies the verdict once no refusal can follow; an unproven build is dropped.
  if [ -n "$BUILT_MERGED" ]; then PENDING_VERDICT=promote
  elif [ -n "$PR_BRANCH_MERGED" ] && [ "$(_to git rev-list --count "$PR_BRANCH_TIP" --not "$PR_BUILT_TIP" 2>/dev/null)" != 0 ]; then PENDING_VERDICT=unproven
  else PENDING_VERDICT=drop
  fi
fi
settle_pending() {
  case $PENDING_VERDICT in
    promote) if git update-ref "$MARKER_REF" "$PENDING_TIP"; then drop_pending; else KEEP=1; echo "WARNING: could not record $MARKER_REF; next run will replay commits." >&2; fi ;;
    drop)
      drop_pending
      echo "WARNING: dropped the pending build $PENDING_TIP: its merge into $TARGET is not proven, so its commits will be replayed. If it was merged (squash, rebase, or on a remote $TARGET not yet pulled), update $TARGET, then re-anchor: git update-ref $(shq "$MARKER_REF") $PENDING_TIP" >&2 ;;
  esac
}

# BASE bounds every commit range below: the last published tip when still an ancestor, else $TARGET.
BASE="$TARGET_SHA"
MARKER_TIP=$(git rev-parse -q --verify "$MARKER_REF")
[ "$PENDING_VERDICT" = promote ] && MARKER_TIP=$PENDING_TIP
if [ -n "$MARKER_TIP" ]; then
  _to git merge-base --is-ancestor "$MARKER_TIP" "$CUR"; _a=$?
  [ $_a -gt 1 ] && { echo "Cannot check $MARKER_REF; re-run." >&2; exit 1; }
  if [ $_a = 0 ]; then
    BASE="$MARKER_TIP"
  else
    # History rewritten: match by patch-id over kept paths. A published commit with no equal patch counts when its
    # files are unchanged from the published tip to $TARGET (squash, then rebase). BASE ends the leading run of
    # published or unpicked (N) commits. Warn on an unmatched published commit, a matched one above an unpublished
    # one, a picked one with no patch-id, or a failed lookup.
    # rw_git GIT-ARGS... — git with its output config pinned, bounded, limited to the kept paths.
    rw_git() {
      set -- "$@" --no-color --no-ext-diff -- ':/'
      while IFS= read -r _p; do [ -n "$_p" ] && set -- "$@" ":(exclude)$_p"; done <<RW_PATHS_EOF
$FILTER_PATHS
RW_PATHS_EOF
      TO=60 _to git -c color.ui=never -c diff.relative=false "$@"
    }
    REWRITE=WARN
    # Section and F commit lines start with a TAB; git quotes any path holding one, so none can match.
    if RW_L=$(TO=60 _to git rev-list --no-merges --left-only "$MARKER_TIP...$CUR" 2>/dev/null) &&
      RW_R=$(TO=60 _to git rev-list --no-merges --topo-order --right-only "$MARKER_TIP...$CUR" --not "$TARGET_SHA" 2>/dev/null) &&
      RW_N=$(for H in $(printf '%s\n%s' "$RW_L" "$RW_R"); do picked "$H" || echo "$H"; done) &&
      RW_D=$(rw_git diff --name-only --no-renames "$MARKER_TIP" "$TARGET_SHA" 2>/dev/null) &&
      RW_F=$(rw_git log --full-history --name-only --format='%x09%H' "$MARKER_TIP...$CUR" 2>/dev/null) &&
      RW_P=$(set -o pipefail; rw_git log -p --full-history --no-merges --format='commit %H' "$MARKER_TIP...$CUR" | TO=60 _to git patch-id --stable); then
      REWRITE=$(printf '\tL\n%s\n\tR\n%s\n\tD\n%s\n\tF\n%s\n\tP\n%s\n\tN\n%s\n' "$RW_L" "$RW_R" "$RW_D" "$RW_F" "$RW_P" "$RW_N" |
        awk '/^\t[LRDFPN]$/{s=index("LRDFPN",substr($0,2));next}
          s==1&&NF{L[$1]=nl++} s==2&&NF{R[++n]=$1} s==3&&$0!=""{dif[$0]=1}
          s==4&&/^\t/{cur=substr($0,2);next} s==4&&$0!=""{nf[cur]++; if($0 in dif)nd[cur]++}
          s==5&&NF{pid[$2]=$1} s==6&&NF{np[$1]=1}
          END{ if(!nl){print "WARN";exit}
            for(c in pid){ if(c in L) lp[pid[c]]=1; else here[pid[c]]=1 }
            for(c in L) if(!(c in np)&&((c in pid)?(!(pid[c] in here)&&nd[c]>0):nf[c]>0)){print "WARN";exit}
            for(i=n;i>=1;i--){ c=R[i]
              if(!(c in np)&&!(c in pid)){print "WARN";exit}
              if(!stop && (c in np || (pid[c] in lp))){tip=c;continue}
              stop=1; if(pid[c] in lp){print "WARN";exit} }
            print "OK", (tip==""?"-":tip) }')
    fi
    case $REWRITE in
      "OK -") ;;
      OK\ *) BASE=${REWRITE#OK } ;;
      *) echo "WARNING: $MARKER_REF is not an ancestor of $CURRENT_BRANCH and its patches do not all match a commit here (history rewritten); using $TARGET as base. Re-anchor: git update-ref $(shq "$MARKER_REF") <rebased commit equivalent to last published tip>" >&2 ;;
    esac
  fi
elif [ -n "$PR_BRANCH_MERGED" ]; then
  echo "WARNING: $PR_BRANCH is merged into $TARGET but nothing is recorded as published for $CURRENT_BRANCH in $PR_MODE mode, so every commit is picked again. If an earlier publish is merged, re-anchor: git update-ref $(shq "$MARKER_REF") <last published commit on $CURRENT_BRANCH>" >&2
fi
# The filter below removes files from the index AND the working tree before each
# commit lands, and this command switches branches underneath the user's own
# checkout. An uncommitted edit to a tracked file would be destroyed by that, and
# git cherry-pick refuses to run against a dirty tree anyway — so fail here, where
# the message is legible, rather than midway through the cherry-pick loop.
DIRTY=$(git status --porcelain --untracked-files=no)
if [ -n "$DIRTY" ]; then
  echo "Working tree has uncommitted changes — commit or stash them first:" >&2
  echo "$DIRTY" >&2
  exit 1
fi

# A leftover -pr branch is reset only when already merged. Refuse here, before handle_sub_repos
# pushes branches and opens PRs, so a refused run has no outward effects.
if [ -n "$PR_BRANCH_TIP" ] && { [ -z "$PR_BRANCH_MERGED" ] || [ "$PENDING_VERDICT" = unproven ]; }; then
  if [ -z "$PR_BRANCH_MERGED" ]; then echo "$PR_BRANCH exists and is not merged into $TARGET (if it was merged on a remote $TARGET, update $TARGET and re-run). Else choose one, then re-run:" >&2
  else echo "$PR_BRANCH is merged into $TARGET but no longer holds the pending build $PENDING_TIP. Choose one, then re-run:" >&2; fi
  if [ "$PENDING_VERDICT" != promote ] && git rev-parse -q --verify "$PENDING_REF" >/dev/null; then
    echo "  published (re-anchor): git update-ref $(shq "$MARKER_REF") \$(git rev-parse $(shq "$PENDING_REF")) && git branch -D $(shq "$PR_BRANCH") && $DISCARD_PENDING" >&2
    echo "  discard: git branch -D $(shq "$PR_BRANCH") && $DISCARD_PENDING" >&2
  else
    echo "  discard: git branch -D $(shq "$PR_BRANCH")" >&2
  fi
  exit 1
fi
settle_pending
AHEAD=$(_to git rev-list --count "$CUR" --not "$BASE" "$TARGET_SHA")
if [ "$AHEAD" = "0" ]; then
  echo "No commits ahead of the last published tip (or $TARGET) — nothing to filter."
  exit 0
fi
```

Display:
```
### GSD ► PR BRANCH

Branch: {CURRENT_BRANCH}
Target: {TARGET}
Commits: {AHEAD} ahead
Mode:    {PR_MODE}  (planning.pr_strict={PR_STRICT})
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
# #5548: drop inherited repo-location vars (set inside git hooks) so cwd, not GIT_DIR, picks ROOT.
unset GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_OBJECT_DIRECTORY GIT_DIR GIT_WORK_TREE GIT_IMPLICIT_WORK_TREE GIT_GRAFT_FILE GIT_INDEX_FILE GIT_NO_REPLACE_OBJECTS GIT_REPLACE_REF_BASE GIT_PREFIX GIT_SHALLOW_FILE GIT_COMMON_DIR
ROOT=$(git rev-parse --show-toplevel)
DIRTY_FILE=$(mktemp)

node -e "
  const repos = JSON.parse(process.argv[1]);
  const { execFileSync } = require('child_process');
  const path = require('path');
  const fs = require('fs');
  const root = process.argv[2];
  // realpath parity with the pr-subrepo seam's validatePath: resolve $ROOT through
  // symlinks once so the containment check below compares real paths, not text.
  let realRoot;
  try { realRoot = fs.realpathSync(root); } catch (_) { realRoot = path.resolve(root); }
  const out = [];
  for (const r of repos) {
    // Reject before any git invocation: this scan runs on raw config values,
    // ahead of the pr-subrepo seam's own validatePath guard. A traversal,
    // embedded-newline, or symlink entry here would run git outside the
    // workspace, or inject a spurious record into the dirty-file output.
    if (typeof r !== 'string' || !/^[A-Za-z0-9._\/-]+$/.test(r)) continue;
    // realpathSync follows symlinks — path.resolve only normalizes '..' textually,
    // so an in-tree symlink pointing outside root would otherwise smuggle git out.
    let resolved;
    try { resolved = fs.realpathSync(path.resolve(realRoot, r)); } catch (_) { continue; }
    if (resolved !== realRoot && !resolved.startsWith(realRoot + path.sep)) continue;
    try {
      const res = execFileSync('git', ['-C', resolved, 'status', '--porcelain'],
                               { encoding: 'utf8', timeout: 10_000 });
      // Exclude untracked-only repos: seam filters ?? lines, so detection must match.
      const tracked = res.split('\n').filter(l => l.length > 0 && !l.startsWith('??'));
      if (tracked.length > 0) out.push(r);
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
SUBREPO_EXIT=$?
```

If the seam exited non-zero (stage/commit/push failure), report its error and move on to
the next selected sub-repo. **Do not run the companion-PR step below for this repo** —
the seam's stderr already explains the failure, and the "branch pushed" path would
otherwise contradict it:

```bash
if [ "$SUBREPO_EXIT" -ne 0 ]; then
  echo "pr-subrepo failed for $REPO_REL — see error above; skipping companion PR." >&2
fi
```

Only when `$SUBREPO_EXIT` is `0`, parse the structured result with node and open the
companion PR. If `remote_slug` is null (non-GitHub remote), skip `gh pr create` and show
the push URL instead:

```bash
REMOTE_SLUG=$(node -e "
  try { console.log(JSON.parse(process.argv[1]).remote_slug || ''); } catch(_) {}
" "$RESULT")

if [ -n "$REMOTE_SLUG" ]; then
  # Defense-in-depth: $REPO_REL was already validated by the dirty-scan filter and
  # the pr-subrepo seam's validatePath, but these are separate, independent git -C
  # invocations on the same value. Resolve it through symlinks with the SAME realpath
  # containment the seam uses (path.resolve alone would not catch a symlink escape),
  # and run git against the validated absolute path rather than re-concatenating.
  SUB_REPO_DIR=$(node -e "
    const fs = require('fs'), path = require('path');
    try {
      const realRoot = fs.realpathSync(process.argv[1]);
      const resolved = fs.realpathSync(path.resolve(realRoot, process.argv[2]));
      if (resolved !== realRoot && !resolved.startsWith(realRoot + path.sep)) process.exit(1);
      process.stdout.write(resolved);
    } catch (_) { process.exit(1); }
  " "$ROOT" "$REPO_REL" 2>/dev/null)

  if [ -z "$SUB_REPO_DIR" ]; then
    echo "Refusing unsafe sub-repo path: $REPO_REL" >&2
    SUB_TARGET="$TARGET"
  else
    # Resolve base branch: use $TARGET if it exists in sub-repo, else fall back to
    # the sub-repo's own default branch
    if git -C "$SUB_REPO_DIR" ls-remote --exit-code --heads origin "$TARGET" \
         > /dev/null 2>&1; then
      SUB_TARGET="$TARGET"
    else
      SUB_TARGET=$(git -C "$SUB_REPO_DIR" remote show origin 2>/dev/null \
        | awk '/HEAD branch/ {print $NF}')
      SUB_TARGET="${SUB_TARGET:-main}"
    fi
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
# Get all commits ahead of the base: these are the only candidates to pick
TO=60 _to git log --oneline --no-merges "$CUR" --not "$BASE" "$TARGET_SHA"
REVS=$(TO=60 _to git rev-list --reverse --no-merges "$CUR" --not "$BASE" "$TARGET_SHA") || { echo "Cannot list the commits to pick; re-run." >&2; exit 1; }
INCLUDED_COMMITS=$(for H in $(printf '%s' "$REVS"); do picked "$H" && echo "$H"; done)
```

For each commit, check what it touches:

```bash
# For each commit hash
FILES=$(git diff-tree -z --no-commit-id --name-only -r $HASH | tr '\0' '\n')
NON_PLANNING=$(grep -Ecv '^(\.planning/|$)' <<<"$FILES" || true)
STRUCTURAL=$(grep -Ec "$STRUCTURAL_RE" <<<"$FILES" || true)
PLANNING_COUNT=$(grep -c "^\.planning/" <<<"$FILES" || true)
```

Classify, using `NON_PLANNING`, `STRUCTURAL`, and `PLANNING_COUNT` computed above — every arm's
condition is explicit and computable so no reading of it is ambiguous:
- **Code commits**: `NON_PLANNING > 0` and `PLANNING_COUNT == 0` → INCLUDE (both modes)
- **Mixed code+planning commits**: `NON_PLANNING > 0` and `PLANNING_COUNT > 0` → INCLUDE (both
  modes; the planning paths are filtered out by `create_pr_branch`, not the commit)
- **Structural-only planning commits**: `NON_PLANNING == 0` and `STRUCTURAL == PLANNING_COUNT`
  and `PLANNING_COUNT > 0` (every `.planning/` file touched is structural) → INCLUDE in
  **default** mode; **EXCLUDE** in strict mode, which has no structural carve-out
- **Mixed planning commits (#4447)**: `NON_PLANNING == 0` and `STRUCTURAL > 0` and
  `STRUCTURAL < PLANNING_COUNT` (some but not all `.planning/` files touched are structural —
  the rest are transient and/or the "other" bucket, e.g. `config.json`/`intel/`) → INCLUDE in
  **default** mode (the transient-dir subset of the non-structural paths is filtered out by
  `create_pr_branch`'s universal per-commit filter exactly as for a mixed code+planning commit;
  any "other" non-structural, non-transient path — `config.json`, `intel/`, etc. — is simply
  preserved, same as default mode already does for such paths on any commit); **EXCLUDE** in
  strict mode
- **Transient-only planning commits**: `NON_PLANNING == 0` and `STRUCTURAL == 0` and
  `PLANNING_COUNT > 0` → EXCLUDE (both modes)

In strict mode this collapses to a single rule: `NON_PLANNING > 0` → INCLUDE, else EXCLUDE.

Display analysis:
```
Commits to include: {N} (code changes{, + structural planning — default mode only})
Commits to exclude: {N} (planning-only)
Mixed commits: {N} (code + planning — included, planning paths filtered)
Structural planning commits: {N} ({included|excluded — strict mode})
Mixed planning commits: {N} ({included — structural + transient/other, planning paths filtered|excluded — strict mode})
```
</step>

<step name="create_pr_branch">
```bash
# Create PR branch from target; -B resets a merged leftover (the preconditions refused any other).
TO=60 _to git checkout -q --no-track -B "$PR_BRANCH" "$TARGET_SHA" || { echo "could not create $PR_BRANCH from $TARGET" >&2; exit 1; }
```

Cherry-pick the included commits, in order, filtering `$FILTER_PATHS` out of each one.

The filter forces every filtered path back to **exactly what the PR branch's HEAD already
has**, in both the index and the working tree. That is stricter than simply un-staging, and
both halves matter:

- `git rm -r -f --ignore-unmatch` clears the index entry (including an unmerged one) and
  removes the file the pick just wrote. It only ever touches paths that are in the index, so
  a genuinely untracked planning file of the user's is never harmed.
- `git checkout HEAD --` then restores whatever the target branch legitimately tracks at
  those paths. **Without this, un-staging a path the target branch already tracks records a
  DELETION** — the generated PR would remove the base branch's planning files. In strict mode
  that would be the base's entire `.planning/` tree.

Leaving the filtered file behind in the working tree is not an option either: a later commit
touching the same planning path makes `git cherry-pick` abort with *"untracked working tree
files would be overwritten by merge"*, and every remaining commit is silently dropped.

```bash
# Rewrapped through unquoted command substitution (gsd-core#4109): a bare
# `$VAR` word-splits under bash but not zsh, collapsing every element onto
# one iteration there.
for HASH in $(printf '%s' "$INCLUDED_COMMITS"); do
  # A modify/delete conflict on a filtered path is EXPECTED and is resolved below — the
  # filtered path is absent from HEAD by construction. Do not treat it as a failure here.
  git cherry-pick --no-commit "$HASH" || true

  # One path per LINE, not per space (#4605) — a discovered `<milestone>-phases/`
  # directory can contain a space, so `for P in $(printf ...)` would word-split it
  # into spurious entries. `while IFS= read -r` reads $FILTER_PATHS one line at a
  # time instead, matching the newline-safe pattern used to build $FILTER_PATHS above.
  while IFS= read -r P; do
    [ -n "$P" ] || continue
    git rm -r -f -q --ignore-unmatch -- "$P" 2>/dev/null || true
    git checkout HEAD -- "$P" 2>/dev/null || true
  done <<FILTER_PATHS_EOF
$FILTER_PATHS
FILTER_PATHS_EOF

  # #4606: a conflict on a "third bucket" path (`.planning/` — not `$FORBIDDEN_RE`
  # transient, not `$STRUCTURAL_RE` structural — the same bucket `verify`'s
  # `$OTHER` reports) is not a real conflict either, and needs its own
  # resolution distinct from the filter loop above. Such a path is never
  # per-commit replayed by classification — a commit touching ONLY a
  # third-bucket path is EXCLUDEd — so when a LATER included commit (structural
  # or code + that same path) reuses it, the diff's context can predate
  # whatever the PR branch actually has, and cherry-pick reports a genuine
  # content conflict on a path this command was never asked to filter.
  # `git checkout --theirs` resolves it correctly by construction: in a
  # cherry-pick's 3-way merge, "theirs" IS $HASH's own content for that path —
  # exactly the chained final value the path is owed, the same guarantee
  # `create_pr_branch` already gives structural files. A path $HASH deletes has
  # no "theirs" blob to check out, so fall back to accepting the deletion (the
  # `verify` step's `$PLANNING_DELETIONS` gate independently catches this if
  # `$TARGET` ever legitimately tracked that path).
  #
  # The deleted-by-$HASH case is checked explicitly with `git cat-file -e`
  # rather than inferred from `checkout --theirs` failing, so an unrelated
  # checkout failure (I/O, permissions, a stale index lock) can't be
  # misread as a deletion and silently `git rm`-ed — it falls through to the
  # unmerged-path halt below instead.
  #
  # The `git add` below restages a path already committed to $CURRENT_BRANCH's
  # own history onto the disposable $PR_BRANCH; not a commit_docs bypass
  # (#1783/#3585), which guards against staging .planning/ content that was
  # never committed at all.
  #
  # The unmerged list is snapshotted, then read one path PER LINE. `for P in
  # $(git diff --name-only --diff-filter=U)` would split it on IFS instead: a
  # third-bucket path containing a space (`.planning/My Notes.md`) becomes the
  # fragments `.planning/My` and `Notes.md`, neither of which names the real
  # conflicted file, so nothing is resolved and the run aborts with exactly the
  # #4606 failure this block exists to prevent. Same word-split class as #4109.
  # Snapshot-then-iterate (rather than piping) both keeps the list stable while
  # the body restages paths and keeps the body in THIS shell, not a subshell.
  UNMERGED_PATHS=$(git diff --name-only --diff-filter=U)
  while IFS= read -r P; do
    [ -n "$P" ] || continue
    case "$P" in
      .planning/*) ;;
      *) continue ;;
    esac
    if echo "$P" | grep -Eq "$FORBIDDEN_RE"; then continue; fi
    if echo "$P" | grep -Eq "$STRUCTURAL_RE"; then continue; fi
    if git cat-file -e "$HASH:$P" 2>/dev/null; then
      git checkout --theirs -- "$P" && git add -- "$P" # gsd-scan-ignore: #4606 -- see block comment above
    else
      git rm -f -q -- "$P" 2>/dev/null || true
    fi
  done <<UNMERGED_PATHS_EOF
$UNMERGED_PATHS
UNMERGED_PATHS_EOF

  # Anything still unmerged is a REAL conflict, outside the filter. Halt — do not
  # improvise a resolution and do not continue, which would drop the rest of the queue.
  # Unwind first: this loop runs in the user's own checkout, so exiting mid-sequence
  # would strand them on a half-built branch with cherry-pick state still live.
  if [ -n "$(git diff --name-only --diff-filter=U)" ]; then
    echo "Conflict outside the .planning/ filter while picking $HASH:" >&2
    git diff --name-only --diff-filter=U >&2
    # Order matters. `--quit` drops the sequencer state but leaves the unmerged index
    # in place, and an unmerged index makes `git checkout` refuse — so reset first.
    # $PR_BRANCH is disposable and every commit on it was cherry-picked, and the
    # clean-tree precondition guarantees the user had nothing uncommitted, so a hard
    # reset here cannot destroy anything of theirs.
    git cherry-pick --quit 2>/dev/null || true
    git reset -q --hard HEAD
    if git checkout -q "$CURRENT_BRANCH"; then
      git branch -q -D "$PR_BRANCH" 2>/dev/null || true
      echo "Restored $CURRENT_BRANCH and removed the partial $PR_BRANCH." >&2
    else
      # Never claim a restore that did not happen — say exactly where they are.
      echo "Could not return to $CURRENT_BRANCH; you are still on $PR_BRANCH." >&2
      echo "Run: git checkout $(shq "$CURRENT_BRANCH") && git branch -D $(shq "$PR_BRANCH")" >&2
    fi
    echo "Resolve the conflict against $TARGET, then re-run /gsd:pr-branch. If it came from replaying commits already published, re-anchor instead: see the WARNING above." >&2
    exit 1
  fi

  # Nothing left after filtering (possible when a pick's only surviving content was
  # planning state): clear the sequencer rather than failing on an empty commit.
  if git diff --cached --quiet; then
    git cherry-pick --quit 2>/dev/null || true
    continue
  fi

  git commit -q -C "$HASH"
done
```

Return to original branch:
```bash
git checkout "$CURRENT_BRANCH"
```
</step>

<step name="verify">
Assert against the **active mode's** contract — `$FORBIDDEN_RE`, the same declaration
`create_pr_branch` filtered on. Counting every `.planning/` path unconditionally would
contradict default mode, which is specified to preserve structural files: a correct run
would report itself as failed on every phase that touched STATE.md, which is every phase.

```bash
# Fail closed: empty lists pass both gates.
{ DIFF_PATHS=$(set -o pipefail; TO=60 _to git diff -z --name-only "$TARGET_SHA"..refs/heads/"$PR_BRANCH" | tr '\0' '\n') &&
  DELETED=$(set -o pipefail; TO=60 _to git diff -z --name-only --no-renames --diff-filter=D "$TARGET_SHA"..refs/heads/"$PR_BRANCH" | tr '\0' '\n'); } ||
  { git branch -qD "$PR_BRANCH" && D=deleted || D="not deleted; run git branch -D $(shq "$PR_BRANCH") first"; echo "Cannot read $PR_BRANCH ($D); re-run." >&2; exit 1; }
FORBIDDEN=$(grep -Ec "$FORBIDDEN_RE" <<<"$DIFF_PATHS" || true)
PLANNING_TOTAL=$(grep -c "^\.planning/" <<<"$DIFF_PATHS" || true)
ALLOWED=$((PLANNING_TOTAL - FORBIDDEN))
TOTAL_FILES=$(grep -c . <<<"$DIFF_PATHS" || true)
PR_COMMITS=$(TO=60 _to git rev-list --count "$TARGET_SHA"..refs/heads/"$PR_BRANCH")

# #3679: a DELETED planning path is never legitimate — this workflow only ever
# excludes content a cherry-picked commit ADDED; pre-existing target-tracked
# planning files must survive byte-identical. The plain $DIFF_PATHS list cannot see
# status, so gate on the --diff-filter=D read, across every planning category.
PLANNING_DELETIONS=$(grep -c "^\.planning/" <<<"$DELETED" || true)

# Default mode preserves anything under .planning/ that is neither transient nor
# structural — config.json, intel/, workstreams/. That is deliberate and unchanged, but it
# must not be silent: report it so the user can choose strict mode knowingly.
OTHER=$(grep "^\.planning/" <<<"$DIFF_PATHS" | grep -Ev "$FORBIDDEN_RE" | grep -Ev "$STRUCTURAL_RE" || true)
```

`$FORBIDDEN` is the pass/fail number — it must be `0`. A non-zero value means the filter
did not do what this mode promised; report it and do not tell the user to push.

`$PLANNING_DELETIONS` is a second hard gate (#3679) — it must also be `0`. A non-zero
value means the PR branch would DELETE planning files the target branch tracks
(`grep "^\.planning/" <<<"$DELETED"` lists
them). That is data loss, not filtering — report it, do not tell the user to push, and
rebuild the branch.

When both gates pass, record the built tip as pending (`$TIP`, never HEAD) and the `$PR_BRANCH` tip
beside it; the next run promotes pending to published once that tip is merged. A failed write warns; it never aborts:

```bash
if [ "$FORBIDDEN" = 0 ] && [ "$PLANNING_DELETIONS" = 0 ] && [ -z "${KEEP:-}" ]; then
  git update-ref "$PR_TIP_REF" "$(TO=60 _to git rev-parse "refs/heads/$PR_BRANCH")" && git update-ref "$PENDING_REF" "$TIP" || echo "WARNING: could not record $PR_TIP_REF or $PENDING_REF; next run will replay commits." >&2
fi
```

Display results:
```
✅ PR branch created: {PR_BRANCH}

Original: {AHEAD} commits, {ORIGINAL_FILES} files
PR branch: {PR_COMMITS} commits, {TOTAL_FILES} files
Mode: {PR_MODE}
Planning paths in diff: {PLANNING_TOTAL} (allowed {ALLOWED}, forbidden {FORBIDDEN} — must be 0)
Planning deletions: {PLANNING_DELETIONS} (must be 0 — #3679)

Next steps (names shell-quoted):
  git push origin {PR_BRANCH}
  gh pr create --base {TARGET} --head {PR_BRANCH}

Or use /gsd:ship to create the PR automatically.
```

When `$OTHER` is non-empty (default mode only — strict forbids all of it), append:
```
ℹ️  These .planning/ paths are neither transient nor structural, so default mode keeps them:
{OTHER}
    Set `planning.pr_strict: true` to keep every .planning/ path out of the PR branch.
```
</step>

</process>

<success_criteria>
- [ ] Working tree was clean before the PR branch was created
- [ ] PR branch created from target
- [ ] Planning-only commits excluded
- [ ] Zero paths matching the active mode's `$FORBIDDEN_RE` in the PR branch diff —
      strict: no `.planning/` path at all; default: none from `$TRANSIENT_DIRS`
- [ ] No `.planning/` path the target branch already tracked was deleted
- [ ] Every included commit landed — none dropped by a failed cherry-pick
- [ ] Commit messages preserved from original
- [ ] User shown next steps
</success_criteria>
