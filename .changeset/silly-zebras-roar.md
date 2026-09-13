---
type: Changed
pr: 0
---
**Every path-containment check in the tree now routes through one predicate, enforced by lint** — around two dozen hand-rolled containment comparisons were still scattered across installers, capability lifecycle, research storage and command routing; each now takes its decision from the canonical predicate while keeping its own behavior. A new lint rule bans the hand-rolled shape and a discarded containment answer, so a reintroduced copy fails the build. Two rejection messages in capability module loading collapse into one, and a missing module now reports as a module-resolution failure rather than a file-not-found. (#4654)
