---
type: Added
pr: 754
---
**New `agent_skills_security.trusted_global_roots` config** — opt-in allowlist of trusted root directories so symlinked `global:` agent skills whose real path resolves outside the default skills dir (e.g. `~/.claude/skills`) are accepted; default `[]` is byte-identical and preserves the symlink-escape guard.
