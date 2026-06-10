---
type: Fixed
pr: 921
---
**`/gsd-plan-phase`, `/gsd-execute-phase`, `/gsd-autonomous` no longer carry `context: fork`** — these are spawning orchestrators; a forked subagent context has no `Agent` tool, preventing them from spawning the subagents they require. `effort: xhigh` is preserved. Fixes `/gsd:autonomous` halting with "running as a forked subagent" on 1.4.1 (#921). Also replaces the introspection-based Agent-availability check in `plan-phase`'s `<runtime_compatibility>` block with an attempt-based gate: the workflow now always attempts the `Agent()` call and only stops if a real tool-unavailable error is returned, eliminating false-negative aborts in top-level sessions (#922).
