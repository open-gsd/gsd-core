---
type: Changed
pr: 6680
---
**`model_overrides.<agent>` accepts a runtime-keyed object** — one committed `.planning/config.json` can now pin `{ "claude": "opus", "codex": "gpt-6-astra" }` for an agent and each host resolves its own entry, instead of a Codex id reaching Claude Code and failing at spawn. A runtime with no key falls through to tier resolution, an object value no longer prints as `[object Object]`, and the install-time baking for Codex, OpenCode and Kilo and the orchestrator-worktree pin select by the runtime being installed or dispatched to. String entries are unchanged; the one adjacent fix is that an agent named like an `Object.prototype` member (`toString`) no longer resolves an inherited function at install time. (#4669)
