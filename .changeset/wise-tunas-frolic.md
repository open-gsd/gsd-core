---
type: Changed
pr: 0
---
**`model_overrides.<agent>` accepts a runtime-keyed object** — one committed `.planning/config.json` can now pin `{ "claude": "opus", "codex": "gpt-6-astra" }` for an agent and each host resolves its own entry, instead of a Codex id reaching Claude Code and failing at spawn. A runtime with no key falls through to tier resolution, an object value no longer prints as `[object Object]`, and the install-time baking for Codex, OpenCode and Kilo, the orchestrator-worktree pin and the Cline binding select by the runtime being installed or dispatched to. String entries are unchanged. (#4669)
