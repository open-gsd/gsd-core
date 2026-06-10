---
type: Fixed
pr: 929
---
`cmdSkillManifest` now discovers concrete skills nested under `gsd-ns-*` routers (`<root>/gsd-ns-<router>/skills/<stem>/SKILL.md`), so `gsd-health` and `gsd-settings` report the correct count on nested-layout runtimes (cline, qwen, hermes, augment, trae, antigravity). The scan is scoped to `gsd-ns-*` router dirs only — unrelated user dirs that happen to have a `skills/` subdirectory are not traversed. Dual-routed concretes (same skill installed under two routers) are deduped by name within each root. (#929)
