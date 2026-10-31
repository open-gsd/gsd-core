---
type: Added
pr: 0
---
**`/gsd-code-review` now flags code that guards against problems your stack cannot have** — at standard and deep depth the reviewer reports necessity findings (impossible-state guards, concerns another layer already owns, cargo-culted patterns, lapsed requirements, single-use abstractions) as evidence-backed Warning or Info findings. `--fix` leaves them alone and `--fix --all` removes them, and `--fix --auto` stops once nothing is left in the fix scope instead of re-running to its iteration cap. (#4100)
