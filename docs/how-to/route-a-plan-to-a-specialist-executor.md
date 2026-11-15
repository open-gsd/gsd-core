# How to route a plan to a specialist executor

Send one plan to your own executor agent (a Rails or Flutter specialist, say) instead of `gsd-executor`, while keeping worktree isolation and model selection working.

Background on why the routed executor is recorded and checked: [About executor identity](../explanation/executor-identity.md). Field reference: [PLAN.md `agent_hint`](../reference/plan-md.md#per-plan-executor-routing).

---

## 1. Install the specialist agent

Put an agent file for the specialist in your runtime's agent directory, project-local or user-global. On Claude Code that is `.claude/agents/acme-rails-executor.md` or `~/.claude/agents/acme-rails-executor.md`.

The agent must follow the `gsd-executor` execution contract: it reads `execute-plan.md`, makes atomic commits, and has Read, Edit, Write and Bash.

Do not name it after a GSD role. A hint such as `gsd-verifier` or `gsd-planner` is refused (see step 5).

## 2. Name it in the plan

Add `agent_hint:` to the plan's PLAN.md frontmatter:

```yaml
---
phase: 02-api
plan: 02-01-api
agent_hint: acme-rails-executor
---
```

## 3. Check that routing is on

Routing is on by default. Confirm it:

```bash
gsd config-get workflow.agent_hint_routing
```

If it prints `false`, turn it back on with `gsd config-set workflow.agent_hint_routing true`, or answer **Allow installed executors** to the Executor question in `/gsd-settings` ([How to choose which executors run your plans](choose-the-executor-policy.md)).

## 4. Choose the specialist's model (optional)

With no setting, the specialist runs on the model `gsd-executor` would get under your current profile. To pin a different model, add a `model_overrides` entry named after the agent:

```json
{
  "model_overrides": {
    "acme-rails-executor": "opus"
  }
}
```

Effort comes from the specialist's own agent frontmatter. GSD passes no `effort=` for it.

## 5. Run the phase and read the routing output

```bash
/gsd-execute-phase 2
```

- If the hint resolves, the plan is dispatched with `subagent_type="acme-rails-executor"`. The isolation guard treats it as the plan's executor, so on a worktree-capable host it must run in a worktree, exactly like `gsd-executor`. Ad-hoc use of the same agent outside `execute-phase` is held to the same rule for up to 24 hours after a record names it, in any phase of the project, and whenever a scan overflow (more than 1024 entries in `.gsd/dispatch-isolation`), a link or unreadable `.gsd` or record directory, a truncated record, or a refused recent record file forces the fail-closed rule. While a fail-closed case holds, every valid non-GSD-role agent, host built-ins such as `Explore` included, must also run in a worktree. To clear it, follow the per-case recovery list in [If every non-GSD-role agent is held to the worktree rule](#if-every-non-gsd-role-agent-is-held-to-the-worktree-rule) (records are otherwise pruned after 24 hours); background in [About executor identity](../explanation/executor-identity.md).
- Hint names must be bare agent names (letters, digits, `.`, `_`, `-`, starting with a letter or digit, at most 128 characters). Any other name routes to `gsd-executor`.
- If the agent file is missing or misspelled, the plan runs on `gsd-executor`.
- If the hint names a GSD role, routing prints `warning: agent_hint "gsd-verifier" names a GSD non-executor role; dispatching gsd-executor instead (#6213)` and uses `gsd-executor`. Rename the hint to your own agent.
- On the `orchestrator-worktree` backend, routing prints a note and uses `gsd-executor`, because that backend does not route subagent types.

## If the isolation guard blocks the specialist

A block that names `subagent_type="acme-rails-executor"` and a missing `isolation="worktree"` means the dispatch dropped the isolation flag the recorded decision requires. Re-run the phase so the orchestrator rebuilds the dispatch from the template, which carries the flag.

## If every non-GSD-role agent is held to the worktree rule

A fail-closed case holds (see [About executor identity](../explanation/executor-identity.md#the-fail-closed-cases)); host built-ins such as `Explore` are held too. Recover by case:

- A legacy slot `.gsd/dispatch-isolation-sentinel.json` that is refused or malformed: remove it (or rewrite it as valid JSON).
- `.gsd` or `.gsd/dispatch-isolation` that is a link or any other non-directory: replace it with a real directory.
- A truncated record (more than 64 hinted executors in a phase or milestone, or names over the record's byte budget): shorten or reduce the `agent_hint` names; every phase- or milestone-level write rewrites the record, and the case clears 24 hours after the last write.
- A scan overflow (more than 1024 entries in `.gsd/dispatch-isolation`): remove stale entries from `.gsd/dispatch-isolation/` until 1024 or fewer remain, or remove the directory (it is recreated on the next write).
- An unreadable `.gsd` or `.gsd/dispatch-isolation` directory: restore read and execute permission on it.
- A recent keyed record file in `.gsd/dispatch-isolation/` that the reader refuses or rejects (malformed, wrong key, hard link, link, FIFO, device, unreadable (mode 000), no phase, oversize): remove it.
- A recent record whose `written_at` is in the future (beyond the clock-skew allowance), or a future-dated legacy slot: the legacy slot (`.gsd/dispatch-isolation-sentinel.json`) clears on the next dispatch-isolation write; a keyed file clears 24 hours after its mtime (the writer prunes it and the reader stops counting it) or when removed by hand.

## To stop routing

Route every plan back to `gsd-executor`:

```bash
gsd config-set workflow.agent_hint_routing false
```
