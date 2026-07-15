---
type: Fixed
pr: 2302
---
**Claude Code installs now pre-approve `.planning/` and `STATE.md` writes** — the installer wrote `Write(.planning/*)`/`Write(STATE.md)` permission rules, but Claude Code has no standalone `Write` gate (file edits are gated via `Edit(pattern)`), so those rules never matched and every fresh install still hit first-run approval prompts (and a session-start warning). The installer now writes `Edit(...)` rules and migrates the stale `Write(...)` entries away on the next run. (#2278)
