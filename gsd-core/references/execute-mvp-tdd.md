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
2. **The test was actually red — INTENTIONALLY (#3770).** Read `gsd-core/references/tdd.md`, "Red-Green-Refactor Cycle", RED step 4, and follow its complete evidence contract before GREEN. That section owns format selection (TAP, including Node/Vitest; JUnit XML, including Surefire/Failsafe; swift-testing console; or Python `unittest` text), reporter reruns, report freshness, the classifier invocation, and semantic inspection. Require `RED_EVIDENCE_OK` for the actual run and verify the planned target assertion failed for the intended reason. An `INVALID_RED` verdict, unsupported format, or failed semantic assessment trips this gate; self-attestation cannot substitute for machine validation. A `RED:` prefix or `(RED)` tag in the commit message is not evidence.
3. **No implementation commit yet.** No `feat({phase}-{plan})` commit may exist for the same plan ID before the failing-test commit.

If any check fails, the gate trips. A non-zero exit from `gsd_run check tdd-red-evidence` (`69` `UNAVAILABLE`: the record could not be read, #5170) is a command failure that has NOT authorized GREEN — the gate trips. For check 2, an `INVALID_RED` classifier verdict or a failed semantic assessment trips the gate (halt reason `invalid_red`) — the executor MUST halt and block the implementation step.

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
   3. Re-run /gsd:execute-phase
   ```

3. Exit the current execution wave cleanly. Do NOT roll back any prior commits in the same wave.
4. Update `STATE.md` with `last_gate_trip: {plan_id}/{task_id}` so the user can resume after writing the test.

## Escalation: end-of-phase TDD review under TDD

The existing end-of-phase TDD review (in `workflows/execute-phase.md`'s `tdd_review_checkpoint` step) is normally **advisory** — it surfaces gate violations but does not block phase completion.

Under TDD mode, escalate this to **blocking**:
- If any TDD plan is missing a RED or GREEN commit, the executor MUST refuse to mark the phase complete. A `NotEvaluable` row is not a violation and leaves `block` false. The gate reports it only for a plan with no live plan commit and an incomplete RED/GREEN credit, in one of two cases:
  - `sealed_shallow_history`: the plan has a seal entry that names two distinct 40-hex hashes, but the history is not complete (a shallow clone, or git cannot answer). The sealed commits cannot be verified: fetch full history.
  - `unsealed_summary_unreachable`: the plan has no seal entry. Its SUMMARY (the first existing candidate name decides) names 1 to 64 distinct task commits, all unreachable in a complete history, and not all rewritten. A named commit counts as rewritten when its exact subject line occurs on a commit reachable from HEAD but not from the named commits, and whose committer date is not before the earliest author or committer date of any named commit. If any named commit no longer exists, the rewrite check is skipped and the plan is `NotEvaluable`.

  SUMMARY hashes cannot be re-verified once squashed away, so a fabricated hash also yields `NotEvaluable`. A SUMMARY that names more than 64 distinct task commits, is over 64 KiB, or is a symlink or other non-regular file is an ordinary failure. So is a reachability or subject lookup that git cannot answer.
- The user is shown the same review table, but the verdict line reads:
  > "Phase blocked: {N} TDD plan(s) violate the RED→GREEN gate sequence under TDD. Resolve and re-run /gsd:execute-phase, or override with `/gsd:execute-phase {phase} --force-mvp-gate` to ship anyway."

The `--force-mvp-gate` flag is documented but not introduced by this plan — it is the escape hatch the spec mentions; if the user later builds it, the workflow already references the contract.

## What this gate does NOT do

- It does not enforce REFACTOR commits. REFACTOR remains optional (per `gsd-core/references/tdd.md`).
- It does not check test quality (the test could be trivially weak). That's the planner's job. It DOES check that the RED failure was intentional — the target test failing an assertion (#3770).
- It does not start implementation by running tests. During RED, the executor runs the planned test and captures its result, rerunning the planned target with a supported reporter when the first report is unsupported (`tdd.md` RED step 4); before GREEN, this gate inspects that persisted evidence, git history, and test assertion. The implementation step starts only after the RED gate passes.
- It does not gate config-only or doc-only tasks (see "behavior-adding task" definition).

## Compatibility with existing TDD discipline

This gate is additive to `gsd-core/references/tdd.md`. Tasks not under TDD mode continue to use the existing advisory TDD discipline (RED/GREEN/REFACTOR commits with end-of-phase review checkpoint). Only the runtime gate and the blocking escalation are new.
