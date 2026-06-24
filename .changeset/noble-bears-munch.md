---
type: Fixed
pr: 1665
---
**`check.decision-coverage-plan` no longer false-passes when CONTEXT.md decisions use the titled-colon bullet form** — `parseDecisions` recognized the colon-immediate (`- **D-NN:** text`) and em-dash (`- **D-NN — title** body`) forms but dropped the titled-colon form (`- **D-NN: Title.** body`, where a title sits between the colon and the closing `**`) via the parse-miss guard. When all decisions used the titled convention, the parser returned 0 decisions and the coverage gate passed vacuously. A third per-form regex (checked last, a strict superset of the colon form) now parses the titled-colon form; id and `[tags]` trackability are honored.
