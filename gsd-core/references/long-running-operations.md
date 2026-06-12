# Long-running operation guard

Purpose: keep GSD executors from blocking blindly on commands that were expected to be short, while still allowing legitimate heavy work to proceed safely.

## Non-negotiable rule

No executor may let an unknown-runtime command consume the child-agent timeout without an intervening progress review.

The child-agent timeout is an emergency fuse for the agent process. It is not permission to run silent shell/Python/solver/training commands until that fuse expires.

## Runtime classes

| Class | Expected runtime | Default handling | First health check | Soft review | Local hard cap |
|---|---:|---|---:|---:|---:|
| quick | <1-3 min | foreground with explicit timeout | on completion | n/a | 180-300s |
| medium | 3-20 min | background or foreground with explicit timeout and progress checks | 3-5 min | 10-15 min | 30 min |
| unknown | unknown or underestimated | short observation window; suspicious until progress is proven | 2 min | 5 min | 30 min |
| long compute | >30-60 min or hours | smoke/canary, then async SLURM manifest + watcher | 5-15 min early-flight after submit | detach after healthy | SLURM #SBATCH --time |

## Progress contract required before nontrivial commands

Before starting any command that may run longer than ~2 minutes, write down or infer:

- expected duration class: quick, medium, unknown, or long compute
- expected progress signal: stdout/stderr line pattern, log mtime, artifact size, step/epoch counter, heartbeat JSON, CPU/memory activity
- first health-check deadline
- soft-review deadline
- abort conditions
- verification command/output after completion

If the plan does not provide this, infer conservatively. Unknown-runtime commands are suspicious until progress is proven.

## Progress signals

Acceptable signals include:

- stdout/stderr emits increasing step/epoch/trajectory/reaction counters
- log file mtime updates at least every 1-5 minutes depending class
- output artifact exists and grows or checkpoints appear
- CPU usage remains nontrivial for compute-bound work
- memory is stable or bounded by expected working set
- SLURM state/logs show the job entered RUNNING and initialized correctly

Silent scientific/ML/build scripts are not acceptable long-run infrastructure. Long-running scripts should emit machine-readable progress heartbeats. If a compute script is silent for an extended soft-review window, treat that as an engineering defect to fix with heartbeat/progress logging, not as a reason to raise agent timeouts.

## Pivot decisions at the soft review

Classify the operation:

- completed quickly: continue normally
- healthy-long: progress is real but ETA exceeds local cap; convert to async SLURM if it is compute, or pause with an explicit manifest/handoff
- suspicious-long: no progress, repeated errors, stalled CPU, explosive ETA, memory leak, or same warning loop; cancel, preserve logs, diagnose, fix, restart from a smaller canary
- unclear: stop and surface the uncertainty instead of waiting for the child timeout

## Abort conditions

Abort or pause for diagnosis when any of these occur:

- no stdout/stderr/log update by the first health check for an unknown-runtime command
- no progress signal by the soft-review deadline
- extrapolated ETA exceeds expected runtime by >3x and the operation was not explicitly classified long compute
- same warning/error repeats many times with no forward progress
- CPU near zero while process remains alive for a compute-bound task
- memory grows monotonically toward node/job limit
- SLURM job starts with import/path/env/data errors

## Execution mode guidance

- Quick commands: foreground with explicit timeout.
- Medium/unknown commands: background or monitored foreground; inspect logs and process state at the health gates.
- Long compute: do not block the agent. Run a smoke/canary first when feasible, then use async SLURM protocol in `references/async-slurm.md`.

## SLURM early-flight gate

Even after submitting to SLURM, monitor the first 5-15 minutes when practical:

- job reaches RUNNING or has a valid PENDING reason
- environment and conda activation succeed
- paths/data resolve
- first log/progress/heartbeat appears
- no immediate import/config/missing-file error appears

If early-flight fails, `scancel` the job, inspect logs, fix the root cause, and resubmit. Do not leave a known-broken 24h job running.
