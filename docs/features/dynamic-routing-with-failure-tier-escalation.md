---
id: 127
title: Dynamic Routing with Failure-Tier Escalation
group: v1.41.0 Features
---

**Purpose:** Pay for the cheap tier by default; escalate to a more capable model automatically when the orchestrator detects a soft failure (verification inconclusive, plan-check FLAG, etc.).

**Config key:** `dynamic_routing` in `.planning/config.json`

**Behavior:**
- `enabled: false` (default) — feature is off; all agents use the precedence chain unchanged.
- `enabled: true` — the resolver picks `tier_models[default_tier]` for the first spawn and escalates one tier up on orchestrator-detected soft failure, capped by `max_escalations`.

**Composition:** `model_overrides` always wins; `dynamic_routing.tier_models[<tier>]` resolves above `models.<phase_type>` and `model_profile`. On the first spawn, and on any respawn that does not move the tier, a `model_policy` preset, a non-Claude runtime's tier map, and a `model_profile_overrides.claude` pin also outrank `tier_models`. So `resolve-execution --attempt 0` reports the same model as `resolve-model` (#6214).

Under an explicit project `resolve_model_ids: "omit"` on Claude Code, routing still picks and escalates the tier, but the resolver returns that tier's alias (`haiku` / `sonnet` / `opus`) rather than the `tier_models` value (#3703). On a runtime without native tier aliases or a tier map, an applied `"omit"` stays blank on every attempt. `provider_escalation` is skipped on Claude Code and wherever the `"omit"` left the model blank.

**Requirements:**
- REQ-DYNROUTE-01: `dynamic_routing.enabled` acts as a master switch; when `false` or block is absent, zero behavior change.
- REQ-DYNROUTE-02: New resolver `resolveModelForTier(cwd, agent, attempt)` in `core.cjs` is the single call-site for orchestrator integration.
- REQ-DYNROUTE-03: `max_escalations` caps the escalation chain to prevent runaway cost.

**Reference issue:** [#3024](https://github.com/open-gsd/gsd-core/pull/3031)
