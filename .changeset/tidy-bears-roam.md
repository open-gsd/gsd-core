---
type: Fixed
pr: 6260
---
**A project-local agents directory or manifest that is a symlink or junction is now followed** — `init new-project` and `init new-milestone` reported `agents_installed: false` and fell back to the global agents dir for a project that links one shared GSD install, because the local probe used `lstat`. A link now resolves to the local install when a manifest is present, and a dangling link still falls back to the global dir. (#5911)
