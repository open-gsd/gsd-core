---
type: Fixed
pr: 397
---
State handlers (`record-session`, `advance-plan`, `planned-phase`) now preserve executor-authored STATE.md field values instead of overwriting them with template defaults. Introduces explicit field-ownership via `KNOWN_TEMPLATE_DEFAULTS` and `stateReplaceFieldIfTemplate`. Fixes a data-loss shape where hand-authored Resume File / Status / Last Activity values were silently lost on the next state-handler call.
