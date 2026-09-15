---
type: Added
pr: 4698
---
**Existing projects can now migrate legacy or milestone-prefixed phase IDs to the bracket convention** — `roadmap upgrade --convention bracket` previews by default, requires a project code, rewrites matching ROADMAP headings/checklists and phase directories, records `phase_id_convention: "bracket"` only on apply, refuses dirty trees, and surgically restores ignored `.planning/` bytes if an apply fails. (#612)
