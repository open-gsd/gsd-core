---
type: Fixed
pr: 1207
---
**Claude Code plugin installs no longer fail with empty `@~/.claude/gsd-core/...` includes** — agents, commands, and templates `@`-include the canonical `~/.claude/gsd-core/` path, but a marketplace plugin install (`claude plugin install`) never creates that directory, so every include resolved to nothing and agents (e.g. the executor) failed. A new `SessionStart` hook (`gsd-ensure-canonical-path.js`) symlinks the canonical path's immutable subdirs (`bin`, `contexts`, `references`, `templates`, `workflows`) to the plugin's bundled tree. It is a no-op in classic `bin/install.js` installs, preserves user-generated files (e.g. `USER-PROFILE.md`), prunes stale links so it self-heals after `claude plugin update`, and uses Windows junctions. (#1207)
