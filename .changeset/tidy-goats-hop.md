---
type: Fixed
pr: 2312
---
**Codex agents no longer fail to launch with an unsupported-model error** — GSD was writing an Anthropic tier name (`opus`/`sonnet`/`haiku`/`fable`) or a `claude-*` id into each Codex agent's `.toml` `model` field, which Codex rejects — fatally on a ChatGPT account (`The 'sonnet' model is not supported when using Codex with a ChatGPT account`). GSD now never writes an Anthropic-flavored model to a Codex agent: an explicit real-Codex model pin is kept, anything else is omitted so the agent inherits the working session model. (#2310)
