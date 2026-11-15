# Model Profile Resolution

Resolve each agent's model through `gsd-tools`, then pass it to the `Agent()` spawn — or
omit the parameter entirely when nothing resolved.

## Resolution Pattern

Prefer the field your workflow's own `init.*` payload already emits (every orchestrator
init that spawns subagents carries one — `mapper_model`, `planner_model`,
`executor_model`, `doc_writer_model`, …). Declare it in the workflow's parse line so the
binding is stated, not implied:

```
Parse JSON for: `mapper_model`, …
```

When the agent type is only known at runtime — a capability hook naming its own agent, for
example — resolve it directly instead:

```bash
AGENT_MODEL=$(gsd_run query resolve-model "<agent-type>" --raw)
```

Both surfaces return the same thing: a model string for the active runtime, or the **empty
string** when nothing resolved.

## Lookup Table

@~/.claude/gsd-core/references/model-profiles.md

## Passing the model to a spawn

```
Agent(
  prompt="...",
  subagent_type="gsd-planner",
  model="{planner_model}"
)
```

Substitute the field **this workflow bound** — never a generic placeholder name.

**#2517 — omit, do not emit an empty model.** When the resolved value is `"inherit"` or
empty, **omit the `model=` parameter entirely**:

```
Agent(
  prompt="...",
  subagent_type="gsd-planner"
)
```

No model parameter is passed at all — `planner_model` resolved to `"inherit"` or empty, and
omitting it inherits the orchestrator's model. Passing either value through as an argument
instead 404s on non-Claude runtimes.

This is not cosmetic, and both values really occur. `model_profile: "inherit"` resolves to
the literal string `"inherit"`. `resolve_model_ids: "omit"` resolves to the **empty string**
on a runtime that has neither native tier aliases nor a runtime tier map; an agent type
absent from the profile table takes that same empty-string path, because it has no tier for
the earlier steps to resolve. Emitting either value verbatim fails the spawn on every
runtime without native tier aliases.

On a runtime whose descriptor declares native tier aliases (`hostBehaviors.nativeModelAliases`
— Claude Code), `"omit"` resolves to the agent's tier alias (`opus` / `sonnet` / `haiku`)
rather than the empty string (#3703), so the bound field is non-empty and is passed as
`model=`. A blank there would hand the choice to the host (on Claude Code,
`CLAUDE_CODE_SUBAGENT_MODEL` when set), not to the profile.

**#2684 — substitute a field your workflow actually bound.** `model="{…}"` must name a key
your own `init.*` payload emits, a shell variable you assigned, or a field on your declared
parse line. A placeholder that resolves to nothing does not fail loudly — the orchestrator
silently invents a value, which is the invisible partial application ADR-1411 prohibits.
`tests/model-omit-when-inherit-guard.test.cjs` enforces both rules.

## Profile semantics

Each profile resolves an agent to a tier alias (`opus` / `sonnet` / `haiku`) from the
lookup table above; on the Claude runtime the alias is passed to `model=` as-is.

If `model_profile` is `"adaptive"`, agents resolve to role-based assignments (opus/sonnet/
haiku based on agent type).

If `model_profile` is `"inherit"`, all agents resolve to `"inherit"` (useful for OpenCode
`/model`).

## Usage

1. Bind the model once — from the `init.*` payload field, or `query resolve-model` when the
   agent type is runtime-determined
2. Declare the bound field on the workflow's parse line
3. Pass `model="{bound_field}"` on each `Agent()` spawn
4. Omit `model=` entirely whenever the bound value is `"inherit"` or empty
