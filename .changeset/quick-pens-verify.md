---
type: Fixed
pr: 6381
---
**A `gaps_found` verification report whose covered files changed now reads `stale`** — `query verification status` returned `gaps_found` before the covered-fingerprint check ran, so a gap closed outside a gap-closure plan never reported stale: it kept routing to `plan-phase --gaps`, and `execute-phase` with every plan summarized exited without re-running the verifier; a `gaps_found` report with a moved fingerprint now reads `stale` (naming the moved files) and routes to the verifier re-run, while a matching fingerprint, a malformed one, or no fingerprint keeps `gaps_found`. (#6078)
