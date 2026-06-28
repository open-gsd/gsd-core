---
type: Changed
pr: 1801
---
**Internal: the installer's runtime → global-config-home hook-pathogen fragment is now a single `getGlobalConfigHomeFragment` lookup** — the 14-branch `if (runtime === 'x') return "'...'"` chain in `getConfigDirFromHome` (`bin/install.js`, the hook `path.join()` codegen mapping) is collapsed into one table in `runtime-name-policy.cts`, sibling to `getRuntimeLabel` (ADR-1239 Phase B, #1679 AC2 slice 2). Generated hook output is byte-identical for all 16 runtimes (golden-parity asserted); antigravity's dynamic env-overridable resolution is preserved in the caller. No user-facing change.

<!-- docs-exempt: internal refactor; hook codegen path-fragment table, no user-facing doc surface -->
