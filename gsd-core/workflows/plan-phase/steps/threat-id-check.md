# Threat-ID checks

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; _gsd_id_ok() { case "$("$1" runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') return 0;; *) return 1;; esac; }; _gsd_homes() { set -- "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}" "$HOME/.gemini/antigravity-ide" "$HOME/.gemini/antigravity-cli" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}" "${CLINE_CONFIG_DIR:-$HOME/.cline}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}" "${CODEX_HOME:-$HOME/.codex}" "${COPILOT_CONFIG_DIR:-${COPILOT_HOME:-$HOME/.copilot}}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}" "${HERMES_HOME:-$HOME/.hermes}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}" "${KIMI_CONFIG_DIR:-$HOME/.config/agents}" "$HOME/.agents" "${KIMI_CODE_HOME:-$HOME/.kimi-code}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}" "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}" "${TRAE_CONFIG_DIR:-$HOME/.trae}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}" "${ZCODE_CONFIG_DIR:-$HOME/.zcode}" "${GROK_AGENTS_HOME:-$HOME/.agents}"; for _h; do _gsd_at "$_h/gsd-core/bin/${_GSD_SHIM_NAME}" && return 0; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif _gsd_homes; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; [ -n "$_G" ] && _gsd_id_ok "$_G"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and no identity-proving gsd_run is on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; _gsd_id_ok gsd_run && GSD_IDENTITY_STATUS=ok; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
```

## Before planning

**Threat-ID uniqueness (#4683 — applies whether or not the security hook is active):** if the init payload's `threat_id_duplicate_count` is non-zero, init reports `threat_id_duplicates` — each `T-{phase}-NN` ID claimed by more than one live PLAN file in this phase. Surface the list to the planner spawn prompt in step 8 — "these threat IDs are already claimed by earlier plans in this phase: {list}; number new registers continuing after the phase's highest in-use `T-{phase}-NN`". Regardless of the count, include the numbering rule in the planner spawn prompt whenever this phase already has PLAN files: threat IDs are unique within a phase, and new registers continue after the highest in-use `T-{phase}-NN` — the count only reports an EXISTING collision, it cannot prevent the first one. The reserved `T-{phase}-SC` row is never listed. execute-phase hard-stops on a non-empty list regardless of what happened here.

## After planning

After plan writes and before committing phase plans, scan fresh. Run this block in the same shell as the CLI bootstrap above. Bind `PHASE` to the target phase and `GSD_WS` to the normalized `--ws name` option (a set but empty string for root scope). Callers supply these values from their init or dispatch context. Missing scope, missing phase, and scan errors block the commit. The scan reports IDs claimed by multiple live PLAN files, with the reserved SC row exempt.

```bash
if [[ -z "${GSD_WS+x}" ]]; then
  echo "BLOCKED: threat-ID scan needs explicit workstream scope" >&2
  exit 1
fi
GSD_WS="${GSD_WS:-}"
if [[ -z "${PHASE:-}" ]]; then
  echo "BLOCKED: threat-ID scan needs a phase" >&2
  exit 1
fi
THREAT_SCAN=$(gsd_run query init.plan-phase ${GSD_WS:+--ws=${GSD_WS##* }} "${PHASE}") || { echo "BLOCKED: threat-ID scan failed" >&2; exit 1; }
if [[ "$THREAT_SCAN" == @file:* ]]; then THREAT_SCAN=$(cat "${THREAT_SCAN#@file:}") || { echo "BLOCKED: cannot read threat-ID scan payload" >&2; exit 1; }; fi
THREAT_ID_ISSUES=$(THREAT_SCAN="$THREAT_SCAN" node -e 'const j=JSON.parse(process.env.THREAT_SCAN);if(j.phase_found===false)throw new Error("threat-ID scan phase not found");if(j.phase_found!==true||!Array.isArray(j.threat_id_duplicates)||j.threat_id_duplicate_count!==j.threat_id_duplicates.length)throw new Error("invalid threat-ID scan");const issues=j.threat_id_duplicates.map(d=>{if(typeof d.id!=="string"||!Array.isArray(d.plans)||d.plans.length<2)throw new Error("invalid duplicate claim");return {plan:d.plans.join(", "),dimension:"threat_id_uniqueness",severity:"blocker",required_property:"A numbered threat ID is claimed by at most one live plan in the phase.",description:d.id+" claimed by "+d.plans.join(", "),fix_hint:"Assign the colliding row a new phase threat ID and update its references."}});process.stdout.write(JSON.stringify(issues))') || { echo "BLOCKED: cannot validate threat-ID scan" >&2; exit 1; }
```

Planner-agent use: bind `PHASE` and `GSD_WS` from the dispatch context. Scan before the agent commit, including revision mode. Fix IDs and references in newly authored rows, then rescan. Preserve prior committed IDs. On unresolved collisions, return `## PLANNING INCONCLUSIVE` with the structured `threat_id_uniqueness` issues and leave plans uncommitted. A scan failure also blocks the commit. Use the revision routing below only in plan-phase. Import has its own commit guard.

### Plan-checker use

Skip this dimension for `quick`, `quick-full`, and `quick-batch-item` modes. Consume the fresh `<threat_id_issues>` from the orchestrator. Each entry is a BLOCKER under `threat_id_uniqueness`; include every claiming plan and return `## ISSUES FOUND`. For phase planning with no fresh payload, run § After planning above binding `PHASE` and `GSD_WS` from verification context (empty workstream option for root scope). Never trust the pre-planner scan. The scan checks claims across distinct live PLAN files. The reserved SC row is exempt.

### Revision routing

Before counting issues in step 12, include the fresh threat-ID issues once. If there is no checker result or checking is disabled or skipped, count the threat issues directly. A fresh scan supersedes prior threat-ID issues. When a collision remains at the revision limit or stall, display `THREAT_ID_ISSUES` and stop the workflow before any commit. Apply this same terminal check when the pre-commit scan finds a collision after revisions are exhausted. Never offer a bypass for this blocker.

If `THREAT_ID_ISSUES` is non-empty (`[]` means empty), merge these BLOCKER issues into the checker result and enter step 12 before accepting or committing plans. When general verification is skipped, send these issues directly to step 12. Rescan after revision; at the revision limit stop with the collision list rather than force-commit colliding plans. If empty and verification is skipped, continue to step 13 without dispatching a checker. Otherwise follow the normal checker route. Give the fresh JSON to the checker as `<threat_id_issues>`. A scan error blocks planning with its diagnostic. The execute-phase gate remains the backstop.

### Revision stall

When stalled (`issue_count >= prev_issue_count`) and threat-ID issues remain, display `THREAT_ID_ISSUES` and STOP without committing or offering a proceed option. Only when the scan is clear may the following stall options run.

**Stall detection:** If `issue_count >= prev_issue_count`:
  Display: `Revision loop stalled — issue count not decreasing ({issue_count} issues remain after {N} iterations)`

  **If `stall_reentry_count < 2`:**
    Ask user:
      Question: "Issues remain after {N} revision attempts with no progress. Proceed with current output?"
      Options: "Proceed anyway" | "Adjust approach"
    If "Proceed anyway": accept current plans and continue to step 13.
    If "Adjust approach": increment `stall_reentry_count`, open freeform discussion, then re-enter step 8 (full replanning). Note: re-entry resets `iteration_count` and `prev_issue_count` but `stall_reentry_count` persists across re-entries and is capped at 2.

  **If `stall_reentry_count >= 2`:**
    Display: `Stall persists after 2 re-planning attempts. The following issues could not be resolved automatically:`
    List the remaining issues from the checker.
    Suggest: "Consider resolving these issues manually or running `/gsd:debug` to investigate root causes."
    Options: "Proceed anyway" | "Abandon"
    If "Proceed anyway": accept current plans and continue to step 13.
    If "Abandon": stop workflow.
