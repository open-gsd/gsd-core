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
dispatch. Before each Agent() call that carries the receipt line, under either toggle,
the orchestrator runs
`gsd_receipt_path "${PHASE_DIR}" <spawn> "${PROJECT_ROOT}"` (`<spawn>` is `planner`, `checker`,
`revision`, `outline`, or the plan ID; `PROJECT_ROOT` is init's `project_root`) and substitutes the printed absolute path for `{receipt}`,
both in the spawn prompt's `<return_receipt>{receipt}</return_receipt>` line and in
every watch call for that spawn. If `gsd_receipt_path` prints nothing (it fails closed on
input outside its stated contract or a symlinked phase dir, naming the reason on stderr), there is no receipt: omit the `<return_receipt>` line
and pass `""` as the watch's second argument; the wait then ends on the runtime's
completion result or as `stalled`. Like `$TS`, it is a literal the orchestrator carries
across tool calls; nothing persists across fences, so never pass an unexpanded
`$RECEIPT`/`$TS` expression. The agent's LAST action is to write its complete return
(the marker line first, then the rest of what it returns, word for word) to that path
with one atomic Bash call, a `.part` file renamed into place (`agents/gsd-planner.md`,
`agents/gsd-plan-checker.md`). On `marker_received` the receipt IS the return:
`gsd_return_body "{receipt}"` prints it, and the marker that routes (step 11's
`## VERIFICATION PASSED` vs `## ISSUES FOUND`, the revision's COMPLETE vs CONFLICT) is
`gsd_return_marker "{receipt}" <that call's markers>`; never re-grep anything else.

The watch never reads a host output file (`{outputFile}`). On Claude Code that file is
the subagent transcript, which already holds the agent's prompt and definition
snapshot, and both quote the markers, so a match there proves nothing. Other hosts
return no such file at all. The receipt is the same on every runtime, and
`gsd_return_marker` counts a marker only at the START of a receipt line, so quoted or
JSON-encoded marker text can never match. Each watch site's rule runs `rm -f "{receipt}"`
after routing any result, stalled and Retry included; with no receipt bound, `{receipt}`
is `""` and the rm is a no-op. With the toggle `false`, the
prompt still carries the receipt line and the agent still writes it; the orchestrator
consumes the real returned result and removes the receipt the same way.

**The receipt is the complete return; the completion result is the fallback:** the agent
writes its whole return to the receipt as its last tool action, atomically, so a receipt
that exists is complete, so for an agent that writes its complete return `marker_received` means the return has arrived. Route on
`gsd_return_body "{receipt}"` without waiting for the completion result; the same text is
also the agent's final message. If the spawned agent's real completion result reaches the
orchestrator between cycles, stop the watch and route that result's recognized marker
exactly as the `false` path does. Precedence: whichever
of the two ends the wait routes it. If both are present and name different markers,
treat the return as unrecognized (9a/11a). A receipt that holds only the marker (an
agent definition installed before the body was added; `gsd_return_body` then prints
just that one line, and a one-line body counts as no body for the routes that need an
issue list, a plan count or a checkpoint question) leaves
the body to the completion result, and a route that needs the body when neither has it
fails closed: a receipt-routed `## ISSUES FOUND` with no issue list is
never counted as 0 issues; use 11a and offer Retry checker before Accept. A
receipt-routed `## VERIFICATION PASSED` whose body has not arrived when the watch ends
never proceeds to step 13 on the receipt alone, since step 11 reads that body for
listed findings (#5578): use 11a and offer Retry checker before Accept. A planner
`## CHECKPOINT REACHED`, `## PHASE SPLIT RECOMMENDED`, `## ⚠ Source Audit` or
`## PLANNING INCONCLUSIVE` whose body (the question, the proposed split, the gap list,
the attempts step 9 shows) has not arrived when the watch ends never routes to an empty
checkpoint, 9b, 9c or an empty attempts list: use 9a's receipt case, name the marker
received, and offer Retry planner before Accept; with no plans on disk there is
nothing to accept, so 9a offers Retry planner or Stop. A revision `## REVISION_CONFLICT` whose body (the
`CONFLICT_*` fields step 12 records) has not arrived when the watch ends never writes an
empty conflict record: use that watch's `stalled` menu, name the marker received, and
offer Retry before Accept.

The helper functions and the config values above do not persist between tool calls
either: re-run this block in every fence that calls them.

**Plan-checker receipt:** a checker that PASSES touches no `*-PLAN.md`, so its receipt
is its only completion signal for this watch. The checker keeps its read-only `tools:`
line (no `Write`; #767 Group A) and writes its receipt (its complete return) through its shell, with
one Bash call (`agents/gsd-plan-checker.md`). A refused write is not fatal: the
checker notes it in its return and continues.

**Known limit, a sandbox that refuses the shell write (Codex `read-only`):** Codex derives
the checker's `sandbox_mode` from its `tools:` line (`src/codex-agent-toml.cts`), and a
`read-only` sandbox is expected to refuse that write, so no checker receipt would be
written there (derived from the installer, not measured on Codex). The wait ends on the
completion result, as above, or as `stalled` at the threshold (#5182 ruling of 2026-11-05,
acceptance criterion 5 as amended; the gap and its ADR are tracked in #6110).

**Known limit, kimi-code:** it dispatches `-planner` to its `plan` built-in and
`-checker` to `explore`, and per `runtime-aware-dispatch.md` neither built-in writes
files, so no receipt is expected there (not measured on kimi-code; #6110). The wait
ends on the completion result, as above, or as `stalled` at the threshold.

**Known limit, no receipt and no fresh artifact:** a checker with no receipt (any
refused or failed receipt write, or the two hosts above) touches no `*-PLAN.md`, and neither does a planner
before its first `PLAN.md`, so its watch can only end on the completion result or
as `stalled` at the threshold. There is no heartbeat protocol.

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
# Both values are config-controlled (the project config.json, editable by any repo
# contributor) and both flow into `$(( ))` arithmetic below. A non-numeric
# value there is NOT a code-execution risk (empirically verified: bash's
# arithmetic evaluator hard-errors on a `$(cmd)`-shaped operand instead of
# invoking it — "syntax error: operand expected", command never runs) but IS
# a reliability risk this fix cannot afford: a malformed config value would
# abort the stall-watcher itself with a bash syntax error, silently defeating
# the exact hang-recovery this issue is about. Reject anything that is not a
# bare positive integer before it is ever used, so a bad config value
# degrades to the safe default instead of crashing the watcher. Zero is
# rejected too (#3923): an interval of 0 makes every gsd_stall_watch cycle a
# zero-length sleep, and a threshold of 0 declares a healthy agent stalled on
# the first check. At most 9 digits, so `* 60` can never overflow.
[[ "$PLANNER_STALL_INTERVAL_MINUTES" =~ ^[1-9][0-9]{0,8}$ ]] || PLANNER_STALL_INTERVAL_MINUTES=5
[[ "$PLANNER_STALL_THRESHOLD_MINUTES" =~ ^[1-9][0-9]{0,8}$ ]] || PLANNER_STALL_THRESHOLD_MINUTES=10

# gsd_stall_should_recover — pure decision function, no IO, no sleeping. Given how
# long the orchestrator has been waiting plus two liveness signals (a completion
# marker found in the agent's output file, and fresh on-disk artifact activity),
# decides whether to keep waiting, treat the wait as satisfied, or auto-surface the
# existing accept/retry/stop recovery menu (9a/11a). Never kills or retries anything
# itself — it only classifies. Re-validates both numeric args as bounded bare
# non-negative integers (defense in depth — safe to call with any input, not just
# the resolved config globals above, which are always >= 1) before either ever
# reaches arithmetic expansion. It accepts 0 so callers can test boundaries.
gsd_stall_should_recover() {
  local elapsed_seconds="$1" threshold_minutes="$2" marker_found="$3" artifact_fresh="$4"
  [[ "$elapsed_seconds" =~ ^[0-9]{1,15}$ ]] || elapsed_seconds=0
  [[ "$threshold_minutes" =~ ^[0-9]{1,9}$ ]] || threshold_minutes=10
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

# gsd_receipt_path PHASE_DIR SPAWN ROOT — print a fresh, absolute return-receipt path
# PHASE_DIR/.gsd-returns/SPAWN.EPOCH.XXXXXXXX (#5182). The directory is created
# (with a `*` .gitignore); the file is NOT (a host Write tool may refuse to
# overwrite a file the agent never read). Absolute because a subagent's cwd may
# differ from the orchestrator's; `mktemp -u` keeps back-to-back dispatches in one
# second distinct and EPOCH makes a leftover receipt's dispatch time readable.
# SPAWN is reduced to [A-Za-z0-9_-] and cut to 64 characters, so a plan ID can
# never leave the directory or overflow a file name (the character lists are spelled
# out, not ranges, so no locale can widen them).
# Input contract: PHASE_DIR (init's phase_dir) and ROOT (init's project_root) are
# absolute paths (a drive letter counts only where cygpath exists) with no empty,
# `.` or `..` component (so a UNC path, which starts with `//`, is refused), no
# trailing separator (except a ROOT that is a filesystem root), no quote, `$`,
# backtick, `<`, `>` or ASCII control character (matched with LC_ALL=C set
# locally), and in PHASE_DIR no backslash; anything
# else is refused before the filesystem is touched.
# The receipt directory must also sit physically under ROOT: a checkout can commit
# the phase dir, `.planning` or `.gsd-returns` as a symlink, and mkdir -p and the
# .gitignore write would follow it out of the project. So a link on the walk from
# the phase dir up to and including its nearest existing ancestor (a dangling one
# too; a link above that ancestor passes when the physical path stays under ROOT and outside .git), a phase
# dir that resolves outside ROOT, is ROOT, or holds a `.git` component below it (in
# any letter case, and the names Windows reads as `.git`), and a symlinked
# .gsd-returns or .gitignore (or a .gitignore other than exactly `*` and a newline) all disable the receipt; the watch then ends on the
# runtime's completion result or as `stalled`. Both sides are compared after
# `cd -P`/`pwd -P` (macOS temp dirs live under the /var -> /private/var link; Git
# Bash maps C:/ to /c/ on both sides). Only static, checked-in links are in scope: a
# link swapped in between these checks and the mkdir/printf (check-then-act) is not.
# Every refusal, including a failed cygpath or mktemp, prints one
# `gsd_receipt_path: no receipt: <reason>` line on stderr (the reason only, never the
# path, which may hold control characters).
_gsd_no_receipt() { printf 'gsd_receipt_path: no receipt: %s\n' "$1" >&2; return 1; }
# _gsd_receipt_arg LABEL VALUE — refuse VALUE unless it meets the input contract above
# (the backslash rule for PHASE_DIR is applied by the caller).
_gsd_receipt_arg() {
  local LC_ALL=C
  [ -n "$2" ] || { _gsd_no_receipt "$1 is empty"; return 1; }
  case "$2" in
    *[[:cntrl:]]*|*[\'\"\$\`\<\>]*) _gsd_no_receipt "$1 holds a quote, \$, backtick, <, > or a control character"; return 1 ;;
  esac
  case "$2" in
    /*) ;;
    [A-Za-z]:[/\\]*) command -v cygpath >/dev/null 2>&1 || { _gsd_no_receipt "$1 is not absolute"; return 1; } ;;
    *) _gsd_no_receipt "$1 is not absolute"; return 1 ;;
  esac
  [ "$1" = 'project root' ] && case "$2" in /|[A-Za-z]:[/\\]) return 0 ;; esac
  case "$2" in *[/\\][/\\]*) _gsd_no_receipt "$1 has an empty component"; return 1 ;; esac
  case "$2/" in *[/\\].[/\\]*|*[/\\]..[/\\]*) _gsd_no_receipt "$1 has a . or .. component"; return 1 ;; esac
  case "$2" in *[/\\]) _gsd_no_receipt "$1 ends in a separator"; return 1 ;; esac
  return 0
}
gsd_receipt_path() {
  local dir="$1" spawn="${2//[^ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-]/_}"
  local root rp a up phys rest got low
  spawn="${spawn:0:64}"
  _gsd_receipt_arg 'phase dir' "$dir" || return 1
  case "$dir" in *\\*) _gsd_no_receipt 'phase dir holds a backslash'; return 1 ;; esac
  _gsd_receipt_arg 'project root' "${3:-}" || return 1
  root=$(CDPATH='' cd -P -- "$3" >/dev/null 2>&1 && pwd -P) || { _gsd_no_receipt 'project root does not resolve'; return 1; }
  # The root without a trailing slash ("" for /), held in a variable: bash does not
  # match "${root%/}" written inside a case pattern.
  rp="${root%/}"
  # Walk up to the nearest existing ancestor; any walked component that is a link
  # (tested before -e, so a dangling one counts) is refused. A drive's top is C:/, not C:.
  a="$dir"
  while :; do
    [ -L "$a" ] && { _gsd_no_receipt 'a symlink on the path to the phase dir'; return 1; }
    [ -e "$a" ] && break
    up="${a%/*}"
    case "$up" in '') up=/ ;; [A-Za-z]:) up="$up/" ;; esac
    [ "$up" = "$a" ] && { _gsd_no_receipt 'no existing ancestor of the phase dir'; return 1; }
    a="$up"
  done
  phys=$(CDPATH='' cd -P -- "$a" >/dev/null 2>&1 && pwd -P) || { _gsd_no_receipt 'the phase dir ancestor does not resolve'; return 1; }
  case "$phys/" in "$rp"/*) ;; *) _gsd_no_receipt 'the phase dir resolves outside the project root'; return 1 ;; esac
  # The part of the phase dir below its existing ancestor, with its leading slash
  # (the ancestor / or C:/ ends in one, so it is cut without it).
  rest="${dir#"${a%/}"}"
  # The project root itself and anything under a .git component are never a phase dir.
  [ "${phys%/}$rest" = "$rp" ] && { _gsd_no_receipt 'the phase dir is the project root'; return 1; }
  # Only the part under the root is compared, lowercased (on APFS and NTFS .GIT is .git),
  # with each segment's trailing dots and spaces dropped and the 8.3 name git~1 matched
  # (Windows reads .git with a trailing dot or space, and GIT~1, as .git).
  low=$(printf '%s' "${phys#"$rp"}$rest/" | LC_ALL=C tr '[:upper:]' '[:lower:]' | LC_ALL=C sed 's/[. ]*\//\//g')
  # The input always ends in /, so an empty result means tr or sed failed.
  [ -n "$low" ] || { _gsd_no_receipt 'cannot check the phase dir for .git'; return 1; }
  case "$low" in */.git/*|*/git~1/*) _gsd_no_receipt 'the phase dir is inside .git'; return 1 ;; esac
  [ -L "$dir/.gsd-returns" ] && { _gsd_no_receipt '.gsd-returns is a symlink'; return 1; }
  mkdir -p "$dir/.gsd-returns" 2>/dev/null || { _gsd_no_receipt 'cannot create .gsd-returns'; return 1; }
  got=$(CDPATH='' cd -P -- "$dir/.gsd-returns" >/dev/null 2>&1 && pwd -P) || { _gsd_no_receipt '.gsd-returns does not resolve'; return 1; }
  [ "$got" = "${phys%/}$rest/.gsd-returns" ] || { _gsd_no_receipt '.gsd-returns resolves elsewhere'; return 1; }
  [ -L "$dir/.gsd-returns/.gitignore" ] && { _gsd_no_receipt '.gsd-returns/.gitignore is a symlink'; return 1; }
  # The redirection's own error is silenced by the outer 2>/dev/null (an inner one would
  # apply after the failed open), so a refusal stays one stderr line.
  if [ -e "$dir/.gsd-returns/.gitignore" ]; then
    # A directory or FIFO there would fail or block the write.
    [ -f "$dir/.gsd-returns/.gitignore" ] || { _gsd_no_receipt '.gsd-returns/.gitignore is not a regular file'; return 1; }
    # Any other content (a later `!*` line, say) might let receipts be committed, so only
    # the exact bytes written below are accepted; an unreadable file fails the compare too.
    printf '*\n' | cmp -s - "$dir/.gsd-returns/.gitignore" 2>/dev/null || { _gsd_no_receipt '.gsd-returns/.gitignore is not exactly the * line written here, or is unreadable'; return 1; }
  else
    { printf '*\n' > "$dir/.gsd-returns/.gitignore"; } 2>/dev/null || { _gsd_no_receipt 'cannot write .gsd-returns/.gitignore'; return 1; }
  fi
  if command -v cygpath >/dev/null 2>&1; then
    { dir=$(cygpath -m "$dir" 2>/dev/null) && [ -n "$dir" ]; } || { _gsd_no_receipt 'cygpath failed'; return 1; }
  fi
  { got=$(mktemp -u "$dir/.gsd-returns/${spawn:-spawn}.$(date +%s).XXXXXXXX" 2>/dev/null) && [ -n "$got" ]; } || { _gsd_no_receipt 'mktemp failed'; return 1; }
  printf '%s\n' "$got"
}

# gsd_return_marker FILE MARKER... — print the first MARKER that STARTS a line of
# FILE's first 64 lines and first 4096 bytes (the receipt is agent-written; one
# marker line is expected; the byte cap keeps one huge line from stalling the
# watch), or nothing. A marker must end within those 4096 bytes and its boundary
# must be seen (4097 bytes are read): a line cut at the read window ends nowhere, so
# a longer word cut at the cap is never taken for a marker. Literal prefix match (no regex), and the marker must be
# followed by the end of the line, a space, tab, CR, VT, FF or a colon (the
# planner's Source Audit return puts `: Unplanned Items Found` after its marker),
# so `## PLAN COMPLETE-x` or a
# longer word that merely starts with a marker is not that marker. A BOM at the
# start of the file (line 1 only) and a missing final newline are tolerated. A receipt that is a symlink is never
# read, nor one with a NUL byte in its first 4097 bytes (bash and zsh read a NUL differently). The one owner of "which marker did the agent return": gsd_stall_watch and
# step 11's routing both use it. Indented, mid-line, or JSON-encoded marker text
# (prompts, agent definitions, transcripts) never matches.
gsd_return_marker() {
  local file="$1" line m rest n=0 size cut; shift
  [ -L "$file" ] && return 0
  [ -f "$file" ] && [ -r "$file" ] || return 0
  size=$(( $(head -c 4097 -- "$file" 2>/dev/null | wc -c) ))
  [ "$(( $(head -c 4097 -- "$file" 2>/dev/null | LC_ALL=C tr -d '\000' | wc -c) ))" -eq "$size" ] || return 0
  while [ "$n" -lt 64 ]; do
    cut=0
    if IFS= read -r line; then :
    elif [ -n "$line" ]; then [ "$size" -le 4096 ] || cut=1
    else break
    fi
    n=$((n + 1))
    if [ "$n" -eq 1 ]; then line="${line#$'\xef\xbb\xbf'}"; fi
    for m in "$@"; do
      [[ "$line" == "$m"* ]] || continue
      rest="${line#"$m"}"
      case "${rest:0:1}" in
        '') [ "$cut" = 0 ] && { printf '%s\n' "$m"; return 0; } ;;
        ' '|$'\t'|$'\r'|$'\v'|$'\f'|:) printf '%s\n' "$m"; return 0 ;;
      esac
    done
  done < <(head -c 4097 -- "$file" 2>/dev/null)
  return 0
}

# gsd_return_body FILE — print the agent's complete return from its receipt: the whole
# file. Nothing is printed for a symlink, a directory, a missing or unreadable file, an
# empty one, one with a NUL byte anywhere (bash and zsh read a NUL differently), or one
# over 65536 bytes (a return is a short report; a cut body could drop a finding, so an
# oversize one counts as no body and the body-needing routes fail closed). Call it only
# after `marker_received`; the first line is the marker (`gsd_return_marker` names it)
# and a receipt that holds only that line is a marker-only receipt, which routes
# through the 9a/11a body-less cases.
gsd_return_body() {
  local file="$1" size
  [ -L "$file" ] && return 0
  [ -f "$file" ] && [ -r "$file" ] || return 0
  size=$(( $(wc -c < "$file" 2>/dev/null) ))
  [ "$size" -gt 0 ] && [ "$size" -le 65536 ] || return 0
  [ "$(( $(LC_ALL=C tr -d '\000' < "$file" 2>/dev/null | wc -c) ))" -eq "$size" ] || return 0
  cat -- "$file" 2>/dev/null
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
  [[ "$dispatch_ts" =~ ^[0-9]+$ ]] || dispatch_ts=$(date +%s)
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
  # findutils) and BSD find (macOS). $artifact_glob is one string, a literal
  # directory plus a basename pattern (`<phase>/*-PLAN.md`) or a literal file
  # (the chunked sites' $OUTLINE_FILE / $PLAN_FILE). A path that exists is that one
  # file, whatever characters its name holds (`outline[1].md` is never a pattern).
  # Otherwise find matches the basename with -name inside the quoted directory (a
  # space in PHASE_DIR must not split it), so the shell never globs: this reads the
  # same under bash and under zsh, which has no shopt and does not glob a variable's
  # value. No match prints nothing, and artifact_fresh stays false. A relative path
  # gets a `./` prefix, so find reads a leading `-`, `!` or `(` as a path, not an
  # option or operator. -H follows a phase dir that is itself a symlink; -type f counts
  # regular files only in both branches (a directory or symlink, named like a plan or
  # passed as the literal file, is not activity), and
  # -name matches a leading dot (`.x-PLAN.md` counts).
  artifact_fresh="false"
  case "$artifact_glob" in ''|/*|[A-Za-z]:[/\\]*) ;; *) artifact_glob="./$artifact_glob" ;; esac
  local _d="${artifact_glob%/*}" _p="${artifact_glob##*/}"
  [ -n "$_d" ] || _d=/
  if [ -n "$artifact_glob" ] && [ -e "$artifact_glob" ]; then
    [ -n "$(find "$artifact_glob" -maxdepth 0 -type f -mmin "-${PLANNER_STALL_INTERVAL_MINUTES}" 2>/dev/null)" ] && artifact_fresh="true"
  elif [ -n "$artifact_glob" ] && [ -d "$_d" ]; then
    [ -n "$(find -H "$_d" -maxdepth 1 -type f -name "$_p" -mmin "-${PLANNER_STALL_INTERVAL_MINUTES}" 2>/dev/null)" ] && artifact_fresh="true"
  fi
  gsd_stall_should_recover "$elapsed" "$PLANNER_STALL_THRESHOLD_MINUTES" "$marker_found" "$artifact_fresh"
}
```
