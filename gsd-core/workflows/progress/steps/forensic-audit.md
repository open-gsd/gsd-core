<step name="forensic_audit">
**Forensic Integrity Audit** — only runs when `--forensic` is present in ARGUMENTS.

If `--forensic` is NOT present in ARGUMENTS: skip this step entirely. Default progress behavior (standard report + routing) is unchanged.

If `--forensic` IS present: after the standard report and routing suggestion have been displayed, append the following audit section.

---

## Forensic Integrity Audit

Running 7 deep checks against project state...

Run each check in order. For each check, emit ✓ (pass) or ⚠ (warning) with concrete evidence when a problem is found.

**Check 1 — STATE vs artifact consistency**

Read STATE.md `status` / `stopped_at` fields (from the STATE snapshot already loaded). Compare against the artifact count from the roadmap analysis. If STATE.md claims the current phase is pending/mid-flight but the artifact count shows it as complete (all PLAN.md files have matching SUMMARY.md files), flag inconsistency. Emit:
- ✓ `STATE.md consistent with artifact count` — if both agree
- ⚠ `STATE.md claims [status] but artifact count shows phase complete` — with the specific values

**Check 2 — Orphaned handoff files**

Check for existence of:
```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; _gsd_id_ok() { case "$("$1" runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') return 0;; *) return 1;; esac; }; _gsd_homes() { set -- "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}" "$HOME/.gemini/antigravity-ide" "$HOME/.gemini/antigravity-cli" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}" "${CLINE_CONFIG_DIR:-$HOME/.cline}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}" "${CODEX_HOME:-$HOME/.codex}" "${COPILOT_CONFIG_DIR:-${COPILOT_HOME:-$HOME/.copilot}}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}" "${HERMES_HOME:-$HOME/.hermes}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}" "${KIMI_CONFIG_DIR:-$HOME/.config/agents}" "$HOME/.agents" "${KIMI_CODE_HOME:-$HOME/.kimi-code}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}" "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}" "${TRAE_CONFIG_DIR:-$HOME/.trae}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}" "${ZCODE_CONFIG_DIR:-$HOME/.zcode}" "${GROK_AGENTS_HOME:-$HOME/.agents}"; for _h; do _gsd_at "$_h/gsd-core/bin/${_GSD_SHIM_NAME}" && return 0; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif _gsd_homes; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; [ -n "$_G" ] && _gsd_id_ok "$_G"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and no identity-proving gsd_run is on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; _gsd_id_ok gsd_run && GSD_IDENTITY_STATUS=ok; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
PLANNING_ROOT=$(gsd_run query planning.inspect ${GSD_WS:+--ws=${GSD_WS##* }} --pick generated_from.planning_root)
: "${PLANNING_ROOT:?}"
ls .planning/HANDOFF*.json "${PLANNING_ROOT}"/phases/*/.continue-here*.md "${PLANNING_ROOT}"/phases/*/*HANDOFF*.md 2>/dev/null || true
```
Also check `.planning/continue-here.md`.

Emit:
- ✓ `No orphaned handoff files` — if none found
- ⚠ `Orphaned handoff files found` — list each file path, add: `→ Work was paused mid-flight. Read the handoff before continuing.`

**Check 3 — Deferred scope drift**

Search phase artifacts (CONTEXT.md, DISCUSSION-LOG.md, BUG-BRIEF.md, VERIFICATION.md, SUMMARY.md, HANDOFF.md files under `{planning_root}/phases/` (`{planning_root}`: the active scope's root, from `planning.inspect`)) for patterns:
```bash
PLANNING_ROOT=$(gsd_run query planning.inspect ${GSD_WS:+--ws=${GSD_WS##* }} --pick generated_from.planning_root)
: "${PLANNING_ROOT:?}"
grep -rl "defer to Phase\|future phase\|out of scope Phase\|deferred to Phase" "${PLANNING_ROOT}/phases/" 2>/dev/null || true
```

For each match, extract the referenced phase number. Cross-reference against ROADMAP.md phase list. If the referenced phase number is NOT in ROADMAP.md, flag as deferred scope not captured.

Emit:
- ✓ `All deferred scope captured in ROADMAP` — if no mismatches
- ⚠ `Deferred scope references phase(s) not in ROADMAP` — list: file, reference text, missing phase number

**Check 4 — Memory-flagged pending work**

Check if `.planning/MEMORY.md` or `.planning/memory/` exists:
```bash
ls .planning/MEMORY.md .planning/memory/*.md 2>/dev/null || true
```

If found, grep for entries containing: `pending`, `status`, `deferred`, `not yet run`, `backfill`, `blocking`.

Emit:
- ✓ `No memory entries flagging pending work` — if none found or no MEMORY.md
- ⚠ `Memory entries flag pending/deferred work` — list the matching lines (max 5, truncated at 80 chars)

**Check 5 — Blocking operational todos**

Check for pending todos:
```bash
ls .planning/todos/pending/*.md 2>/dev/null || true
```

For files found, scan for keywords indicating operational blockers: `script`, `credential`, `API key`, `manual`, `verification`, `setup`, `configure`, `run `.

Emit:
- ✓ `No blocking operational todos` — if no pending todos or none match operational keywords
- ⚠ `Blocking operational todos found` — list the file names and matching keywords (max 5)

**Check 6 — Uncommitted code**

```bash
git status --porcelain 2>/dev/null | grep -v "^??" | grep -v "^.planning\/" | grep -v "^\.\." | head -10
```

If output is non-empty (modified/staged files outside `.planning/`), flag as uncommitted code.

Emit:
- ✓ `Working tree clean` — if no modified files outside `.planning/`
- ⚠ `Uncommitted changes in source files` — list up to 10 file paths

**Check 7 — Unresolved deferred items**

Glob every phase directory's SCOPE BOUNDARY log (executor writes out-of-scope discoveries here per `agents/gsd-executor.md`):
```bash
PLANNING_ROOT=$(gsd_run query planning.inspect ${GSD_WS:+--ws=${GSD_WS##* }} --pick generated_from.planning_root)
: "${PLANNING_ROOT:?}"
ls "${PLANNING_ROOT}"/phases/*/deferred-items.md 2>/dev/null || true
```

For each `deferred-items.md` found, read its entries (bullet list, one entry per top-level list item — `-`, `*`, `+` or an ordered marker of one to nine digits terminated by a DOT, where an ordered list counts when it starts at `0.` or `1.` or continues a list already open at its level; `1)` is not a marker and neither is a ten-digit ordinal (`999999999.` counts, `1234567890.` does not) — with continuation lines indented beneath it; fenced code blocks at ANY indent, including deeper than CommonMark's three-space cap, and `* * *`-style separators are not entries; an unclosed fence ends with its own entry and never hides the entries after it; a closed pair of delimiters is a fence whatever sits between them). An entry is RESOLVED only if it carries an explicit `status: resolved` field on one of its lines — the bare key lower-case only, or the bolded `**Status:**` form in any case; the VALUE is case-insensitive in both; every other entry — including one with no `status:` field at all — is UNRESOLVED and must be surfaced (fail-safe: never silently drop a possibly-open item).

Emit:
- ✓ `No unresolved deferred items` — if no `deferred-items.md` files exist, or every entry in every file is `status: resolved`
- ⚠ `Unresolved deferred items found` — list each file's phase directory and its unresolved entry text (max 5 per file, truncated at 80 chars)

---

After all 7 checks, display the verdict:

**If all 7 checks passed:**
```
### Verdict: CLEAN

The standard progress report is trustworthy — proceed with the routing suggestion above.
```

**If 1 or more checks failed:**
```
### Verdict: N INTEGRITY ISSUE(S) FOUND

The standard progress report may not reflect true project state.
Review the flagged items above before acting on the routing suggestion.
```

Then for each failed check, add a concrete next action:
- Check 2 (orphaned handoff): `Read the handoff file(s) and resume from where work was paused: /gsd:resume-work ${GSD_WS}`
- Check 3 (deferred scope): `Add the missing phases to ROADMAP.md or update the deferred references`
- Check 4 (memory pending): `Review the flagged memory entries and resolve or clear them`
- Check 5 (blocking todos): `Complete the operational steps in .planning/todos/pending/ before continuing`
- Check 6 (uncommitted code): `Commit or stash the uncommitted changes before advancing`
- Check 7 (unresolved deferred items): `Address each deferred item and mark it status: resolved in its deferred-items.md, or fold it into the roadmap`
- Check 1 (STATE inconsistency): `Run /gsd:verify-work ${PHASE} ${GSD_WS} to reconcile state`
</step>
