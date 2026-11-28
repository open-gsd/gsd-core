---
id: 164
title: Live-DOM UAT Capability
group: v1.7.0 Features
---

**Config key:** `workflow.live_dom_uat` (default `false`)

**Purpose:** A phase with a live-UI acceptance criterion could not be finished by the agent that executed it. `gsd-executor` carries no browser tools, so it correctly returned a `checkpoint:human-action` — even though the work was not human-only, just tool-less. Every such phase quietly degraded from *executed by the executor* to *executed, then finished by hand in the orchestrator*, and the plan's `autonomous: false` marker could not distinguish "a human must judge this" from "the executor lacks the tool" (#2856).

**Behavior:** A default-off capability owns one boolean key, one agent, and one additive step. When the key is on, `gsd-dom-verifier` runs at `execute:wave:post` and writes `{phase}-DOM-VERIFY.md`; the orchestrator's `automated_ui_verification` step additionally considers `mcp__chrome-devtools__*` / `mcp__claude-in-chrome__*` when present.

**Design points (the arguments are in [The live-DOM UAT capability](../explanation/live-dom-uat-capability.md)):**
- The executor's tool surface is unchanged in every configuration; browser reach lives in one purpose-built agent that carries no `Bash`.
- Two independent fail-closed gates: the capability's `activationKey` and the step's own `when` guard. Tool presence alone never activates it.
- The pre-existing `mcp__playwright__*` path keeps its gating; the key gates only the newly added families.
- A browser-profile lock is tolerated, not coordinated: the verifier reports `could_not_look` / `profile_locked`, names `--isolated`, and stops.
- `nothing_to_report` is never conflated with `could_not_look`; the artifact carries a closed `reason` enum.

**Known limits:** no sandbox — once enabled, nothing constrains which origins are reached ([ADR-1244](adr/1244-capability-ecosystem.md) D5); DOM observation only, no screenshot diffing, accessibility audit, or performance tracing.

**Reference:** [Configuration](CONFIGURATION.md) · [Enable live-DOM verification](how-to/enable-live-dom-verification.md) · [Explanation](explanation/live-dom-uat-capability.md) · [Agents](reference/agents.md)
