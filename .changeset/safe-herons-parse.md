---
type: Fixed
pr: 4533
---
**`/gsd-code-review` can parse phase SUMMARY files without shell syntax errors** — the embedded JavaScript now runs from a literal heredoc and receives the SUMMARY path through `argv`, so quotes and backticks cannot break the workflow command. (#4461)
