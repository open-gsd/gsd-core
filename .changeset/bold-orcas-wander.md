---
type: Changed
pr: 1811
---
**Internal: the installer's per-function `is<Runtime>` flag-declaration blocks are now a single `runtimeFlags` lookup** — the four duplicated `const isX = runtime === 'x'` blocks in `bin/install.js` (uninstall / writeManager / install / a fourth helper — 48 branches) are collapsed into one `runtimeFlags(runtime)` helper in `runtime-name-policy.cts` (ADR-1239 Phase B / #1679 AC2 slice 3). The add-a-host tax for flags is removed (one `RUNTIME_FLAG_IDS` entry, not four declaration blocks). Install output is byte-identical for all 16 runtimes (golden-parity asserted); `runtime ===` count in `bin/install.js`: 101 → 53. No user-facing change.

<!-- docs-exempt: internal refactor; no user-facing doc surface -->
