---
type: Changed
pr: 828
---
Codex CLI installs now emit two enrichments per agent and skill. **Agent TOML enrichment:** light-tier agents (haiku-equivalent, `routingTier: "light"` in model-catalog.json) get `service_tier = "flex"` and `model_verbosity = "low"` appended to their agent TOML, telling the Codex scheduler to use the flex tier (lower cost, background processing) and suppress verbose token output. **Skill TUI chip:** each installed `gsd-*` skill directory now receives an `agents/openai.yaml` file with `interface.display_name` and `interface.short_description`, making the skill appear in the Codex `/skills` picker with a human-readable name and description drawn from the skill's existing short-description frontmatter. Both enrichments are additive and backward-compatible with Codex CLI ≥ 0.130.0. (#774)
