---
type: Fixed
pr: 2312
---
**Codex agents no longer fail to launch with an unsupported-model error** — GSD was writing an Anthropic tier name (e.g. `sonnet`) or a `claude-*` id into each Codex agent's `.toml` `model` field, which Codex rejects — fatally on a ChatGPT account (`The 'sonnet' model is not supported when using Codex with a ChatGPT account`). Tier aliases now resolve to the correct Codex model and Anthropic-flavored values are never written. (#2310)
