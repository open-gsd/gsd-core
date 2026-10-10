---
type: Fixed
pr: 4833
---
**Checkpoint continuations use one shipped prompt the executor recognizes** — every continuation spawn in `execute-phase` (after a user answer, in auto mode, and inside a parallel wave) now builds its prompt from `execute-phase/steps/checkpoint-continuation-prompt.md` instead of an obsolete template reference. The prompt names the plan and phase, wraps completed tasks in the `<completed_tasks>` block that `gsd-executor` uses to recognize a continuation (so committed tasks are not redone), states per-checkpoint-type resume instructions, and passes the user's answer as delimited data. `checkpoints.md` now states what `human_verify_mode` enforces at runtime, names both layers that auto-approve, and gives a worked outcome for every tracer-gate row. (#4783)
