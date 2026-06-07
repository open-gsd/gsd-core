---
type: Added
pr: 0
---
The GitHub Copilot installer now reaches lifecycle-hook and instruction parity with other first-class runtimes. It emits a self-contained `sessionStart` hook config (`.github/hooks/gsd-session.json` for local installs, `~/.copilot/hooks/gsd-session.json` for global) and writes `AGENTS.md` at the repository root (which Copilot CLI reads as primary instructions) alongside `copilot-instructions.md`. The hook is an inline `command` hook with no separate script file, so it cannot dangle. Both artifacts are removed — with user-authored content preserved — on `--uninstall`. (#786)
