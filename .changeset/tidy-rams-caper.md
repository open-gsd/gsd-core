---
type: Fixed
pr: 4934
---
**`phase-plan-index` now reports each plan's `gap_closure` value**, so `/gsd-execute-phase N --gaps-only` runs the gap-closure plans instead of selecting none and exiting with a success message; the `--gaps-only` rule now stops with an error, rather than reporting an empty selection, when the index carries no `gap_closure` key. (#4924)
