# Temporal context as a first-class GSD signal

**Source:** [#2756](https://github.com/open-gsd/gsd-core/issues/2756)
**Decision:** wontfix — closed without further engagement
**Date:** 2026-05-02

## Proposal summary

Reporter proposed treating idle-time-between-turns as a first-class context signal in
GSD. Three flavors floated across the issue:

1. **Passive** — block at session resume injecting "you've been idle Nh, here's what was
   open" into the orchestrator prompt.
2. **Active** — `/resume-context` slash command.
3. **Retrospective** — `HANDOFF.json` written at session end, read at next start.

Framed initially as a `claude-inject-idle-time` plugin, with a request that GSD treat
the pattern as core.

## Why GSD does not own this

- **Subagent gap unsolved.** Passive injection lands in the orchestrator's context
  only. Subagents (the workers that actually do GSD's planning, execution, verification)
  spawn fresh and never see the temporal signal. The proposal does not solve this, and
  any GSD-core integration would inherit the gap. Until the subagent boundary is
  addressed, "first-class temporal context" is at best a partial feature.
- **`HANDOFF.json` duplicates existing artifacts.** GSD already persists session
  continuity through `.planning/state/*` and per-phase artifacts (PLAN.md, RESEARCH.md,
  REVIEW.md, VERIFICATION.md). A separate handoff file would either drift from those or
  redundantly mirror them. The right primitive for "what was I doing" already exists.
- **Statusline / TUI re-entry is platform-level, not GSD-level.** A statusline showing
  idle time belongs in Claude Code itself or in a thin user plugin, not in GSD's phase
  machinery.
- **Scope is unstable.** Reporter agreed with the narrowed minimum ask ("doc mention
  only, rest opt-in"), then partially retracted it in a follow-up comment ("very
  integral to myself"). The maintainer asked which version of the ask should move
  forward; reporter did not respond.

## Re-open criteria

This may be revisited if a reporter:

- Engages with the subagent-gap problem and proposes a concrete mechanism for
  temporal context to reach subagents (not just the orchestrator).
- Demonstrates a use case `.planning/state/*` provably cannot serve.
- Commits to a single stable scope (doc mention OR core integration OR plugin
  reference) rather than oscillating between them mid-thread.

A drive-by enhancement request that the author does not return to engage with after
maintainer questions is not actionable. Future proposers: please plan to participate
through to a triage decision rather than dropping an issue and moving on.

## Related

- `.planning/state/` — existing session-continuity artifacts
- `get-shit-done/references/` — where any future plugin-interface doc would live
