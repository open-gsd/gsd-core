---
type: Fixed
pr: 138
---
`config-get workflow.nyquist_validation` calls in validate-phase and audit-milestone now include `--default true`, preventing stderr noise and fragile empty-variable fallback when the key is absent.
