---
type: Fixed
pr: 6250
---
**`/gsd-verify-work` reconciles the commit claim on template-shaped SUMMARYs** — the claim-extraction grep now matches the indented `commits:` field every shipped SUMMARY template writes, so reconciliation runs instead of silently downgrading the SUMMARY to the legacy no-claim warning.
