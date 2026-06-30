---
type: Changed
pr: 1800
---
**Internal: install/uninstall runtime labels are now sourced from a single `getRuntimeLabel` lookup** — the two duplicated `runtimeLabel` assignment chains in `bin/install.js` (uninstall + install) are collapsed into one curated label table in `runtime-name-policy.cts`, sibling to the registry-derived `getDirName` (ADR-1239 Phase B, #1679). Install output is byte-identical for all 16 runtimes (golden-parity asserted). Two console-label inconsistencies are normalized as a side effect: `kimi` shows 'Kimi CLI' in both sites, and `cline` uninstall no longer falls through to 'Claude Code'.

<!-- docs-exempt: internal refactor; only cosmetic console-label normalization with no doc surface to update -->
