# How to choose which executors run your plans

Decide whether every plan runs on `gsd-executor`, or whether a plan's `agent_hint:` may send it to another executor agent installed on your runtime. The setting is `workflow.agent_hint_routing`; it defaults to allowing installed executors.

What a routed executor gets (model, effort, worktree isolation) and why: [About executor identity](../explanation/executor-identity.md#the-executor-policy). Setting reference: [`workflow.agent_hint_routing`](../CONFIGURATION.md).

---

## When starting a project

`/gsd-new-project` asks it right after the AI Models questions, in interactive and auto (`--auto`) mode alike:

| Answer | Writes | Effect |
|---|---|---|
| **Allow installed executors (Recommended)** | `workflow.agent_hint_routing: true` | A plan whose `agent_hint:` names an executor agent installed on this runtime runs on that agent. Plans without a hint run on `gsd-executor`. |
| **gsd-executor only** | `workflow.agent_hint_routing: false` | Every plan runs on `gsd-executor`. `agent_hint:` is ignored. |

If you start from saved defaults and pick **Modify some settings**, answer **Yes** to "Do you want to change the Executor setting?" to get the same question. If no answer is given, the project gets your saved default from `~/.gsd/defaults.json`, or allow when there is none.

## In an existing project

Run `/gsd-settings` and answer the **Executor** question in the Execution section. Choosing **Save as defaults** carries the answer into new projects.

Or set it directly:

```bash
gsd config-set workflow.agent_hint_routing false   # gsd-executor only
gsd config-set workflow.agent_hint_routing true    # allow installed executors
```

Check the current value:

```bash
gsd config-get workflow.agent_hint_routing
```

## If a plan still runs on gsd-executor with routing allowed

- The hint names an agent that is not installed on this runtime, or is misspelled: install the agent file or fix the name.
- The hint names a GSD role such as `gsd-verifier`: GSD roles are never used as executors. Routing prints a warning and uses `gsd-executor`.
- The phase runs on the `orchestrator-worktree` backend, which always runs `gsd-executor`.

Steps to install and name a specialist: [How to route a plan to a specialist executor](route-a-plan-to-a-specialist-executor.md).
