---
type: Fixed
pr: 0
---
**A plan routed to a specialist executor with `agent_hint:` is now held to the same worktree isolation and model rules as `gsd-executor`** — before, the isolation guards let a hinted executor run in the primary checkout even when the phase required a worktree, it got `gsd-executor`'s model instead of its own `model_overrides` entry, and a hint naming a GSD role such as `gsd-verifier` was dispatched as the executor; such hints are now refused with a warning; while a fail-closed case holds (for example a malformed record file), host built-in agents such as Explore are also held to the worktree rule (#6213).
