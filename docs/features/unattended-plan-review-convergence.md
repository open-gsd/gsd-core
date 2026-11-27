---
id: 4617
title: Unattended Plan-Review Convergence
group: v1.7.0 Features
---

**Command:** `/gsd-review --cycle-summary`, `/gsd-plan-review-convergence --on-escalation exit`

**Purpose:** A caller with no person attached — a board worker, a CI job — could neither run `/gsd-plan-review-convergence` to its end nor read the convergence counters without it. The wrapper asked "Proceed anyway / Manual review" when cycles ran out, and the `CYCLE_SUMMARY` counters existed only as an instruction the wrapper gave its own review agent, so a caller assembling `/gsd-review` + `/gsd-plan-phase --reviews` itself had to re-implement the counting rules (#4617).

**`CYCLE_SUMMARY` belongs to `/gsd-review`.** With `--cycle-summary`, the review's final response ends with `CYCLE_SUMMARY: current_high=<N> current_actionable=<M>` followed by the `## Current HIGH Concerns` and `## Current Actionable Non-HIGH Concerns` sections. The counting rules — the consensus gate with its existence/judgment classification, the evidence-quality markers, fail-open, and the include/exclude lists — live once, in the `cycle_summary` step of `workflows/review.md`. The convergence wrapper passes the flag instead of carrying a copy, so a standalone caller and the wrapper read identical counters. Without the flag nothing changes. When no review ran (every lane failed or was skipped) there is no `CYCLE_SUMMARY` line at all, never `current_high=0`.

**An unattended exit for the wrapper.** `--on-escalation exit` replaces the interactive question with a status. When cycles run out, the run prints the final `CYCLE_SUMMARY` line and both concern sections, then ends with one line:

`CONVERGENCE_STATUS: <status> cycles=<n> current_high=<N> current_actionable=<M> open_conflicts=<K>`

| `<status>` | Meaning |
|---|---|
| `converged` | No HIGH, no actionable non-HIGH, no open plan-revision conflict. State was written as usual. |
| `open_conflicts` | A `## Plan-Revision Conflicts` entry is unresolved. A blocker; outranks the other two. |
| `stalled` | Cycles ran out and the unresolved count did not decrease in the last cycle. |
| `max_cycles` | Cycles ran out with concerns still open and neither of the above applies (this includes a run of one cycle, which has no earlier count to compare against). |

The exit path asks nothing, writes no `STATE.md`, and does not replan, so the plans are left as the last cycle left them. The caller decides what a person should do next through its own channel. `--on-escalation` accepts only `ask` (the default, unchanged) and `exit`; any other value is refused before cycle 1, because falling back to the question would hang the very caller that asked for the exit.

**Known limits:** the counting is still performed by an agent following prose — this removes the second copy of the rules, not the judgment. `/gsd-autonomous --converge` does not pass `--on-escalation`, so it keeps asking. There is no config key; the flag is per invocation.

**Reference:** [Commands](COMMANDS.md#gsd-plan-review-convergence) · [Run plan-review convergence unattended](how-to/run-plan-review-convergence-unattended.md)
