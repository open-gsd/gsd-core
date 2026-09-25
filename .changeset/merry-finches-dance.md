---
type: Fixed
pr: 4888
---
**Installed agents no longer cite reference files at a path that does not exist** — 11 `@gsd-core/references/<x>.md` pointers in `gsd-debugger`, `gsd-planner`, `gsd-plan-checker` and `gsd-verifier` now use the installed-path form the installer rewrites, so the 8 references they address (planner, verifier, plan-checker and debugger guidance) load after install; a test refuses the bare form in `agents/` and reports any pointer that does not name a reference whole, and `check-contract-drift` follows the bare, `~/.claude`, `$HOME/.claude` and project-relative include spellings rather than one. (#4841)
