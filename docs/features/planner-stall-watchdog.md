---
id: 3923
title: Planner Stall Watchdog
group: Planning Features
---

**Command:** `/gsd-plan-phase` (settings: `/gsd-config --advanced`, Planning Tuning)

**Purpose:** A planner or plan-checker subagent can finish its work while the runtime loses the completion handoff, which used to leave plan-phase waiting forever (#2650). Plan-phase now watches for completion itself and, after a bounded wait with no sign of progress, offers the accept-plans / retry / stop recovery choice. Models differ widely in speed, so how long "no sign of progress" lasts before that choice appears is a setting you can change (#3923).

**Behavior:**

- **Two signals count as progress.** A completion marker in the agent's output, or a `*-PLAN.md` file modified within the last check interval. Either one keeps plan-phase waiting. Only when neither appears for `planner.stall_threshold_minutes` (default `10`) does plan-phase treat the agent as stalled.
- **It checks on a fixed cadence.** Plan-phase looks every `planner.stall_detect_interval_minutes` (default `5`). Each check is one bounded wait, so a finished agent is noticed at most one interval late. That is the cost of never hanging.
- **The threshold is the knob for slow models.** A model that is still working but takes longer than the threshold to write anything is flagged as stalled. Raising the threshold removes those false alarms. Lowering the interval notices a finished planner sooner, at the price of more checks.
- **Both values are whole minutes, `1` or more.** A stored `0`, a negative, a non-number or a value of more than nine digits falls back to the default. An interval of `0` would make every check a zero-length wait, and a threshold of `0` would flag a healthy agent on the first check.
- **The watchdog can be turned off.** `planner.stall_detection_enabled: false` waits on the runtime's own completion signal instead. That gives up the bounded recovery, so `/gsd-config --advanced` shows a warning first and only asks for the threshold and interval while the watchdog is on.

**Requirements:**
- REQ-PLANNER-STALL-01: The stall threshold and check interval MUST be settable from `/gsd-config --advanced` without editing `config.json`
- REQ-PLANNER-STALL-02: The defaults MUST stay 10 minutes (threshold) and 5 minutes (interval)
- REQ-PLANNER-STALL-03: A stored value that is not a positive integer of at most nine digits MUST resolve to the default
