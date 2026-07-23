---
type: Added
pr: 2521
---
<!-- docs-exempt: Phase 3 is an internal behavior fallback for `gsd-tools query agent-skills` on non-Claude runtimes — no user-facing command surface or config to document. -->
**`gsd-tools query agent-skills <name>` returns the installed agent's prompt content on non-Claude runtimes** — previously, when a non-Claude runtime (kimi, kimi-code, opencode, kilo, etc.) had no explicit `agent_skills` config entry, `buildAgentSkillsBlock` returned empty and the `${AGENT_SKILLS_*}` workflow injection carried no persona. Phase 3 adds a fallback in `cmdAgentSkills`: on non-Claude runtimes, when the configured block is empty, resolve the runtime's agents directory via `checkAgentsInstalled(runtime)` and read `<agentsDir>/<agentType>.md` as the block. Gated to `runtime !== 'claude'` (Claude supports named dispatch and its `${AGENT_SKILLS_*}` contract is a skills-injection path, not a persona fallback). (#2510)
