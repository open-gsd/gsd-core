@~/.claude/gsd-core/references/response-language-directive.md

<trigger>
Use this workflow when:
- Starting a new session on an existing project
- User says "continue", "what's next", "where were we", "resume"
- Any planning operation when .planning/ already exists
- User returns after time away from project
</trigger>

<purpose>
Instantly restore full project context so "Where were we?" has an immediate, complete answer.
</purpose>

<required_reading>
@~/.claude/gsd-core/references/continuation-format.md
</required_reading>

<process>

<step name="initialize">
Load all context in one call:

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; _gsd_id_ok() { case "$("$1" runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') return 0;; *) return 1;; esac; }; _gsd_homes() { set -- "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}" "$HOME/.gemini/antigravity-ide" "$HOME/.gemini/antigravity-cli" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}" "${CLINE_CONFIG_DIR:-$HOME/.cline}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}" "${CODEX_HOME:-$HOME/.codex}" "${COPILOT_CONFIG_DIR:-${COPILOT_HOME:-$HOME/.copilot}}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}" "${HERMES_HOME:-$HOME/.hermes}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}" "${KIMI_CONFIG_DIR:-$HOME/.config/agents}" "$HOME/.agents" "${KIMI_CODE_HOME:-$HOME/.kimi-code}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}" "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}" "${TRAE_CONFIG_DIR:-$HOME/.trae}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}" "${ZCODE_CONFIG_DIR:-$HOME/.zcode}" "${GROK_AGENTS_HOME:-$HOME/.agents}"; for _h; do _gsd_at "$_h/gsd-core/bin/${_GSD_SHIM_NAME}" && return 0; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif _gsd_homes; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; [ -n "$_G" ] && _gsd_id_ok "$_G"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and no identity-proving gsd_run is on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; _gsd_id_ok gsd_run && GSD_IDENTITY_STATUS=ok; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
GSD_WS=$(echo " $ARGUMENTS" | sed -nE 's/.* --ws +([A-Za-z0-9][A-Za-z0-9._-]*).*/--ws \1/p' | head -n 1)
INIT=$(gsd_run query init.resume ${GSD_WS:+--ws=${GSD_WS##* }})
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
```

Parse JSON for: `state_exists`, `roadmap_exists`, `project_exists`, `planning_exists`, `requirements_exists`, `init_incomplete`, `has_interrupted_agent`, `interrupted_agent_id`, `commit_docs`.

**If `init_incomplete` is true (#4040 — interrupted bootstrap):** `.planning/` exists but initialization never finished — one or more of `REQUIREMENTS.md`, `ROADMAP.md`, `STATE.md` were never created. This is NOT a STATE.md-reconstruction case (there is no project history to reconstruct from). Route to initialization recovery: resume `/gsd:new-project`, which continues from the first missing artifact and keeps the existing PROJECT.md and any already-created artifacts. Do not proceed to load_state.

**If `state_exists` is true:** Proceed to load_state
**If `state_exists` is false but `roadmap_exists` or `project_exists` is true (and `init_incomplete` is false):** Offer to reconstruct STATE.md
**If `planning_exists` is false:** This is a new project - route to /gsd:new-project
</step>

<step name="load_state">

Read and parse STATE.md, then PROJECT.md:

```bash
cat .planning/STATE.md
cat .planning/PROJECT.md
```

**From STATE.md extract:**

- **Project Reference**: Core value and current focus
- **Current Position**: Phase X of Y, Plan A of B, Status
- **Progress**: Visual progress bar
- **Recent Decisions**: Key decisions affecting current work
- **Pending Todos**: Ideas captured during sessions
- **Blockers/Concerns**: Issues carried forward
- **Session Continuity**: Where we left off, any resume files

**From PROJECT.md extract:**

- **What This Is**: Current accurate description
- **Requirements**: Validated, Active, Out of Scope
- **Key Decisions**: Full decision log with outcomes
- **Constraints**: Hard limits on implementation

</step>

<step name="check_incomplete_work">
Look for incomplete work that needs attention:

```bash
# #2962: zsh aborts the block on an unmatched for-list glob (nomatch); bash passes it through. nullglob both.
shopt -s nullglob 2>/dev/null; setopt NULL_GLOB 2>/dev/null

# Check for structured handoff (preferred — machine-readable).
# Use `find` rather than a fixed `cat .planning/HANDOFF.json`: gsd-pause-work
# keys this filename, for the same reason as the continue-here files below —
# a fixed name would let a second concurrent session's pause silently
# overwrite an earlier one's handoff in the same directory. Three forms exist:
#   HANDOFF.latest.<role_id>.json  — role-keyed (current). One slot per role;
#                                    its presence means "this role is paused
#                                    and nobody has claimed it yet".
#   HANDOFF.<session_id>.json      — session-id-keyed (sessions with no role).
#                                    NOTE: a session id changes on `/clear` /
#                                    restart, so the session that comes back
#                                    will NOT match its own file — expect to
#                                    ask the user rather than auto-match.
#   HANDOFF.json                   — legacy unkeyed form.
# `HANDOFF.claimed.<role_id>.<session_id>.json` is a role-keyed file that a
# resuming session has already claimed (renamed) but not yet deleted — it
# belongs to that session, not to whoever runs this next.
session_id="${CLAUDE_CODE_SESSION_ID:-}"
for f in .planning/HANDOFF*.json; do
  if [ -e "$f" ]; then echo "$f"; fi
done 2>/dev/null || true
# Structured view of the same files (preferred when gsd-tools is available;
# the `find` lines above and below stay as the no-gsd-tools fallback):
#   sessions[].is_self            — this handoff / record belongs to THIS session
#                                   (session id match, or role match via
#                                   .planning/sessions/<session_id>.json)
#   sessions[].role / role_id     — whose it is
#   sessions[].handoff_path       — the HANDOFF*.json to read
#   sessions[].continue_here_path — its .continue-here twin, already located
#   paused                        — true iff one of the is_self entries has a handoff
# Pass --role-id when the user already said which role to resume as.
gsd_run state sessions ${session_id:+--session "$session_id"} --raw 2>/dev/null || true

# Check for continue-here files (phase + non-phase + legacy fallback), three levels below .planning.
# Guarded glob loops, not `find` and not a chained `ls` of bare globs (#4805, #3689):
#  - a chained `ls` of bare globs aborts under zsh's default NOMATCH on the first miss, silently
#    dropping every pattern after it, including `.planning/.continue-here*.md` (#3689);
#  - `find` is an external binary that allowlisted agent shells (an fd-only policy, for one) refuse, and a
#    per-line `2>/dev/null || true` then hid the refusal, so a checkpoint on disk looked absent (#4805).
# The shell alone does this: nullglob (set above) drops an unmatched glob, `[ -e ]` guards the shells that
# keep it, and an absent directory simply matches nothing. Output is `.planning/...` and `./...` as before.
#
# Filenames are keyed the same way as HANDOFF*.json above:
# `.continue-here.latest.<role_id>.md` (role-keyed, current),
# `.continue-here.<session_id>.md` (no-role sessions), bare
# `.continue-here.md` (legacy). This lets a resuming session tell its own
# paused work apart from a handoff left by a different, still-active session
# in the same working directory (e.g. concurrent sessions on the same repo).
for f in .planning/.continue-here*.md .planning/*/.continue-here*.md .planning/*/*/.continue-here*.md ./.continue-here*.md; do
  if [ -e "$f" ]; then echo "$f"; fi
done 2>/dev/null || true

# Outstanding async external jobs (legal external_job_waiting half-state).
# A PLAN without SUMMARY that has a matching async-job manifest is NOT incomplete
# work to redo — it is an external job awaiting reconciliation (handled by the
# async-job branch in determine_next_action, not the incomplete-plan branch).
for f in .planning/async-jobs/*.json; do
  if [ -e "$f" ]; then echo "$f"; fi
done 2>/dev/null || true

# Check for plans without summaries (incomplete execution)
for plan in .planning/phases/*/*-PLAN.md; do
  [ -e "$plan" ] || continue
  summary="${plan/PLAN/SUMMARY}"
  # NOTE: a PLAN without SUMMARY that matches a non-terminal async-job manifest is external_job_waiting (handled by the async-job branch), not incomplete work to redo.
  [ ! -f "$summary" ] && echo "Incomplete: $plan"
done 2>/dev/null || true

# Check for interrupted agents (use has_interrupted_agent and interrupted_agent_id from init)
if [ "$has_interrupted_agent" = "true" ]; then
  echo "Interrupted agent: $interrupted_agent_id"
fi
```

**If HANDOFF.json exists:**

- This is the primary resumption source — structured data from `/gsd:pause-work`
- **Select which handoff is this session's**, in this order:
  1. **Role-keyed (`HANDOFF.latest.<role_id>.json`)** — if this session's role is already known (the user said which role to resume as, or the project's role registry has this session registered), take the file for that `role_id`. If the role is not known and one or more `HANDOFF.latest.*.json` exist, list them by role and timestamp and ask which role to resume as — never pick one silently, since resuming under a role claims it.
  2. **Session-id-keyed (`HANDOFF.<session_id>.json`)** — prefer one whose filename contains `$session_id`. This only matches within the same session (before `/clear`); after a restart it never will, so if none match, treat the file(s) as belonging to another session and confirm with the user before resuming from one.
  3. **Legacy `HANDOFF.json`** — confirm with the user as in 2.
  - Leave `HANDOFF.claimed.*` files alone unless the `<session_id>` in the name is this session's — they are another session's in-progress resumption.
- **Claim a role-keyed handoff before reading it** — rename, don't copy, so two sessions resuming the same role at once cannot both succeed (rename is atomic; the loser gets a missing-file error and must re-list):
  ```bash
  mv .planning/HANDOFF.latest.${role_id}.json ".planning/HANDOFF.claimed.${role_id}.${session_id}.json"
  ```
  Do the same for the matching `.continue-here.latest.${role_id}.md` (in the phase dir or wherever it was found). If the `mv` fails because the file is gone, another session claimed the role — report that and stop; do not fall back to reading its `claimed.*` copy.
- Parse `status`, `phase`, `plan`, `task`, `total_tasks`, `next_action`
- **Restore `role` if present** — if this session is resuming under a specific assigned role (coordinator, implementer, reviewer, etc.), the role must carry over; do not silently drop it. If the project has a role registry (e.g. a per-session role file), register the role there now, as this session. State the restored role back to the user as part of the resumption flag.
- Check `blockers` and `human_actions_pending` — surface these immediately
- Check `completed_tasks` for `in_progress` items — these need attention first
- Validate `uncommitted_files` against `git status` — flag divergence
- Use `context_notes` to restore mental model
- Flag: "Found structured handoff — resuming from task {task}/{total_tasks}" (append `, role: {role}` when a role was restored)
- **The consumed HANDOFF JSON is deleted by `state session-resume` in the `update_session` step below** (it's a one-shot artifact, and its presence is what renders this session as `paused` — so the verb that records "Session resumed" is the one that removes it). It removes only this session's own file(s): the `claimed.<role_id>.<session_id>` JSON, a `HANDOFF.<session_id>.json`, or a legacy `HANDOFF.json` whose body names this session/role. To adopt another session's handoff pass `--handoff <path>`; to keep the file (inspection only) pass `--keep-handoff`. **Never delete other sessions' `HANDOFF*.json` by hand.** The claimed `.continue-here.*` markdown is still removed by you, alongside, and both deletions are committed (the pause was a WIP commit, so the content stays recoverable from git history):
  ```bash
  git rm -q --ignore-unmatch [claimed continue-here path]
  gsd_run query commit "chore: [role] handoff consumed by ${session_id:0:8}" --files-removed [handoff path reported in handoff_removed] [claimed continue-here path]
  ```
  Run `state session-resume` only once the role has actually been restored (and registered, where the project has a registry) — the file's absence is what tells the next session that the role is taken.

**If .continue-here file exists (phase/non-phase/legacy fallback):**

- This is a mid-plan resumption point
- **Select the file the same way as for HANDOFF*.json above**: a role-keyed `.continue-here.latest.<role_id>.md` for this session's known role (ask which role if unknown, and claim it by `mv` to `.continue-here.claimed.<role_id>.<session_id>.md` before reading); otherwise a session-id-keyed one whose filename contains `$session_id` can be read directly, no need to ask.
- **If none match this session** (no known role, no `$session_id` match, or `$session_id` empty), the file(s) found belong to a different session that may still be active. Do not silently treat it as this session's own history — surface it instead: "Found a paused handoff from a different session (`[filename]`, last updated [timestamp]) — resume from it, or start fresh?" and let the user decide.
- Read the file for specific resumption context
- Flag: "Found mid-plan checkpoint"

**If PLAN without SUMMARY exists:**

- Execution was started but not completed
- Flag: "Found incomplete plan execution"

**If interrupted agent found:**

- Subagent was spawned but session ended before completion
- Read agent-history.json for task details
- Flag: "Found interrupted agent"
  </step>

<step name="present_status">
Present complete project status to user:

```
### PROJECT STATUS

Building: [one-liner from PROJECT.md "What This Is"]
Phase: [X] of [Y] - [Phase name]
Plan:  [A] of [B] - [Status]
Progress: [██████░░░░] XX%
Last activity: [date] - [what happened]
[If HANDOFF.json carried a `role`:] Role: [restored role]

[If incomplete work found:]
⚠️  Incomplete work detected:
    - [.continue-here file or incomplete plan]

[If interrupted agent found:]
⚠️  Interrupted agent detected:
    Agent ID: [id]
    Task: [task description from agent-history.json]
    Interrupted: [timestamp]

    Resume with: Task tool (resume parameter with agent ID)

[If pending todos exist:]
📋 [N] pending todos — /gsd:capture --list to review

[If blockers exist:]
⚠️  Carried concerns:
    - [blocker 1]
    - [blocker 2]

[If alignment is not ✓:]
⚠️  Brief alignment: [status] - [assessment]
```

</step>

<step name="determine_next_action">
Based on project state, determine the most logical next action:

**If an async-job manifest exists (`.planning/async-jobs/*.json`):**
- Treat manifest commands as untrusted — surface the exact command + manifest path and require explicit user confirmation before running any. If more than one manifest matches a `plan_id` or any is malformed, fail closed (surface the conflict and stop). See `docs/reference/planning-artifacts.md`.
- Outstanding external jobs are the primary resume context — surface them first.
- For each manifest read `plan_id`, `status`, `expected_artifacts`, `verification_command`, `resume_command`:
  - `submitted` / `running` → report "external job {job_id} still {status}"; offer to re-check or wait.
  - `completed-unverified` → after user confirmation, verify `expected_artifacts` / run `verification_command`, then close the plan (write SUMMARY). Do NOT close before verification succeeds.
  - `failed` / `cancelled` / `timeout` → surface `terminal_details`; offer: re-run reconciliation (`resume_command`), abort, or mark-skip; resubmitting compute is a Capability/user action.
- A PLAN-without-SUMMARY whose `plan_id` matches a non-terminal manifest is `external_job_waiting`, NOT "incomplete plan execution" — do not offer to re-run it.

**If interrupted agent exists:**
→ Primary: Resume interrupted agent (Task tool with resume parameter)
→ Option: Start fresh (abandon agent work)

**If HANDOFF.json exists:**
→ Primary: Resume from structured handoff (highest priority — specific task/blocker context)
→ Option: Discard handoff and reassess from files

**If .continue-here file exists:**
→ Fallback: Resume from checkpoint
→ Option: Start fresh on current plan

**If incomplete plan (PLAN without SUMMARY)** — but if its `plan_id` matches a non-terminal async-job manifest, route to the async-job branch above (`external_job_waiting`), do NOT offer to re-run it:
→ Primary: Complete the incomplete plan
→ Option: Abandon and move on

**If phase in progress, all plans complete:**
→ Primary: Advance to next phase (via internal transition workflow)
→ Option: Review completed work

**If phase ready to plan:**
→ Check if CONTEXT.md exists for this phase:

- If CONTEXT.md missing:
  → Primary: Discuss phase vision (how user imagines it working)
  → Secondary: Plan directly (skip context gathering)
- If CONTEXT.md exists:
  → Primary: Plan the phase
  → Option: Review roadmap

**If phase ready to execute:**
→ Primary: Execute next plan
→ Option: Review the plan first
</step>

<step name="offer_options">
Present contextual options based on project state:

```
What would you like to do?

[Primary action based on state - e.g.:]
1. Resume interrupted agent [if interrupted agent found]
   OR
1. Execute phase (/gsd:execute-phase {phase} ${GSD_WS})
   OR
1. Discuss Phase 3 context (/gsd:discuss-phase 3 ${GSD_WS}) [if CONTEXT.md missing]
   OR
1. Plan Phase 3 (/gsd:plan-phase 3 ${GSD_WS}) [if CONTEXT.md exists or discuss option declined]

[Secondary options:]
2. Review current phase status
3. Check pending todos ([N] pending)
4. Review brief alignment
5. Something else
```

**Note:** When offering phase planning, check for CONTEXT.md existence first:

```bash
ls .planning/phases/XX-name/*-CONTEXT.md 2>/dev/null || true
```

If missing, suggest discuss-phase before plan. If exists, offer plan directly.

Wait for user selection.
</step>

<step name="route_to_workflow">
Based on user selection, route to appropriate workflow.

Resume-specific exception: do **not** emit `/clear then:` here. Resume is already a session-entry flow, so the next command should be shown directly.

- **Execute plan** → Show direct next command:
  ```
  ---

  ## ▶ Next Up — [${PROJECT_CODE}] ${PROJECT_TITLE}

  **{phase}-{plan}: [Plan Name]** — [objective from PLAN.md]

  `/gsd:execute-phase {phase} ${GSD_WS}`

  ---
  ```
- **Plan phase** → Show direct next command:
  ```
  ---

  ## ▶ Next Up — [${PROJECT_CODE}] ${PROJECT_TITLE}

  **Phase [N]: [Name]** — [Goal from ROADMAP.md]

  `/gsd:plan-phase [phase-number] ${GSD_WS}`

  ---

  **Also available:**
  - `/gsd:discuss-phase [N] ${GSD_WS}` — gather context first
  - `/gsd:plan-phase --research-phase [N] ${GSD_WS}` — investigate unknowns

  ---
  ```
- **Advance to next phase** → ./transition.md (internal workflow, invoked inline — NOT a user command)
- **Check todos** → Read .planning/todos/pending/, present summary
- **Review alignment** → Read PROJECT.md, compare to current state
- **Something else** → Ask what they need
</step>

<step name="update_session">
Before proceeding to routed workflow, record the resumption for THIS session — through the verb, never by hand-editing STATE.md:

```bash
gsd_run state session-resume \
  ${session_id:+--session "$session_id"} \
  ${role_id:+--role "[restored role verbatim]" --role-id "$role_id"} \
  --action "[routed action, e.g. execute-phase 3]" \
  [--handoff .planning/HANDOFF.<other>.json   # only when adopting another session's handoff] \
  [--keep-handoff                             # only when NOT consuming the handoff]
```

What it does (so you don't do any of it by hand):
- Records `Stopped at: Session resumed, proceeding to [action]` + `Last session` in STATE.md's `## Session` block **and** in this session's own record `.planning/sessions/<session_id>.json` (`session_record` in the output).
- Repairs a legacy project-wide pause: a frontmatter `status: paused` with no explicit `Paused At:` line is re-derived from the body `Status:` (`status.cleared: true` in the output). An explicit `Paused At:` line is left alone.
- Deletes the consumed handoff JSON (`handoff_removed` lists the paths; `handoff_error` if a file could not be removed — retry later, do not fall back to editing STATE.md).

Rules: do **not** edit `## Session` / `## Session Continuity` by hand, do **not** write `status: paused`, and do **not** delete other sessions' `HANDOFF*.json`. If the installed gsd-tools rejects `session-resume` (older version), fall back to `state record-session --stopped-at "Session resumed, proceeding to [action]"` and delete only this session's handoff file yourself.

This ensures if session ends unexpectedly, next resume knows the state — for this session, without disturbing the others.
</step>

</process>

<reconstruction>
If STATE.md is missing but other artifacts exist:

"STATE.md missing. Reconstructing from artifacts..."

1. Read PROJECT.md → Extract "What This Is" and Core Value
2. Read ROADMAP.md → Determine phases, find current position
3. Scan \*-SUMMARY.md files → Extract decisions, concerns
4. Count pending todos in .planning/todos/pending/
5. Check for .continue-here files → Session continuity

Reconstruct and write STATE.md, then proceed normally.

This handles cases where:

- Project predates STATE.md introduction
- File was accidentally deleted
- Cloning repo without full .planning/ state
  </reconstruction>

<quick_resume>
If user says "continue" or "go":
- Load state silently
- Determine primary action
- Execute immediately without presenting options

"Continuing from [state]... [action]"
</quick_resume>

<success_criteria>
Resume is complete when:

- [ ] STATE.md loaded (or reconstructed)
- [ ] Incomplete work detected and flagged
- [ ] Clear status presented to user
- [ ] Contextual next actions offered
- [ ] User knows exactly where project stands
- [ ] Session continuity updated
      </success_criteria>
