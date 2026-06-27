---
type: Fixed
pr: 1773
---

`state prune` (and `workflow.auto_prune_state`) now resolves the current phase from the canonical template's prose `Phase: [X] of [Y]` field, not only an explicit `Current Phase:` field. Previously, prune was a silent no-op on any STATE.md generated from the template — it always reported `"Only 0 phases — nothing to prune"` because the template never emits `Current Phase:`. Mirrors the prose fallback `buildStateFrontmatter` and `state sync` already use.
