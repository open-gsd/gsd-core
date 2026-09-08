# complete-milestone.md — deferred elaboration

Read in full when `workflow.compact_content` is `false` (the default) — see
`gsd-core/references/compact-content-gate.md` for the check and resolution rule this
spine defers to. Each `§` below is the full text the spine condenses at the point it
names.

## § 1 — pre_close_artifact_audit: the [A] Acknowledge branch

If user chooses [A] (Acknowledge):
1. Re-run `gsd_run query audit-open --json` to get structured data.
2. Acknowledge every open item through the `audit-open acknowledge` CLI writer — this is what actually suppresses each item starting at the NEXT `audit-open` scan; the STATE.md table in step 3 is a disclosure record only, it is no longer the suppression mechanism. Every acknowledge call's exit status is accumulated (`ACK_FAILURES`); the step HALTS before closing if any failed — a refusal (`unsupported_heading_shape`, `ambiguous`, `not_found`, missing file, etc.) must never be silently discarded and let the close proceed as if everything were suppressed. `AUDIT_JSON` uses the same `@file:` large-payload sentinel handling `INIT_MANAGER` uses in `verify_readiness` below — `io.output` swaps any JSON payload over 50000 chars for a `@file:<path>` marker, and feeding that literal string to `jq` would silently make every loop body below iterate zero times:
   ```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif _gsd_at "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" "${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}" "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd_run is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; case "$(gsd_run runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') GSD_IDENTITY_STATUS=ok;; esac; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
   AUDIT_JSON=$(gsd_run query audit-open --json)
   if [[ "$AUDIT_JSON" == @file:* ]]; then AUDIT_JSON=$(cat "${AUDIT_JSON#@file:}"); fi
   MILESTONE_VERSION="v[X.Y]"   # already known from ROADMAP.md's active milestone header — the same identifier `milestone.complete` uses in the archive_milestone step

   ACK_FAILURES=0
   ACK_FAILURE_LOG=""
   record_ack_failure() {
     ACK_FAILURES=$((ACK_FAILURES + 1))
     ACK_FAILURE_LOG="${ACK_FAILURE_LOG}
   - $1"
   }

   # debug_sessions / threads (--slug)
   # NOTE: `< <(...)` process substitution, not `... | while`, so the loop
   # runs in THIS shell — a `| while` pipeline puts the loop in a subshell
   # and any ACK_FAILURES/ACK_FAILURE_LOG update inside it is lost the
   # moment the pipeline exits.
   for cat in debug_sessions threads; do
     while IFS= read -r slug; do
       [ -z "$slug" ] && continue
       if ! gsd_run query audit-open acknowledge --category "$cat" --milestone "$MILESTONE_VERSION" --slug "$slug"; then
         record_ack_failure "$cat slug=$slug"
       fi
     done < <(printf '%s' "$AUDIT_JSON" | jq -r --arg cat "$cat" '.items[$cat][] | select(.scan_error | not) | .slug')
   done

   # seeds (--seed-id)
   while IFS= read -r seed_id; do
     [ -z "$seed_id" ] && continue
     if ! gsd_run query audit-open acknowledge --category seeds --milestone "$MILESTONE_VERSION" --seed-id "$seed_id"; then
       record_ack_failure "seeds seed_id=$seed_id"
     fi
   done < <(printf '%s' "$AUDIT_JSON" | jq -r '.items.seeds[] | select(.scan_error | not) | .seed_id')

   # todos (--filename) — the scanner caps its list to 5 entries per scan
   # (remainder items carry `_remainder_count`, no `filename`, and are skipped)
   while IFS= read -r filename; do
     [ -z "$filename" ] && continue
     if ! gsd_run query audit-open acknowledge --category todos --milestone "$MILESTONE_VERSION" --filename "$filename"; then
       record_ack_failure "todos filename=$filename"
     fi
   done < <(printf '%s' "$AUDIT_JSON" | jq -r '.items.todos[] | select((.scan_error or ._remainder_count) | not) | .filename')

   # quick_tasks (--dir) — the scanner's `slug` strips a leading
   # YYYYMMDD-/YYYY-MM-DD- date prefix for display; `--dir` needs the
   # ORIGINAL .planning/quick/<dir>/ name, so reconstruct it from `date`+`slug`.
   while IFS= read -r dir; do
     [ -z "$dir" ] && continue
     if ! gsd_run query audit-open acknowledge --category quick_tasks --milestone "$MILESTONE_VERSION" --dir "$dir"; then
       record_ack_failure "quick_tasks dir=$dir"
     fi
   done < <(printf '%s' "$AUDIT_JSON" | jq -r '.items.quick_tasks[] | select(.scan_error | not) | if .date != "" then "\(.date)-\(.slug)" else .slug end')

   # uat_gaps / verification_gaps / context_questions — phase-scoped
   # (--phase --file [--archived-milestone] when the item was found in an archived phase)
   for cat in uat_gaps verification_gaps context_questions; do
     while IFS= read -r item; do
       [ -z "$item" ] && continue
       phase=$(printf '%s' "$item" | jq -r '.phase')
       file=$(printf '%s' "$item" | jq -r '.file')
       archived=$(printf '%s' "$item" | jq -r '.archived_milestone // empty')
       if [ -n "$archived" ]; then
         if ! gsd_run query audit-open acknowledge --category "$cat" --milestone "$MILESTONE_VERSION" --phase "$phase" --file "$file" --archived-milestone "$archived"; then
           record_ack_failure "$cat phase=$phase file=$file archived-milestone=$archived"
         fi
       else
         if ! gsd_run query audit-open acknowledge --category "$cat" --milestone "$MILESTONE_VERSION" --phase "$phase" --file "$file"; then
           record_ack_failure "$cat phase=$phase file=$file"
         fi
       fi
     done < <(printf '%s' "$AUDIT_JSON" | jq -c --arg cat "$cat" '.items[$cat][] | select(.scan_error | not)')
   done

   # deferred_items — same phase-scoped identification, plus --text (the
   # exact bullet the audit read, which uniquely identifies the entry)
   while IFS= read -r item; do
     [ -z "$item" ] && continue
     phase=$(printf '%s' "$item" | jq -r '.phase')
     file=$(printf '%s' "$item" | jq -r '.file')
     text=$(printf '%s' "$item" | jq -r '.text')
     archived=$(printf '%s' "$item" | jq -r '.archived_milestone // empty')
     if [ -n "$archived" ]; then
       if ! gsd_run query audit-open acknowledge --category deferred_items --milestone "$MILESTONE_VERSION" --phase "$phase" --file "$file" --text "$text" --archived-milestone "$archived"; then
         record_ack_failure "deferred_items phase=$phase file=$file archived-milestone=$archived"
       fi
     else
       if ! gsd_run query audit-open acknowledge --category deferred_items --milestone "$MILESTONE_VERSION" --phase "$phase" --file "$file" --text "$text"; then
         record_ack_failure "deferred_items phase=$phase file=$file"
       fi
     fi
   done < <(printf '%s' "$AUDIT_JSON" | jq -c '.items.deferred_items[] | select(.scan_error | not)')

   if [ "$ACK_FAILURES" -gt 0 ]; then
     echo "ERROR: $ACK_FAILURES acknowledge call(s) failed — HALTING before milestone close. Resolve each listed item manually (e.g. edit the file directly for unsupported_heading_shape/ambiguous, or re-run the audit if a --text/--file target has since changed) and re-run /gsd:complete-milestone:" >&2
     printf '%s\n' "$ACK_FAILURE_LOG" >&2
     exit 1
   fi
   ```
   `todos` is the only category the scanner caps (5 entries per scan, with a remainder count for the rest). Re-run `gsd_run query audit-open --json` (through the same `@file:` handling above) and repeat the `todos` block until it reports no `todos` items — every other category always returns its full open set in one pass.
3. Re-run `gsd_run query audit-open --json` once more and write the items just acknowledged as new rows to STATE.md under `## Deferred Items` — append to the existing table (creating the section if absent) rather than overwriting it, preserving rows recorded at earlier milestone closes:
   ```markdown
   ## Deferred Items

   Items acknowledged and deferred at milestone close, most recent first:

   | Category | Item | Status | Deferred At | Milestone |
   |----------|------|--------|-------------|-----------|
   | debug_sessions | {slug} | {status} | {date} | {milestone} |
   | quick_tasks | {slug} | {status} | {date} | {milestone} |
   | threads | {slug} | {status} | {date} | {milestone} |
   | seeds | {seed_id} | {status} | {date} | {milestone} |
   | todos | {filename} | (presence-only) | {date} | {milestone} |
   | uat_gaps | {phase}/{file} | {status} | {date} | {milestone} |
   | verification_gaps | {phase}/{file} | {status} | {date} | {milestone} |
   | context_questions | {phase}/{file} | {question_count} questions | {date} | {milestone} |
   | deferred_items | {phase}/{file}: {text} | acknowledged | {date} | {milestone} |
   ```
   One row per item actually acknowledged in step 2 (omit categories with nothing to disclose this close). `{date}` is today's date; `{milestone}` is `MILESTONE_VERSION`. Sanitize all slug/status/text values via `sanitizeForDisplay()` before writing. Never inject raw file content into STATE.md.
4. Set `closeout_type=override_closeout` and record in the MILESTONES.md entry: `Known verification overrides: {N} newly acknowledged, {M} carried forward from a prior close (see STATE.md Deferred Items)` — `{N}` is the count of items acknowledged in step 2 (the pre-acknowledgment audit JSON's `counts.total`) and `{M}` is that same audit JSON's `acknowledged.total` (items a PRIOR close already suppressed and still are).
5. Proceed with milestone close.

Acknowledging is verdict-preserving and self-invalidating: it never rewrites the artifact's own `status:` field (except `deferred_items`, whose entry has no other meaning for that field), and the suppression it grants lapses automatically the moment the artifact's observed state changes again — a reopened debug session, an edited UAT gap, a re-triggered seed, etc. resurfaces on its own at the next audit and must be acknowledged again.

If output shows all clear (no open items): set `closeout_type=verified_closeout`. If the audit JSON's `acknowledged.total` is `0`, print `All artifact types clear.` and proceed. Otherwise the close is clean only because `{acknowledged.total}` item(s) acknowledged at an earlier milestone close are still being suppressed, not because everything was fixed this time — print `All artifact types clear ({acknowledged.total} previously acknowledged item(s) still suppressed — see STATE.md Deferred Items).` and record `Known verification overrides: 0 newly acknowledged, {acknowledged.total} carried forward from a prior close (see STATE.md Deferred Items)` in the MILESTONES.md entry before proceeding.

(The SECURITY note on audit JSON provenance and STATE.md sanitization is stated in the spine, not repeated here.)

## § 2 — handle_branches

Check branching strategy and offer merge options.

Use `init milestone-op` for context, or load config directly:

```bash
INIT=$(gsd_run query init.execute-phase "1")
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
INIT_CM=$(gsd_run query init.complete-milestone)
if [[ "$INIT_CM" == @file:* ]]; then INIT_CM=$(cat "${INIT_CM#@file:}"); fi
```

Extract `branching_strategy`, `phase_branch_template`, `milestone_branch_template`, and `commit_docs` from init JSON. Extract `git_create_tag` and `section_manifest` from `INIT_CM` (used by the `git_tag` step below).

`BASE_BRANCH` is already resolved by the spine at this point (via the shared `git.base-branch` resolver) — the branch options below use it as-is.

**If "none":** Skip to git_tag.

**For "phase" strategy:**

```bash
BRANCH_PREFIX=$(echo "$PHASE_BRANCH_TEMPLATE" | sed 's/{.*//')
PHASE_BRANCHES=$(git branch --list "${BRANCH_PREFIX}*" 2>/dev/null | sed 's/^\*//' | tr -d ' ')
```

**For "milestone" strategy:**

```bash
BRANCH_PREFIX=$(echo "$MILESTONE_BRANCH_TEMPLATE" | sed 's/{.*//')
MILESTONE_BRANCH=$(git branch --list "${BRANCH_PREFIX}*" 2>/dev/null | sed 's/^\*//' | tr -d ' ' | head -1)
```

**If no branches found:** Skip to git_tag.

**If branches exist:**

```
## Git Branches Detected

Branching strategy: {phase/milestone}
Branches: {list}

Options:
1. **Merge to main** — Merge branch(es) to main
2. **Delete without merging** — Already merged or not needed
3. **Keep branches** — Leave for manual handling
```

AskUserQuestion with options: Squash merge (Recommended), Merge with history, Delete without merging, Keep branches.

**Squash merge:**

```bash
CURRENT_BRANCH=$(git branch --show-current)
git checkout ${BASE_BRANCH}

if [ "$BRANCHING_STRATEGY" = "phase" ]; then
  # Rewrapped through unquoted command substitution (gsd-core#4109): a bare
  # `$VAR` word-splits under bash but not zsh, collapsing every element onto
  # one iteration there.
  for branch in $(printf '%s' "$PHASE_BRANCHES"); do
    git merge --squash "$branch"
    # Strip .planning/ from staging if commit_docs is false
    if [ "$COMMIT_DOCS" = "false" ]; then
      git reset HEAD .planning/ 2>/dev/null || true
    fi
    git commit -m "feat: $branch for v[X.Y]"
  done
fi

if [ "$BRANCHING_STRATEGY" = "milestone" ]; then
  git merge --squash "$MILESTONE_BRANCH"
  # Strip .planning/ from staging if commit_docs is false
  if [ "$COMMIT_DOCS" = "false" ]; then
    git reset HEAD .planning/ 2>/dev/null || true
  fi
  git commit -m "feat: $MILESTONE_BRANCH for v[X.Y]"
fi

git checkout "$CURRENT_BRANCH"
```

**Merge with history:**

```bash
CURRENT_BRANCH=$(git branch --show-current)
git checkout ${BASE_BRANCH}

if [ "$BRANCHING_STRATEGY" = "phase" ]; then
  # Rewrapped through unquoted command substitution (gsd-core#4109): a bare
  # `$VAR` word-splits under bash but not zsh, collapsing every element onto
  # one iteration there.
  for branch in $(printf '%s' "$PHASE_BRANCHES"); do
    git merge --no-ff --no-commit "$branch"
    # Strip .planning/ from staging if commit_docs is false
    if [ "$COMMIT_DOCS" = "false" ]; then
      git reset HEAD .planning/ 2>/dev/null || true
    fi
    git commit -m "Merge branch '$branch' for v[X.Y]"
  done
fi

if [ "$BRANCHING_STRATEGY" = "milestone" ]; then
  git merge --no-ff --no-commit "$MILESTONE_BRANCH"
  # Strip .planning/ from staging if commit_docs is false
  if [ "$COMMIT_DOCS" = "false" ]; then
    git reset HEAD .planning/ 2>/dev/null || true
  fi
  git commit -m "Merge branch '$MILESTONE_BRANCH' for v[X.Y]"
fi

git checkout "$CURRENT_BRANCH"
```

**Delete without merging:**

```bash
if [ "$BRANCHING_STRATEGY" = "phase" ]; then
  # Rewrapped through unquoted command substitution (gsd-core#4109): a bare
  # `$VAR` word-splits under bash but not zsh, collapsing every element onto
  # one iteration there.
  for branch in $(printf '%s' "$PHASE_BRANCHES"); do
    git branch -d "$branch" 2>/dev/null || git branch -D "$branch"
  done
fi

if [ "$BRANCHING_STRATEGY" = "milestone" ]; then
  git branch -d "$MILESTONE_BRANCH" 2>/dev/null || git branch -D "$MILESTONE_BRANCH"
fi
```

**Keep branches:** Report "Branches preserved for manual handling"
