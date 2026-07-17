---
type: Fixed
pr: 2381
---
**Todo severity is now captured and surfaced end-to-end** — `/gsd-capture` (add-todo) now confirms a severity (blocker/major/minor/cosmetic) before writing a todo instead of silently omitting it, and `gsd-tools list-todos` / `init todos` now include the `severity` field in their JSON output (omitted for older todos that have none), so a backlog can be triaged by severity instead of by re-reading every file. (#2337)
