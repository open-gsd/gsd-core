---
type: Changed
pr: 1611
---
**`/gsd-verify-work` now routes UAT deterministically from a structured `coverage:` block on SUMMARY.md** — deliverables proven by passing tests (`human_judgment: false` with a non-empty all-`pass` `verification` list) are auto-passed (`source: automated`, no prompt), and only judgment-dependent or unverified deliverables are presented for human sign-off. SUMMARYs without a `coverage:` block fall back to the previous prose-based extraction, byte-identical. Authored by `execute-plan` and validated by the new `gsd-tools uat classify-coverage` verb.
