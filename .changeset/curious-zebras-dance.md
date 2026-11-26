---
type: Added
pr: 6675
---
**A seed can now be closed with `/gsd-capture --seed --close`** — `--promoted <REQ-ID>`, `--built <PHASE>` or `--dropped "<why>"` sets `status: closed` and records what the seed became as `outcome_kind`, `outcome_ref` and `outcome`, and `list-seeds` returns those fields. `/gsd-new-milestone` now offers only `dormant`, `active` and `triggered` seeds, the same set the milestone-close audit treats as open, so a delivered idea stops coming back as scope. (#4647)
