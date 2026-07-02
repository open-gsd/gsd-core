---
type: Fixed
pr: 1924
---
**Phase archival is now wired end-to-end across the milestone lifecycle** — finishes the #1871 follow-up: `phases archive` is now a real command (the half-wired alias is routed, no longer errors Unknown), `milestone complete` archives phase dirs by default (`--no-archive-phases` opts out), and `new-milestone` §6 stages the archive move + source removal in the same commit so history is preserved atomically rather than left as orphaned uncommitted deletions. (#1871)
