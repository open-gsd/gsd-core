---
type: Fixed
pr: 1363
---

**Codex `hooks.json` is now always written in the nested `{ "hooks": { … } }` shape Codex expects** — the writer previously echoed back whatever shape it read, so an empty, absent, or legacy top-level `hooks.json` (`{ "SessionStart": [...] }`) stayed in the legacy shape that current Codex can reject or warn on. Every write now canonicalizes to the nested form, lifting any legacy top-level event entries (including mixed nested+top-level files) under `hooks` without dropping user-owned entries. Managed-hook dedup/removal is unchanged. (#1348)
