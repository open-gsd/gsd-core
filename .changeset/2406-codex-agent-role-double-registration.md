---
type: Fixed
pr: 0
---
**Codex installer no longer double-registers each agent role in `config.toml`, eliminating one duplicate-role startup warning per agent** — `generateCodexConfigBlock` stopped emitting `[agents.gsd-*]` tables whose `config_file` pointed back at the same standalone TOMLs Codex already auto-discovers under `$CODEX_HOME/agents/`; reinstalling over an existing config also drops any legacy managed role tables left by a prior install while preserving unrelated user config and the user's own AgentsToml scalars. (#2406)
