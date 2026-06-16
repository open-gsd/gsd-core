---
type: Changed
pr: 1313
---
**Graphify now respects surface/profile state, not just `graphify.enabled`** — `gsd-tools graphify` is off unless graphify is installed AND surfaced AND `graphify.enabled` is true (previously only the config key was checked). The gate is now runtime-aware: Codex/Cursor/etc. read their own runtime's surface instead of `~/.claude`. (#1313)
