<purpose>
List all pending todos, allow selection, load full context for the selected todo, and route to appropriate action.
</purpose>

<required_reading>
Read all files referenced by the invoking prompt's execution_context before starting.
</required_reading>

<process>

<step name="init_context">
Load todo context:

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/get-shit-done/bin/${_GSD_SHIM_NAME}"; if [ -f "$GSD_TOOLS" ]; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${_GSD_RUNTIME_ROOT}/.claude/get-shit-done/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${_GSD_RUNTIME_ROOT}/.claude/get-shit-done/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif command -v gsd-tools >/dev/null 2>&1; then GSD_TOOLS="$(command -v gsd-tools)"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif [ -f "$HOME/.claude/get-shit-done/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="$HOME/.claude/get-shit-done/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd-tools is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi
INIT=$(gsd_run query init.todos)
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
```

Extract from init JSON: `todo_count`, `todos`, `pending_dir`.

If `todo_count` is 0:
```
No pending todos.

Todos are captured during work sessions with /gsd-add-todo.

---

Would you like to:

1. Continue with current phase (/gsd:progress)
2. Add a todo now (/gsd-add-todo)
```

Exit.
</step>

<step name="parse_filter">
Check for area filter in arguments:
- `/gsd:capture --list` → show all
- `/gsd:capture --list api` → filter to area:api only
</step>

<step name="list_todos">
Use the `todos` array from init context (already filtered by area if specified).

Parse and display as numbered list:

```
Pending Todos:

1. Add auth token refresh (api, 2d ago)
2. Fix modal z-index issue (ui, 1d ago)
3. Refactor database connection pool (database, 5h ago)

---

Reply with a number to view details, or:
- `/gsd:capture --list [area]` to filter by area
- `q` to exit
```

Format age as relative time from created timestamp.
</step>

<step name="handle_selection">
Wait for user to reply with a number.

If valid: load selected todo, proceed.
If invalid: "Invalid selection. Reply with a number (1-[N]) or `q` to exit."
</step>

<step name="load_context">
Read the todo file completely. Display:

```
## [title]

**Area:** [area]
**Created:** [date] ([relative time] ago)
**Files:** [list or "None"]

### Problem
[problem section content]

### Solution
[solution section content]
```

If `files` field has entries, read and briefly summarize each.
</step>

<step name="check_roadmap">
Check for roadmap (can use init progress or directly check file existence):

If `.planning/ROADMAP.md` exists:
1. Check if todo's area matches an upcoming phase
2. Check if todo's files overlap with a phase's scope
3. Note any match for action options
</step>

<step name="offer_actions">
**If todo maps to a roadmap phase:**


**Text mode (`workflow.text_mode: true` in config or `--text` flag):** Set `TEXT_MODE=true` if `--text` is present in `$ARGUMENTS` OR `text_mode` from init JSON is `true`. When TEXT_MODE is active, replace every `AskUserQuestion` call with a plain-text numbered list and ask the user to type their choice number. This is required for non-Claude runtimes (OpenAI Codex, Gemini CLI, etc.) where `AskUserQuestion` is not available.
Use AskUserQuestion:
- header: "Action"
- question: "This todo relates to Phase [N]: [name]. What would you like to do?"
- options:
  - "Work on it now" — move to done, start working
  - "Add to phase plan" — include when planning Phase [N]
  - "Brainstorm approach" — think through before deciding
  - "Put it back" — return to list

**If no roadmap match:**

Use AskUserQuestion:
- header: "Action"
- question: "What would you like to do with this todo?"
- options:
  - "Work on it now" — move to done, start working
  - "Create a phase" — /gsd-add-phase with this scope
  - "Brainstorm approach" — think through before deciding
  - "Put it back" — return to list
</step>

<step name="execute_action">
**Work on it now:**
```bash
mv ".planning/todos/pending/[filename]" ".planning/todos/completed/"
```
Update STATE.md todo count. Present problem/solution context. Begin work or ask how to proceed.

**Add to phase plan:**
Note todo reference in phase planning notes. Keep in pending. Return to list or exit.

**Create a phase:**
Display: `/gsd-add-phase [description from todo]`
Keep in pending. User runs command in fresh context.

**Brainstorm approach:**
Keep in pending. Start discussion about problem and approaches.

**Put it back:**
Return to list_todos step.
</step>

<step name="update_state">
After any action that changes todo count:

Re-run `init todos` to get updated count, then update STATE.md "### Pending Todos" section if exists.
</step>

<step name="git_commit">
If todo was moved to done/, commit the change:

```bash
git rm --cached .planning/todos/pending/[filename] 2>/dev/null || true
gsd_run query commit "docs: start work on todo - [title]" --files .planning/todos/completed/[filename] .planning/STATE.md
```

Tool respects `commit_docs` config and gitignore automatically.

Confirm: "Committed: docs: start work on todo - [title]"
</step>

</process>

<success_criteria>
- [ ] All pending todos listed with title, area, age
- [ ] Area filter applied if specified
- [ ] Selected todo's full context loaded
- [ ] Roadmap context checked for phase match
- [ ] Appropriate actions offered
- [ ] Selected action executed
- [ ] STATE.md updated if todo count changed
- [ ] Changes committed to git (if todo moved to done/)
</success_criteria>
