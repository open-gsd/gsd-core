---
id: 4795
title: Advisor Pre-filter
group: v1.23.0 Features
---

**Config:** `workflow.advisor_prefilter: true` (default `false`)

**Purpose:** Before the orchestrator opens the next review gate, ask the Claude Code session advisor one narrow question: is the current output final and internally consistent, given everything already reviewed in this session? The gates that exist today (`gsd-plan-checker`, `gsd-code-reviewer`, `gsd-verifier`, `gsd-security-auditor`) spawn cold subagents that only see the repository at spawn time, so an edit made after their pass can move a phase forward on a review of stale content. The advisor already holds the transcript, so it can name that gap for the cost of one consult instead of a second cold spawn.

**Seam:** The optional first-party capability `advisor-prefilter` declares one `kind: "step"` hook with `ref.skill: "advisor-prefilter"` at three loop points: `execute:wave:post`, `verify:post` and `ship:pre`. The three host workflows already dispatch every active `step`, so no workflow, envelope or validator changes. The step runs the skill in the orchestrator's own context, which is the only place the advisor tool is reachable (a `ref.command` subprocess cannot call it).

**Requirements:**
- REQ-ADVISOR-01: With `workflow.advisor_prefilter` unset or `false`, `loop render-hooks` returns no `advisor-prefilter` entry at any point.
- REQ-ADVISOR-02: With the key `true`, exactly three points (`execute:wave:post`, `verify:post`, `ship:pre`) return one `step` entry, `onError: "skip"`, with no `produces` or `consumes`.
- REQ-ADVISOR-03: When the session has no advisor tool, the skill prints nothing and writes nothing (silent no-op).
- REQ-ADVISOR-04: The skill never blocks, never edits files and never spawns a subagent; the next gate runs whatever the advisor answers.
- REQ-ADVISOR-05: The capability does not replace `gsd-plan-checker`, `gsd-code-reviewer`, `gsd-verifier`, `gsd-security-auditor` or the cross-AI lanes of `/gsd-plan-review-convergence`.

**Cost and limits:** Each consult sends the full session transcript to the advisor model, billed at the advisor's rate, so the key is off by default. The advisor is a single session-wide model (per-agent control is tracked upstream in anthropics/claude-code#73072) and may share a family with the executor, so the answer is an early warning rather than decorrelated review. The Claude Code advisor is an experimental host feature; GSD takes no dependency on its interface beyond the tool being present.

See [ADR-4795](adr/4795-advisor-prefilter-in-review-pipeline.md), [Enable the advisor pre-filter](how-to/enable-the-advisor-prefilter.md) and the [advisor caveats](../gsd-core/references/model-profiles.md).
