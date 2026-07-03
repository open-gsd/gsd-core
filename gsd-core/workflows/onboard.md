<purpose>
Guide existing-codebase onboarding by sequencing the already-owned GSD primitives:
`/gsd:map-codebase`, `/gsd:ingest-docs`, and `/gsd:new-project`. The workflow is
idempotent: it confirms existing artifacts, refuses to overwrite planning data silently,
and stops with the exact next top-level command whenever a nested interactive workflow
would be unsafe.
</purpose>

<required_reading>
Read all files referenced by the invoking prompt's execution_context before starting.
</required_reading>

<process>

## 1. Initialize

Display banner:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 GSD ► ONBOARDING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Parse `$ARGUMENTS`:
- `--fast` sets `MAP_COMMAND` to `/gsd:map-codebase --fast`; otherwise `/gsd:map-codebase`.
- `--text` sets `TEXT_MODE=true`.

Run the init projection:

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; if [ -f "$GSD_TOOLS" ]; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif command -v gsd-tools >/dev/null 2>&1; then GSD_TOOLS="$(command -v gsd-tools)"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif [ -f "$HOME/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="$HOME/.claude/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd-tools is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
INIT=$(gsd_run init onboard)
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
```

Parse JSON fields: `planning_exists`, `project_exists`, `requirements_exists`,
`roadmap_exists`, `state_exists`, `has_existing_code`, `has_package_file`,
`is_brownfield`, `has_codebase_map`,
`codebase_map_files_present`, `missing_codebase_map_files`, `has_docs_candidates`,
`doc_candidate_count`, `onboarding_summary_exists`, `text_mode`, `commit_docs`, `agents_installed`,
`missing_agents`, `has_git`, `git_worktree_root`, `in_nested_subdir`.

Set `TEXT_MODE=true` if `--text` is present OR `text_mode` from INIT is true.

## 2. Git and Existing Planning Safety

If `has_git` is true and `in_nested_subdir` is true, warn that onboarding artifacts will
belong to the outer worktree at `git_worktree_root`. Do not run `git init` here.

If `planning_exists` is true, do not overwrite PROJECT/ROADMAP/STATE. Onboarding is
idempotent and must only confirm or summarize existing files unless the user explicitly
runs the lower-level refresh commands.

## 3. Codebase Mapping Gate

If `is_brownfield` is true and `has_codebase_map` is false:

- If `TEXT_MODE=true`, print:

```text
Existing code was detected, but the complete .planning/codebase/ map is missing.
Missing map files: {missing_codebase_map_files}

1. Map codebase first — run {MAP_COMMAND} to understand the repo before project setup (Recommended)
2. Skip mapping — continue with weaker onboarding context

Enter number:
```

Stop and wait for the user's reply.

- Otherwise use AskUserQuestion:
  - header: "Codebase"
  - question: "Existing code was detected, but the complete .planning/codebase/ map is missing. Map it first?"
  - options:
    - "Map codebase first" — Run `{MAP_COMMAND}` to understand the repo before project setup (Recommended)
    - "Skip mapping" — Continue with weaker onboarding context

If the user chooses mapping, do not nest the interactive map-codebase workflow. Print:

```text
Run this top-level command first, then rerun /gsd:onboard:

{MAP_COMMAND}
```

Exit.

If the user skips mapping, continue with a warning.

If `is_brownfield` is false and `planning_exists` is false, print:

```text
No existing code was detected. For a greenfield project, run:

/gsd:new-project
```

Exit.

## 4. Existing Docs Gate

If `has_docs_candidates` is true and `project_exists` is false:

- If `TEXT_MODE=true`, print:

```text
Detected {doc_candidate_count} possible ADR/PRD/SPEC/RFC document(s).

1. Ingest docs first — run /gsd:ingest-docs to bootstrap planning from existing docs (Recommended)
2. Skip docs ingest — continue to /gsd:new-project

Enter number:
```

Stop and wait for the user's reply.

- Otherwise use AskUserQuestion:
  - header: "Docs"
  - question: "Detected {doc_candidate_count} possible ADR/PRD/SPEC/RFC document(s). Ingest them first?"
  - options:
    - "Ingest docs first" — Run `/gsd:ingest-docs` to bootstrap planning from existing docs (Recommended)
    - "Skip docs ingest" — Continue to `/gsd:new-project`

If the user chooses ingest, do not nest the interactive ingest-docs workflow. Print:

```text
Run this top-level command first, then rerun /gsd:onboard:

/gsd:ingest-docs
```

Exit.

## 5. Project Initialization Gate

If `project_exists` is false:

Print:

```text
Codebase context is ready for project initialization.

Run this top-level command, then rerun /gsd:onboard:

/gsd:new-project
```

Exit.

If `project_exists` is true and either `requirements_exists`, `roadmap_exists`, or
`state_exists` is false, print:

```text
Existing PROJECT.md was found, but planning is incomplete.

Planning file status:
- REQUIREMENTS.md: {requirements_exists ? "present" : "missing"}
- ROADMAP.md: {roadmap_exists ? "present" : "missing"}
- STATE.md: {state_exists ? "present" : "missing"}

Run one of these top-level commands, then rerun /gsd:onboard:

/gsd:ingest-docs --mode merge
/gsd:new-project
```

Exit. Do not write `.planning/onboarding/SUMMARY.md` and do not print the onboarding
complete status for partial planning.

If `project_exists`, `requirements_exists`, `roadmap_exists`, and `state_exists` are all
true, continue.

## 6. Write Onboarding Summary

Create `.planning/onboarding/SUMMARY.md` only after PROJECT.md exists. If it already
exists, update it only after confirmation; do not overwrite silently.

Summary contents:

```markdown
# Onboarding Summary

**Generated:** {YYYY-MM-DD}
**Status:** Ready for GSD workflow

## Artifact Status

- Project: .planning/PROJECT.md
- Requirements: .planning/REQUIREMENTS.md
- Roadmap: .planning/ROADMAP.md
- State: .planning/STATE.md
- Codebase map: {has_codebase_map ? ".planning/codebase/ (complete)" : ".planning/codebase/ (incomplete or skipped)"}

## Codebase Map

{if has_codebase_map}
Confirmed files:
- STACK.md
- ARCHITECTURE.md
- STRUCTURE.md
- CONVENTIONS.md
- TESTING.md
- INTEGRATIONS.md
- CONCERNS.md
{else}
Present files: {codebase_map_files_present}
Missing files: {missing_codebase_map_files}
Context strength: weaker because codebase mapping was skipped or is incomplete.
{endif}

## Existing Docs

Detected planning docs: {doc_candidate_count}

## Recommended Next Step

/gsd:discuss-phase 1
```

Commit the summary if `commit_docs` is true:

```bash
gsd_run query commit "docs: create onboarding summary" --files .planning/onboarding/SUMMARY.md
```

## 7. Final Status

Print:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 GSD ► ONBOARDING COMPLETE ✓
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Created / confirmed / status:
- .planning/codebase/ {has_codebase_map ? "(complete)" : "(incomplete or skipped; missing: {missing_codebase_map_files})"}
- .planning/PROJECT.md
- .planning/REQUIREMENTS.md {requirements_exists ? "(present)" : "(missing; onboarding incomplete)"}
- .planning/ROADMAP.md
- .planning/STATE.md
- .planning/onboarding/SUMMARY.md

───────────────────────────────────────────────────────────────

## ▶ Next Up

**Discuss Phase 1** — capture implementation decisions before planning.

`/gsd:discuss-phase 1`

───────────────────────────────────────────────────────────────

**Also available:**
- `/gsd:map-codebase` — refresh the codebase map after significant changes
- `/gsd:ingest-docs --mode merge` — merge new ADR/PRD/SPEC docs into planning
- `/gsd:progress` — inspect current workflow state

───────────────────────────────────────────────────────────────
```

</process>

<success_criteria>
- [ ] Existing codebase detected before project initialization
- [ ] Missing codebase map routes to `/gsd:map-codebase` or `/gsd:map-codebase --fast`
- [ ] Existing planning docs route to `/gsd:ingest-docs`
- [ ] Missing project setup routes to `/gsd:new-project`
- [ ] Existing `.planning/` files are not overwritten silently
- [ ] Text mode stops and waits at numbered-list gates
- [ ] `.planning/onboarding/SUMMARY.md` is created only after PROJECT.md exists
- [ ] User sees next command
</success_criteria>
