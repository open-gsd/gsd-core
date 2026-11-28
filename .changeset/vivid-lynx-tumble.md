---
type: Fixed
pr: 6883
---
**`/gsd-plan-phase`'s requirements coverage gate now reads each live plan's frontmatter `requirements` field** — it used to grep raw `requirements:` lines from root `*-PLAN.md` files, which kept the key glued to the first ID, missed block-list IDs, counted body text and superseded plans, and skipped nested `plans/` and bare `PLAN.md` plans. The gate now takes the plan set from `phase.list-plans`, reads each plan's `requirements` with `frontmatter.get`, and counts an ID as covered only on an exact match. A plan without the key, or one that cannot be read, adds no IDs. The step needs `jq` (1.6 or later) and strips the CR a native Windows `jq.exe` writes. (#6814)
