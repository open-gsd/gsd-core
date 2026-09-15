---
type: Fixed
pr: 4754
---
**Seeds minted by parallel workstreams no longer share an id by construction** — `/gsd:capture --seed` derives `SEED-YYMMDD-xxx` from the local date plus a random suffix instead of counting files in `.planning/seeds/`, which each worktree could only do from what had merged, so two workstreams planting before either merged both picked the same id; the residual same-day collision bound (~1 in 46,656 per pair) is the one the `.planning/quick/` scheme already accepts. Existing `SEED-NNN` seeds keep resolving in list, enrich, the new-milestone scan, and audit — whose scan now publishes the same canonical id as `list-seeds` and whose acknowledge resolves either id to the same file. (#4378)
