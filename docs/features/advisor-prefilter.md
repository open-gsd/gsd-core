---
id: 4795
title: Advisor Pre-filter
group: v1.23.0 Features
---

**Config:** `workflow.advisor_prefilter: true` (default `false`)

**Purpose:** Before the orchestrator opens the next review gate, ask the Claude Code session advisor one narrow question: is the current output final and internally consistent, given everything already reviewed in this session? The gates that exist today (`gsd-plan-checker`, `gsd-code-reviewer`, `gsd-verifier`, `gsd-security-auditor`) spawn cold subagents that only see the repository at spawn time, so an edit made after their pass can move a phase forward on a review of stale content. The advisor already holds the transcript, so it can name that gap for the cost of one consult instead of a second cold spawn.

**Seam:** The optional first-party capability `advisor-prefilter` declares one `kind: "contribution"` hook, `into: "orchestrator"`, at two loop points: `verify:post` and `ship:pre`. Those are the points whose step publishes the `orchestrator` role; `execute:*` does not. `verify-work.md` and `ship.md` each dispatch the contribution, and the fragment tells the orchestrator, which is where the advisor tool is reachable, to consult it once.

**Requirements:**
- REQ-ADVISOR-01: With `workflow.advisor_prefilter` unset or off, `loop render-hooks` returns no `advisor-prefilter` entry at any point. A string `"false"`, `"0"`, `"no"` or `"off"` counts as off.
- REQ-ADVISOR-02: With the key on, exactly two points (`verify:post`, `ship:pre`) return one `contribution` entry `into: "orchestrator"`, `onError: "skip"`, with no `produces` or `consumes`.
- REQ-ADVISOR-03: When the session has no advisor tool, the fragment's instruction is to print nothing and write nothing (silent no-op).
- REQ-ADVISOR-04: The consult never blocks, never edits files and never spawns a subagent; the next gate runs whatever the advisor answers.
- REQ-ADVISOR-05: The capability does not replace `gsd-plan-checker`, `gsd-code-reviewer`, `gsd-verifier`, `gsd-security-auditor` or the cross-AI lanes of `/gsd-plan-review-convergence`.
- REQ-ADVISOR-06: Empty, `"false"`, `"0"`, `"no"` and `"off"` strings (any case, trimmed) read as off for every capability config switch.

**Cost and limits:** Each consult sends the full session transcript to the advisor model, billed at the advisor's rate, so the key is off by default. The advisor is a single session-wide model (per-agent control is tracked upstream in anthropics/claude-code#73072) and may share a family with the executor, so the answer is an early warning rather than decorrelated review. The Claude Code advisor is an experimental host feature; GSD takes no dependency on its interface beyond the tool being present.

See [ADR-4795](adr/4795-advisor-prefilter-in-review-pipeline.md), [Enable the advisor pre-filter](how-to/enable-the-advisor-prefilter.md) and the [advisor caveats](../gsd-core/references/model-profiles.md).
