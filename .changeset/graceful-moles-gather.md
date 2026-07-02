---
type: Fixed
pr: 1873
---
Executor and milestone-summary/forensics workflows now call state.* commands with named flags so the named-only router records metrics, decisions, blockers, and session continuity instead of silently dropping positional args.
