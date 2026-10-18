@~/.claude/gsd-core/references/response-language-directive.md

<purpose>
Create structured `.planning/HANDOFF.json` and `.continue-here.md` handoff files to preserve complete work state across sessions. The JSON provides machine-readable state for `/gsd:resume-work`; the markdown provides human-readable context. Both filenames are keyed by the session's **role** when it has one (e.g. `HANDOFF.latest.design.json`) — the role is the identity that survives `/clear` and restarts, so the resuming session can find its own handoff and claim it. Sessions without a role fall back to a session-id key (`HANDOFF.<session_id>.json`) so concurrent sessions paused in the same directory still don't overwrite each other.

**Pause is per session, not per project.** Several sessions (coordinator, implementer, reviewer, …) may share one `.planning/`; the others keep working while this one pauses. A session's paused state is represented **solely by the existence of its handoff file** under `.planning/` — the statusline, `/gsd:next` and `/gsd:resume-work` all read it from there. **Never set STATE.md `status:` to `paused` and never add a `Paused At:` line** — that would flip every session's status and there is no GSD path back out of it. The shared `## Session` block still gets a heartbeat (`state record-session`) for backward compatibility, and the same fields are mirrored to this session's own record `.planning/sessions/<session_id>.json`.
</purpose>

<required_reading>
Read all files referenced by the invoking prompt's execution_context before starting.
</required_reading>

<process>

<step name="detect">
## Context Detection

Determine what kind of work is being paused and set the handoff destination accordingly:

```bash
# Key the handoff filename so that (a) concurrent sessions paused in the same
# working directory never overwrite each other, and (b) the session that later
# resumes can tell which handoff is its own.
#
# Preferred key: the session's ROLE (role_id — see the gather step). A session id
# is NOT a usable key for (b): `/clear` and restarts issue a new
# CLAUDE_CODE_SESSION_ID, so a session-id-keyed file is never matched by the
# session that comes back, never gets deleted, and piles up (18+ stale files
# were observed in one repo). The role survives that boundary. The role-keyed
# file is a single "latest" slot per role — a new pause of the same role
# overwrites it — and its presence means "this role is paused and unclaimed";
# resume-work claims it (rename) and deletes it once the role is restored.
#
# Fallback key: session id, for sessions with no role (older behaviour). Legacy
# unkeyed names are used only when the env var is unset (older client).
session_id="${CLAUDE_CODE_SESSION_ID:-}"
role_id=""   # set in the gather step; leave empty when this session has no role
if [ -n "$role_id" ]; then
  continue_here_name=".continue-here.latest.${role_id}.md"
  handoff_json_name="HANDOFF.latest.${role_id}.json"
elif [ -n "$session_id" ]; then
  continue_here_name=".continue-here.${session_id}.md"
  handoff_json_name="HANDOFF.${session_id}.json"
else
  continue_here_name=".continue-here.md"
  handoff_json_name="HANDOFF.json"
fi

# Check for active phase
phase=$(ls -t .planning/phases/*/*-PLAN.md 2>/dev/null | head -1 || true)
phase=${phase:+$(basename "$(dirname "$phase")")}

# Check for active spike
spike=$(ls -t .planning/spikes/*/SPIKE.md .planning/spikes/*/DESIGN.md .planning/spikes/*/README.md 2>/dev/null | head -1 || true)
spike=${spike:+$(basename "$(dirname "$spike")")}

# Check for active sketch
sketch=$(ls -t .planning/sketches/*/README.md .planning/sketches/*/index.html 2>/dev/null | head -1 || true)
sketch=${sketch:+$(basename "$(dirname "$sketch")")}

# Check for active deliberation
deliberation=$(ls .planning/deliberations/*.md 2>/dev/null | head -1 || true)
```

- **Phase work**: active phase directory → handoff to `.planning/phases/XX-name/${continue_here_name}`
- **Spike work**: active spike directory or spike-related files (no active phase) → handoff to `.planning/spikes/SPIKE-NNN/${continue_here_name}` (create directory if needed)
- **Sketch work**: active sketch directory (no active phase/spike) → handoff to `.planning/sketches/${continue_here_name}`
- **Deliberation work**: active deliberation file (no phase/spike/sketch) → handoff to `.planning/deliberations/${continue_here_name}`
- **Research work**: research notes exist but no phase/spike/sketch/deliberation → handoff to `.planning/${continue_here_name}`
- **Default**: no detectable context → handoff to `.planning/${continue_here_name}`, note the ambiguity in `<current_state>`

If phase is detected, proceed with phase handoff path. Otherwise use the first matching non-phase path above.
</step>

<step name="gather">
**Collect complete state for handoff:**

1. **Current position**: Which phase, which plan, which task
2. **Session role** (if this session was operating under an assigned role — e.g. a named role in a multi-session/multi-role workflow such as "coordinator", "implementer", "reviewer"): capture it verbatim as `role` so resume restores the same role instead of dropping it. Prefer the project's own role registry as the source of truth when it has one (e.g. a per-session role file) over recalling the role from conversation — the two must not disagree.
   - Also derive **`role_id`**: a short filesystem-safe slug of the role (`[a-z0-9-]+`, ASCII only — no spaces, no non-ASCII, since it becomes part of a filename). If the project defines its roles in files (e.g. `docs/roles/<slug>.md`), use that slug verbatim; otherwise lowercase the role's English name and join words with `-` (`code reviewer` → `code-reviewer`). Set `role_id` in the detect step's shell before computing the filenames. Leave it empty when the session has no role.
3. **Work completed**: What got done this session
4. **Work remaining**: What's left in current plan/phase
5. **Decisions made**: Key decisions and rationale
6. **Blockers/issues**: Anything stuck
7. **Human actions pending**: Things that need manual intervention (MCP setup, API keys, approvals, manual testing)
8. **Background processes**: Any running servers/watchers that were part of the workflow
9. **Files modified**: What's changed but not committed
10. **Outstanding async external jobs**: any `.planning/async-jobs/*.json` manifests for non-terminal jobs — record job id, backend, status, expected artifacts, verification + resume commands, and any watcher/daemon state. Do NOT cancel the external job; it keeps running across the pause.
11. **Blocking constraints**: Anti-patterns or methodological failures encountered during this session that a resuming agent MUST be aware of before proceeding. Only include items discovered through actual failure — not warnings or predictions. Assign each constraint a `severity`:
   - `blocking` — The resuming agent MUST demonstrate understanding before proceeding. The discuss-phase and execute-phase workflows will enforce a mandatory understanding check.
   - `advisory` — Important context but does not gate resumption.

Ask user for clarifications if needed via conversational questions.

**Also inspect SUMMARY.md files for false completions:**
```bash
# Check for placeholder content in existing summaries
grep -l "To be filled\|placeholder\|TBD" .planning/phases/*/*.md 2>/dev/null || true
```
Report any summaries with placeholder content as incomplete items.
</step>

<step name="write_structured">
**Write structured handoff to `.planning/${handoff_json_name}`** (role-keyed, e.g. `.planning/HANDOFF.latest.design.json`, overwriting any previous pause of the same role; session-id-keyed `.planning/HANDOFF.<session_id>.json` when the session has no role; `.planning/HANDOFF.json` only if `$CLAUDE_CODE_SESSION_ID` is also unset):

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; _gsd_id_ok() { case "$("$1" runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') return 0;; *) return 1;; esac; }; _gsd_homes() { set -- "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}" "$HOME/.gemini/antigravity-ide" "$HOME/.gemini/antigravity-cli" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}" "${CLINE_CONFIG_DIR:-$HOME/.cline}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}" "${CODEX_HOME:-$HOME/.codex}" "${COPILOT_CONFIG_DIR:-${COPILOT_HOME:-$HOME/.copilot}}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}" "${HERMES_HOME:-$HOME/.hermes}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}" "${KIMI_CONFIG_DIR:-$HOME/.config/agents}" "$HOME/.agents" "${KIMI_CODE_HOME:-$HOME/.kimi-code}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}" "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}" "${TRAE_CONFIG_DIR:-$HOME/.trae}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}" "${ZCODE_CONFIG_DIR:-$HOME/.zcode}" "${GROK_AGENTS_HOME:-$HOME/.agents}"; for _h; do _gsd_at "$_h/gsd-core/bin/${_GSD_SHIM_NAME}" && return 0; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif _gsd_homes; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; [ -n "$_G" ] && _gsd_id_ok "$_G"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and no identity-proving gsd_run is on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; _gsd_id_ok gsd_run && GSD_IDENTITY_STATUS=ok; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
timestamp=$(gsd_run query current-timestamp full --raw)
```

```json
{
  "version": "1.0",
  "timestamp": "{timestamp}",
  "session_id": "{value of $CLAUDE_CODE_SESSION_ID, or \"unknown\" if unset}",
  "role": "{this session's assigned role, verbatim, e.g. \"coordinator\", \"implementer\" — omit or null if this session has no assigned role}",
  "role_id": "{slug used in the filename, e.g. \"coordinator\", \"hardware-operator\" — omit or null when role is absent}",
  "phase": "{phase_number}",
  "phase_name": "{phase_name}",
  "phase_dir": "{phase_dir}",
  "plan": {current_plan_number},
  "task": {current_task_number},
  "total_tasks": {total_task_count},
  "status": "paused",
  "completed_tasks": [
    {"id": 1, "name": "{task_name}", "status": "done", "commit": "{short_hash}"},
    {"id": 2, "name": "{task_name}", "status": "done", "commit": "{short_hash}"},
    {"id": 3, "name": "{task_name}", "status": "in_progress", "progress": "{what_done}"}
  ],
  "remaining_tasks": [
    {"id": 4, "name": "{task_name}", "status": "not_started"},
    {"id": 5, "name": "{task_name}", "status": "not_started"}
  ],
  "blockers": [
    {"description": "{blocker}", "type": "technical|human_action|external", "workaround": "{if any}"}
  ],
  "async_jobs": [
    {"manifest": ".planning/async-jobs/{job}.json", "job_id": "{id}", "backend": "{backend}", "status": "running", "submit_command": "{cmd}", "submitted_at": "{iso8601}", "expected_artifacts": ["..."], "verification_command": "{cmd}", "resume_command": "{cmd}"}
  ],
  "human_actions_pending": [
    {"action": "{what needs to be done}", "context": "{why}", "blocking": true}
  ],
  "decisions": [
    {"decision": "{what}", "rationale": "{why}", "phase": "{phase_number}"}
  ],
  "uncommitted_files": ["XY path", "..."],  # #3968: MEASURED — see below
  "next_action": "{specific first action when resuming}",
  "context_notes": "{mental state, approach, what you were thinking}"
}
```

Any recorded `async_jobs` entries are the primary resume context on the next session — check them first before treating a PLAN-without-SUMMARY as incomplete work.

**`uncommitted_files` is measured, never asserted (#3968).** Populate it from an actual call,
not from memory — a narrated `[]` over a dirty tree is how 14 plans' worth of uncommitted
code went invisible in the wild:
```bash
UNCOMMITTED=$(git status --porcelain)
# One array entry per line ("XY path"); truncate the list at 50 entries and note the
# elided count, but NEVER round it to empty — a non-empty porcelain output is the single
# most load-bearing fact a resume session needs.
```
</step>

<step name="write">
**Write handoff to `${continue_here_name}` at the path determined in the detect step** (e.g. `.planning/phases/XX-name/${continue_here_name}`, `.planning/spikes/SPIKE-NNN/${continue_here_name}`, or `.planning/${continue_here_name}`):

```markdown
---
context: [phase|spike|sketch|deliberation|research|default]
phase: XX-name
task: 3
total_tasks: 7
status: in_progress
last_updated: [timestamp from current-timestamp]
session_id: [value of $CLAUDE_CODE_SESSION_ID, or "unknown" if unset]
role: [assigned role verbatim — omit the line if none]
role_id: [slug used in the filename — omit the line if none]
---

# BLOCKING CONSTRAINTS — Read Before Anything Else

> These are not suggestions. Each constraint below was discovered through failure.
> Acknowledge each one explicitly before proceeding.

- [ ] CONSTRAINT: [name] — [what it is] — [structural mitigation required]

**Do not proceed until all boxes are checked.**

_If no constraints have been identified yet, remove this section._

## Critical Anti-Patterns

| Pattern | Description | Severity | Prevention Mechanism |
|---------|-------------|----------|---------------------|
| [pattern name] | [what it is and how it manifested] | blocking | [structural step that prevents recurrence — not acknowledgment] |
| [pattern name] | [what it is and how it manifested] | advisory | [guidance for avoiding it] |

**Severity values:** `blocking` — resuming agent must pass understanding check before proceeding. `advisory` — important context, does not gate resumption.

_Remove rows that do not apply. The discuss-phase and execute-phase workflows parse this table and enforce a mandatory understanding check for any `blocking` rows._

<current_state>
[Where exactly are we? Immediate context]
</current_state>

<completed_work>

Completed Tasks:
- Task 1: [name] - Done
- Task 2: [name] - Done
- Task 3: [name] - In progress, [what's done]
</completed_work>

<remaining_work>

- Task 3: [what's left]
- Task 4: Not started
- Task 5: Not started
</remaining_work>

<decisions_made>

- Decided to use [X] because [reason]
- Chose [approach] over [alternative] because [reason]
</decisions_made>

<blockers>
- [Blocker 1]: [status/workaround]
</blockers>

## Required Reading (in order)
<!-- List documents the resuming agent must read before acting -->
1. [document] — [why it matters]
1. `.planning/METHODOLOGY.md` (if it exists) — project analytical lenses; apply before any assumption analysis

## Critical Anti-Patterns (do NOT repeat these)
<!-- Mistakes discovered this session that must be structurally avoided -->
- [ANTI-PATTERN]: [what it is] → [structural mitigation]

## Infrastructure State
<!-- Running services, external state, environment specifics -->
- [service/env]: [current state]

## Pre-Execution Critique Required
<!-- Fill in ONLY if pausing between design and execution (e.g. spike design done, not yet run) -->
- Design artifact: [path]
- Critique focus: [key questions the critic should probe]
- Gate: Do NOT begin execution until critique is complete and design is revised

<context>
[Mental state, what were you thinking, the plan]
</context>

<next_action>
Start with: [specific first action when resuming]
</next_action>
```

Be specific enough for a fresh Claude to understand immediately.

Use `current-timestamp` for last_updated field. You can use init todos (which provides timestamps) or call directly:
```bash
timestamp=$(gsd_run query current-timestamp full --raw)
```
</step>

<step name="record_session">
**Record the pause as this session's continuity heartbeat** — through the verb, never by hand-editing STATE.md:

```bash
# --session keys the per-session record (.planning/sessions/<session_id>.json);
# --role / --role-id carry this session's role so resume-work and the statusline
# can match the role-keyed handoff back to it. Omit the role flags when the
# session has no role. The STATE.md `## Session` block is updated as before.
gsd_run state record-session \
  --stopped-at "Paused: [context] [XX-name] task [X]/[Y] — [one-line what was in flight]" \
  --resume-file "[handoff-path with ${continue_here_name}]" \
  ${session_id:+--session "$session_id"} \
  ${role_id:+--role "[role verbatim]" --role-id "$role_id"}
```

Rules:
- **Never set STATE.md `status:` to `paused` or add a `Paused At:` line.** Pause is per-session — represented solely by `.planning/${handoff_json_name}`. Other sessions share this `.planning/` and keep working; a project-wide `paused` would be wrong for them and nothing clears it.
- Do not edit `## Session` / `## Session Continuity` by hand; `state record-session` owns that block.
- If `state record-session` rejects `--session` (older installed gsd-tools), rerun it without the session/role flags — the handoff files alone still carry the pause.
</step>

<step name="commit">
```bash
gsd_run query commit "wip: [context-name] paused at [X]/[Y]" --files [handoff-path with ${continue_here_name}] .planning/${handoff_json_name} ${session_id:+.planning/sessions/${session_id}.json}
```
(`.planning/sessions/<session_id>.json` is included only when `state record-session` reported a `session_record`.)
</step>

<step name="confirm">
```
✓ Handoff created:
  - .planning/${handoff_json_name} (structured, machine-readable, keyed to this session's role — or session id if no role)
  - [handoff-path with ${continue_here_name}] (human-readable, same key)
  - .planning/sessions/${session_id}.json (this session's continuity record; STATE.md status left untouched — pause is per-session)

Current state:

- Context: [phase|spike|deliberation|research]
- Location: [XX-name or SPIKE-NNN]
- Task: [X] of [Y]
- Status: [in_progress/blocked]
- Blockers: [count] ({human_actions_pending count} need human action)
- Committed as WIP

To resume: /gsd:resume-work

```
</step>

</process>

<success_criteria>
- [ ] Context detected (phase/spike/deliberation/research/default)
- [ ] `role_id` derived (ASCII slug) when the session has a role, and the filenames keyed by it (`.continue-here.latest.<role_id>.md` / `HANDOFF.latest.<role_id>.json`); session-id key only when there is no role
- [ ] `${continue_here_name}` created at correct path for detected context
- [ ] `${handoff_json_name}` written to `.planning/`, including `session_id`, `role` and `role_id` (if applicable)
- [ ] `state record-session` run with `--session` (and `--role`/`--role-id` when applicable); STATE.md `status:` NOT set to `paused`, no `Paused At:` line added
- [ ] Required Reading, Anti-Patterns, and Infrastructure State sections filled
- [ ] Pre-Execution Critique section filled if pausing between design and execution
- [ ] Committed as WIP
- [ ] User knows location and how to resume
</success_criteria>
