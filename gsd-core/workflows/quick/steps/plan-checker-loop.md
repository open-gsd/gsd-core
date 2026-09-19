**Step 5.5: Plan-checker loop (only when `$VALIDATE_MODE`)**

Skip this step entirely if NOT `$VALIDATE_MODE`.

Display banner:
```
### GSD ► CHECKING PLAN

◆ Spawning plan checker... (runs in a subagent — no output until it returns, ~1–5 min; expected, not a freeze)
```

**Verify-command path probe (#2401, #4767).** Before spawning, run the deterministic probe over
the quick plan's `<automated>` commands and hand its JSON to the checker, exactly as
`plan-phase.md` does. Quick plans live under `${QUICK_DIR}`, not `.planning/phases/`, so the
probe takes the directory directly. It never executes command text and never prescribes a
replacement path.

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif _gsd_at "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" "${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}" "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd_run is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; case "$(gsd_run runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') GSD_IDENTITY_STATUS=ok;; esac; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
VERIFY_PATHS=$(gsd_run check verify-command-paths --dir "${QUICK_DIR}" --raw)
```

Checker prompt:

```markdown
<verification_context>
**Mode:** quick-full
**Task Description:** ${DESCRIPTION}

<required_reading>
- ${QUICK_DIR}/${quick_id}-PLAN.md (Plan to verify)
</required_reading>

${AGENT_SKILLS_CHECKER}

<verify_command_path_probe>
**Deterministic verify-command path probe (#2401)** — already run; do NOT re-derive these
verdicts by reading the filesystem yourself. Act on `severity` per the "Verify Command Path
Resolvability" dimension: `blocker` → BLOCKER, `warning` → WARNING, `none` → silent.
`status: pending_creation` is not a finding. A non-empty `readError` means the probe could not
look — a WARNING, not a pass. Report the failing target verbatim; never prescribe a
replacement path.

```json
{VERIFY_PATHS}
```
</verify_command_path_probe>

**Scope:** This is a quick task, not a full phase. Skip checks that require a ROADMAP phase goal.
</verification_context>

<check_dimensions>
- Requirement coverage: Does the plan address the task description?
- Task completeness: Do tasks have files, action, verify, done fields?
- Key links: Are referenced files real?
- Verify-command path resolvability: act on the `<verify_command_path_probe>` verdicts above (#2401, #4767)
- Scope sanity: Is this appropriately sized for a quick task (1-3 tasks)?
- must_haves derivation: Are must_haves traceable to the task description?

Skip: cross-plan deps (single plan), ROADMAP alignment
${DISCUSS_MODE ? '- Context compliance: Does the plan honor locked decisions from CONTEXT.md?' : '- Skip: context compliance (no CONTEXT.md)'}
</check_dimensions>

<expected_output>
- ## VERIFICATION PASSED — all checks pass
- ## ISSUES FOUND — structured issue list
</expected_output>
```

```
Agent(
  prompt=checker_prompt,
  subagent_type="gsd-plan-checker",
  model="{checker_model}",
  description="Check quick plan: ${DESCRIPTION}"
)
```

> **ORCHESTRATOR RULE — CODEX RUNTIME**: After calling Agent() above, stop working on this task immediately. Do not read more files, edit code, or run tests related to this task while the subagent is active. Wait for the subagent to return its result. This prevents duplicate work, conflicting edits, and wasted context. Only resume when the subagent result is available.

**Handle checker return:**

- **`## VERIFICATION PASSED`:** Display confirmation, proceed to step 6.
- **`## ISSUES FOUND`:** Count BLOCKER + WARNING entries in the YAML issues block; an entry whose severity is missing or unrecognized counts as a BLOCKER (fail closed). If zero — every entry is explicitly INFO — display `ℹ advisory — {dimension}: {description}` per entry and proceed to step 6; INFO is advisory and never enters the loop (#3724). Otherwise display issues, check iteration count, enter revision loop.

**Revision loop (max 2 iterations):**

Track `iteration_count` (starts at 1 after initial plan + check).

**If iteration_count < 2:**

Display: `Sending back to planner for revision... (iteration ${N}/2)`

Revision prompt:

Reuse the `PLAN_PRE_HOOKS_JSON` snapshot captured by Quick Step 5; do not render hooks again.

```markdown
<revision_context>
**Mode:** quick-full (revision)

<required_reading>
- ${QUICK_DIR}/${quick_id}-PLAN.md (Existing plan)
</required_reading>

${AGENT_SKILLS_PLANNER}

{For each active entry in `PLAN_PRE_HOOKS_JSON` where `kind == "contribution"` and `into == "planner"` (in array order): inject the entry's `fragment.inline` verbatim here, plus its resolved `configValues` when the entry carries them. If no active planner contributions exist, omit this block entirely.}

**Checker issues:** ${structured_issues_from_checker}

</revision_context>

<instructions>
Make targeted updates to address checker issues.

`required_property` + evidence + severity BIND. `fix_hint` is ONE non-binding example route: a
smaller or different mechanism reaching the same property addresses the issue in full — say which
you used. Re-check ${DISCUSS_MODE ? 'locked decisions in ' + quick_id + '-CONTEXT.md, ' : ''}capability guidance (CLAUDE.md, project skills) and the
constraints these plans already encode BEFORE editing; if a hint would contradict one, or the
property is unreachable without breaking one, return `## REVISION_CONFLICT` with the conflict and
the alternatives rather than applying or working around it. Full contract:
`gsd-core/references/planner-revision.md`, which you load in revision mode.

Do NOT replan from scratch unless issues are fundamental.
Return what changed.
</instructions>
```

```
Agent(
  prompt=revision_prompt,
  subagent_type="gsd-planner",
  model="{planner_model}",
  description="Revise quick plan: ${DESCRIPTION}"
)
```

> **ORCHESTRATOR RULE — CODEX RUNTIME**: After calling Agent() above, stop working on this task immediately. Do not read more files, edit code, or run tests related to this task while the subagent is active. Wait for the subagent to return its result. This prevents duplicate work, conflicting edits, and wasted context. Only resume when the subagent result is available.

**If the planner returns `## REVISION_CONFLICT`:** a conflict is not resolvable by re-running the
same loop, so it must not consume retry budget. Do NOT increment `iteration_count` and do NOT
re-spawn the checker yet. Present the conflict table and its alternatives to the user and ask
which to take: adopt a named alternative / override the named constraint and apply the hint /
amend the constraint itself. Every option resolves the conflict. Accepting the plan with the
blocker still open is NOT offered here — the blocking `required_property` still fails, and that
choice belongs to the max-iteration escalation below, which is unchanged.

A quick task has no REVIEWS.md and no phase, so `workflow.plan_review_convergence` has nothing to
arbitrate over here; the user is the only route. `plan-phase` is where the convergence hand-off
lives.

Re-spawn the planner with the chosen resolution, then **re-evaluate its return from the top of
this handler** — do not fall through to the checker spawn below. A second conflict is still a
conflict, not a revised plan.

**Bounded:** A conflict naming the SAME `required_property` twice in a row (no successful revision in between) is a stall, and so is the
THIRD conflict return of this loop whatever property it names — alternating property names
would otherwise never trip the repeat rule and the path would be unbounded. Stop re-spawning and
route it to the same iteration-count check below, so declining to spend an iteration cannot make
this path unbounded.

**Otherwise (the planner returns a revised plan, not `## REVISION_CONFLICT`):** spawn checker again, increment `iteration_count`.

**If iteration_count >= 2:**

Display: `Max iterations reached. ${N} issues remain:` + issue list

Offer: 1) Force proceed, 2) Abort
