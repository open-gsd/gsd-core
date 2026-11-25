---
type: Fixed
pr: 6669
---
**Parsing a malformed PLAN.md no longer slows quadratically on unclosed `<task` tags or whitespace after `<objective>`** — `parsePlanDocument` re-scanned the rest of the document for every unclosed `<task ` opening and for the whitespace run after `<objective>`, so a file with 100,000 repetitions took 18 s to parse and grew quadratically; both scans are now single linear passes, and every input returns exactly the same result as before. (#6420)
