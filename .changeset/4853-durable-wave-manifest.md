---
type: Changed
pr: 5426
---
**Interrupted `execute-phase` waves leave durable, discoverable worktree manifests** — wave worktree manifests now reside at deterministic phase-scoped paths (`{phase_dir}/wave-{N}-manifest.json`) instead of an ephemeral random file under `$TMPDIR`. If a wave crashes, times out, or is interrupted, the manifest remains discoverable on disk or queryable via `gsd_run query worktree.manifest-path`, preventing unmanifested worktree leaks and allowing operators to reconcile in-flight branches. Completed wave cleanup automatically removes the manifest file. Manifests are ephemeral runtime records holding machine-local paths; `gsd_run query commit` automatically excludes wave manifests from staging and commits under `commit_docs: true`. Wave dispatch and cleanup-wave refuse git-tracked manifests with a FATAL diagnostic and `git rm --cached` guidance (#4853).
