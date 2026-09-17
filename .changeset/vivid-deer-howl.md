---
type: Fixed
pr: 0
---
**Stale verification now routes to the verifier** — the `stale` status told users to re-run `/gsd-verify-work`, but that workflow never rewrites VERIFICATION.md, so following the advice looped forever. The routing now names the regeneration path (execute-phase resumes at the verification gates and re-runs the verifier), and verify-work's stale stop dispatches `gsd-verifier` and re-checks instead of self-referencing. (#4682)
