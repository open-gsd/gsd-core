---
type: Fixed
pr: 4693
---
**Executor dispatches are no longer refused when a phase correctly degrades to sequential execution.** The isolation guards identified a dispatch by regex-scraping model-authored prose, which returned identifiers in a different namespace from the ones the run-scoped sentinel records — so a fresh decision was discarded on every executor dispatch and every legitimate `ISOLATION=none` degrade was denied, leaving the work unrun. Dispatch identity now has one owner for both the emitted format and the parser that reads it back. (#4594)
