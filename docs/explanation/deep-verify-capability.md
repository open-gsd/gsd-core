# Deep verify capability

> Explanation. Why GSD enumerates interaction-level behaviors during UAT and how the
> capability is shaped. Keys, behavior and limits are in the
> [Deep Verify Capability feature entry](../FEATURES.md); setup is in
> [Enable deep verification](../how-to/enable-deep-verification.md).

## The problem (#3858)

UAT depth was capped by how finely the acceptance criteria were written. A criterion such as
"the table renders" produced one checkpoint, while the deliverable held dozens of
interaction-level behaviors (filter chips, invalid-sort fallback, keyboard navigation, empty
states, scope isolation) that never became checkpoints, so the user found and clicked through
each one by hand, phase after phase.

## Why it is a capability and not a `verify-work` edit

The capability registers a `verify:pre` `step` hook, which `verify-work` dispatches since [#3866](https://github.com/open-gsd/gsd-core/issues/3866), and its `produces` artifact reaches `extract_tests` through the produced-artefact seam. Nothing in core changed. Results travel through `produces` and not through a `contribution`, because a contribution injects prompt prose only ([ADR-857](../adr/857-capability-system.md) D4).

## Why only the checkpoint artifact is produced

Listing the full-results file would make the seam parse every passed behavior as a checkpoint and surface it to the human; the results file therefore stays unlisted. The checkpoint file is rewritten on every run (with no entries when nothing needs a human) and carries the bare declared name, because the agent cannot delete a stale file and the seam looks the artifact up by that name. Entries carry just `name` and `expected`, the two fields the seam reads.

## Which phases it runs on

Once on, it runs only on UI phases, which the agent recognizes by a phase-scoped `{phase}-UI-SPEC.md` in the phase directory (it cannot read the init payload, and nothing in core relays it). `workflow.deep_verify_all_phases` widens it to every phase; on its own it activates nothing.

## Why the browser contract is the existing two-family one

`mcp__playwright__*` is driven whenever it responds; the Chrome-family servers only while `workflow.live_dom_uat` is also `true`. The browser grants live on the agent's own `tools:` line, which carries no `Bash` ([ADR-1244](../adr/1244-capability-ecosystem.md) D2); `gsd-executor` is not widened.

## Why `nothing_to_report` is never conflated with `could_not_look`

The results artifact carries a closed `reason` enum so "the phase had nothing to check" and "I had no browser" stay distinguishable.
