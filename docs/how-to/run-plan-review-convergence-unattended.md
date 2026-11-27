# How to run plan-review convergence unattended

**Goal:** Run the plan → review → replan loop where no person can answer a question — a board worker, a CI job — and get back a status and the open concerns instead of a prompt.

**Prerequisites:** At least one reviewer lane available (see [Set up cross-AI review](set-up-cross-ai-review.md)) and a phase that has plans or can be planned.

---

## 1. Enable the loop

`/gsd-plan-review-convergence` is off by default:

```bash
gsd config-set workflow.plan_review_convergence true
```

## 2. Run it with the unattended exit

```bash
/gsd-plan-review-convergence 3 --max-cycles 3 --on-escalation exit
```

Add reviewer flags (`--codex`, `--all`, …) as usual. Without `--on-escalation exit` the loop asks "Proceed anyway / Manual review" when cycles run out, and waits for an answer.

## 3. Read the last line

The run ends with one machine-readable line:

```text
CONVERGENCE_STATUS: <status> cycles=<n> current_high=<N> current_actionable=<M> open_conflicts=<K>
```

| `<status>` | What it means | What to do |
|---|---|---|
| `converged` | Nothing open. State was written. | Run `/gsd-execute-phase 3`. |
| `open_conflicts` | A plan-revision conflict in `REVIEWS.md` is unresolved. | Route to a person; replanning cannot resolve it on its own. |
| `stalled` | Cycles ran out and the unresolved count did not fall. | Route to a person; more cycles are unlikely to help. |
| `max_cycles` | Cycles ran out and neither of the above applies (a one-cycle run lands here, since it has no earlier count to compare). | Re-run with a higher `--max-cycles`, or route to a person. |

On a non-`converged` exit, everything above that line is for the person: the final `CYCLE_SUMMARY` line, then `## Current HIGH Concerns` and `## Current Actionable Non-HIGH Concerns`. (A converged run prints the usual banner and `Next:` line first.) A non-`converged` exit writes no state and leaves the plans as the last cycle left them.

**A missing `CONVERGENCE_STATUS` line is not success.** If the run died earlier (for example a bad `--on-escalation` value, which is refused before cycle 1 with `'ask' or 'exit'`), treat the absence as "could not look", not "nothing to report".

---

## Assembling the cycle yourself

If you need the replan step under your own control, run the pieces and read the same counters:

```bash
/gsd-review --phase 3 --codex --cycle-summary
```

The response ends with `CYCLE_SUMMARY: current_high=<N> current_actionable=<M>` and the two concern sections, counted by the same rules the loop uses. Then replan with `/gsd-plan-phase 3 --reviews`. Do not grep `REVIEWS.md` for counts: it accumulates every cycle's history. If no review ran (every lane failed or was skipped) there is no `CYCLE_SUMMARY` line — never read that as zero concerns.

---

## Related

- [Commands](../COMMANDS.md#gsd-plan-review-convergence)
- [Unattended Plan-Review Convergence](../FEATURES.md#4617-unattended-plan-review-convergence)
