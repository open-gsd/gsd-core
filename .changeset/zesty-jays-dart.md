---
type: Fixed
pr: 5137
---
**The codebase-drift gate now flags a map made stale by edits or deletions, and never prints unsafe paths** — a codebase map that went stale through modified or deleted files inside mapped directories was never flagged, only the old STRUCTURE.md was consulted for territory, and paths with traversal, whitespace, non-ASCII or shell metacharacters reached the warn message and the mapper prompt; the gate now reads all seven map documents, counts modified and deleted files toward `workflow.drift_threshold`, and withholds unsafe paths with a count (#5134).
