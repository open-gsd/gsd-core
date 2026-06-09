---
type: Fixed
pr: 937
---
Fix `--reapply` verifier false-positives on post-#604-rename installs caused by two gaps in pristine-baseline handling:

**Gap 1** (`verify-reapply-patches.cjs`): when `backup-meta.json` records a `pristine_hash` for a file but `gsd-pristine/` has no corresponding snapshot on disk, the verifier fell to over-broad mode (every upstream-changed line treated as a user-added requirement) and produced `FAIL_USER_LINES_MISSING` false positives. Fix: return advisory `OK_NO_BASELINE` reason (non-blocking, exit 0) when a recorded hash is present but the pristine file is absent — the verifier cannot reason correctly without a baseline and must not block.

**Gap 2** (new migration `004-prune-stale-pristine-snapshots`): migration 003 removed legacy `get-shit-done/` runtime files but left `gsd-pristine/get-shit-done/` orphan snapshots in place. Those stale snapshots referenced `get-shit-done/...` key paths that no longer match the active `gsd-core/...` layout, contributing to `FAIL_INSTALLED_MISSING` false reports. Fix: add a new migration (not editing 003, to preserve its checksum) that removes all files under `gsd-pristine/get-shit-done/`. (#934)
