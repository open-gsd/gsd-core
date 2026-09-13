---
type: Security
pr: 4659
---
**The secret-read guard no longer lets a trailing dot or space alias past it** — Windows strips trailing dots and spaces from every path component, so `.env.`, `.env ` and `.secrets.` all resolve to the protected file while the guard treated them as unrelated names and allowed the read. Names are now normalized before classification, and the Read, Grep and Bash arms share one path-segmentation rule instead of two that disagreed on backslash paths. (#4651)
