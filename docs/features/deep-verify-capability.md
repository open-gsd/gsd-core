---
id: 3858
title: Deep Verify Capability
group: v1.42.1 Features
---

**Config keys:** `workflow.deep_verify` (default `false`), `workflow.deep_verify_all_phases` (default `false`)

**Purpose:** UAT depth was capped by how finely the acceptance criteria were written. A criterion such as "the table renders" produced one checkpoint, while the deliverable held dozens of interaction-level behaviors (filter chips, invalid-sort fallback, keyboard navigation, empty states, scope isolation) that never became checkpoints, so the user found and clicked through each one by hand, phase after phase (#3858).

**Behavior:** A default-off capability owns two boolean keys, one agent and one additive step. When `workflow.deep_verify` is on, `gsd-behavior-verifier` runs at `verify:pre`, enumerates behaviors as `action → expected observable outcome` from the plan's `must_haves` / acceptance criteria, the SUMMARY "Files Changed" list and the files it names, and executes each machine-observable one through a browser MCP server. It writes the full run to `{phase}-DEEP-VERIFY.md` and hands `extract_tests` only what a human must still confirm in `DEEP-VERIFY-CHECKPOINTS.md`: judgment items, failed behaviors and anything it could not run. Failures then enter diagnose-issues and gap-closure planning unchanged. With no browser MCP the step degrades to printing the enumerated list and routing every item to the human.

**Built as a capability, not a `verify-work` edit.** The capability registers a `verify:pre` `step` hook, which `verify-work` dispatches since [#3866](https://github.com/open-gsd/gsd-core/issues/3866), and its `produces` artifact reaches `extract_tests` through the produced-artefact seam. Nothing in core changed. Results travel through `produces` and not through a `contribution`, because a contribution injects prompt prose only ([ADR-857](adr/857-capability-system.md) D4).

**Only the checkpoint artifact is produced.** Listing the full-results file would make the seam parse every passed behavior as a checkpoint and surface it to the human; the results file therefore stays unlisted. The checkpoint file is rewritten on every run (with no entries when nothing needs a human) and carries the bare declared name, because the agent cannot delete a stale file and the seam looks the artifact up by that name. Entries carry just `name` and `expected`, the two fields the seam reads.

**Which phases it runs on.** Once on, it runs only on UI phases, which the agent recognizes by a phase-scoped `{phase}-UI-SPEC.md` in the phase directory (it cannot read the init payload, and nothing in core relays it). `workflow.deep_verify_all_phases` widens it to every phase; on its own it activates nothing.

**The browser contract is the existing two-family one.** `mcp__playwright__*` is driven whenever it responds; the Chrome-family servers only while `workflow.live_dom_uat` is also `true`. The browser grants live on the agent's own `tools:` line, which carries no `Bash` ([ADR-1244](adr/1244-capability-ecosystem.md) D2); `gsd-executor` is not widened.

**`nothing_to_report` is never conflated with `could_not_look`.** The results artifact carries a closed `reason` enum so "the phase had nothing to check" and "I had no browser" stay distinguishable.

**Known limits:** the browser-family gate, the phase-directory boundary and the scope gate are instructions the agent follows, not permissions the runtime enforces; the "diff" is the SUMMARY's changed-file list read with `Read`, not a VCS diff; enumeration is best-effort and not a coverage claim; DOM observation only; #1602 coverage metadata does not reach `{phase}-UAT.md`; no sandbox constrains which origins are reached once browser reach is on ([ADR-1244](adr/1244-capability-ecosystem.md) D5).

**Reference:** [Configuration](CONFIGURATION.md) · [Enable deep verification](how-to/enable-deep-verification.md) · [Agents](reference/agents.md)
