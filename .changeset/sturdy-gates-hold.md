---
type: Changed
pr: 5126
---
**`query dispatch-isolation` answers `none` while it holds a sequential degrade an earlier dispatch step recorded** — for up to ten minutes after a step records `none` with `--force-isolation`, a plain query whose `--phase` and `--plan`, where it passes non-empty ones, equal the record's prints `none`, not the runtime's isolation capability. Under `--json` it marks that answer `held: true`; a query that is not holding gives `held: false`, and so does `inspect-dispatch-isolation`, which is never held. The isolation sentinel gains a `decided_by` field (`caller` or `resolver`) naming who recorded the decision. A script that reads this query's stdout as the runtime's capability should read `inspect-dispatch-isolation` instead. (#4904)
