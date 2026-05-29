---
type: Added
pr: 463
---
**Effort and fast-mode routing controls (Opus 4.8)** — GSD resolves a universal `effort` level (minimal–max, default high) and an orthogonal `fast_mode` toggle per agent via config (`effort.default`/`effort.routing_tier_defaults`/`effort.agent_overrides` and the `fast_mode.*` equivalents), rendered to each runtime's native parameter (Claude `output_config.effort` / subagent `effort` frontmatter; Codex `model_reasoning_effort`) with cross-provider clamping. New `query resolve-execution` exposes the resolved execution profile.
