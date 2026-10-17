---
type: Fixed
pr: 5373
---
**Quick task state updates honor the selected workstream** — migration and append no longer target the root STATE.md when a workstream is active, and migration reports a missing scoped state file as an error. (#5051)
