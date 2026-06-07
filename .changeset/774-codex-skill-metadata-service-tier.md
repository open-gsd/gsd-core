---
"@opengsd/gsd-core": patch
---

Changed: emit `service_tier = "flex"` and `model_verbosity = "low"` in the Codex agent TOML for light-tier agents (haiku-class), so the Codex TUI schedules them on the flex tier for lower latency and cost. Also emit `agents/openai.yaml` alongside each installed Codex skill with `interface.display_name` and `interface.short_description`, populating the Codex skill picker chip from the skill's existing short-description frontmatter. (#774)
