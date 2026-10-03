---
type: Changed
pr: 4964
---
**Interrupted `execute-phase` waves leave durable, discoverable worktree manifests** — wave worktree manifests now reside at deterministic phase-scoped paths (`{phase_dir}/wave-{N}-manifest.json`) instead of an ephemeral random file under `$TMPDIR`. If a wave crashes, times out, or is interrupted, the manifest remains discoverable on disk or queryable via `gsd_run query worktree.manifest-path`, preventing unmanifested worktree leaks and allowing operators to reconcile in-flight branches. Completed wave cleanup removes the manifest file. Manifests are ephemeral runtime records holding machine-local paths; under `commit_docs: true`, operators should reconcile interrupted waves with `worktree cleanup-wave --manifest <path>` before committing documentation, or add `.planning/**/wave-*-manifest.json` to their project `.gitignore`.
