# Plan:Pre Generic Step and Gate Dispatch (#5982)

Implements @gsd-core/references/loop-hook-dispatch.md for `plan:pre`. Read `activeHooks` from `PLAN_PRE_HOOKS_JSON` in-context. This runs in **manual and auto-chain mode alike**, before the planner is spawned — a resolved hook is dispatched, never silently dropped.

**Dedicated sections.** These `capId`s own a `plan:pre` step or gate that a named section of `plan-phase.md` already runs with its own mode-specific behavior. Skip their `step` and `gate` entries here so none runs twice; dispatch **every other** active `step` and `gate`, first-party or third-party, in array order. (Contributions are injected at §5.55 and §8, not here.)

| capId | Section | What that section owns |
|---|---|---|
| `research` | §5 | the research step, behind §5's research decision |
| `drift` | §4.6 | the context-drift gate (§4.6) and the codebase-drift gate (§5.65), both non-blocking |
| `ui` | §5.6 | the `ui-phase` step and the `ui.plan-gate` gate (Branches 2–6) |
| `ai-integration` | §5.6 | the AI-integration step (pipeline: skill; manual: recommendation) |
| `pattern-mapper` | §7.8 | the pattern-mapper agent step, which needs `RESEARCH_PATH` |
| `intel` | §7.9 | the `intel api-surface` command step, which sets `API_SURFACE_PATH` |

If no active `step` or `gate` remains after that, return to §5.6. Otherwise make sure the phase values the dispatch lines carry are set — §1 already parsed them from `INIT`, so each is only filled when empty:

```bash
IFS= read -rd '' GSD_ARGS <<'GSD_ARGS_END' || true
$ARGUMENTS
GSD_ARGS_END
GSD_ARGS=${GSD_ARGS%$'\n'}
GSD_WS=$(echo " $GSD_ARGS" | sed -nE 's/.* --ws +([A-Za-z0-9][A-Za-z0-9._-]*).*/--ws \1/p' | head -n 1)
PHASE_NUMBER="${PHASE_NUMBER:-$(gsd_run query init.plan-phase ${GSD_WS:+--ws=${GSD_WS##* }} "$PHASE" --pick phase_number 2>/dev/null)}"
PHASE_DIR="${PHASE_DIR:-$(gsd_run query init.plan-phase ${GSD_WS:+--ws=${GSD_WS##* }} "$PHASE" --pick phase_dir 2>/dev/null)}"
PHASE_REQ_IDS="${PHASE_REQ_IDS:-$(gsd_run query init.plan-phase ${GSD_WS:+--ws=${GSD_WS##* }} "$PHASE" --pick phase_req_ids 2>/dev/null)}"
PHASE_REQ_IDS="${PHASE_REQ_IDS:-TBD}"
AUTO_CHAIN=$(gsd_run query check auto-mode --pick auto_chain_active 2>/dev/null)
AUTO_CHAIN="${AUTO_CHAIN:-false}"
```

## Steps

For each remaining active entry where `kind == "step"` (exactly one of `ref.skill`, `ref.agent`, `ref.command` is set):

- **`ref.skill`** → `Skill(skill="gsd-${ref.skill}", args="${PHASE} ${GSD_WS}")`, appending `--auto` to `args` only when `AUTO_CHAIN` is `true`. Prepend `gsd-` to `ref.skill`.
- **`ref.agent`** → print `◆ Spawning ${ref.agent}... (runs in a subagent — no output until it returns; expected, not a freeze)`, then `Agent(prompt=filled_hook_fragment, subagent_type=ref.agent, model="{researcher_model}")` with the hook's `fragment.inline` as the prompt body, phase fields filled. Omit `model=` when `researcher_model` is `"inherit"` or empty (#2517).
- **`ref.command`** → validate it IN-CONTEXT before any shell use: the value must match `^[a-z][a-z0-9-]*( [a-z][a-z0-9-]*)*$`. Check it yourself — never by pasting it into a shell command to be tested there. A value that fails is a malformed manifest: record a warning naming the `capId`, skip it, continue. Only a value that passed is run:

  ```bash
  # shellcheck disable=SC2086 # the validated command is a family and subcommand: splitting it into two words is intended
  gsd_run ${ref.command} --phase "${PHASE_NUMBER}" --raw
  ```

Wait for each result before the next hook. A step is advisory: on error record a warning naming the `capId` and continue, unless `onError == "halt"` — then surface the error and stop the plan-phase workflow.

## Gates

For each remaining active entry where `kind == "gate"`, in array order. ⚠ **Validate `check` before shell use** (third-party manifest input; `loop-hook-dispatch.md` § `gate`): replace every `.` in `check.query` with `-`, check that normalized value against `^[a-z][a-z0-9]*(-[a-z0-9]+)*( [a-z][a-z0-9]*(-[a-z0-9]+)*)*$` in-context, and wherever `${hook.check.query}` appears below write that normalized value. Serialize `check.predicate` to compact one-line JSON and pass it as a **single argv element** through the quoted heredoc below — never re-quote it into a shell string, where an apostrophe would close the literal. A malformed check is routed per `onError` in step 1, never run.

```bash
# named-query gate (the validated query may be several words; splitting it is intended):
# shellcheck disable=SC2086
GATE_RESULT=$(gsd_run check ${hook.check.query} "${PHASE_DIR}" "${PHASE_REQ_IDS}" --raw) && CHECK_EXIT=0 || CHECK_EXIT=$?
```
OR, for a `predicate` gate (ADR-2008):
```bash
IFS= read -rd '' PREDICATE_JSON <<'GSD_PREDICATE_END' || true
<hook.check.predicate as compact one-line JSON>
GSD_PREDICATE_END
PREDICATE_JSON=${PREDICATE_JSON%$'\n'}
GATE_RESULT=$(gsd_run check predicate --predicate "$PREDICATE_JSON" --phase-dir "${PHASE_DIR}" --phase-number "${PHASE_NUMBER}" --phase-req-ids "${PHASE_REQ_IDS}" --raw) && CHECK_EXIT=0 || CHECK_EXIT=$?
```

A gate carrying neither — including an `agentVerdict` check, which has no runner at `plan:pre` — cannot be evaluated here: record a warning naming the `capId` and treat it as a check-command failure in step 1, **never** as a silent pass.

**Step 1 — did the check command fail?** (malformed check, non-zero `CHECK_EXIT` including `69` UNAVAILABLE, empty output, or unparseable JSON — its `block` is not a verdict):
- `onError == "halt"` → surface `⚠ plan:pre gate check failed ({hook.capId})` with the error and stop the plan-phase workflow.
- otherwise → record a warning naming the `capId` and continue to the next gate.

**Step 2 — read `GATE_RESULT.block`:**
- `blocking == true` and `block == true` → output `⚠ Planning blocked by capability gate ({hook.capId}): {message}` (`check.message`, plus the result's own `message` when it has one) and **EXIT the plan-phase workflow. Do not spawn the planner.**
- `blocking == false` → advisory: surface the message when `block` is `true`, and continue.
- `block == false` → continue silently.

When every remaining hook has been handled, return to §5.6.
