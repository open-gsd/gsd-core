---
type: Fixed
pr: 1687
---
The `verify-work` security-blocked presentation no longer offers next-phase planning. When security enforcement blocks phase advancement (no `SECURITY.md` produced), the workflow now routes only to the current-phase fix instead of competing `/gsd:plan-phase {next}` and `/gsd:execute-phase {next}` options.
