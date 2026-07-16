---
type: Fixed
pr: 2318
---
**Deferred out-of-scope findings logged to `deferred-items.md` are now surfaced** — the executor's SCOPE BOUNDARY convention writes discoveries to a phase directory's `deferred-items.md`, but nothing read it back, so those items were permanently invisible. `/gsd-progress`'s forensic audit and `audit-uat` now glob `.planning/phases/*/deferred-items.md` and surface unresolved entries. (#2287)
