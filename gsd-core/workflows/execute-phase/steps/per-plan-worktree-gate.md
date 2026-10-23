# Per-plan worktree decision (#2772) and per-dispatch isolation record (#3045, #5516)
## Part 1 — Decide (run for each plan in the wave, up front, at `execute_waves` step 2.5)
This gate has two parts that run at **different times**. **Part 1** (this part) decides, for every plan in the wave, whether it uses worktree isolation, and stores each plan's answer; it runs for the whole wave before any dispatch. **Part 2** (below) writes the plan-scoped isolation record and runs once per plan, immediately before that plan's `Agent()` dispatch in step 3. The output `USE_WORKTREES_FOR_PLAN` gates the dispatch branch (worktree mode vs sequential mode) for that plan only — other plans in the same wave can still take the worktree path.

`SUBMODULE_PATHS` is computed once in the `initialize` step (parsed from `.gitmodules`).

`PLAN_FILES` is the whitespace-separated list of paths the plan declared it will touch, extracted from the `phase-plan-index` JSON loaded in `discover_and_group_plans`:

```bash
# plan_json is the JSON object for this plan from PLAN_INDEX.plans[]
# files_modified is an array of strings (repo-relative paths or globs)
PLAN_FILES=$(jq -r '.files_modified // [] | join(" ")' <<<"$plan_json")
# #3003: files_deleted is the paths the plan declared it will REMOVE. Separate from
# files_modified on purpose — it authorizes the cleanup-wave deletions guard, and a
# deletion authorization must never be inferred from a general scope declaration.
PLAN_DELETIONS=$(jq -r '.files_deleted // [] | join(" ")' <<<"$plan_json")
plan_id=$(jq -r '.id' <<<"$plan_json")
```

Then run the per-plan gate:

```bash
USE_WORKTREES_FOR_PLAN="$USE_WORKTREES"

# #3003: this gate asks "does the plan touch a submodule at all", and REMOVING a file
# inside one is as much a touch as modifying it. Both declared channels feed the
# intersection: before files_deleted existed a deleted path had to appear in
# files_modified to be planned at all, so the gate saw it. Now that plan-md.md tells
# authors a deleted path needs no files_modified entry, reading files_modified alone
# would let a deletion-only submodule plan keep worktree isolation on — exactly the
# case #2772 disabled it for. Note this is the OPPOSITE posture from the cleanup-wave
# deletions guard: there the two channels are kept apart because a deletion
# AUTHORIZATION must never be inferred; here they are merged because a safety fallback
# must never MISS a touch.
PLAN_SCOPE_PATHS=$(printf '%s %s' "$PLAN_FILES" "$PLAN_DELETIONS" | tr -s ' ' | sed 's/^ //; s/ $//')

if [ -n "$SUBMODULE_PATHS" ] && [ "$USE_WORKTREES_FOR_PLAN" != "false" ]; then
  if [ -z "$PLAN_SCOPE_PATHS" ]; then
    # Fallback: planned paths are unknown/unparseable — fall back to the safe
    # behavior (disable worktree isolation for this plan) and log why.
    echo "[worktree] Plan ${plan_id}: files_modified and files_deleted both missing/unparseable — disabling worktree isolation as a safety fallback (submodule project)"
    USE_WORKTREES_FOR_PLAN=false
  else
    # Compute intersection with glob-safe normalization. Both sides are
    # normalized (strip leading "./", strip trailing "/") and matched
    # bidirectionally so a globby planned path like "vendor/**/*.c" still
    # matches submodule "vendor/foo", and "./vendor/foo/bar.c" matches
    # submodule "vendor/foo".
    INTERSECT=""
    set -f  # disable globbing while iterating literal patterns
    # Rewrapped through unquoted command substitution (gsd-core#4109): a bare
    # `$VAR` word-splits under bash but not zsh, collapsing every element onto
    # one iteration there.
    for sm_raw in $(printf '%s' "$SUBMODULE_PATHS"); do
      # Normalize submodule path: strip ./ prefix and trailing /
      sm="${sm_raw#./}"
      sm="${sm%/}"
      [ -z "$sm" ] && continue
      # Rewrapped through unquoted command substitution (gsd-core#4109): a bare
      # `$VAR` word-splits under bash but not zsh, collapsing every element onto
      # one iteration there.
      for pf_raw in $(printf '%s' "$PLAN_SCOPE_PATHS"); do
        # Normalize planned path the same way
        pf="${pf_raw#./}"
        pf="${pf%/}"
        [ -z "$pf" ] && continue
        matched=0
        # Direction 1: planned path is the submodule or lies inside it
        case "$pf" in
          "$sm"|"$sm"/*) matched=1 ;;
        esac
        # Direction 2: submodule lies inside the planned path (e.g. plan
        # declares "vendor" or a glob expanding to a directory containing
        # the submodule).
        if [ "$matched" -eq 0 ]; then
          case "$sm" in
            "$pf"|"$pf"/*) matched=1 ;;
          esac
        fi
        # Direction 3: planned path uses a glob — strip glob wildcards
        # and check whether the resulting prefix overlaps the submodule
        # path in either direction.
        if [ "$matched" -eq 0 ]; then
          case "$pf" in
            *'*'*|*'?'*|*'['*)
              # Take the literal prefix before the first glob metachar.
              prefix="${pf%%[*?[]*}"
              prefix="${prefix%/}"
              if [ -n "$prefix" ]; then
                case "$sm" in
                  "$prefix"|"$prefix"/*) matched=1 ;;
                esac
                if [ "$matched" -eq 0 ]; then
                  case "$prefix" in
                    "$sm"|"$sm"/*) matched=1 ;;
                  esac
                fi
              fi
              ;;
          esac
        fi
        if [ "$matched" -eq 1 ]; then
          INTERSECT="$INTERSECT $pf_raw"
        fi
      done
    done
    set +f
    if [ -n "$INTERSECT" ]; then
      echo "[worktree] Plan ${plan_id}: planned paths intersect submodule paths (${INTERSECT# }) — disabling worktree isolation for this plan"
      USE_WORKTREES_FOR_PLAN=false
    fi
  fi
fi
```

After running this for the plan, the dispatch branches in `execute_waves` step 3 MUST gate on `USE_WORKTREES_FOR_PLAN` for the current plan, not on the project-level `USE_WORKTREES`. Track which plans in this wave actually used worktrees (append `plan_id` to a `WAVE_WORKTREE_PLANS` accumulator when `USE_WORKTREES_FOR_PLAN != false`) — the post-wave cleanup step (5.5) uses this to decide whether worktree-merge cleanup is needed at all.

**Store the decision per plan (#5516).** `USE_WORKTREES_FOR_PLAN` is one shared value: the next plan's decision overwrites it. Keep each plan's answer as `plan_id → value` (for example `WAVE_PLAN_ISOLATION="03-01-api=false 03-02-docs=true"`) so step 3 can restore the dispatched plan's own value just before its dispatch (the value after `<plan_id>=`). `PLAN_FILES` and `PLAN_DELETIONS` above are shared the same way, and step 3 passes them to `worktree.record-agent` / `worktree.create`: re-run the extraction block above on the dispatched plan's JSON to restore them. This part does **not** write the isolation record.

## Part 2 — Re-record the dispatch-isolation sentinel, scoped to THIS plan (#3045 BLOCKER 1, #5516)

Run this in `execute_waves` step 3, **immediately before dispatching THIS plan**, after restoring that plan's **stored decision** from Part 1 (`plan_id` := this plan's `id`, `USE_WORKTREES_FOR_PLAN` := the value stored for it, and `PLAN_FILES` / `PLAN_DELETIONS` re-extracted from this plan's JSON). Never run it at step 2.5 and never for a plan other than the one about to dispatch: the sentinel is a single slot, so recording every plan up front leaves only the wave's last plan in it, and every earlier plan is dispatched against a record naming a different plan (the isolation guard discards it and its registry fallback denies a sequential dispatch the plan's own decision allowed, #5516).

The phase-level sentinel (written by the "Resolve ISOLATION" step, before any per-plan decision exists) authorizes/denies at the PHASE level. The per-plan decision can override that (submodule intersection forcing `USE_WORKTREES_FOR_PLAN=false` on an otherwise harness-worktree phase) — without a fresh, plan-scoped record at dispatch time, the isolation guard hooks would still be reading the STALE phase-level `harness-worktree` sentinel when this plan's dispatch omits the isolation kwarg (correctly, since it isn't worktree-isolated), producing a false DENY; or, symmetrically, a plan-level degrade elsewhere in the wave could leave a stale `none` sentinel that a LATER, genuinely harness-worktree plan's own dispatch could be misread against. Running it right before the dispatch keeps the sentinel always fresh and always keyed to the plan it authorizes:

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; _gsd_id_ok() { case "$("$1" runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') return 0;; *) return 1;; esac; }; _gsd_homes() { set -- "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}" "$HOME/.gemini/antigravity-ide" "$HOME/.gemini/antigravity-cli" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}" "${CLINE_CONFIG_DIR:-$HOME/.cline}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}" "${CODEX_HOME:-$HOME/.codex}" "${COPILOT_CONFIG_DIR:-${COPILOT_HOME:-$HOME/.copilot}}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}" "${HERMES_HOME:-$HOME/.hermes}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}" "${KIMI_CONFIG_DIR:-$HOME/.config/agents}" "$HOME/.agents" "${KIMI_CODE_HOME:-$HOME/.kimi-code}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}" "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}" "${TRAE_CONFIG_DIR:-$HOME/.trae}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}" "${ZCODE_CONFIG_DIR:-$HOME/.zcode}" "${GROK_AGENTS_HOME:-$HOME/.agents}"; for _h; do _gsd_at "$_h/gsd-core/bin/${_GSD_SHIM_NAME}" && return 0; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif _gsd_homes; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; [ -n "$_G" ] && _gsd_id_ok "$_G"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and no identity-proving gsd_run is on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; _gsd_id_ok gsd_run && GSD_IDENTITY_STATUS=ok; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
if [ "${USE_WORKTREES_FOR_PLAN:-}" = "false" ]; then
  # Submodule intersection (or an inherited USE_WORKTREES=false) forces
  # sequential dispatch for this plan specifically — force the resolver's
  # single write path to record `none`, scoped to this plan, even though the
  # phase/registry would otherwise resolve harness-worktree.
  gsd_run query dispatch-isolation --raw --phase "${PHASE_NUMBER:-}" --plan "$plan_id" --force-isolation none >/dev/null 2>&1 || true
elif [ -n "${USE_WORKTREES_FOR_PLAN:-}" ]; then
  # No plan-level override — re-resolve normally, still scoped to this plan,
  # so the sentinel's `plan` field always matches the plan about to dispatch.
  gsd_run query dispatch-isolation --raw --phase "${PHASE_NUMBER:-}" --plan "$plan_id" >/dev/null 2>&1 || true
fi
# An EMPTY value (the plan state was lost with an earlier tool call's shell) writes
# nothing, so a recorded phase-level degrade is never re-persisted as harness-worktree (#5479).
```

**`PLAN_FILES` is reused after dispatch (#2596):** pass it as `--files "$PLAN_FILES"` on the step-3 `worktree.record-agent` call (and on `worktree.create` in the orchestrator-worktree path) so the post-wave cleanup gauntlet can compare each plan branch's actual committed diff against the scope the plan declared, and report any path outside it. That check is advisory — it warns, it never blocks the merge — and omitting the flag simply skips it for that plan.

**`PLAN_DELETIONS` is reused the same way (#3003):** pass it as `--deletions "$PLAN_DELETIONS"` on the same `worktree.record-agent` / `worktree.create` calls. Unlike `--files`, this one is **not** advisory — it is what lets the post-wave deletions guard merge a branch whose plan declared a file removal. Matching is exact per path: a declared path merges, anything else still blocks that entry (and only that entry). Omitting the flag keeps the guard's original behavior of blocking on any deletion at all, so a plan that declares nothing loses nothing.
