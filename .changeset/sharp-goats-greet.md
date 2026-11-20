---
type: Added
pr: 6246
---
**`/gsd:complete-milestone` can remind you to run a security audit before closing** — opt in with `workflow.security_audit_phase` (default `false`): when the key is on and the milestone shows no evidence of a security audit, the close prints a clear non-blocking reminder to run one before finishing. The reminder is tool-agnostic — it suggests whatever audit skill/tooling is installed and reports "no audit tooling available" rather than fabricating results. With the key off the close is unchanged (#6222).
