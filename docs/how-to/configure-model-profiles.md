# How to configure model profiles

Choose the right model tier strategy for your project, then tune individual agents or entire phase types without writing a large override block. This guide starts with the simplest lever and works up to dynamic routing.

---

## The four profiles (plus `adaptive` and `inherit`)

Set `model_profile` in `.planning/config.json` or via `/gsd-config --profile <name>`:

| Profile | Planner | Executor | Researchers | Verifier | Use when |
|---------|---------|----------|-------------|----------|----------|
| `quality` | Opus | Opus | Opus | Sonnet | Production-quality work where cost is secondary |
| `balanced` | Opus | Sonnet | Sonnet | Sonnet | Normal development — the default |
| `budget` | Sonnet | Sonnet | Haiku | Haiku | Rapid prototyping, cost-sensitive contexts |
| `adaptive` | Opus | Sonnet | Sonnet | Sonnet | Resolves the same way as the other tiers under runtime-aware profiles; use when switching between runtimes frequently |
| `inherit` | (session model) | (session model) | (session model) | (session model) | Non-Anthropic providers (OpenRouter, local models) — all agents follow your current session model |

The table above shows a representative subset. All 33 shipped agents have explicit per-profile tier assignments in `sdk/shared/model-catalog.json`. For the full table see [Model Profiles](../CONFIGURATION.md#model-profiles) in the configuration reference.

**Quick switch via command:**

```bash
/gsd-config --profile balanced   # Normal development
/gsd-config --profile budget     # Prototyping or high-cost phases
/gsd-config --profile quality    # Production release
/gsd-config --profile inherit    # OpenRouter, local models
```

**Or edit `.planning/config.json` directly:**

```json
{
  "model_profile": "balanced"
}
```

---

## Per-agent overrides (`model_overrides`)

If a single agent needs a different tier without changing the whole profile, use `model_overrides`:

```json
{
  "model_profile": "balanced",
  "model_overrides": {
    "gsd-executor": "opus",
    "gsd-codebase-mapper": "haiku"
  }
}
```

Valid values: `opus`, `sonnet`, `haiku`, `inherit`, or any fully-qualified model ID (e.g. `"openai/o3"`, `"google/gemini-2.5-pro"`).

`model_overrides` can be set per-project in `.planning/config.json` or globally in `~/.gsd/defaults.json`. Per-project entries win on conflict; non-conflicting global entries are preserved.

**Important for Codex and OpenCode:** Those runtimes embed the resolved model into each agent's static config at install time. After editing `model_overrides`, re-run the installer for the change to take effect:

```bash
npx @opengsd/gsd-core@latest --codex --global   # or --opencode, --kilo, etc.
```

---

## Per-phase-type models (`models`)

If you want to say "Opus for planning, Sonnet for everything else" without learning all 33 agent names, use the `models` block. It maps six phase types to tier aliases:

```json
{
  "model_profile": "balanced",
  "models": {
    "planning":      "opus",
    "discuss":       "opus",
    "research":      "sonnet",
    "execution":     "opus",
    "verification":  "sonnet",
    "completion":    "sonnet"
  }
}
```

Phase types and their agents:

| Phase type | Agents covered |
|---|---|
| `planning` | `gsd-planner`, `gsd-roadmapper`, `gsd-pattern-mapper` |
| `research` | `gsd-phase-researcher`, `gsd-project-researcher`, `gsd-research-synthesizer`, `gsd-codebase-mapper`, `gsd-ui-researcher` |
| `execution` | `gsd-executor`, `gsd-debugger`, `gsd-doc-writer` |
| `verification` | `gsd-verifier`, `gsd-plan-checker`, `gsd-integration-checker`, `gsd-nyquist-auditor`, `gsd-ui-checker`, `gsd-ui-auditor`, `gsd-doc-verifier` |
| `discuss`, `completion` | Reserved — no subagent today; accepted by schema for forward compatibility |

The `models` block accepts tier aliases only (`opus`, `sonnet`, `haiku`, `inherit`). For a fully-qualified model ID, use `model_overrides` per agent instead.

**Combining `models` with a per-agent exception:**

```json
{
  "model_profile": "balanced",
  "models": {
    "research": "sonnet"
  },
  "model_overrides": {
    "gsd-codebase-mapper": "haiku"
  }
}
```

All five research agents resolve to `sonnet` *except* `gsd-codebase-mapper`, which is pinned to `haiku`.

---

## Dynamic routing — start cheap, escalate on failure

If you want to pay for cheaper tiers by default and only escalate when an agent fails a quality gate, enable `dynamic_routing`:

```json
{
  "dynamic_routing": {
    "enabled": true,
    "tier_models": {
      "light":    "haiku",
      "standard": "sonnet",
      "heavy":    "opus"
    },
    "escalate_on_failure": true,
    "max_escalations": 1
  }
}
```

Each agent has a default tier (`light`, `standard`, or `heavy`). On the first attempt, GSD picks `tier_models[default_tier]`. If the orchestrator detects a soft failure (verification inconclusive, plan-check flagged, etc.), it re-spawns the agent one tier up. `max_escalations` caps the total retries.

Agents that already sit at `heavy` cannot escalate further.

**Turning off escalation while keeping dynamic resolution:**

```json
{
  "dynamic_routing": {
    "enabled": true,
    "escalate_on_failure": false
  }
}
```

Every attempt uses `tier_models[default_tier]` regardless of outcome — useful when you want explicit tier-to-model mapping without the escalation behaviour.

`dynamic_routing` is **disabled by default**. Omitting the block or setting `enabled: false` preserves static resolution.

---

## Using GSD on non-Anthropic runtimes

If you installed GSD for Codex, OpenCode, Gemini CLI, or Kilo, the installer already set `resolve_model_ids: "omit"` in your config. This tells GSD to skip Anthropic model ID resolution and let the runtime choose its own default model. No manual setup is needed for the basic case.

**If you want tiered models on Codex:**

```json
{
  "runtime": "codex",
  "model_profile": "balanced"
}
```

GSD resolves each tier alias to the Codex-native model and reasoning effort defined in the runtime tier map.

**If you want per-agent model IDs on any non-Claude runtime:**

```json
{
  "resolve_model_ids": "omit",
  "model_overrides": {
    "gsd-planner":   "o3",
    "gsd-executor":  "o4-mini",
    "gsd-debugger":  "o3"
  }
}
```

For the full runtime-aware profiles reference and the `model_policy` surface (provider-neutral presets added in v1.42), see [Configuration reference — Model Profiles](../CONFIGURATION.md#model-profiles).

---

## Resolution precedence (highest to lowest)

When multiple layers apply, the resolver picks the highest-priority entry:

```text
1. model_overrides[<agent>]           — per-agent; full IDs; targeted exception
2. dynamic_routing.tier_models[<tier>] — when enabled; escalates on soft failure
3. models[<phase_type>]               — coarse phase-level tier
4. model_profile (per-agent column)   — global tier strategy
5. Runtime default                    — when nothing else applies
```

---

## Choosing the right lever

| You want | Use |
|---|---|
| One tier strategy for all agents | `model_profile` |
| Coarse phase-level tuning ("Opus for planning") | `models.<phase_type>` |
| Per-agent precision ("force Haiku on the codebase mapper") | `model_overrides[<agent>]` |
| A fully-qualified model ID for a specific agent | `model_overrides[<agent>]: "openai/gpt-5"` |
| Start cheap, escalate only on failure | `dynamic_routing` |
| All agents follow the session model (non-Anthropic provider) | `model_profile: "inherit"` |

---

## Related

- [Configuration reference](../CONFIGURATION.md)
- [Multi-agent orchestration](../explanation/multi-agent-orchestration.md)
- [Commands reference](../COMMANDS.md)
- [Docs index](../README.md)
