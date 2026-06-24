---
type: Fixed
pr: 1655
---
**`phase complete` no longer double-counts Total plans completed velocity on re-run** — re-running `phase complete` on an already-complete phase incremented the velocity total each time (2 -> 4 -> 6 ...), because the metric re-read the cumulative total and blind-added the phase's plan count on every invocation. The total is now derived from the By-Phase table's Plans column (the same source the table upserts against), so re-completing a phase upserts the same row and the sum stays stable — and a hand-edited inflated total self-heals to the true sum on the next completion. (#1582)
