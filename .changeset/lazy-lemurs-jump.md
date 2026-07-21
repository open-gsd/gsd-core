---
type: Fixed
pr: 2477
---
**`check tdd.review-checkpoint` no longer silently skips TDD plans with CRLF line endings** — the frontmatter regex at `src/check-command-router.cts:751` used literal `\n` which couldn't match a CRLF PLAN.md delimiter (`---\r\n`), so a Windows-authored `type: tdd` plan was silently classified as "no type:tdd plans found" and the advisory gate short-circuited to a confident pass with no violations table. The regex now uses the same CRLF-tolerant form (`/^---\r?\n([\s\S]*?)\r?\n---/`) already in use elsewhere in the same file (line 205, `extractPlanDesignatedSections`). With `core.autocrlf=input`, the triggering CRLF was invisible to `git diff`/`git status`, so the contributor had no way to tell their plan was being misclassified.
