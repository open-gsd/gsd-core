---
type: Changed
pr: 1271
---
**`gsd-verifier` no longer marks behavior-dependent must-haves `VERIFIED` on symbol presence alone** — a truth that asserts a state transition or a cancellation/cleanup/ordering invariant is marked `PRESENT_BEHAVIOR_UNVERIFIED` when no test exercises it: excluded from the `verified_truths` score, reported as a `behavior_unverified` count, and routed to human verification, so a clean N/N now certifies behavioral evidence rather than mere symbol presence. (#966)
