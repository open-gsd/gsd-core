---
type: Added
pr: 2471
---
**Reversibility tagging for planning decisions** — decisions can now be rated `reversible`, `costly`, or `one-way` by how expensive they are to undo. A `one-way` decision (one whose undo needs a data migration, breaks a published contract, or is impossible) earns a `checkpoint:decision` before the task that implements it, so an unattended run pauses for your sign-off instead of walking through the door. `costly` decisions are flagged in the plan without blocking; `reversible` ones flow as before. Pass `--no-reversibility-gates` to `/gsd:plan-phase` to suppress the checkpoint on runs you mean to leave unattended — ratings are still recorded either way. (#1951)
