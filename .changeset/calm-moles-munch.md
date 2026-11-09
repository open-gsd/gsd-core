---
type: Fixed
pr: 5420
---
<!-- docs-exempt: agent prompt internal gate alignment and shared reference update; no public CLI or docs change -->
**Shared requirements are no longer marked complete prematurely when executing via `/gsd-execute-phase`** — a plan that finishes before its siblings leaves those shared IDs pending, including when the plan file uses Windows line endings, a decimal or milestone phase number, or a stale path from another phase, and a failed lookup reports the underlying error. The gate lives in a shared reference so the executor prompt stays within its size cap; documentation lookup stays in the reference the researcher prompts already include.
