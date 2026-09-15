---
type: Fixed
pr: 0
---
**Seeds minted by parallel workstreams no longer share an id by construction** — `/gsd:capture --seed` derives `SEED-YYMMDD-xxx` from the local date plus a random suffix instead of counting files in `.planning/seeds/`, which each worktree could only do from what had merged, so two workstreams planting before either merged both picked the same id; the residual same-day collision bound (~1 in 46,656 per pair) is the one the `.planning/quick/` scheme already accepts. Existing `SEED-NNN` seeds keep resolving in list, enrich, and the new-milestone scan; `audit`'s seed scan keeps matching every seed file and its acknowledge flow round-trips unchanged (its id display remains filename-derived, as before this change). (#4378)
