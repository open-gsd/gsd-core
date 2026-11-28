---
id: 3885
title: No Silent Swallow, No Verdict From Dropped Data
group: v1.7.0 Features
---

**Purpose:** ADR-3473 §8.5: a failure or a gap in the input must not be absorbed into an
output that reads as authoritative. This closes four instances of that collapse found across
`gsd-tools`. The reasoning is in
[Why failures are surfaced, not absorbed](../explanation/why-failures-are-surfaced-not-absorbed.md#no-silent-swallow-no-verdict-from-dropped-data-3885).

**Behavior:**
- `intel query` no longer overflows the stack on deeply nested JSON (#3427): nesting is
  bounded at `MAX_JSON_SEARCH_DEPTH = 48` and the result carries a `truncated` field, so a
  match past the ceiling reads as truncated, not absent.
- `phase-plan-index` names an unresolved `depends_on:` token in its own `warnings[]` entry
  and suppresses the wave-mismatch warning for that plan only (#3427). The token is escaped
  before it enters the warning text.
- `review.md` withholds `REVIEWS.md` when every lane failed (#3352), reports the failure,
  and preserves per-lane outputs and non-empty `.err` files before cleanup.
- Unreadable phase directories are distinguished from absent ones (#3473 B5) in
  `countPhasePlansAndSummaries`, `runGapAnalysis` and two `init.cts` blocks, via
  `context_read_error` / `phase_dir_read_error`.

**Audited, no defect found:** `withPlanningLock`, `acquireStateLock`,
`atomicRenameWithRetry` and `renameWithRetry` already fail loudly on a fatal errno.

**Known limits:**
- A match deeper than 48 levels is reported as truncated, and the value is not returned.
- `phase-plan-index`'s `waves` / `wave` fields remain computed from the degraded DAG when an
  edge is dropped.
- `review.md`'s evidence preservation is bounded by what a lane actually wrote.
