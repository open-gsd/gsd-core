---
type: Fixed
pr: 1256
---
**`state begin-phase` / `complete-phase` now advance the frontmatter `status` for pipe-table `STATE.md`, not only inline `Status:` files.** The status update matched the YAML frontmatter `status:` line first and never updated a body `| Status | … |` cell, so the frontmatter `status` froze (e.g. stuck at `planning`); it now transitions correctly (`planning → executing → completed`) regardless of whether the body `Status` is inline or pipe-table. (#1255)
