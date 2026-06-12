# Async SLURM checkpoint protocol

Purpose: make hours-long compute durable and resumable without keeping a GSD agent turn alive.

Use this for training runs, large solver jobs, full model expansion, cache generation, or any operation whose legitimate runtime is >30-60 minutes.

## Core invariant

SLURM completion is not GSD plan completion.

A plan is complete only after a later agent verifies the SLURM outputs, records verification evidence, and writes the normal `SUMMARY.md`.

## Legal async half-state

Normal close-out remains:

`production-code commit(s) -> SUMMARY commit -> STATE/ROADMAP update`

Async SLURM adds one legal paused half-state:

`input/code commit(s) -> SLURM submit -> async-job manifest commit -> handoff commit -> pause`

In that state, `SUMMARY.md` is intentionally absent. `execute-phase` must treat the matching async manifest as the authority and must not duplicate the work.

## Submission protocol

1. Commit or explicitly record all code/config/input changes needed by the job.
2. Run a smoke/canary first when feasible.
3. Submit with a parsable job id:

```bash
JOBID=$(sbatch --parsable slurm/<job>.sbatch)
```

4. Prefer per-job output roots and non-overwritten logs:

```text
Artifacts/jobs/<JOBID>/stdout.log
Artifacts/jobs/<JOBID>/stderr.log
```

For new or modified sbatch scripts, prefer `%j` or an `Artifacts/jobs/<jobid>/` path over fixed logs that can be overwritten by a later submission.

5. Write a manifest under:

```text
.planning/async-jobs/<phase>-<plan>-<task>-slurm-<JOBID>.json
```

6. Write/update:

```text
.planning/HANDOFF.json
.planning/phases/<phase-dir>/.continue-here.md
```

7. Commit the manifest and handoff:

```bash
gsd_run query commit "wip(<phase>-<plan>): await SLURM job <JOBID> for <task>" --files \
  .planning/async-jobs/<manifest>.json \
  .planning/HANDOFF.json \
  .planning/phases/<phase-dir>/.continue-here.md
```

8. Return `external_job_waiting` to the orchestrator. Do not create `SUMMARY.md`; do not update ROADMAP as complete.

## Required manifest fields

Use `templates/async-slurm-manifest.json` as the starting schema. The manifest must include:

- phase, phase_dir, plan_id, task_id
- repo path, branch, submit commit, dirty/clean state
- sbatch command, script, job id, partition, walltime
- stdout/stderr paths
- expected artifacts
- verification commands and success contract
- resume instructions: must-read files, next action, do-not-repeat constraints
- status: `submitted`, `pending`, `running`, `completed_unverified`, `failed`, `cancelled`, `timeout`, or `verified`

## Watcher

The watcher polls one or more manifests, updates status atomically, and prints only when a job reaches a terminal state and has not already notified.

```bash
python /path/to/gsd-core/bin/gsd-slurm-watch.py .planning/async-jobs/*.json
```

Use it from a durable scheduler/watchdog job every 10-15 minutes. Empty stdout means no notification.

Example cron script body:

```bash
cd /path/to/project
python /path/to/gsd-core/bin/gsd-slurm-watch.py .planning/async-jobs/*.json
```

## Resume protocol

A later `/gsd-resume-work` or `/gsd-execute-phase <phase>` must:

1. Read `.planning/HANDOFF.json`, the phase `.continue-here.md`, and the async manifest.
2. Run the watcher or direct `squeue`/`sacct` checks.
3. If the job is pending/running: report that the plan is waiting on external compute; do not resubmit.
4. If `completed_unverified`: inspect logs, check artifacts, run every verification command, and record results in the manifest.
5. If verification passes: set manifest `status=verified`, continue the plan from the post-job validation point, then create `SUMMARY.md` and update STATE/ROADMAP normally.
6. If failed/cancelled/timeout/verification-failed: preserve logs, diagnose, and halt or repair according to plan policy. Do not silently resubmit a 24h job.

## Failure policy

- Do not assume SLURM `COMPLETED` means scientifically valid output.
- Do not assume missing `squeue` output means success; check `sacct`.
- Do not overwrite old job logs.
- Do not regenerate inputs or resubmit unless the manifest proves the previous job is obsolete or failed and the repair policy allows resubmission.
