---
name: gsd-mempalace-recall
description: "Recall decisions, patterns, and surprises from MemPalace before planning"
argument-hint: "[phase-slug]"
allowed-tools:
  - Read
  - Write
  - Bash
---


**STOP -- DO NOT READ THIS FILE. You are already reading it. This prompt was injected into your context by the command system. Using the Read tool on this file wastes tokens. Begin executing Step 0 immediately.**

## Step 0 -- Banner

**Before ANY tool calls**, display this banner:

```
GSD > MEMPALACE RECALL
```

Then proceed to Step 1.

## Step 1 -- Config Gate

Check whether the MemPalace capability is enabled by reading `.planning/config.json` directly with the Read tool.

**DO NOT use `gsd-tools config get-value`** -- it hard-exits on missing keys.

1. Read `.planning/config.json` with the Read tool.
2. If the file does not exist: write the "unavailable" stub (Step 4) and **STOP**.
3. Parse the JSON. Proceed to Step 2 only if `config.mempalace && config.mempalace.enabled === true` **and** `config.mempalace.recall_on_plan !== false`. Otherwise display the disabled message and **STOP** (`recall_on_plan: false` turns plan-time recall off while leaving the rest of the capability enabled).

**Disabled message:**

```
GSD > MEMPALACE RECALL

MemPalace memory is disabled. To activate:

  node <runtime-home>/gsd-core/bin/gsd-tools.cjs config-set mempalace.enabled true

Recall is opt-in; the loop proceeds normally without it.
```

This step is `onError: skip` at `plan:pre` -- recall never blocks planning.

## Step 2 -- Resolve wing, mode, and transport

1. **Wing.** Use `config.mempalace.wing` if non-empty; otherwise derive from `config.project_code`; otherwise fall back to the repository directory name.
2. **Mode.** Read `config.mempalace.memory_mode` (`augment` | `kg_backend` | `replace`, default `augment`). Only `augment` is wired today, so recall always treats the palace as additive; `kg_backend`/`replace` are forward-declared and behave as `augment`.
3. **Transport.** Prefer the **MCP tools** (`mempalace_*`) in interactive runs *when your MemPalace MCP server is registered and your runtime permits those tools*. Otherwise — headless/cron/autonomous runs, or runtimes that don't grant the MemPalace MCP tools — use the **CLI** (`mempalace wake-up`, `mempalace search`), which this skill's `Bash` allow-tool always covers. If neither is reachable, go to Step 4.
4. **Topic.** Read the phase `CONTEXT.md` (the consumed artifact). Derive a short search query from its title, goal, and key decisions.

## Step 3 -- Retrieve (read-only)

All calls in this step are side-effect-free. On any error or timeout, stop retrieving and write whatever was gathered (or the stub) -- never raise.

1. **Wake up** (cheap, ~600--900 tokens):
   - Interactive: read the wing identity/summary, then `mempalace_search`.
   - Headless: `mempalace wake-up --wing <wing>`.
2. **Targeted search:**
   - Interactive: `mempalace_search(query=<topic>, wing=<wing>)`.
   - Headless: `mempalace search "<topic>" --wing <wing>`.
3. **Knowledge-graph facts** (when `config.mempalace.mirror_kg` is true): `mempalace_kg_query` / `mempalace_kg_timeline` for decisions relevant to the topic and their validity windows. Only `augment` is currently wired, so the palace KG *supplements* GSD's native `.planning/graphs/` — do not treat it as the sole source. (`kg_backend`/`replace` are forward-declared and behave as `augment` today.)
4. **Dedup** the returned drawers/facts; keep the top results.

## Step 4 -- Write MEMORY-RECALL.md

Write `MEMORY-RECALL.md` in the current phase directory. The planner consumes it.

When recall succeeded, structure it as:

```markdown
# Memory Recall (MemPalace)

_Wing: <wing> · Mode: <mode> · Transport: <mcp|cli>_

## Prior decisions
- <decision> — <provenance: drawer id / kg fact, valid_from>

## Patterns
- <pattern> — <provenance>

## Surprises / gotchas
- <surprise> — <provenance>
```

When MemPalace is unreachable, write the stub and continue:

```markdown
# Memory Recall (MemPalace)

_MemPalace unavailable at recall time — proceeding without recalled memory._
```

## Anti-Patterns

1. DO NOT let any MemPalace error fail the step -- recall is `onError: skip`.
2. DO NOT write to the palace from this skill -- recall is read-only; capture is a separate skill.
3. DO NOT paste raw search output into the file -- distil to decisions/patterns/surprises with provenance.
4. DO NOT skip the config gate.
