---
type: Changed
pr: 719
---
**Workflow size budget now measures bytes, not lines (#717).** `tests/workflow-size-budget.test.cjs` re-bases its tier ceilings (XL/LARGE/DEFAULT) from line counts to byte counts — deterministic, no tokenizer, and matching the unit vendors bound on (Codex's 32,768-byte project_doc_max_bytes cap). The #597 tighten-only ratchet and per-file semantics are unchanged; the budget's caching-independent quality rationale (context rot / attention budget) is now documented.
