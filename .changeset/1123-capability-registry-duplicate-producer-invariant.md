---
type: Added
pr: 1131
---
**`gen-capability-registry` now rejects duplicate artifact producers at the same Loop Extension Point** — if two capability `steps` declare `produces: [<same artifact>]` at the same point, the generator throws at gen time naming the artifact, the point, and the producing capability ids, instead of letting the topological sort pick a winner silently (which left ADR-857 Decision #6's data-flow contract undefined). The check counts distinct `(capId, stepIdx)` producer steps, so a single step listing an artifact twice does not false-positive. ADR-894 §4's enumerated cross-capability invariant list gains the artifact-production-uniqueness rule. (#1123)
