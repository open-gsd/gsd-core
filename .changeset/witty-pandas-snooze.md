---
type: Fixed
pr: 0
---
**Workstream-scoped commands now load the right skills and paths** — a phase started with `--ws <name>` no longer gets an empty or foreign `agent_skills` block (or a wrong-workstream `init.*` bundle) when the session pointer names a different workstream, because every workflow now forwards its `--ws` to each `agent-skills` and `init.*` call. (#4772)
