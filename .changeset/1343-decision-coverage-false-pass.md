---
type: Fixed
pr: 1358
---

**`check.decision-coverage-plan` no longer reports a false pass when a `D-NN` decision header has text before the colon** — `parseDecisions` previously dropped any `- **D-NN …:**` bullet whose header contained a `(parenthetical)`, em-dash, or other prose before the `:**`, silently narrowing the trackable set so the blocking coverage gate green-lit a phase whose dropped decisions were never checked. The parser now tolerates a freeform run before the colon (preserving `[bracket]` tags) and warns on any `D-NN` bullet it still cannot parse instead of dropping it. (#1343)
