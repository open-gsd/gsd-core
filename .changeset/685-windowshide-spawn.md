---
type: Fixed
pr: 0
---
**No more "gsd-core" console-window flash on Windows.** Every gsd-core child process now passes `windowsHide: true`: the context monitor's `record-session` spawn, the `execGit` / `execNpm` / `execTool` helpers in `shell-command-projection`, the `gsd-worktree-path-guard` and `gsd-workflow-guard` hook git probes, `check-command-router`'s `git log` call, and the `roadmap-upgrade` git status/rev-parse/reset/clean calls — matching the existing `gsd-check-update` spawn. `execNpm` (which uses `shell: true` → `cmd.exe` and runs on every SessionStart, i.e. every `/clear`) and the worktree-path guard (which runs on every Edit/Write in a worktree) were the most visible offenders. No behavior change on macOS/Linux, where the flag is ignored.
