---
type: Fixed
pr: 1742
---
**Windows install/upgrade/state-write operations no longer fail on transient antivirus/indexer file locks** — the fs.renameSync atomic-publish sites (install state, hooks config, capability ledger/lifecycle, phase/workstream/milestone dirs, roadmap, planning/state locks) now retry EPERM/EBUSY/EACCES via retryRenameSync instead of propagating the transient lock; enforced by the new local/require-fs-op-fallback lint rule (ADR-1703 Phase 6). (#1740)
