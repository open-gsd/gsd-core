---
type: Added
pr: 1419
---
**`gap-analysis --phase-req-ids` now expands numeric ID ranges** — a same-prefix ascending equal-width range like `SEL-01..SEL-03` expands to `SEL-01, SEL-02, SEL-03` (zero-pad preserved) instead of being treated as one literal ID that gap-analysis then reports as missing. Ambiguous tokens (mismatched prefix, descending, differing width, non-numeric, >1000 span) stay literal. (#1269)

<!-- docs-exempt: `--phase-req-ids` is an internal gsd-tools query flag consumed by GSD workflows, not part of the user-facing documented command surface; no docs/ entry exists for it. -->
