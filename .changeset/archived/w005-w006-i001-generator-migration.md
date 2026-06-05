---
type: Fixed
pr: 26
---
W005/W006-archived/I001 drift items now covered by the validate.generated.cjs generator (gen-validate.mjs + validate.ts). PR #3806 hand-ported the behavioral fixes; issue #26 routes them through the generator so they cannot drift again. Per ADR-3524 generator framework introduced by PR #154, extended by PR #156.
