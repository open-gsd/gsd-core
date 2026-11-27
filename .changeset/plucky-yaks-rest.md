---
type: Added
pr: 0
---
**`state session-resume`, `state sessions` and `state record-session --session` track pause per session** — two sessions on one `.planning/` can now each keep a handoff, resume only their own, and see who is paused, instead of sharing one project-wide handoff. A session id comes from `--session` or a runtime key (never a terminal), a role survives `/clear`, and `record-session` without `--session` is unchanged. (#6796)
