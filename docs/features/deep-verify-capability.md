---
id: 3858
title: Deep Verify Capability
group: v1.42.1 Features
---

**Config keys:** `workflow.deep_verify` (default `false`), `workflow.deep_verify_all_phases` (default `false`)

**Purpose:** UAT depth was capped by how finely the acceptance criteria were written. A criterion such as "the table renders" produced one checkpoint, while the deliverable held dozens of interaction-level behaviors (filter chips, invalid-sort fallback, keyboard navigation, empty states, scope isolation) that never became checkpoints, so the user found and clicked through each one by hand, phase after phase (#3858).

**Behavior:** A default-off capability owns two boolean keys, one agent and one additive step. When `workflow.deep_verify` is on, `gsd-behavior-verifier` runs at `verify:pre`, enumerates behaviors as `action → expected observable outcome` from the plan's `must_haves` / acceptance criteria, the SUMMARY "Files Changed" list and the files it names, and executes each machine-observable one through a browser MCP server. It writes the full run to `{phase}-DEEP-VERIFY.md` and hands `extract_tests` only what a human must still confirm in `DEEP-VERIFY-CHECKPOINTS.md`: judgment items, failed behaviors and anything it could not run. Failures then enter diagnose-issues and gap-closure planning unchanged. With no browser MCP the step degrades to printing the enumerated list and routing every item to the human.

**Design points (the arguments are in [Deep verify capability](../explanation/deep-verify-capability.md)):** it is a capability with a `verify:pre` `step` hook, not a `verify-work` edit; only the checkpoint artifact (`DEEP-VERIFY-CHECKPOINTS.md`, rewritten on every run) is produced; it runs on UI phases (a phase-scoped `{phase}-UI-SPEC.md`) unless `workflow.deep_verify_all_phases` widens it; `mcp__playwright__*` is driven whenever it responds and the Chrome-family servers only while `workflow.live_dom_uat` is also `true`; and the results artifact carries a closed `reason` enum so `nothing_to_report` and `could_not_look` stay distinguishable.

**Known limits:** the browser-family gate, the phase-directory boundary and the scope gate are instructions the agent follows, not permissions the runtime enforces; the "diff" is the SUMMARY's changed-file list read with `Read`, not a VCS diff; enumeration is best-effort and not a coverage claim; DOM observation only; #1602 coverage metadata does not reach `{phase}-UAT.md`; no sandbox constrains which origins are reached once browser reach is on ([ADR-1244](adr/1244-capability-ecosystem.md) D5).

**Reference:** [Configuration](CONFIGURATION.md) · [Enable deep verification](how-to/enable-deep-verification.md) · [Agents](reference/agents.md)
