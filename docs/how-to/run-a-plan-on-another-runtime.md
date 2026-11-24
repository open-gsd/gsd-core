# How to run a plan on another runtime

**Goal:** Execute one plan with a different runtime's CLI than the one hosting your session, for example a plan run by `codex exec` while Claude Code orchestrates the phase.

**Prerequisites:** The target runtime's CLI is on `PATH`, and `workflow.use_worktrees` is not `false`. The design is [ADR-3711](../adr/3711-cross-runtime-plan-execution.md).

---

## 1. Turn the gate on

```bash
gsd-tools config-set workflow.cross_runtime_execution true
```

The gate is off by default and must be the boolean `true`; the string `"true"` does not count.

## 2. Declare the target on the plan

In the plan's frontmatter:

```yaml
executor_runtime: codex
```

The value is a runtime id (letters, digits, `_`, `-`). `verify plan-structure` refuses the field on a plan with `autonomous: false` or a checkpoint task, on a plan that also sets `agent_hint`, and on a value that is not a runtime id.

## 3. Pick the target's model (optional)

```bash
gsd-tools config-set execute.models.codex gpt-5-codex
```

The model is read only from `execute.models.<runtime>`. Your host's model and `model_overrides` never reach the target's command line. When the key is unset, no model flag is passed and the target uses its own default.

## 4. Check what will happen

Without `--cwd-target` the route answers the per-plan decision (no worktree exists yet) and `exec` is `null`; with it, `exec` is the command to spawn.

```bash
gsd-tools query dispatch-isolation --json --phase <phase> --plan <plan-id> --cwd-target <worktree> --prompt go
```

| Field | Meaning |
|---|---|
| `runtime` | The host runtime |
| `executorRuntime` | The plan's declared target, or `null` |
| `isolation` | `orchestrator-worktree` when the foreign dispatch is in effect |
| `exec` | The target command, arguments and working directory |
| `fallback` | `null`, or the one reason the plan runs on the host instead |
| `held` | `true` when the query held a caller's recorded `none` and wrote no decision record |
| `decidedAt` | When that held decision was made (epoch ms), or `null` |

## Fallback reasons

When a precondition fails the plan runs on the host as if the field were absent, and one advisory line names the reason.

| `fallback` | Cause |
|---|---|
| `gate_off` | `workflow.cross_runtime_execution` is not `true` |
| `worktrees_off` | `workflow.use_worktrees` is `false` |
| `unknown_runtime` | The id is not a registered runtime |
| `forced_isolation` | The caller forced this plan's isolation (`--force-isolation`, for example the submodule gate), and a forced decision is never overridden |
| `same_runtime` | The target is the host |
| `descriptor_unresolved` | The target does not support process-spawn execution, or its command cannot be built |
| `binary_absent` | The target command is not on `PATH` |

## What the worker records

The dispatch writes the plan's isolation decision once, naming `producer: "dispatch-isolation"` and `executor_runtime`. A query that holds a caller's recorded `none` for the plan writes no decision record and still reports the foreign dispatch, with `held: true`; execute-phase re-records the plan before the launch, so the launch writes the decision. The worker gets a lifecycle record (`<worktree>.worker.json`) carrying `executorRuntime`. The plan is complete when its SUMMARY, plan-scoped commits and branch state reconcile, not when the process exits.
