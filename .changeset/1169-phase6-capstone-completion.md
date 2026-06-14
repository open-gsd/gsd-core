---
type: Changed
pr: 1183
---
**ADR-857 phase 6 complete: optional features are now Capabilities, not inline loop branches.** `tdd`, `schema-gate`, `drift`, `gap-analysis`, and `profile-pipeline` are migrated out of the five-step host loop into declarative Capabilities (loop hooks + a command family); their config keys are federated to capability ownership; and the `plan-phase`/`execute-phase` workflow bodies shrink accordingly. Two previously-declared-but-dead capability gates now actually fire — the security ship-time gate (`ship:pre`) and the UI safety gate (`execute:wave:post`) — and the phase-6 conformance gate is hardened to be un-gameable (rejects empty stubs, requires loop-body shrink, verifies hook dispatch and gate-result contracts). Behavior is preserved, verified across five adversarial review passes. (#1139, #1167, #1168, #1169)
