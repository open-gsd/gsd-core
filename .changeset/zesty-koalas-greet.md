---
type: Fixed
pr: 4507
---
**Capability predicate gates no longer decide on blank phase context** — A predicate gate interpolates `${PHASE_NUMBER}`, `${PHASE_DIR}` and `${PHASE_REQ_IDS}` into its command, and each one its dispatch omitted became an empty string, so the gate decided on the wrong evidence. `plan:post` now forwards the phase number, and `execute:post` now forwards the phase directory and the requirement IDs too. The two remaining sites are tracked in #5289 (`verify:pre`) and #5290 (`execute:wave:post`). (#4483)
