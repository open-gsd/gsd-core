---
type: Fixed
pr: 6448
---
**The phase evaluation scope reads the task rows gsd-executor writes for TDD tasks, and names a SUMMARY it could not read** — a `**Task 1 (tracer):**` or `**Task 1 RED:**` row and the RED and GREEN commits listed as sub-bullets under a task row now count as task commits, so their files are in the scope instead of vanishing; and a SUMMARY whose `## Task Commits` section yields no commit id is reported in the new `unparsedSummaries` field and printed by the code-review step, rather than leaving a `resolved` scope that reads as complete. (#6215)
