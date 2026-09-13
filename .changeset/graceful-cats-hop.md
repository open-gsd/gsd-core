---
type: Fixed
pr: 4646
---
**A three-segment (or deeper) phase id no longer breaks phase-number validation or extraction** — code-review, code-review-fix, the gsd-code-fixer agent (both variants), execute-plan's plan-filename parsing, and plan-phase's --research-phase flag all re-derived a two-segment-max regex; a nested phase like 23.1.2 was rejected outright or silently truncated to the wrong id. All six sites now accept an arbitrary number of dotted segments, matching the canonical grammar. (#4568)
