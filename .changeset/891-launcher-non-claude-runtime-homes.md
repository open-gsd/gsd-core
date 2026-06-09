---
type: Fixed
pr: 903
---
**`gsd_run` launcher shim now probes all non-Claude runtime homes before failing.** The shim's last-resort detection previously stopped at `$HOME/.claude`, causing a false-positive fatal error on every non-Claude runtime (Hermes, Cursor, Codex, Copilot, Windsurf, Augment, Trae, Qwen, CodeBuddy, Cline, Grok, Antigravity, OpenCode, Kilo) when `RUNTIME_DIR` was unset and `gsd-tools` was not on `PATH`. The snippet now probes each runtime's config directory (respecting `HERMES_HOME`, `CURSOR_CONFIG_DIR`, `CODEX_HOME`, etc. with sensible `$HOME`-relative defaults) before emitting the install error.
