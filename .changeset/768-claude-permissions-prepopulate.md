---
type: Added
pr: 819
---
**Installer pre-populates `permissions.allow`/`deny` for Claude Code** — fresh Claude Code installs now receive GSD's known-safe tool-call patterns (`Bash(npx gsd-core *)`, `Read(.planning/*)`, `Write(.planning/*)`, `Read(STATE.md)`, `Write(STATE.md)`) in `settings.json` out of the box, eliminating first-run approval prompts. A `deny` block for credential files (`Read(.env)`, `Read(.env.*)`, `Read(.secrets)`) is also added for defense-in-depth. The merge is additive and idempotent; existing user-set entries are preserved. Uninstall removes only GSD-owned entries. (#768)
