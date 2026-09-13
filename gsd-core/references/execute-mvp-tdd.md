# Execute-Phase — TDD Gate (Runtime Enforcement)

> Loaded by `execute-phase` workflow and `gsd-executor` agent when `TDD_MODE=true` for the phase (#4011 — the gate no longer requires MVP mode; MVP may imply TDD, but TDD never requires MVP). Defines the runtime gate that blocks behavior-adding tasks until a failing-test commit exists.

## When this gate fires

- `TDD_MODE` is `true` (resolved from `--tdd` flag → `workflow.tdd_mode` config). MVP mode is NOT required (#4011).
- The current task being executed has `tdd="true"` in its `<task>` frontmatter (set by the planner per Phase 1).
- The task's `<behavior>` block lists at least one expected behavior.

If any of these is false, the gate is inactive — execution proceeds normally.

## What the gate checks

For each task gated by TDD, the executor MUST verify (before running the implementation step):

1. **A failing-test commit exists.** Search git log on the current branch for a commit matching `test({phase}-{plan})` whose subject mentions the same plan as the current task. The commit must touch a test file (`*.test.*`, `*.spec.*`, `tests/**`).
2. **The test was actually red — INTENTIONALLY (#3770).** For every runner, persist the real command, actual exit status, unmodified output, target test identity, expected result from the plan's `<behavior>`, and actual result from the captured run. Identify the runner from the actual command that produced the evidence, including in mixed-runner projects. If the runner is unresolved, STOP and investigate before selecting a validation branch.
   - If the actual command invokes Node's built-in test runner and the output is compatible TAP, pass the unchanged record to `gsd_run check tdd-red-evidence <record.json> --raw` and require `RED_EVIDENCE_OK`. If the reporter is incompatible, rerun the planned target with Node's compatible TAP reporter and capture that real command and result first. Do not infer Node from `package.json` or package metadata, npm/pnpm or another package manager, or TAP-shaped text alone. Every existing `INVALID_RED` reason (`unexpected_green`, `zero_tests_discovered`, `nonzero_exit_without_test_failure`, `fixture_or_load_failure`, `no_target_test_failure`, `invalid_record`, `unreadable_record`) trips the gate.
   - For every other identified runner, directly inspect the captured output and the test assertion.
   - After either branch, inspect whether the named target actually executed and failed on the planned assertion for the intended reason. Zero tests, a missing or skipped target, setup, collection, import, syntax, or fixture faults, unrelated failures, unexpected green, and incomplete or ambiguous evidence block GREEN. Record the concise assessment in the existing RED evidence and SUMMARY surfaces; do not fabricate a parser verdict or Node counters. A `RED:` prefix or `(RED)` tag in the commit message is not evidence.
3. **No implementation commit yet.** No `feat({phase}-{plan})` commit may exist for the same plan ID before the failing-test commit.

If any check fails, the gate trips. For check 2, an `INVALID_RED` Node verdict or a failed direct semantic assessment trips the gate — the executor MUST halt and block the implementation step.

## What "behavior-adding task" means

A task is behavior-adding when:
- Its frontmatter has `tdd="true"` AND
- Its `<behavior>` block names at least one user-visible outcome (not a config-only or doc-only task) AND
- Its `<files>` list includes at least one source file (not exclusively docs/tests/config files such as `*.md`, `*.json`, `*.test.*`, `*.spec.*`, `*.yml`, `*.yaml`, `*.toml`, `*.ini`, `.env*`)

Pure documentation, configuration, or test-only tasks are skipped by this gate even when both modes are active.

## What happens when the gate trips

The executor MUST:

1. Halt before running the task's implementation step.
2. Emit a structured halt report:

   ```
### TDD GATE TRIPPED — Plan {plan_id}, Task {task_id}

   Reason: {missing_red_commit | red_commit_not_failing | feat_before_test | invalid_red}

   Behavior expected to be tested:
   - {first behavior bullet}

   Required next step:
   1. Write a failing test for the behavior above.
   2. Commit it as: test({phase}-{plan}): {short description}
   3. Re-run /gsd execute-phase
   ```

3. Exit the current execution wave cleanly. Do NOT roll back any prior commits in the same wave.
4. Update `STATE.md` with `last_gate_trip: {plan_id}/{task_id}` so the user can resume after writing the test.

## Escalation: end-of-phase TDD review under TDD

The existing end-of-phase TDD review (in `workflows/execute-phase.md`'s `tdd_review_checkpoint` step) is normally **advisory** — it surfaces gate violations but does not block phase completion.

Under TDD mode, escalate this to **blocking**:
- If any TDD plan is missing a RED or GREEN commit, the executor MUST refuse to mark the phase complete.
- The user is shown the same review table, but the verdict line reads:
  > "Phase blocked: {N} TDD plan(s) violate the RED→GREEN gate sequence under TDD. Resolve and re-run /gsd execute-phase, or override with `/gsd execute-phase {phase} --force-mvp-gate` to ship anyway."

The `--force-mvp-gate` flag is documented but not introduced by this plan — it is the escape hatch the spec mentions; if the user later builds it, the workflow already references the contract.

## What this gate does NOT do

- It does not enforce REFACTOR commits. REFACTOR remains optional (per `gsd-core/references/tdd.md`).
- It does not check test quality (the test could be trivially weak). That's the planner's job. It DOES check that the RED failure was intentional — the target test failing an assertion (#3770).
- It does not start implementation by running tests. During RED, the executor runs the planned test and captures its result; before GREEN, this gate inspects that persisted output, git history, and test assertion, and reruns the planned Node target with compatible TAP when required. The implementation step starts only after the RED gate passes.
- It does not gate config-only or doc-only tasks (see "behavior-adding task" definition).

## Compatibility with existing TDD discipline

This gate is additive to `gsd-core/references/tdd.md`. Tasks not under TDD mode continue to use the existing advisory TDD discipline (RED/GREEN/REFACTOR commits with end-of-phase review checkpoint). Only the runtime gate and the blocking escalation are new.
