---
type: Fixed
pr: 5401
---
**Verification stays fresh across CRLF and LF checkouts** — New fingerprints treat CRLF byte pairs as LF while preserving every other byte; existing v1–v3 reports retain their original semantics.
