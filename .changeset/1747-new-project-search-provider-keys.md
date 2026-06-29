---
type: Fixed
pr: 1814
---
**`/gsd-settings` no longer warns about four search-provider keys on fresh projects (#1747)** — `buildNewProjectConfig` emits seven search-provider availability flags and `research-provider.cts` `providerAvailability()` consumes all seven, but only three were registered in `VALID_CONFIG_KEYS` (`config-schema.manifest.json`). Running `/gsd-settings` on a freshly generated `.planning/config.json` printed `unknown config key(s) … tavily_search, ref_search, perplexity, jina — these will be ignored` even though the user never hand-edited the config. The four missing keys are now registered alongside `brave_search`/`firecrawl`/`exa_search` and documented in `docs/CONFIGURATION.md`; a drift guard in `tests/bug-2530-valid-config-keys.test.cjs` now requires every config-driven research-provider flag to be in the schema, so a future provider addition cannot reintroduce the drift.
