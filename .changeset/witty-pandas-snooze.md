---
type: Fixed
pr: 5147
---
**Workstream-scoped commands now load the right skills and paths** — a phase started with `--ws <name>` no longer gets an empty or foreign `agent_skills` block (or a wrong-workstream `init.*` bundle) when the session pointer names a different workstream, because every workflow now forwards its `--ws` to each `agent-skills` and `init.*` call. `none` is now a reserved workstream name: `--ws none`, `GSD_WORKSTREAM=none` and `workstream create|set none` fail with a clear error instead of silently resolving `.planning/workstreams/none/` (an existing `none` directory keeps working). (#4772)
