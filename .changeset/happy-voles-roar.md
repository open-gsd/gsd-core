---
type: Fixed
pr: 1288
---
**Researcher agents can now invoke Perplexity** — `gsd-phase-researcher` and `gsd-project-researcher` referenced `mcp__perplexity__*` in their provider dispatch tables but never granted it in their `tools:` allowlist, so Perplexity web research silently fell through to the next provider. The grant is now generated from the researcher profiles, with a parity guard that fails if a future dispatch-table provider is added without its tool grant. (#1284)
