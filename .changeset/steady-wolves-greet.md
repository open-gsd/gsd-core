---
type: Fixed
pr: 1382
---
**`check.decision-coverage-plan` no longer reports a false pass when a CONTEXT.md records its decisions under markdown `## … decisions` headers instead of a `<decisions>` block** — `parseDecisions` previously returned an empty set for any CONTEXT.md without a `<decisions>` XML wrapper, so the blocking coverage gate green-lit phases whose markdown-header decisions were never checked. The parser now falls back to the body under markdown decision headers (nested category sub-headings preserved); the `<decisions>` block path is unchanged and still takes precedence when both shapes are present. (#1364)
