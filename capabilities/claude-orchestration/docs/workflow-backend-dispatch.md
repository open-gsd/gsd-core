# Claude orchestration — Workflow execution backend (BETA)

> This is the orchestrator-side procedure for the Workflow execution backend.
> It is NOT a loop contribution and is not injected anywhere. It was
> previously declared as an `execute:wave:pre` contribution with
> `into: "executor"`, which routed orchestrator instructions into executor
> prompts — a role-partition violation (the orchestrator only orchestrates,
> the executor only executes). It is retained here as the reference for
> whoever wires the orchestrator side through a host-level mechanism. See
> issue #4740.

> **Editor's note:** the body below is preserved byte-for-byte from when this
> file WAS the `execute:wave:pre` contribution fragment, so its section
> headings and prose ("this contribution", "injected", etc.) still speak in
> those terms. That is intentional — it is not being rewritten to match its
> new status — and it is retained purely as the orchestrator-side reference
> described above.
>
> **#4747 factual update:** the activation gates, the Agent SDK version
> section, and the shape of the script's return value were corrected to match
> the code (the SDK-version gate was replaced by Claude Code's documented
> workflow kill switches; worktree metadata now comes back as schema-validated
> structured output with a per-plan `error`). Everything else is unchanged.

## When this contribution is active

The Claude orchestration capability is **default-off and BETA**. It activates only
when ALL of the following hold:

1. `claude_orchestration.enabled` is `true` in `.planning/config.json`, AND
2. the active runtime is **Claude Code** (the Workflow tool is Claude / Agent
   SDK-specific), AND
3. `claude_orchestration.execution_backend` resolves to `workflow` — either
   explicitly, or via `auto` — **and** no Claude Code workflow kill switch is
   set: `CLAUDE_CODE_DISABLE_WORKFLOWS`, or `disableWorkflows: true` /
   `enableWorkflows: false` in managed, project-local, project or user settings
   (fail-closed: an unreadable settings file counts as set). The
   `claude_orchestration.min_agent_sdk_version` key is deprecated and ignored
   (#4747).

Detection is fail-closed: any miss degrades to **inline, manual, one-agent-per-
message dispatch** — exactly today's behaviour. On a non-Claude runtime this
contribution is a no-op.

## Why `execute:wave:pre` (not `execute:wave:post`)

This is a **dispatch-backend selector** — it decides HOW a wave's executor agents
are spawned. That decision has to be made BEFORE the wave's `Agent()` calls in
`execute-phase.md` step 3, not after the wave has already finished (#2285). The
capability previously registered at `execute:wave:post`, which fires only after
worktree merge/post-merge tests/tracking updates — by then the wave was already
dispatched inline, so the contribution was structurally unable to change how
dispatch happened. This fragment is injected at the point that actually precedes
dispatch.

## What the orchestrator does when the Workflow backend is active

Before spawning executor agents for the current wave (execute-phase.md step 3),
resolve the dispatch backend through the single composed CLI seam:

```bash
gsd-tools claude-orchestration resolve-wave-dispatch \
  --waves "$WAVE_MANIFEST_PATH" --run-id "$PHASE_RUN_ID" \
  --runtime "$RUNTIME" \
  --phase-dir "$PHASE_DIR" --raw
```

No Agent SDK version is passed or resolved (#4747): the router reads Claude
Code's workflow kill switches itself; see **Workflow availability** below.

This composes `detectWorkflowBackend` (the gate ladder above) with
`emitWorkflowScript` (the wave→plan mapping below) in ONE call — the pure
function backing it is `resolveWaveDispatch` in
`gsd-core/bin/lib/claude-orchestration.cjs`. Response shape:
`{ backend: 'inline'|'workflow', reason, script?, summary? }`.

### Manifest construction (`$WAVE_MANIFEST_PATH`, `$PHASE_RUN_ID`, `$PHASE_DIR`)

These are NOT pre-existing execute-phase.md variables — the orchestrator builds
them at this step, from data it already has in-context from `discover_and_group_plans`
(the `PLAN_INDEX` JSON) and step 2.5 (the per-plan `USE_WORKTREES_FOR_PLAN` decision):

1. **`$PHASE_DIR`** — reuse `{phase_dir}` from the `INIT` bundle (already loaded
   in the `initialize` step). No new value needed.

2. **`$PHASE_RUN_ID`** — a stable identifier for THIS phase-execution attempt, so
   `resumeFromRunId` can resume an interrupted run without re-dispatching plans
   the Workflow tool already completed. Construct it deterministically —
   `execute-{phase_number}-{phase_slug}` — from `INIT`'s `phase_number`/`phase_slug`
   (both are already validated identifiers used elsewhere in this workflow, so
   they satisfy `emitWorkflowScript`'s `isScriptableIdentifier` check). Do NOT
   mint a new random id per wave — the SAME `$PHASE_RUN_ID` is reused for every
   wave in the phase so the Workflow tool can correctly track cross-wave resume
   state.

3. **`$WAVE_MANIFEST_PATH`** — a fresh temp file for THIS wave's manifest (one
   wave = one `waves` array with a single entry, matching the wave-by-wave
   dispatch loop; do not batch multiple waves into one manifest — waves are
   dispatched in wave order, not all at once):

   ```bash
   WAVE_MANIFEST_PATH=$(mktemp "${TMPDIR:-/tmp}/gsd-wave-dispatch-XXXXXX") && mv "$WAVE_MANIFEST_PATH" "$WAVE_MANIFEST_PATH.json" && WAVE_MANIFEST_PATH="$WAVE_MANIFEST_PATH.json"
   ```

   Then **use the Write tool** (not a bash/jq pipeline — the orchestrator already
   has every field parsed in-context) to write the manifest JSON to
   `$WAVE_MANIFEST_PATH`:

   ```json
   {
     "waves": [
       {
         "id": "wave-{N}",
         "plans": [
           {
             "id": "{plan_id}",
             "brief": "{the SAME <objective>...<success_criteria> prompt block step 3 builds for this plan's inline Agent() call}",
             "files_modified": ["{from PLAN_INDEX.plans[].files_modified for this plan}"],
             "use_worktree": {true unless step 2.5 set USE_WORKTREES_FOR_PLAN=false for this plan}
           }
         ]
       }
     ]
   }
   ```

   - **`id`** — the plan id from `PLAN_INDEX`, e.g. `"01-01"`.
   - **`brief`** — MUST carry the same task content as step 3's inline `Agent()`
     prompt (the `<objective>`/`<execution_context>`/`<required_reading>`/
     `<success_criteria>` block, with `{plan_number}`/`{phase_number}`/
     `{phase_name}` substituted) — a short summary here would NOT reproduce
     step 3's behavior and would violate the "identical artifacts" contract.
   - **`files_modified`** — copy verbatim from the plan's `PLAN_INDEX` entry.
   - **`use_worktree`** — `true` for every plan UNLESS step 2.5's per-plan
     worktree gate (`execute-phase/steps/per-plan-worktree-gate.md`) set
     `USE_WORKTREES_FOR_PLAN=false` for that plan (submodule-touching plan, or
     project-level `USE_WORKTREES=false`) — in which case pass `false` here so
     `emitWorkflowScript` omits `isolation: "worktree"` for that plan (#2772 /
     #2285 finding 1). **Never** hardcode `true` — that would force worktree
     isolation on a plan the inline path explicitly keeps out of worktrees.

**Workflow availability (#4747):** the router reads Claude Code's documented
kill switches itself, so the orchestrator passes nothing for them:

1. `CLAUDE_CODE_DISABLE_WORKFLOWS` in the environment (any non-empty value other
   than `0` / `false` turns workflows off);
2. `disableWorkflows: true` or `enableWorkflows: false` in, highest precedence
   first, managed settings (`managed-settings.json` plus `managed-settings.d/*.json`),
   `.claude/settings.local.json`, `.claude/settings.json`, and the user's
   `settings.json` (under `CLAUDE_CONFIG_DIR` when set, else `~/.claude`).

A settings file that exists but cannot be read, or sets either key to a
non-boolean, resolves to `inline` (`workflow_settings_unreadable`). The plan
tier, the Pro `/config` toggle, `--settings` and non-file managed sources are not
visible to the router; a session without workflow access can pass detection, and
the Workflow tool's own refusal then sends dispatch inline. The old Agent SDK
version gate, its `--agent-sdk-version` flag and `GSD_AGENT_SDK_VERSION` are
ignored.

**If `backend == "workflow"`:** run the emitted `script` via the Workflow tool
for THIS wave instead of the per-message `Agent()` loop in step 3. The script
composes the SAME `gsd-executor` agent type the inline path uses, with
worktree isolation applied PER PLAN from the manifest's `use_worktree` field
(see `emitWorkflowScript`):

- **waves → one or more sequential `parallel()` barriers** — each wave is a
  barrier group; when plans within a wave share `files_modified`, they are split
  into separate sequential stages within that wave's barrier.
- **plans → `agent(brief, { agentType: 'gsd-executor', isolation: 'worktree', schema })`**
  when `use_worktree` is not `false`, or `agent(brief, { agentType: 'gsd-executor' })`
  (no isolation) when it is — so the produced `SUMMARY.md` and commits are
  identical to inline dispatch, INCLUDING the inline path's submodule safety
  gate (#2772 / #2285 finding 1).
- **`files_modified` overlap → separate sequential stages** — the same overlap
  rule execute-phase already applies inline (step 1 of the wave loop).
- **`resumeFromRunId`** — **pass `summary.resumeRunId` as the Workflow tool's
  `resumeFromRunId` INPUT when you invoke the tool.** It is a tool parameter,
  not a script function; the script deliberately does not call it (#2590 — doing
  so threw "resumeFromRunId is not defined" and rejected the entire script).
  Omitting it from the tool invocation silently regresses phase-resume to a
  no-op: an interrupted phase re-runs completed plans.

### After the run: manifest bridge into the merge chain (#3302)

The single Workflow tool call replaces step 3's per-plan `Agent()` loop — which also
means step 3's manifest bookkeeping (creation + per-agent recording) does NOT happen on
this path. The orchestrator MUST bridge the run's per-agent results into the SAME
manifest-scoped merge chain inline dispatch uses, before steps 4–5.8, which then run
unchanged:

1. **Create the manifest BEFORE invoking the tool** (this is step 3's creation block,
   which this path skips). When ANY plan in the wave has `use_worktree` not `false`:

   ```bash
   if [ -z "${WAVE_WORKTREE_MANIFEST:-}" ]; then
     M=$(mktemp "${TMPDIR:-/tmp}/gsd-worktree-wave-XXXXXX") && mv "$M" "$M.json" && WAVE_WORKTREE_MANIFEST="$M.json" || exit 1  # XXXXXX must be path-final on BSD/macOS (#1520)
     # Persist the dispatch-time orchestrator worktree root so wave-cleanup pins back
     # to the orchestrator's OWN worktree (#630), exactly as inline dispatch does.
     ORCH_ROOT=$(git rev-parse --show-toplevel)
     ORCH_ROOT="$ORCH_ROOT" MANIFEST="$WAVE_WORKTREE_MANIFEST" node -e 'const fs=require("fs");fs.writeFileSync(process.env.MANIFEST,JSON.stringify({orchestrator_root:process.env.ORCH_ROOT||null,worktrees:[]})+"\n")'
     export WAVE_WORKTREE_MANIFEST
   fi
   ```

2. **Invoke the Workflow tool with the emitted script and
   `resumeFromRunId: summary.resumeRunId`.** The script top-level `return`s one entry
   per dispatched plan: `{ plan, expects_worktree, metadata, error }`. For a worktree
   plan the `agent()` call carries a JSON Schema, so the executor returns
   `{agent_id, worktree_path, branch, expected_base}` as validated structured output
   (#4747) and `metadata` is that object. `metadata` is `null` when the agent was
   skipped or died, returned an incomplete object, or failed validation after Claude
   Code's retries — and always for a non-worktree plan. `error` is the failure text
   when the agent's call threw, else `null`.

3. **Record every worktree plan** exactly as inline dispatch does at step 3's
   "After each `Agent()` returns" — one `worktree.record-agent` per returned entry
   with `expects_worktree: true` and complete metadata:

   ```bash
   gsd_run query worktree.record-agent --manifest "$WAVE_WORKTREE_MANIFEST" \
     --agent-id "<metadata.agent_id>" --path "<metadata.worktree_path>" \
     --branch "<metadata.branch>" --base "<metadata.expected_base>" \
     --files "<plan files_modified, space-separated>" \
     --deletions "<plan files_deleted, space-separated>"
   ```

   `--deletions` (#3003) carries the plan's declared `files_deleted` so a plan that scoped a file
   removal merges through `cleanup-wave` instead of being blocked. Unlike `--files` it is not
   advisory: omitting it leaves the deletions guard blocking on any deletion at all, so this
   dispatch path must pass it or plans declaring a removal fail to merge here while succeeding on
   the inline path.

   The verb's write-strict validation applies as inline: on a non-zero exit or any
   missing field, stop and ask for recovery — do not append an under-populated entry.

4. **HALT on uncapturable metadata — never a silently-empty manifest (#3302).**
   After recording, the manifest must hold one entry per `expects_worktree: true`
   outcome (`summary.worktreePlans` from `resolve-wave-dispatch` is the expected
   count). Any shortfall — a `null` `metadata`, a missing/empty field, or a count
   mismatch — means commits are stranded on their `worktree-wf_*` branches and
   `worktree.cleanup-wave` would merge nothing while the phase looks green. STOP the
   phase with the failing plan id and the recovery hint below; do NOT run
   `worktree.cleanup-wave` and do NOT proceed to step 4.

   **Recovery hint:** the unmerged `worktree-wf_*` branch still holds the work. Recover
   the missing metadata from the run's per-agent result journal (`journal.jsonl` — one
   `{"type":"result",…}` line per agent — in the Workflow run's transcript dir), re-run
   `worktree.record-agent` by hand, then re-run cleanup. If the journal cannot be
   recovered either, merge the branch manually after review — never discard it.

5. **Resume (`resumeFromRunId`).** Resume works only within the same Claude Code
   session. On relaunch, agents that completed before the first failed one return
   their cached results; the failed agent and every agent started after it run again.
   If a resumed plan still comes back with `metadata: null`, recover it from the
   ORIGINAL run's journal (same hint as above). If it cannot be recovered, fail loudly
   per rule 4 — a resumed run must never report success over silently-dropped agent
   work.

6. **Non-worktree plans** (`expects_worktree: false` — `use_worktree: false` in the
   manifest): they ran without isolation; their commits are already on the main working
   tree. No record-agent entry, no manifest write.

With the manifest populated, steps 4–5.8 (wait/completion bookkeeping, step 5.5's
manifest-scoped `worktree.cleanup-wave`, post-merge gate, tracking update) run
UNCHANGED — the Workflow backend replaces HOW agents are spawned and returns their
metadata; the merge chain itself is the inline path's own, now with real input.

**If `backend == "inline"`** (any gate miss, or `resolve-wave-dispatch` itself
unavailable/erroring): proceed to step 3's standard per-message `Agent()`
dispatch — the default, byte-identical-to-today path. `onError: skip` on this
contribution means a `resolve-wave-dispatch` command failure is treated exactly
like an `inline` result, never as a fatal wave error.

## Fallback contract

Detection is fail-closed end-to-end: capability disabled, non-Claude runtime,
`execution_backend:"inline"`, missing/incapable host descriptor, a workflow kill
switch set or unreadable, or an `emitWorkflowScript` failure on a malformed or
over-cap
wave manifest — ANY of these degrades to `backend:"inline"` and execute-phase's
standard inline dispatch (step 3) runs unmodified. The Workflow backend never
partially activates; the executor MUST NOT assume parallelism, a shared budget,
or resume-from-run-id semantics when `backend == "inline"`.
