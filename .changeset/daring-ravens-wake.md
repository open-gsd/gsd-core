---
type: Changed
pr: 1421
---
**`/gsd-review` now asks external reviewers to verify plan claims against the source** — the reviewer prompt requires opening the referenced files, citing `file:line` evidence + mechanism, and tracing asserted behavior, with a graceful-degradation clause for reviewers that have no file access. This turns every capable agentic reviewer into a real second source instead of a plan-text paraphraser. (#1318)
