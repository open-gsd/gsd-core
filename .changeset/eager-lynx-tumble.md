---
type: Fixed
pr: 6314
---
**An agentless Codex install no longer makes every reinstall report phantom local patches** — the install hashed its file manifest before the Codex `@~/.claude/gsd-core/` include rewrite (and the Kimi/Copilot/Antigravity include retarget) changed those files, and only the agent-roles branch re-hashed afterwards, so reinstalls backed up ~100 untouched files into `gsd-local-patches/` and told the user to run `$gsd-update --reapply`; the manifest is now re-hashed after the rewrites. (#5954)
