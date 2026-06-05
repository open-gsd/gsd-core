---
type: Fixed
pr: 380
---
extractCurrentMilestone now selects the active sub-milestone over a closed sibling. When STATE.md milestone is a shared semver prefix (e.g. v8.0) and ROADMAP.md holds both a closed sub-milestone (CLOSED/FAILED/ARCHIVED/SHIPPED) and an active one (STARTED), the parser previously returned the first (closed) match and excised the active section, breaking phase and roadmap operations with spurious "Phase N not found" errors. It now skips closed-marked headings (unless they also carry an active marker), matches the version with a trailing word boundary so v8.0-B does not match v8.0-Beta, and anchors the preamble at the first milestone heading. Fixes #145.
