---
type: Changed
pr: 1757
---
**Internal: getDirName is now derived from a documented `runtime.localConfigDir` descriptor field** — each runtime's local content-rewrite directory (e.g. `cursor`→`.cursor`, `copilot`→`.github`) moved from a hand-maintained if-chain into its capability descriptor (ADR-1239 Phase B), so it can no longer drift from the registry. Install output is byte-identical for all 16 runtimes (golden-parity asserted); no user-facing change.
