---
type: Fixed
pr: 6704
---
**The plan-time API-coverage checkpoint detects external-API integrations on global installs again** — the plan:pre detector call was cwd-relative (`node gsd-core/bin/lib/api-coverage.cjs`), so in a project without a local `gsd-core/` folder node failed, the error was swallowed, and the checkpoint silently skipped itself as `probe_unavailable`; the snippet now resolves the shipped `lib/api-coverage.cjs` through the `gsd_run` launcher's own lookup (PATH-resolved, symlinks followed, `$GSD_TOOLS` as the same-shell shortcut) and prints a visible error naming the path when no install is reachable, instead of a silent skip. (#6503)
