---
type: Fixed
pr: 5453
---
`phase complete` now lists, in `warnings[]`, an active `verify:post` audit (SECURITY.md, VALIDATION.md) that is missing, still `draft`, or has open threats, so a phase no longer closes silently with the audit unrun (#4972)
