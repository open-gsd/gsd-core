# Loop Hook Dispatch Contract

Generic reference for consuming the `--raw` JSON output of `gsd_run loop render-hooks <point>`
in any host-loop workflow. This document is point-agnostic — it applies to every loop
extension point (discuss:pre, discuss:post, plan:pre, plan:post, execute:pre, execute:wave:pre,
execute:wave:post, execute:post, verify:pre, verify:post, ship:pre, ship:post).

## Envelope shape

```json
{
  "point": "discuss:pre",
  "activeHooks": [
    { "kind": "contribution", "into": "orchestrator", "fragment": { "inline": "..." } },
    { "kind": "step", "ref": { "skill": "my-skill" } },
    { "kind": "gate", "check": { "query": "..." }, "blocking": true, "onError": "skip" }
  ],
  "rendered": "..."
}
```

`activeHooks` is an array of enabled hook entries for the named point. It is empty (or absent)
when no capability has registered an active hook at this point — treat that as a no-op.

## Dispatch rules by `kind`

### `contribution`

Inject `fragment.inline` verbatim into the context for the role named in `into`
(e.g. `orchestrator`, `planner`). Do not paraphrase — the text is the product.

### `step`

Dispatch the referenced unit:

- `ref.skill` present → dispatch via the Skill tool with skill id `gsd-<ref.skill>`.
- `ref.agent` present → dispatch via the Agent tool with `subagent_type` = `ref.agent`.
  Before dispatching an agent, print the canonical liveness banner so users know silence
  is expected and do not kill a healthy agent:

  ```
  ◆ Spawning <agent>... (runs in a subagent — no output until it returns; expected, not a freeze)
  ```

Wait for the result before continuing to the next hook or the next step.

### `gate`

Evaluate `check` (one of `query`, `predicate`, or `agentVerdict`). Then honor `blocking`:

- `blocking: true` → if the check returns `block: true`, surface `check.message` to the user
  and stop the current step. Do not continue.
- `blocking: false` → advisory only; surface the message but continue regardless of outcome.

Honor `onError` if the check itself errors: `skip` means treat as non-blocking and continue;
`fail` means surface the error and stop.

## Empty / absent `activeHooks`

If `activeHooks` is absent, null, or an empty array, skip silently and continue to the next
step in the workflow. No output to the user is needed.
