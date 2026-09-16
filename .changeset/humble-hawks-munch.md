---
type: Fixed
pr: 0
---
**verify-work no longer canonicalizes a vacuous pass** — a UAT session with zero logged issues but every row blocked (0 passed) flipped VERIFICATION.md to `passed`, leaving a phase whose central claim was never observed carrying a passed verification. The canonicalize flip now requires the same `phase uat-passed` predicate the phase-close uses (at least one pass, no blocked/pending/failed rows) and, when it refuses, says the verification stays human_needed with the blocker count. (#4663)
