---
type: Changed
pr: 883
---
**Namespace router skills now nest their concrete sub-skills at install time (#69).** On runtimes with non-recursive skill loaders (Claude global, Cline, Qwen, Hermes, Augment, Trae, Antigravity) the installer emits the 6 `gsd-ns-*` routers as the only top-level skill bundles and nests the ~61 concrete skills under `<router>/skills/<name>/SKILL.md`, cutting the eager skill-listing overhead to ≈6 entries. Concrete skills stay reachable via the router's `Read skills/<name>/SKILL.md` routing table. **Breaking:** on those runtimes the concrete skills are no longer invocable by bare name through the Skill tool / top-level listing — route via the namespace router (or the unchanged `/gsd-*` slash command where a commands surface exists). Legacy top-level `gsd-<concrete>/` skill dirs are removed on upgrade. Recursive/unconfirmed loaders (Cursor, Codex, Copilot, Windsurf, CodeBuddy, OpenCode, Kilo) keep the flat layout.
