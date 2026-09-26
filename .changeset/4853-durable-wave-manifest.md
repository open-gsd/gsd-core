---
type: Changed
pr: 4964
---
Wave worktree manifests created during `execute-phase` now reside at a deterministic, phase-scoped path (`{phase_dir}/wave-{N}-manifest.json`) instead of an ephemeral random file under `$TMPDIR`. If a wave is interrupted mid-flight (crash, turn timeout, manual cancellation), the manifest remains in place and discoverable on disk or queryable via the new `gsd_run query worktree.manifest-path` CLI verb, allowing subsequent health checks, recovery workflows, or operators to inspect and cleanly reconcile executor worktrees. Successfully completed waves remove the manifest file, and in-flight manifests are ignored by git.
