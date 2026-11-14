# How to enable and use the Claude orchestration backend (BETA)

Turn on the capability that can run GSD's execute-phase waves through Claude Code's Workflow tool instead of one-agent-per-message dispatch, check whether your environment qualifies, and emit a Workflow script for a phase.

> **BETA, and not wired into the loop.** `execute-phase` does not dispatch through this backend today: the contribution that used to carry the orchestrator procedure was removed in [#4740](https://github.com/open-gsd/gsd-core/issues/4740), and no replacement dispatch path exists yet. What works is detection and script emission, which you drive yourself (Steps 2–4). The capability is default-off, fail-closed, and Claude-only. See the [explanation doc](../explanation/claude-orchestration-capability.md) for the why, and [ADR-1143](../adr/1143-claude-orchestration-capability.md) for the design.

**What you need:**
- GSD installed with the `full` profile (the capability is `tier: full`).
- **Claude Code** with dynamic workflows available. Claude Code documents them as available on all paid plans, with Anthropic API access, and on Amazon Bedrock, Google Cloud's Agent Platform, and Microsoft Foundry; on Pro you turn them on from the Dynamic workflows row in `/config`. GSD cannot check your plan; see [What detection cannot see](#what-detection-cannot-see).
- A GSD project with at least one planned phase (you need a wave/plan manifest to emit a script for).

---

## Step 1 — Enable the capability

The capability ships disabled. Turn on the master switch inside your GSD project:

```bash
gsd-tools query config-set claude_orchestration.enabled true
```

This key gates the capability's commands and its one loop contribution: the ultraplan ownership declaration injected into the planner at `plan:post`. There is no execute-phase hook — the backend has no dispatch path (see the note at the top).

Verify it took:

```bash
gsd-tools query config-get claude_orchestration.enabled
# → true
```

---

## Step 2 — Check whether your environment qualifies

Detection is fail-closed: the Workflow backend reports `workflow` only when **every** gate opens.

```bash
gsd-tools claude-orchestration detect-backend
```

`--runtime <id>` overrides the runtime (it otherwise follows `GSD_RUNTIME`, then `.planning/config.json` `runtime`, then `claude`). `--no-nested-dispatch` simulates a host that cannot nest agents.

The gates, in order:

1. `claude_orchestration.enabled` is `true`.
2. The runtime is Claude.
3. `claude_orchestration.execution_backend` is not `inline`.
4. The host descriptor advertises nested and background dispatch.
5. No workflow kill switch is set (below), and every settings file that could hold one is readable.

### The kill switches detection reads

These are Claude Code's own documented ways to turn workflows off. If any of them is on, detection reports `inline`:

- **`CLAUDE_CODE_DISABLE_WORKFLOWS`** in the environment. `1` turns workflows off. GSD treats any other non-empty value as off too, except `0` and `false`, so a value it does not recognize never re-enables workflows.
- **`"disableWorkflows": true`** or **`"enableWorkflows": false`** in a settings file. GSD reads the same files, in the same precedence, as Claude Code — the highest one that sets the key wins:
  1. managed settings: `managed-settings.json` plus every `*.json` in `managed-settings.d/` next to it, merged in alphabetical order. The directory is `/Library/Application Support/ClaudeCode` on macOS, `/etc/claude-code` on Linux and WSL, and `C:\Program Files\ClaudeCode` on Windows.
  2. `.claude/settings.local.json` in the project.
  3. `.claude/settings.json` in the project.
  4. `~/.claude/settings.json`, or `$CLAUDE_CONFIG_DIR/settings.json` when `CLAUDE_CONFIG_DIR` is set.

A settings file that exists but cannot be read or parsed, or that sets either key to something other than `true`/`false`, also gives `inline` (`workflow_settings_unreadable`): GSD cannot prove the switch is off, so it does not assume it.

### What detection cannot see

- **Your plan, and the Pro `/config` toggle.** Neither is exposed to tools outside Claude Code. A session without workflow access can pass detection; the Workflow tool then refuses the run, and you fall back to inline dispatch.
- **`--settings` on the `claude` command line**, and managed settings delivered by MDM, the Windows registry, or the Claude Code admin settings page rather than as a file.

### Detection reason codes

| Reason | Meaning | What to do |
|---|---|---|
| `workflow_backend_active` | Every gate passed. | Emit a script (Step 4). |
| `capability_disabled` | `claude_orchestration.enabled` is not `true`. | Step 1. |
| `runtime_not_claude` | The runtime is Codex, Cursor, opencode, or another non-Claude runtime. | Nothing — the Workflow tool is Claude-only. |
| `backend_inline` | `execution_backend` is `inline`. | Step 3, if you want the backend. |
| `workflow_tool_unavailable` | The host descriptor does not advertise nested + background dispatch. | Unusual on Claude Code; you passed `--no-nested-dispatch`, or the session cannot host the tool. |
| `workflows_disabled_by_env` | `CLAUDE_CODE_DISABLE_WORKFLOWS` is set to an on value. | Unset it, or set it to `0`. |
| `workflows_disabled_by_managed_settings` | Managed settings set `disableWorkflows: true` or `enableWorkflows: false`. | Your organization turned workflows off; ask its admin. |
| `workflows_disabled_by_settings` | A user or project settings file turns workflows off. | Remove the key, or override it from a higher-precedence file. |
| `workflow_settings_unreadable` | A settings file exists but cannot be read or parsed, or sets a kill-switch key to a non-boolean. | Fix the file. |
| `workflow_availability_unknown` | The availability check did not run or returned something unrecognized. | Report it as a bug. |

### Deprecated: the Agent SDK version gate

Earlier versions gated on the installed `@anthropic-ai/claude-agent-sdk` version (`claude_orchestration.min_agent_sdk_version`, `--agent-sdk-version`, `GSD_AGENT_SDK_VERSION`). That package version says nothing about whether your Claude Code session has workflows, so the gate was removed ([#4747](https://github.com/open-gsd/gsd-core/issues/4747)). The config key is still accepted so existing configs load, but its value is ignored, and so are the flag and the variable. You can remove them.

---

## Step 3 — Choose the execution backend

`claude_orchestration.execution_backend` controls whether the backend is used once detection passes:

| Value | Behavior |
|-------|-----------|
| `auto` (default) | Use the Workflow backend **if** detection passes; otherwise inline. |
| `workflow` | Same gates as `auto` — it never activates the backend past a failed gate. |
| `inline` | Always one-agent-per-message dispatch, even on a capable Claude Code session. |

```bash
gsd-tools query config-set claude_orchestration.execution_backend inline
```

---

## Step 4 — Emit a Workflow script for a phase

Generate the Workflow script for a phase's wave/plan manifest:

```json
{
  "waves": [
    {
      "id": "w1",
      "plans": [
        { "id": "p1", "brief": "Implement the foo module", "files_modified": ["src/foo.cts"] },
        { "id": "p2", "brief": "Wire the bar seam", "files_modified": ["src/bar.cts"] }
      ]
    }
  ]
}
```

```bash
gsd-tools claude-orchestration emit-workflow \
  --waves .planning/phases/01-foo/waves.json \
  --run-id phase-01-foo \
  --phase-dir .planning/phases/01-foo
```

The script maps GSD's model onto Workflow primitives:

- an `export const meta = { name, description, phases }` block as the first statement,
- **waves → a `phase("Wave <id>")` group and a sequential `await parallel([...])` barrier**, split into separate stages within a wave when `files_modified` sets overlap,
- **plans → `agent(brief, { agentType: "gsd-executor", isolation: "worktree", schema })`** — the same executor agent and worktree isolation the inline path uses. A plan with `"use_worktree": false` gets no isolation and no schema,
- the phase run id in `summary.resumeRunId`, and the intended token pool in `summary.budgetTokens`.

The script returns one entry per plan: `{ plan, expects_worktree, metadata, error }`. For a worktree plan, the schema makes the executor return its worktree metadata (`agent_id`, `worktree_path`, `branch`, `expected_base`) as validated JSON; Claude Code retries an invalid reply up to five times. `metadata` is `null` when the agent was skipped, failed validation, or returned an incomplete object, and `error` holds the failure text when the agent threw. A `null` `metadata` on a worktree plan means its commits are still on a `worktree-wf_*` branch and nothing will merge them — stop and recover them before continuing.

### Limits emission enforces

Claude Code rejects a run that exceeds these caps, so `emit-workflow` refuses to produce one and names the cap instead:

| Cap | Value |
|---|---|
| Plans in one stage (items in one `parallel()` call) | 4,096 |
| Plans in one script (agents per run) | 1,000 |

Two more limits are advisory, so emission does not enforce them. At most 16 agents run at once by default (fewer on machines with fewer CPUs; `CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS` raises it, on Claude Code v2.1.269 or later). And a run that schedules more than 25 agents shows a `Large workflow` warning, while `workflowSizeGuideline` (default `medium`, fewer than 10 agents) tells Claude how big to make the workflows it writes itself.

### Run the emitted script

Pass the script to Claude Code's Workflow tool with `summary.resumeRunId` as the tool's `resumeFromRunId` input.

- **Typing `ultracode` does not do this for you.** The keyword starts a workflow only from a prompt you type yourself, not from `claude -p`, an Agent SDK prompt not marked as human input, a scheduled task, or relayed webhook or pull-request text. Call the Workflow tool directly.
- **Unattended runs need permission.** In `claude -p` and the Agent SDK there is no approval prompt, so the call is denied unless you add `Workflow` to your allow rules, run in bypass or auto mode, allow it from a `PreToolUse` hook, or approve it in a `canUseTool` callback.
- **Resume works within the same session.** Relaunching with `resumeFromRunId` returns cached results for agents that completed before the first failed one; the failed agent and every agent started after it run again. A new session cannot resume the run directly — restart the old one with `claude --resume`, or run the script again from the start.

---

## Step 5 — Ultraplan plan-offload

With the capability on, the planner sees an ultraplan ownership declaration at `plan:post` and may offer `/gsd-ultraplan-phase` as an alternative to local `/gsd-plan-phase`. This is advisory; the local planner stays the default. When the capability is off, or the runtime is not Claude Code, nothing changes.

---

## Disabling

```bash
gsd-tools query config-set claude_orchestration.enabled false
```

Or keep the capability on and force inline dispatch:

```bash
gsd-tools query config-set claude_orchestration.execution_backend inline
```

The federated config keys live only in the capability registry, so they vanish cleanly if the capability is ever removed.

---

## What works today

**Working:**
- Detection (`gsd-tools claude-orchestration detect-backend`), with the kill switches above.
- Emission (`gsd-tools claude-orchestration emit-workflow`) with structured metadata hand-back and cap checks.
- The combined `gsd-tools claude-orchestration resolve-wave-dispatch` command, which runs detection and emission in one call.
- The `plan:post` ultraplan ownership declaration.

**Not wired:**
- `execute-phase` does not call any of this. Choosing how the orchestrator should dispatch through the backend is a separate design question tracked outside this capability.
- The plan-checker and verifier run inline either way.
- The `gsd-ultraplan-phase` skill is not yet migrated into the capability's `skills[]`.
