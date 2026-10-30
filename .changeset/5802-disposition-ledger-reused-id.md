---
type: Fixed
pr: 0
---
**The code-review disposition ledger no longer loses a recorded decision when a re-review reuses a finding ID** — every review numbers from `CR-01` / `WR-01` / `IN-01`, and a reused ID naming a different finding used to drop the earlier row. That row now moves to the next free `<ID>~N` key (`CR-01~1`) with its decision, Source, severity and title, and the move is named on the console; a fix report deciding the new finding no longer erases it. IDs with one review-scoped prefix (`### W6-CR-01:`, `| R1-WR-01 |`) are now read in headings, ledger rows and frontmatter instead of being skipped or silently deleted on rewrite, a ledger row with no readable ID stops the rewrite and is named rather than deleted, and an unreadable frontmatter `- id:` entry no longer gives its title to the previous finding. (#5802)
