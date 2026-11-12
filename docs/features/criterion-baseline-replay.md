---
id: 4310
title: Criterion Baseline Replay
group: v1.43.0 Features
---

**Command:** `gsd-tools verify plan-structure <PLAN.md> --replay` (opt-in, run by hand)

**Purpose:** Check that a recorded baseline was measured, not guessed. `[HEAD=2 EXPECT>=3]` claims the command printed 2 before the work. Replay runs the command and reports a mismatch when it prints something else. Without it, a wrong baseline surfaces only when the executor runs the phase.

**How it works:**
- The command is the backtick span before the notation, or the text before the trailing `#` of an `<automated>` command.
- It runs as direct argv with no shell, from the project root.
- Only `grep`, and `git` with `grep`, `ls-files`, `rev-parse` or `rev-list`, may run. Anything else is a `disallowed` status and does not run.
- Each command gets 10 s and 64 KiB of output. A run replays at most 50 commands within 60 s.

**Output:** a `replay` key, `{ head_sha, results, mismatch_count, statuses }`. Results carry the recorded and observed values, never the raw output.

**Advisory only:** a mismatch is a warning and a status changes nothing. The exit code and `valid` come from the static rules alone.

**Docs:** [How to check recorded baselines by replaying them](how-to/replay-recorded-baselines.md) · [ADR-4310](adr/4310-criterion-replay.md)
