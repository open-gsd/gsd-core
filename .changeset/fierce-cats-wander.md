---
type: Fixed
pr: 5399
---
**Graphs now rebuild after commits made by GSD workflows** — unflagged `query commit` calls through the shipped GSD launchers now trigger auto-update under the existing opt-in, default-branch, and live-lock rules. Global-flag forms remain excluded until the hook can resolve their target checkout safely (#5935).
