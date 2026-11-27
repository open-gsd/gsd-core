---
type: Fixed
pr: 6186
---
**`state advance-plan` no longer rewrites STATE.md when it refuses** — the `plan_position_unreadable` and `ambiguous_plan_position` refusals returned a re-assembled document, so the no-op guard did not fire and the sync step then rewrote the file (frontmatter re-quoted, synced fields added, and on the ambiguous path `current_plan` written with one of the two conflicting values). Every refusal now leaves STATE.md byte-identical; the `last_plan` decline still writes the phase-complete status. (#6168)
