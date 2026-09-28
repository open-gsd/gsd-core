---
type: Fixed
pr: 5103
---
**A passed verification no longer goes permanently stale on its own report or on plans the verifier forgot to list** — `verification fingerprint` now leaves the `*-VERIFICATION.md` report out of its own digest, always includes the phase's own plans and summaries (so `--raw` callers get a digest that verifies too), and accepts phase files that live in a planning store symlinked outside the repository. Fingerprints are now `v3:`; existing `v1`/`v2` reports keep verifying as before, and a report that listed itself needs one re-fingerprint, after which it stays fresh. (#5095)
