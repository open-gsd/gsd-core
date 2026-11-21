---
type: Fixed
pr: 0
---
**The code-review disposition ledger no longer loses recorded decisions without saying so** — a decision displaced by a reused finding id is now reported on the console on every path (including a fix report that decides the new finding), a review heading with a review-scoped prefix such as `### W6-CR-01:` is counted and named instead of recording nothing, a ledger row outside the id grammar is named and kept verbatim instead of deleted on rewrite, and an unrecognised frontmatter id no longer lets the next title overwrite another finding's. (#5802)
