---
type: Changed
pr: 753
---
The `gsd-verifier` agent no longer re-runs the full workspace test suite once per must-have during Step 7b spot-checks — it enumerates tests to prove existence and runs a single named test to prove a pass, invoking the full suite at most once per verification.
