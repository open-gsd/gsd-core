---
type: Fixed
pr: 4644
---
**`execute-phase` no longer fails on a decimal or multi-segment phase** — an inserted phase (`01.1`) or an N-segment phase (`23.1.2`) hit a hard shell arithmetic syntax error at the very first gate (`safe_resume_gate`, which runs unconditionally before any executor dispatches), aborting the workflow before it could do anything. The phase number's leading integer segment is now zero-stripped for the commit-scope regex while the rest is kept as an escaped-dot string, instead of forcing the whole value through base-10 arithmetic. A plain integer phase is unaffected. (#4619)
