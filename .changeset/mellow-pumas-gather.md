---
type: Fixed
pr: 5927
---
**A named pipe, link or oversized file at the dispatch isolation record can no longer hang or mislead subagent dispatch** — such a record could block every subagent dispatch indefinitely or be trusted from outside the project; it is now treated as absent. (#5758)
