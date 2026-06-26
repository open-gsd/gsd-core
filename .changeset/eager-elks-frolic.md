---
type: Changed
pr: 1759
---
**Internal: copyWithPathReplacement converter selection is now data-driven** — the installer's back-compat content-copy path replaced its 13 hardcoded `runtime === 'x'` flag chains with a single per-runtime dispatch table (ADR-1239 Phase B). Install output is byte-identical for all 16 runtimes (golden-parity asserted); no user-facing change.

<!-- docs-exempt: internal refactor, no user-facing surface -->
