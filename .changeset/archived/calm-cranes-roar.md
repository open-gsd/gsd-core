---
type: Fixed
pr: 583
---
**Local-install `.sh` hooks no longer fail on Claude Code/Windows** — on a local install, managed `.sh` hooks (`gsd-session-state.sh`, `gsd-validate-commit.sh`, `gsd-graphify-update.sh`, `gsd-phase-boundary.sh`) were emitted wrapped with the absolute Git Bash path. Because Claude Code runs the hook command string inside Git Bash, the explicit `bash.exe` became the binary bash tried to exec → `cannot execute binary file` on every hook event. The local path now drops the `bash.exe` wrapper and emits the `$CLAUDE_PROJECT_DIR`-anchored script path, matching the global install path's #166/#377 guard. (#580)
