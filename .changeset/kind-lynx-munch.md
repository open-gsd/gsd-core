---
type: Changed
pr: 1728
---
**Internal: derive the non-Claude runtime list from the capability registry** — `NON_CLAUDE_RUNTIMES` is now computed from the capability registry instead of a hand-maintained literal, so it can no longer drift from the per-runtime descriptors. No user-visible behavior change (the list is identical).

<!-- docs-exempt: internal refactor, no user-facing surface -->
