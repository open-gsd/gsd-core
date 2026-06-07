---
type: Fixed
pr: 814
---
Honor the `COPILOT_HOME` environment variable when resolving the GitHub Copilot global config directory. Previously a global `--copilot` install ignored `COPILOT_HOME` and wrote all artifacts (skills, agents, `copilot-instructions.md`, the session hook) to `~/.copilot` even when the user had relocated their Copilot home, making them undiscoverable by Copilot CLI. Resolution now follows `--config-dir` > `COPILOT_CONFIG_DIR` > `COPILOT_HOME` > `~/.copilot`, mirroring the existing `CODEX_HOME` handling. Uninstall uses the same resolver and stays symmetric. (#812)
