<purpose>
Safe git revert workflow. Rolls back GSD phase or plan commits selected within the phase directory's own commit window with dependency checks and a confirmation gate. Uses git revert --no-commit (NEVER git reset) to preserve history.
</purpose>

<required_reading>
@~/.claude/gsd-core/references/ui-brand.md
@~/.claude/gsd-core/references/gate-prompts.md
</required_reading>

<process>
```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif _gsd_at "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" "${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}" "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd_run is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; case "$(gsd_run runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') GSD_IDENTITY_STATUS=ok;; esac; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
RESPONSE_LANGUAGE=$(gsd_run query config-get response_language --raw --default "" 2>/dev/null || echo "")
```

**If `response_language` is set:** All user-facing output of this workflow — narration between tool calls, status updates, progress notes, findings, questions, prompts, and explanations — MUST be presented in `{response_language}`. Technical terms, code, file paths, and subagent prompts stay in English — only user-facing output is translated.

<step name="banner" priority="first">
Display the stage banner:

```
### GSD ► UNDO
```
</step>

<step name="parse_arguments">
Parse $ARGUMENTS for the undo mode:

- `--last N` → MODE=last, COUNT=N (integer, default 10 if N missing)
- `--phase NN` → MODE=phase, TARGET_PHASE=NN (two-digit phase number)
- `--plan NN-MM` → MODE=plan, TARGET_PLAN=NN-MM (phase-plan ID)

If no valid argument is provided, display usage and exit:

```
Usage: /gsd:undo --last N | --phase NN | --plan NN-MM

Modes:
  --last N      Show last N GSD commits for interactive selection
  --phase NN    Revert all commits for phase NN
  --plan NN-MM  Revert all commits for plan NN-MM

Examples:
  /gsd:undo --last 5
  /gsd:undo --phase 03
  /gsd:undo --plan 03-02
```
</step>

<step name="gather_commits">
Based on MODE, gather candidate commits.

**MODE=last:**

Run:
```bash
git log --oneline --no-merges -${COUNT}
```

Filter for GSD conventional commits matching `type(scope): message` pattern (e.g., `feat(04-01):`, `docs(03):`, `fix(02-03):`).

Display a numbered list of matching commits:
```
Recent GSD commits:
  1. abc1234 feat(04-01): implement auth endpoint
  2. def5678 docs(03-02): complete plan summary
  3. ghi9012 fix(02-03): correct validation logic
```

**Text mode (`workflow.text_mode: true` in config or `--text` flag):** Set `TEXT_MODE=true` if `--text` is present in `$ARGUMENTS` OR `text_mode` from init JSON is `true`. When TEXT_MODE is active, replace every `AskUserQuestion` call with a plain-text numbered list and ask the user to type their choice number. This is required for non-Claude runtimes (OpenAI Codex, Antigravity, etc.) where `AskUserQuestion` is not available.
Use AskUserQuestion to ask:
- question: "Which commits to revert? Enter numbers (e.g., 1,3) or 'all'"
- header: "Select"

Parse the user's selection into COMMITS list.

---

**MODE=phase:**

Resolve the phase's own directory, then anchor the selection window on it. `find-phase`
resolves through `planningDir`, so under an active workstream this is that workstream's
phase directory — not the root's same-numbered one.

```bash
PHASE_DIR=$(gsd_run query find-phase "${TARGET_PHASE}" --raw 2>/dev/null)
# find-phase answers relative to the PROJECT ROOT -- gsd-tools resolves it before dispatch --
# not to this shell's cwd, so from a subdirectory a bare `git log -- "${PHASE_DIR}"` looks in
# the wrong place and every path-scoped git call below comes back empty. Take the root from the
# same owner and run those calls there. Unresolved, `.` keeps the behaviour at the root. A root
# in a DIFFERENT repository from this shell's is refused below, never used.
PROJECT_ROOT=$(gsd_run query planning inspect --pick generated_from.cwd --raw 2>/dev/null)
```

If `PHASE_DIR` is empty, the phase does not exist in the active scope:
```
Phase ${TARGET_PHASE} not found in the active planning scope. Nothing to revert.
```
Exit cleanly — do NOT fall back to an unbounded search.

**Refuse an ARCHIVED resolution — it selects the wrong milestone, not merely too few
commits.** `find-phase` searches the live `phases/` directory first, then every
`milestones/v<X.Y>-phases/` directory in ascending version order, and its ambiguity check
is scoped to a *single* directory — it does not span them (`cmdFindPhase`, `src/phase.cts`:
the `matches.length > 1` test sits inside the per-`searchDir` loop). A phase number that is
not live therefore resolves **silently to the oldest archived milestone that has one**,
with no warning. Anchoring there is wrong in both directions at once: the oldest commit
adding that path is the archival **move**, so the phase's real work predates the window and
falls outside it, while the window runs forward from that archival through every later
milestone — where the subject grep matches *their* same-numbered phase. Driven on a
two-archived-milestone fixture, `--phase 03` selected v2.0's `feat(03-01): add search index`
and excluded v1.0's own `feat(03-01): implement auth endpoint`. Feeding that to
`git revert` is the cross-milestone contamination this workflow exists to close, so it
fails closed.

**Two archive layouts exist, and `find-phase` searches only one of them.** The phase locator
(`listArchiveVersionDirs`, `src/phase-locator.cts`) enumerates both the flat
`milestones/v<X.Y>-phases/<phase>/` archive and the workstream archive
`milestones/ws-<name>-<date>/phases/<phase>/` that `workstream complete` writes. `cmdFindPhase`
builds its own search list and admits only the first (`/^v\d+.*-phases$/`), so a phase that lives
*only* in a `ws-*` archive resolves to nothing today and the not-found rule above fails closed.
The refusal below still names both layouts, so it keeps holding if `find-phase` is ever taught the
second one:

```bash
# Match the ARCHIVE LAYOUTS, never the bare token `milestones`. A bare `*/milestones/*`
# REFUSES A LIVE PHASE whenever a workstream or project is itself named `milestones`
# (driven: GSD_WORKSTREAM=milestones resolves `.planning/workstreams/milestones/phases/03-live`,
# which that pattern classifies as archived). The two shapes are the locator's two:
# `v<X.Y>-phases/<phase>` and `ws-<name>-<date>/phases/<phase>`. Blanking PHASE_DIR is
# deliberate: the fail-closed rule below then also holds, so no path reaches selection even if
# this refusal's prose is not honored.
PHASE_DIR_ARCHIVED=""
case "${PHASE_DIR}" in
  */milestones/v[0-9]*-phases/*|milestones/v[0-9]*-phases/*|*/milestones/ws-*/phases/*|milestones/ws-*/phases/*)
    PHASE_DIR_ARCHIVED="${PHASE_DIR}"; PHASE_DIR="" ;;
esac
# The phase directory must live in the SAME repository as the commits this workflow reverts. In a
# `sub_repos` project, .planning/ sits in a parent repository and the code in child ones; from a
# child, PROJECT_ROOT is the parent, and an anchor read there is a commit the child has never seen.
# Compare the COMMON git directories -- the object database -- physically resolved; a different one
# refuses. Common, not per-worktree: gsd-tools maps a linked worktree's planning to the MAIN
# worktree, which is the same repository and holds every commit the linked one does.
PHASE_DIR_FOREIGN=""
if [ -n "${PHASE_DIR}" ] && [ -n "${PROJECT_ROOT}" ]; then
  _gd_here=$(_d=$(git rev-parse --git-common-dir 2>/dev/null) && [ -n "$_d" ] && cd "$_d" && pwd -P) || _gd_here=""
  _gd_root=$(cd "${PROJECT_ROOT}" 2>/dev/null && _d=$(git rev-parse --git-common-dir 2>/dev/null) && [ -n "$_d" ] && cd "$_d" && pwd -P) || _gd_root=""
  if [ -z "$_gd_here" ] || [ "$_gd_here" != "$_gd_root" ]; then
    PHASE_DIR_FOREIGN="${PROJECT_ROOT}"; PHASE_DIR=""
  fi
fi
# A LIVE path can still be a previous occupant's. `--diff-filter=A` does not follow renames,
# so re-creating a literal directory that an earlier milestone or workstream used anchors on
# the EARLIER occupant's add. Nothing is under milestones/ to refuse -- find-phase returned the
# live dir -- so ask the question the anchor depends on instead: did this exact path go EMPTY
# somewhere in HEAD's history and come back? Git history owns that answer for every way a path
# can be vacated -- a flat milestone archive, `workstream complete` moving the workstream into
# milestones/ws-<name>-<date>/, a removed phase re-added under the same slug -- where a layout
# glob answers only for the layouts it spells. `--no-renames` so a move-out reads as the deletion
# it is at this path; `-m` so a merge that emptied it is seen too; `ls-tree` at that commit is
# what separates "the directory went away" from an ordinary deleted plan file.
PHASE_DIR_REUSED=""; PHASE_DIR_LIVE=""
if [ -n "${PHASE_DIR}" ]; then
  for _c in $(git -C "${PROJECT_ROOT:-.}" log -m --no-renames --diff-filter=D --format=%H -- "${PHASE_DIR}" 2>/dev/null); do
    if [ -z "$(git -C "${PROJECT_ROOT:-.}" ls-tree -d "$_c" -- "${PHASE_DIR}" 2>/dev/null)" ]; then
      PHASE_DIR_LIVE="${PHASE_DIR}"; PHASE_DIR_REUSED="$_c"; PHASE_DIR=""; break
    fi
  done
fi
```

If `PHASE_DIR_ARCHIVED` is non-empty, stop — this message, not the not-found one:
```
Phase ${TARGET_PHASE} resolves to an ARCHIVED milestone directory (${PHASE_DIR_ARCHIVED}).
Refusing: the anchor there is the archival commit, so the window would span later
milestones and select their same-numbered phase instead of this one.
Use /gsd:undo --last N and select commits explicitly.
```
If `PHASE_DIR_FOREIGN` is non-empty, stop with its own message:
```
Phase ${TARGET_PHASE} is planned in the repository at ${PHASE_DIR_FOREIGN}, not the one this
command is running in. Refusing: that repository's history cannot bound commits in this one.
Use /gsd:undo --last N here and select commits explicitly.
```
And if `PHASE_DIR_REUSED` is non-empty, stop with its own message:
```
Phase ${TARGET_PHASE} resolves to ${PHASE_DIR_LIVE}, but that path was emptied by commit
${PHASE_DIR_REUSED} and re-created later. Refusing: the first commit adding this path belongs
to the earlier occupant, so the window would open there and select its commits too.
Use /gsd:undo --last N and select commits explicitly.
```
Exit cleanly in every case.

Derive the selection window from `PHASE_DIR` (the `#3995` anchor, shared with
`code-review.md`): the base is the parent of the first commit that added anything under
the phase's own directory, and the tip is `HEAD`.

```bash
PHASE_START=$(git -C "${PROJECT_ROOT:-.}" log --format="%H" --diff-filter=A -- "${PHASE_DIR}" 2>/dev/null | tail -1)
# Only a commit in HEAD's own history may anchor. A SHA from another repository has no resolvable
# parent here, which the root-commit arm below would read as "root commit" and select all of HEAD;
# one from another worktree's branch that HEAD does not contain bounds nothing on this branch.
if [ -n "$PHASE_START" ] && ! git merge-base --is-ancestor "$PHASE_START" HEAD 2>/dev/null; then PHASE_START=""; fi
UNDO_RANGE=""
if [ -n "$PHASE_START" ]; then
  if git rev-parse "${PHASE_START}^" >/dev/null 2>&1; then
    UNDO_RANGE="${PHASE_START}^..HEAD"
  else
    # PHASE_START is the root commit — it has no parent to exclude. `${PHASE_START}..HEAD`
    # would drop PHASE_START ITSELF, refusing a legitimate revert of the first commit.
    UNDO_RANGE="HEAD"
  fi
fi
```

**Fail closed when no anchor resolves.** If `UNDO_RANGE` is empty, stop:
```
Cannot determine a reliable commit window for phase ${TARGET_PHASE} (no commit adds ${PHASE_DIR}).
Re-run with /gsd:undo --last N and select commits explicitly.
```
Exit cleanly. An unbounded repository-wide search is never the fallback — that is the
defect this anchor replaces.

Select within the window. **No `--all`:** only commits reachable from `HEAD` may be
reverted, because reverting a commit that is not in the current branch's history stages a
change the branch never received.

```bash
# `|| true`: grep exits 1 on no match. The former `| head -50` masked that rc; the empty
# case is handled by the Empty check step below, so the pipeline must not abort here.
git log --oneline --no-merges "${UNDO_RANGE}" | grep -E "\(0*${TARGET_PHASE}(-[0-9]+)?\):" || true
```

Use matching commits as COMMITS.

**Report truncation, never truncate silently.** If the selection exceeds 50 commits, show
the count and stop rather than capping — a partial phase revert leaves a worse tree state
than either reverting the phase or not:
```
Phase ${TARGET_PHASE} selects ${N} commits (>50). Refusing to revert a partial phase.
Use /gsd:undo --plan NN-MM per plan, or /gsd:undo --last N.
```

---

**MODE=plan:**

Extract the phase number from `TARGET_PLAN` (the `NN` of `NN-MM`) and derive the same
window from that phase's own directory — a plan number is unique within its phase, and a
phase number only within its milestone and workstream.

```bash
PLAN_PHASE="${TARGET_PLAN%%-*}"
PHASE_DIR=$(gsd_run query find-phase "${PLAN_PHASE}" --raw 2>/dev/null)
# Project-root-relative, exactly as in MODE=phase: path-scoped git calls run from the root.
PROJECT_ROOT=$(gsd_run query planning inspect --pick generated_from.cwd --raw 2>/dev/null)
# Same archived-resolution refusal as MODE=phase, and for the same reason — an archived
# anchor selects a LATER milestone's same-numbered phase. Blanking PHASE_DIR keeps the
# fail-closed rule below load-bearing.
PHASE_DIR_ARCHIVED=""
case "${PHASE_DIR}" in
  */milestones/v[0-9]*-phases/*|milestones/v[0-9]*-phases/*|*/milestones/ws-*/phases/*|milestones/ws-*/phases/*)
    PHASE_DIR_ARCHIVED="${PHASE_DIR}"; PHASE_DIR="" ;;
esac
# Same-repository refusal as MODE=phase: a phase planned in another repository cannot anchor here.
PHASE_DIR_FOREIGN=""
if [ -n "${PHASE_DIR}" ] && [ -n "${PROJECT_ROOT}" ]; then
  _gd_here=$(_d=$(git rev-parse --git-common-dir 2>/dev/null) && [ -n "$_d" ] && cd "$_d" && pwd -P) || _gd_here=""
  _gd_root=$(cd "${PROJECT_ROOT}" 2>/dev/null && _d=$(git rev-parse --git-common-dir 2>/dev/null) && [ -n "$_d" ] && cd "$_d" && pwd -P) || _gd_root=""
  if [ -z "$_gd_here" ] || [ "$_gd_here" != "$_gd_root" ]; then
    PHASE_DIR_FOREIGN="${PROJECT_ROOT}"; PHASE_DIR=""
  fi
fi
# A LIVE path can still be a previous occupant's -- same question, same answer as MODE=phase:
# a path that went EMPTY in HEAD's history and came back anchors on the earlier occupant's add,
# whatever vacated it. Ask git, not a layout glob. Fail closed; `--last N` is the route.
PHASE_DIR_REUSED=""; PHASE_DIR_LIVE=""
if [ -n "${PHASE_DIR}" ]; then
  for _c in $(git -C "${PROJECT_ROOT:-.}" log -m --no-renames --diff-filter=D --format=%H -- "${PHASE_DIR}" 2>/dev/null); do
    if [ -z "$(git -C "${PROJECT_ROOT:-.}" ls-tree -d "$_c" -- "${PHASE_DIR}" 2>/dev/null)" ]; then
      PHASE_DIR_LIVE="${PHASE_DIR}"; PHASE_DIR_REUSED="$_c"; PHASE_DIR=""; break
    fi
  done
fi
PHASE_START=$(git -C "${PROJECT_ROOT:-.}" log --format="%H" --diff-filter=A -- "${PHASE_DIR}" 2>/dev/null | tail -1)
# As in MODE=phase: an anchor outside HEAD's own history never reaches the root-commit arm.
if [ -n "$PHASE_START" ] && ! git merge-base --is-ancestor "$PHASE_START" HEAD 2>/dev/null; then PHASE_START=""; fi
UNDO_RANGE=""
if [ -n "$PHASE_START" ]; then
  if git rev-parse "${PHASE_START}^" >/dev/null 2>&1; then
    UNDO_RANGE="${PHASE_START}^..HEAD"
  else
    # PHASE_START is the root commit — it has no parent to exclude. `${PHASE_START}..HEAD`
    # would drop PHASE_START ITSELF, refusing a legitimate revert of the first commit.
    UNDO_RANGE="HEAD"
  fi
fi
```

Apply the same fail-closed rule as MODE=phase when `PHASE_DIR` or `UNDO_RANGE` is empty —
and the same three refusals, each with its own message, when `PHASE_DIR_ARCHIVED`,
`PHASE_DIR_FOREIGN` or `PHASE_DIR_REUSED` is non-empty — then select within the window:

```bash
# `|| true` for the same reason as MODE=phase: an empty selection is not an error here.
git log --oneline --no-merges "${UNDO_RANGE}" | grep -E "\(${TARGET_PLAN}\):" || true
```

Use matching commits as COMMITS.

**Report truncation, never truncate silently** — the same rule as MODE=phase. If the
selection exceeds 50 commits, show the count and stop rather than capping:
```
Plan ${TARGET_PLAN} selects ${N} commits (>50). Refusing to revert a partial plan.
Use /gsd:undo --last N and select commits explicitly.
```

---

**Known residual — a revision range is ancestry, not chronology.** `PHASE_START^..HEAD`
excludes everything reachable from `PHASE_START^`, which is the right bound for the
ordinary linear case. It is not a *chronological* lower bound: a long-lived side branch
created before the phase, carrying matching scopes, and merged in **after** `PHASE_START`
is reachable from `HEAD` without being an ancestor of `PHASE_START^`, so it stays
selectable. This is strictly narrower than the unbounded search it replaces, not a new
exposure — but it is not zero.

**Known residual — a RENAMED phase directory under-selects.** The anchor is
`--diff-filter=A` on the phase directory's *current* path and does not follow renames, so
for a phase whose directory has since moved the oldest add at that path is the **move**
commit, and the phase's real work commits — which predate it — fall outside the window.
For a rename *within* the live `phases/` tree the failure is under-selection: the undo
reverts too little or refuses, never too much.

The **archival** case is not that case, and is no longer a residual — it is refused above.
It was previously documented here as under-selection only, which was wrong in the direction
that matters: the window runs forward from the archival commit, so while the target's own
work falls outside it, a *later* milestone's same-numbered phase falls inside and matches
the subject grep. Driven on a two-archived-milestone fixture it selected the wrong
milestone's commit and none of the right one's. Both modes now refuse an archived
`PHASE_DIR` outright; `/gsd:undo --last N` is the route for a phase that has been archived.

**Known residual — a phase directory introduced by a merge commit resolves no anchor.**
`git log --diff-filter=A -- "${PHASE_DIR}"` does not walk merge diffs by default. A phase
directory added on a side branch is still found, because the side-branch commit that added
it is itself in history; the uncovered case is a directory that first appears *in the merge
resolution itself*, which a **default** `git log` does not show: it suppresses merge diffs
unless asked (`-m` prints the add once per parent, so the information exists — the anchor
command simply does not request it). `PHASE_START` then resolves
empty and both modes fail closed on a legitimate phase. Safe-direction only — it refuses
rather than mis-selects — and untested: constructing the evil-merge fixture costs more than
the branch is worth while the failure mode is a refusal. `/gsd:undo --last N` is the route
if it is ever hit.

**A re-created directory — same number AND same slug — is REFUSED, not a residual.** The
anchor is the *current path*, and `--diff-filter=A` does not follow renames, so re-creating
a literal directory an earlier occupant used (`03-auth` again, not merely phase `03` again)
makes the oldest add at that path the **previous occupant's**. The archived refusal above
cannot reach it — `find-phase` returns the **live** directory, so nothing is under
`milestones/` to refuse. Driven before the guard: two milestones both using
`.planning/phases/03-auth` anchored on the v1 plan commit and selected all four v1+v2 phase-03
commits; a workstream completed into `milestones/ws-feat-<date>/` and then re-created as `feat`
with the same `03-auth` did the same across the two workstream generations. The collision check
closes both without a phase identity a directory name does not carry, and without restating any
archive layout: a path that went empty in `HEAD`'s history and came back has had a previous
occupant, so the anchor is untrustworthy and both modes refuse. `code-review.md` carries the
same weakness on the same anchor, where it is read-only and merely widens a review scope; here
it reverts, which is why this one is a refusal rather than a note.

**Known residual — the collision check reads history, so it sees only what history shows.**
Two edges, in opposite directions. It **misses** a single commit that both moves the directory
away *and* re-creates it at the same path: the path is never empty in any commit's tree, so the
history carries no vacancy to find, and the anchor opens on the earlier occupant. That takes a
hand-assembled commit — it is not the shape of an archive followed by later planning — and the
over-selection it allows still has to pass `confirm_revert`. It **over-refuses** when a side
branch emptied the directory and the merge kept it: the vacancy is real in that branch's
history, so the path reads as reused. Refusing too often costs a `--last N`; refusing too
rarely reverts another occupant's work, which is why the check is keyed on the vacancy itself
rather than on any narrower proof of ownership.

**Known residual — concurrent workstreams.** The window above is scoped to the target
phase's own directory, which is workstream-correct, but the commit subjects it filters
are not: the executor's scope contract is `type({phase}-{plan})` with no workstream
token, so two workstreams running the same phase number concurrently emit
indistinguishable subjects and both fall inside each other's window. Narrowing the window plus the two
refusals above removes the unreachable-branch class entirely and every previous-milestone
route this workflow can detect — residual 2 is the one it cannot, since a merged side branch
is genuinely reachable from `HEAD`. This last class
needs a discriminator that does not exist in a commit subject today (`#3995`: *"Message
subjects demonstrably do not carry enough information to identify a phase"*). Until one
exists, `confirm_revert` is the backstop for it.

---

**Empty check:**

If COMMITS is empty after gathering:
```
No commits found for ${MODE} ${TARGET}. Nothing to revert.
```
Exit cleanly.
</step>

<step name="dependency_check">
**Applies when MODE=phase or MODE=plan.**

Skip this step entirely for MODE=last.

Resolve the active scope's planning root first — **both** modes below read from it. Under
an active workstream the roadmap and phase directories describing the target are that
workstream's, not the root's:

```bash
PLANNING_DIR=$(gsd_run query planning inspect --pick generated_from.planning_root --raw 2>/dev/null)
[ -n "$PLANNING_DIR" ] || PLANNING_DIR=".planning"
```

---

**MODE=phase:**

Read `${PLANNING_DIR}/ROADMAP.md` inline.

Search for phases that list a dependency on the target phase. Look for patterns like:
- "Depends on: Phase ${TARGET_PHASE}"
- "Depends on: ${TARGET_PHASE}"
- "depends_on: [${TARGET_PHASE}]"

For each dependent phase N found:
1. Check if `${PLANNING_DIR}/phases/${N}-*/` directory exists
2. If directory exists, check for any PLAN.md or SUMMARY.md files inside it

If any downstream phase has started work, collect warnings:
```
⚠  Downstream dependency detected:
   Phase ${N} depends on Phase ${TARGET_PHASE} and has started work.
```

---

**MODE=plan:**

Extract the phase number from TARGET_PLAN (the NN part of NN-MM). Extract the plan number (the MM part).

Look for later plans in the same phase directory (`${PLANNING_DIR}/phases/${NN}-*/`, the
same workstream-resolved root). For each later plan (plans with number > MM):
1. Read the later plan's PLAN.md
2. Check if its `<files>` sections or `consumes` fields reference outputs from the target plan

If any later plan references the target plan's outputs, collect warnings:
```
⚠  Intra-phase dependency detected:
   Plan ${LATER_PLAN} in phase ${NN} references outputs from plan ${TARGET_PLAN}.
```

---

If any warnings exist (from either mode):
- Display all warnings
- Use AskUserQuestion with approve-revise-abort pattern:
  - question: "Downstream work depends on the target being reverted. Proceed anyway?"
  - header: "Confirm"
  - options: Proceed | Abort

If user selects "Abort": exit with "Revert cancelled. No changes made."
</step>

<step name="confirm_revert">
Display the confirmation gate using approve-revise-abort pattern from gate-prompts.md.

Show:
```
The following commits will be reverted (in reverse chronological order):

  {hash} — {message}
  {hash} — {message}
  ...

Total: {N} commit(s) to revert
```

Use AskUserQuestion:
- question: "Proceed with revert?"
- header: "Approve?"
- options: Approve | Abort

If "Abort": display "Revert cancelled. No changes made." and exit.
If "Approve": ask for a reason:

```
AskUserQuestion(
  header: "Reason",
  question: "Brief reason for the revert (used in commit message):",
  options: []
)
```

Store the response as REVERT_REASON. Continue to execute_revert.
</step>

<step name="execute_revert">
**HARD CONSTRAINT: Use git revert --no-commit. NEVER use git reset (except for conflict cleanup as documented below).**

**Dirty-tree guard (run first, before any revert):**

Run `git status --porcelain`. If the output is non-empty, display the dirty files and abort:
```
Working tree has uncommitted changes. Commit or stash them before running /gsd:undo.
```
Exit immediately — do not proceed to any revert operations.

---

Sort COMMITS in reverse chronological order (newest first). If commits came from git log (already newest-first), they are already in correct order.

For each commit hash in COMMITS:
```bash
git revert --no-commit ${HASH}
```

If any revert fails (merge conflict or error):
1. Display the error message
2. Run cleanup — handle both first-call and mid-sequence cases:
   ```bash
   # Try git revert --abort first (works if this is the first failed revert)
   git revert --abort 2>/dev/null
   # If prior --no-commit reverts already staged cleanly before this failure,
   # revert --abort may be a no-op. Clean up staged and working tree changes:
   git reset HEAD 2>/dev/null
   git restore . 2>/dev/null
   ```
3. Display:
   ```
### ERROR

   Revert failed on commit ${HASH}.
   Likely cause: merge conflict with subsequent changes.

   **To fix:** Resolve the conflict manually or revert commits individually.
   All pending reverts have been aborted — working tree is clean.
   ```
4. Exit with error.

After all reverts are staged successfully, create a single commit:

For MODE=phase:
```bash
git commit -m "revert(${TARGET_PHASE}): undo phase ${TARGET_PHASE} — ${REVERT_REASON}"
```

For MODE=plan:
```bash
git commit -m "revert(${TARGET_PLAN}): undo plan ${TARGET_PLAN} — ${REVERT_REASON}"
```

For MODE=last:
```bash
git commit -m "revert: undo ${N} selected commits — ${REVERT_REASON}"
```
</step>

<step name="summary">
Display the completion banner:

```
### GSD ► UNDO COMPLETE ✓
```

Show summary:
```
  ✓ ${N} commit(s) reverted
  ✓ Single revert commit created: ${REVERT_HASH}
```

Show next steps:
```
---

## ▶ Next Up — [${PROJECT_CODE}] ${PROJECT_TITLE}

**Review state** — verify project is in expected state after revert

/clear then:

/gsd:progress

---

**Also available:**
- `/gsd:execute-phase ${PHASE}` — re-execute if needed
- `/gsd:undo --last 1` — undo the revert itself if something went wrong

---
```
</step>

</process>

<success_criteria>
- [ ] Arguments parsed correctly for all three modes
- [ ] --phase mode anchors selection on the phase's own directory (find-phase -> PHASE_START), never a repository-wide commit-subject grep
- [ ] --phase and --plan modes fail closed when no anchor resolves, never widening to an unbounded search
- [ ] Dependency check warns when downstream phases have started (MODE=phase)
- [ ] Dependency check warns when later plans reference target plan outputs (MODE=plan)
- [ ] Dirty-tree guard aborts if working tree has uncommitted changes
- [ ] Confirmation gate shown before any revert execution
- [ ] Reverts use git revert --no-commit in reverse chronological order
- [ ] Single commit created after all reverts staged
- [ ] Error handling cleans up both first-call and mid-sequence conflict cases
- [ ] git reset --hard is NEVER used anywhere in this workflow
</success_criteria>
