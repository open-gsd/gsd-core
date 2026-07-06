---
type: Added
pr: 1998
---
**Long-running compute can now be externalized as async external jobs instead of blocking the agent turn** — a default-off external-job capability lets executors submit SLURM jobs, commit a .planning/async-jobs manifest, defer SUMMARY.md, and return external_job_waiting; the core loop already reconciles these manifests (#1165), so this adds the producer half (SLURM adapter, pure manifest module, planner/executor fragments, operation policy). (#1105)
