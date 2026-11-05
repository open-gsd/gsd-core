---
id: 71
title: Research Gate
group: v1.32 Features
---

**Part of:** `/gsd-plan-phase`

**Purpose:** Block planning when RESEARCH.md has unresolved open questions, preventing plans built on incomplete information.

**Resolved means user-decided:** an open question counts as resolved only when every `D-NN` it cites sits under the phase's CONTEXT.md `<decisions>`, outside Claude's Discretion, and one answers it; a mark the researcher wrote itself, a `(RESOLVED)` heading suffix included, does not. A cited source settles a factual gap, so that is not an open question, but no source settles a choice that needs a user ruling. In an area CONTEXT.md leaves to Claude's Discretion, a sourced recommendation is enough.

**Enforcement point:** plan-checker Dimension 11, in plan-phase's verify loop after the planner runs (#5438). No plan-phase step gates at entry.

**Requirements:**
- REQ-RESGATE-01: System MUST check RESEARCH.md for unresolved open questions when it verifies the plans
- REQ-RESGATE-02: System MUST raise a blocker for each unresolved open question, so the plans are not accepted
- REQ-RESGATE-03: System MUST surface the specific unresolved questions to the user

**Process:**
1. **Scan** — Dimension 11 collects every question RESEARCH.md leaves open, under any heading
2. **Gate** — Each one with no qualifying `D-NN` is a blocker; the planner can cite a decision already on record, but cannot add one
3. **Surface** — With no such decision, the planner returns a conflict and plan-phase asks the user, naming `/gsd-discuss-phase` and `/gsd-plan-phase --research`
