---
type: Added
pr: 1798
---
**`/gsd:next` smart-entry workflow** — adds a state-aware entry point that classifies the current project situation (no-project, blocked, verify-failed, planning, executing, verify-pending, complete, and more) and recommends the right next GSD command. The `gsd-tools smart-entry [--json]` classifier handles phase ordering including decimal phase IDs; the `/gsd:next` skill surfaces the workflow with tiered fallback behavior.
