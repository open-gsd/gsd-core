---
type: Fixed
pr: 6193
---
**`milestone complete` no longer writes every SUMMARY one-liner, repeats included, into MILESTONES.md** — the entry now lists the SUMMARY one-liners with exact repeats dropped (first kept, order preserved), and a new `--accomplishments-file <file>` (a size-capped JSON array of strings, validated before anything is changed) carries the curated 4-6 list that `/gsd-complete-milestone` asks for; the workflow passes it on every `milestone complete` call, including the `--no-archive-phases` form. The JSON result keeps the raw one-liner list. (#6175)
