---
type: Added
pr: 1767
---
**Plural/optional/chosen assumption-delta checkpoint during planning** — when a phase makes something plural, optional, or chosen that used to be singular, required, or derived, the planner is now prompted to re-ask whether the primary key / identity model still names the right thing, preventing silent architectural drift from accumulating into a later user-facing bug. Advisory (non-blocking); fires only on a detected signal. Toggle with workflow.assumption_delta. (#1561)
