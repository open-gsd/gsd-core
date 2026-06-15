---
type: Added
pr: 1261
---
**`agent_skills` can now reference Claude-Code plugin-provided skills** via the namespaced `global:<plugin>:<skill>` form (e.g. `global:coderabbit:code-review`). On the Claude runtime the agent's skills block emits a by-name Skill-tool load directive that resolves the plugin skill (no plugin-cache path is read); path-resolvable skills keep the existing `@`-include unchanged; on non-Claude runtimes a namespaced entry is skipped with a warning. The 22 agent_skills-consumer agents now carry the `Skill` tool so they can load plugin-provided skills.
