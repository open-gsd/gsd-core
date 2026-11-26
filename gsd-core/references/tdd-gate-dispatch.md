# TDD gate dispatch (#4696)

Embedded into an executor `Agent()` prompt only when `execute-phase/steps/tdd-gate-split-dispatch.md`
split a `type: tdd` plan into two dispatches. A plan that is not split never carries this file. The
RED, GREEN and REFACTOR gates themselves, their commit scopes and the RED evidence rules are
stated once, in the canonical `gsd-core/references/tdd.md`; this file only says which gates THIS dispatch runs.

Look for one line in the prompt: `TDD_GATE=red` or `TDD_GATE=green-refactor`.

## TDD_GATE=red

This dispatch exists so the RED gate can run on its own model.

- Run the RED gate exactly as `gsd-core/references/tdd.md` specifies, including its RED evidence verdict.
- Commit the failing test with the RED commit scope from `gsd-core/references/tdd.md`.
- Stop after that commit. Write no implementation, no REFACTOR commit.
- Do not write `SUMMARY.md`, and do not edit `STATE.md` or `ROADMAP.md`. A second dispatch owns them.
- Report: the RED commit hash and the RED evidence verdict.
- Any RED halt (unexpected pass, `INVALID_RED`) is final for this dispatch: report it and stop. The
  orchestrator does not start the next dispatch after a halt.

## TDD_GATE=green-refactor

The RED commit already exists on this branch. This dispatch runs the remaining gates.

- Confirm the RED commit is in the git log first. If it is absent, halt and report that the RED
  commit is missing; this dispatch does not own the RED gate. Never write the failing test yourself
  to make up for it.
- Never rerun or repeat the RED gate. Do not rewrite or amend the RED commit.
- Run the GREEN gate, then the REFACTOR gate if the plan needs one, as `gsd-core/references/tdd.md` specifies.
- Create `SUMMARY.md` as usual, including the `## TDD Gate Compliance` section, and treat the RED
  commit from the first dispatch as part of this plan's gate evidence.

## Both dispatches

Everything else in the prompt applies unchanged: the plan, the checkpoint protocol, the deviation
rules, and the commit protocol. This file adds no instruction about checkpoints or auto-approval.
