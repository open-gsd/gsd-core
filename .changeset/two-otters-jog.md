---
type: Fixed
pr: 2499
---
**pi no longer silently hijacks non-Anthropic providers' model choices** — `pi/gsd.cjs`'s `before_provider_request` handler unconditionally rewrote `payload.model` to the built-in pi/sonnet tier default (`claude-sonnet-5`) via the model-catalog fallback, breaking every outgoing request for pi users on non-Anthropic providers (kimi-coding, zai, openrouter, openai-codex, minimax). The handler now inspects `model_profile_overrides.pi[tier]` explicitly *before* calling `resolveTierEntry` (whose catalog fallback previously masked the "user did not opt in" signal) and fail-opens (`return undefined`) when the user has not set an override — including explicit `null` and `''` (clearing a previously-set value). An explicit opt-in via `model_profile_overrides.pi[tier]` still steers, preserving the legitimate use case. (#2460)
