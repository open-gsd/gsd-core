---
type: Added
pr: 1848
---
**Claude Sonnet 5 is now the `standard` (sonnet) tier model.** The model catalog and provider presets resolve the sonnet/standard tier to `claude-sonnet-5` (GA 2026-06-30) across the Anthropic-backed runtimes (`claude`, `copilot`, and the `anthropic`/`anthropic-fable` presets), plus the OpenRouter-style `anthropic/claude-sonnet-5` for `opencode`/`hermes`, replacing the superseded `claude-sonnet-4-6`. Opus and Haiku tier defaults are unchanged (the `haiku` high-effort preset's escalation slot tracks the current sonnet model). Shipped in 1.6.1. (#1847) (#1848)
