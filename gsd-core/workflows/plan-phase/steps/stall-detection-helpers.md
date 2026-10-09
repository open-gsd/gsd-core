# Bounded Stall-Detection Helpers (#2650)

`planner.stall_detection_enabled` controls the wait policy for the five scoped
planner/plan-checker spawns. It defaults to `true`. In that default-on mode each
spawn dispatches with `run_in_background=true`, records `TS=$(date +%s)`, and
then repeatedly calls `gsd_stall_watch` until it returns something other than
`waiting`/`active`. This mirrors the already-shipped `executor.stall_*`
pattern (`execute-phase.md`, bug #3212, commit `e7942c21b`) but — unlike
that prose-only surveillance, which cannot run during a *blocking* `Agent()`
call — each `gsd_stall_watch` call is a real, bounded bash subprocess wait
issued as its own tool call, so it returns control to the orchestrator on
its own schedule regardless of whether the backgrounded agent's own
completion notification ever arrives.

When the key is explicitly the JSON boolean `false`, each scoped call instead
omits `run_in_background`, waits through the runtime-native ordinary Agent()
completion mechanism, and consumes that real returned result. It never calls
`gsd_stall_watch`, so there are no periodic shell sleeps. This is still a wait,
not fire-and-forget. It deliberately gives up #2650's bounded automatic
recovery: if the runtime loses the completion handoff, the user may need to
interrupt and use the existing filesystem fallback. The completion markers and
empty/truncated/unrecognized-return fallback remain unchanged.

**Binding `{receipt}` (load-bearing, not optional; #5182):** every `gsd_stall_watch`
call takes `{receipt}` as its second argument: a GSD-owned return receipt, one per
dispatch. Before each watched Agent() call the orchestrator runs
`gsd_receipt_path "${PHASE_DIR}" <spawn>` (`<spawn>` is `planner`, `checker`, `revision`,
`outline`, or the plan ID) and substitutes the printed absolute path for `{receipt}`,
both in the spawn prompt's `<return_receipt>{receipt}</return_receipt>` line and in
every watch call for that spawn. Like `$TS`, it is a literal the orchestrator carries
across tool calls; nothing persists across fences, so never pass an unexpanded
`$RECEIPT`/`$TS` expression. The agent's LAST action is to write the marker line it
returns to that path (`agents/gsd-planner.md`, `agents/gsd-plan-checker.md`).
On `marker_received`, the marker that routes (step 11's `## VERIFICATION PASSED`
vs `## ISSUES FOUND`, the revision's COMPLETE vs CONFLICT) is
`gsd_return_marker "{receipt}" <that call's markers>`; never re-grep anything else.

The watch never reads a host output file (`{outputFile}`). On Claude Code that file is
the subagent transcript, which already holds the agent's prompt and definition
snapshot, and both quote the markers, so a match there proves nothing. Other hosts
return no such file at all. The receipt is the same on every runtime, and
`gsd_return_marker` counts a marker only at the START of a receipt line, so quoted or
JSON-encoded marker text can never match. After routing, the orchestrator runs
`rm -f "{receipt}"`. With the toggle `false`, the prompt still carries the receipt
line and the agent still writes it; the orchestrator consumes the real returned
result and removes the receipt the same way.

**The runtime's completion result ends the wait:** the receipt bounds the wait; it does
not replace the runtime's own completion. If the spawned agent's real completion
result reaches the orchestrator between cycles, stop the watch and route that
result's recognized marker exactly as the `false` path does. Precedence: whichever
of the two ends the wait routes it. The receipt carries only the marker; the full
return (the checker's issue list, the planner's plan count or checkpoint) always
comes from the completion result. If both are present and name different markers,
treat the return as unrecognized (9a/11a). A route that needs the body when it never
arrives fails closed: a receipt-routed `## ISSUES FOUND` with no issue list is
never counted as 0 issues; use 11a and offer Retry checker before Accept. A planner
`## CHECKPOINT REACHED`, `## PHASE SPLIT RECOMMENDED` or `## ⚠ Source Audit` whose body
(the question, the proposed split, the gap list) has not arrived by the next cycle
never routes to an empty checkpoint, 9b or 9c: use 9a, name the marker received, and
offer Retry planner before Accept.

The helper functions and the config values above do not persist between tool calls
either: re-run this block in every fence that calls them.

**Plan-checker receipt:** a checker that PASSES touches no `*-PLAN.md`, so its receipt
is its only completion signal for this watch. The checker declares `Write` for that one
file (a #767 Group B report-writer: Claude denies it only `Edit, MultiEdit`, and Codex
derives `workspace-write` from its `tools:`), so it can write the receipt on both.

**Single-cycle by design, not one long-lived loop:** `gsd_stall_watch` sleeps
for exactly one `PLANNER_STALL_INTERVAL_MINUTES` and returns — it does NOT
loop internally for the full `PLANNER_STALL_THRESHOLD_MINUTES`. A single Bash
tool call blocking for `threshold + interval` minutes (up to 15 min at
defaults) risks the *host tool's own* timeout killing the call before it ever
prints a result — silently defeating the fix it exists to ship. Looping at
the orchestrator-prose level instead means every cycle is a short (default 5
min), real, bounded call that reliably hands control back — the outer
threshold is enforced by `dispatch_ts` accumulating across calls, not by one
call's own duration.

**Never a wake-up call between cycles (#4079):** while the orchestrator waits
between `gsd_stall_watch` cycles, it must NOT call `ScheduleWakeup` (or any
host wake/sleep-scheduling tool, e.g. the `/loop` pacing surface) to
literalize "I'll wait". The `gsd_stall_watch` bash call IS the wait mechanism;
wake-up scheduling is never part of it, and a partial-args `ScheduleWakeup`
call surfaces the host's red validation error (`prompt` is required when
`stop` is not true). Just issue the next watch call (or let the blocking
Agent() return) — nothing else.

**Disclosed tradeoff:** the first cycle always sleeps a full
`PLANNER_STALL_INTERVAL_MINUTES` before its first check, so a planner that
completes in seconds is not observed by this path until that interval
elapses (default 5 min) — slower than a plain blocking call's near-instant
return on success. This is deliberate: it trades a bounded, at-most-one-
interval delay on the (common) success path for eliminating the unbounded,
possibly-indefinite hang on the (rare, previously unrecoverable) stall path
this issue is about. `PLANNER_STALL_INTERVAL_MINUTES` is the knob for
projects that want a tighter success-path latency at the cost of more
config-get calls.

This block is independent of, and never gated behind, the `query
teams-status` / `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` guard used for the
researcher spawn — the stall path applies on every runtime, teams-active or
not (AC2). The toggle is resolved through the canonical `config-get` seam, so
root/project/workstream selection stays with the Config Loader rather than a
workflow-local JSON parser. Only the exact boolean result `false` disables;
missing, malformed, string, numeric, or otherwise unrecognized values fail safe
to `true`.

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; _gsd_id_ok() { case "$("$1" runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') return 0;; *) return 1;; esac; }; _gsd_homes() { set -- "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}" "$HOME/.gemini/antigravity-ide" "$HOME/.gemini/antigravity-cli" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}" "${CLINE_CONFIG_DIR:-$HOME/.cline}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}" "${CODEX_HOME:-$HOME/.codex}" "${COPILOT_CONFIG_DIR:-${COPILOT_HOME:-$HOME/.copilot}}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}" "${HERMES_HOME:-$HOME/.hermes}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}" "${KIMI_CONFIG_DIR:-$HOME/.config/agents}" "$HOME/.agents" "${KIMI_CODE_HOME:-$HOME/.kimi-code}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}" "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}" "${TRAE_CONFIG_DIR:-$HOME/.trae}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}" "${ZCODE_CONFIG_DIR:-$HOME/.zcode}" "${GROK_AGENTS_HOME:-$HOME/.agents}"; for _h; do _gsd_at "$_h/gsd-core/bin/${_GSD_SHIM_NAME}" && return 0; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif _gsd_homes; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; [ -n "$_G" ] && _gsd_id_ok "$_G"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and no identity-proving gsd_run is on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; _gsd_id_ok gsd_run && GSD_IDENTITY_STATUS=ok; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
PLANNER_STALL_DETECTION_ENABLED=$(gsd_run query config-get planner.stall_detection_enabled --raw 2>/dev/null || echo "true")
# Defense in depth for hand-edited config and old runtimes: only the exact
# canonical false token may disable the default-on recovery policy.
[ "$PLANNER_STALL_DETECTION_ENABLED" = "false" ] || PLANNER_STALL_DETECTION_ENABLED=true
PLANNER_STALL_INTERVAL_MINUTES=$(gsd_run query config-get planner.stall_detect_interval_minutes --raw 2>/dev/null || echo "5")
PLANNER_STALL_THRESHOLD_MINUTES=$(gsd_run query config-get planner.stall_threshold_minutes --raw 2>/dev/null || echo "10")
# Both values are config-controlled (.planning/config.json, editable by any repo
# contributor) and both flow into `$(( ))` arithmetic below. A non-numeric
# value there is NOT a code-execution risk (empirically verified: bash's
# arithmetic evaluator hard-errors on a `$(cmd)`-shaped operand instead of
# invoking it — "syntax error: operand expected", command never runs) but IS
# a reliability risk this fix cannot afford: a malformed config value would
# abort the stall-watcher itself with a bash syntax error, silently defeating
# the exact hang-recovery this issue is about. Reject anything that is not a
# bare non-negative integer before it is ever used, so a bad config value
# degrades to the safe default instead of crashing the watcher.
[[ "$PLANNER_STALL_INTERVAL_MINUTES" =~ ^[0-9]+$ ]] || PLANNER_STALL_INTERVAL_MINUTES=5
[[ "$PLANNER_STALL_THRESHOLD_MINUTES" =~ ^[0-9]+$ ]] || PLANNER_STALL_THRESHOLD_MINUTES=10

# gsd_stall_should_recover — pure decision function, no IO, no sleeping. Given how
# long the orchestrator has been waiting plus two liveness signals (a completion
# marker found in the agent's output file, and fresh on-disk artifact activity),
# decides whether to keep waiting, treat the wait as satisfied, or auto-surface the
# existing accept/retry/stop recovery menu (9a/11a). Never kills or retries anything
# itself — it only classifies. Re-validates both numeric args as bare non-negative
# integers (defense in depth — safe to call with any input, not just the resolved
# config globals above) before either ever reaches arithmetic expansion.
gsd_stall_should_recover() {
  local elapsed_seconds="$1" threshold_minutes="$2" marker_found="$3" artifact_fresh="$4"
  [[ "$elapsed_seconds" =~ ^[0-9]+$ ]] || elapsed_seconds=0
  [[ "$threshold_minutes" =~ ^[0-9]+$ ]] || threshold_minutes=10
  local threshold_seconds=$(( threshold_minutes * 60 ))
  if [ "$marker_found" = "true" ]; then
    echo "marker_received"; return 0
  fi
  if [ "$artifact_fresh" = "true" ]; then
    echo "active"; return 0
  fi
  if [ "$elapsed_seconds" -ge "$threshold_seconds" ]; then
    echo "stalled"; return 0
  fi
  echo "waiting"; return 0
}

# gsd_receipt_path PHASE_DIR SPAWN — print a fresh, absolute return-receipt path
# PHASE_DIR/.gsd-returns/SPAWN.EPOCH.XXXXXXXX (#5182). The directory is created
# (with a `*` .gitignore); the file is NOT (a host Write tool may refuse to
# overwrite a file the agent never read). Absolute because a subagent's cwd may
# differ from the orchestrator's; `mktemp -u` keeps back-to-back dispatches in one
# second distinct; EPOCH lets gsd_stall_watch recover the dispatch time if `$TS`
# was lost between tool calls. SPAWN is reduced to [A-Za-z0-9_-], so a plan ID can
# never leave the directory (the character lists are spelled out, not ranges, so
# no locale can widen them). Fails closed (prints nothing, returns 1) on an empty
# PHASE_DIR or one holding a quote, `$` or backtick, which the orchestrator could
# not substitute safely into a prompt or a quoted bash argument, and when
# .gsd-returns or its .gitignore is a symlink (a checkout can commit one; mkdir -p
# and the .gitignore write would follow it out of the phase).
gsd_receipt_path() {
  local dir="$1" spawn="${2//[^ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-]/_}"
  case "$dir" in
    ''|*[\'\"\$\`]*) return 1 ;;
    /*|[A-Za-z]:[/\\]*) ;;
    *) dir="$(pwd)/$dir" ;;
  esac
  [ -L "$dir/.gsd-returns" ] && return 1
  mkdir -p "$dir/.gsd-returns" || return 1
  [ -L "$dir/.gsd-returns/.gitignore" ] && return 1
  [ -f "$dir/.gsd-returns/.gitignore" ] || printf '*\n' > "$dir/.gsd-returns/.gitignore"
  if command -v cygpath >/dev/null 2>&1; then dir=$(cygpath -m "$dir"); fi
  mktemp -u "$dir/.gsd-returns/${spawn:-spawn}.$(date +%s).XXXXXXXX"
}

# gsd_return_marker FILE MARKER... — print the first MARKER that STARTS a line of
# FILE's first 64 lines (the receipt is agent-written; one marker line is expected),
# or nothing. Literal prefix match (no regex), ending at a word boundary, so
# a longer word that merely starts with a marker is not that marker. A trailing
# CR needs no stripping (it is not a word character); a leading BOM and a
# missing final newline are tolerated. The one owner of "which marker did the
# agent return": gsd_stall_watch and step 11's routing both use it. Indented,
# mid-line, or JSON-encoded marker text (prompts, agent definitions, transcripts)
# never matches.
gsd_return_marker() {
  local file="$1" line m rest n=0; shift
  [ -f "$file" ] && [ -r "$file" ] || return 0
  while [ "$n" -lt 64 ] && { IFS= read -r line || [ -n "$line" ]; }; do
    n=$((n + 1))
    line="${line#$'\xef\xbb\xbf'}"
    for m in "$@"; do
      [[ "$line" == "$m"* ]] || continue
      rest="${line#"$m"}"
      case "$rest" in [ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_]*) continue ;; esac
      printf '%s\n' "$m"; return 0
    done
  done < "$file"
  return 0
}

# gsd_stall_watch — ONE bounded, real (non-LLM-side) sleep-and-check cycle, not
# a long-lived loop (see "Single-cycle by design" above — a single Bash tool
# call spanning the full threshold risks the host tool's own timeout killing
# it first). Sleeps exactly one PLANNER_STALL_INTERVAL_MINUTES, then checks for
# a completion marker in $2 (the spawn's {receipt}, via gsd_return_marker) or
# fresh mtime activity under $3 (an artifact glob), against
# elapsed time since $1 (an epoch-seconds dispatch_ts the CALLER records once,
# before the first call, and passes unchanged on every repeat). Remaining args
# are completion markers. Prints exactly one of: marker_received | active |
# waiting | stalled. The caller repeats the call while the result is
# waiting/active; any other result ends the wait.
gsd_stall_watch() {
  local dispatch_ts="$1" receipt="$2" artifact_glob="$3"; shift 3
  local markers=("$@")
  # A lost `$TS` (shell state does not survive between tool calls) falls back to
  # the EPOCH gsd_receipt_path stamped into the receipt name, then to "now".
  if ! [[ "$dispatch_ts" =~ ^[0-9]+$ ]]; then
    dispatch_ts="${receipt##*/}"; dispatch_ts="${dispatch_ts#*.}"; dispatch_ts="${dispatch_ts%%.*}"
    [[ "$dispatch_ts" =~ ^[0-9]+$ ]] || dispatch_ts=$(date +%s)
  fi
  sleep "$(( PLANNER_STALL_INTERVAL_MINUTES * 60 ))"
  local now elapsed marker_found artifact_fresh
  now=$(date +%s)
  elapsed=$(( now - dispatch_ts ))
  marker_found="false"
  if [ -n "$(gsd_return_marker "$receipt" "${markers[@]}")" ]; then marker_found="true"; fi
  # -mmin -N ("modified less than N minutes ago"), not -newermt "@<epoch>":
  # -newermt's "@<epoch>" shorthand is a GNU-date convenience the shipped
  # BSD find(1) on macOS does NOT understand ("Can't parse date/time:
  # @<epoch>", verified live) — with the 2>/dev/null below that failed
  # silently and permanently degraded artifact_fresh to false on every
  # macOS run. -mmin -N needs no epoch/date-string conversion at all and is
  # supported identically by GNU find (Linux, Git-for-Windows' bundled
  # findutils) and BSD find (macOS). $artifact_glob stays intentionally
  # unquoted — the shell, not find, expands it into the matching file list.
  artifact_fresh="false"
  if [ -n "$(find $artifact_glob -mmin "-${PLANNER_STALL_INTERVAL_MINUTES}" 2>/dev/null)" ]; then
    artifact_fresh="true"
  fi
  gsd_stall_should_recover "$elapsed" "$PLANNER_STALL_THRESHOLD_MINUTES" "$marker_found" "$artifact_fresh"
}
```
