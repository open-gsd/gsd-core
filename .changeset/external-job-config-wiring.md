---
type: Fixed
pr: 2006
---
**Setting `external_job.submit_timeout_ms` / `poll_timeout_ms` / `artifact_dir` in `.planning/config.json` now actually configures the SLURM adapter** — the keys were declared by the external-job capability but the adapter only read env vars, so config edits silently had no effect. The adapter now resolves them through the canonical capability-config seam (env override > config > registry default), surfaces the resolved `artifact_dir` in `submit` output, documents why the contribution registers at `execute:wave:post` (#1164 asks for `wave:pre`, which `execute-phase.md` does not dispatch today; wiring it is a core-loop change #1164 explicitly defers), and gains unit coverage for the CLI surface (`parseFlags`, `findPlanningDir`, `resolveExternalJobSettings`, `formatShowReport`). (#1164)
