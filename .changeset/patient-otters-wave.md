---
type: Changed
pr: 1735
---
**Internal: extracted the runtime-artifact install engine from `bin/install.js`** — `installRuntimeArtifacts`/`uninstallRuntimeArtifacts`/`installOpencodeFamilySkills` and their helpers now live in a dedicated `gsd-core/bin/lib/install-engine.cjs` module (ADR-1239 Phase B), so adapters can import the install pipeline instead of reaching into the 12k-line installer. Install output is byte-identical for all 16 runtimes (golden-parity asserted); no user-facing behaviour change.
