---
name: gsd:ai-integration-phase
description: Generate an AI-SPEC.md design contract for phases that involve building AI systems.
argument-hint: "[phase number]"
allowed-tools:
  - Read
  - Write
  - Bash
  - Glob
  - Grep
  - Agent
  - WebFetch
  - WebSearch
  - AskUserQuestion
  - mcp__context7__*
requires: [phase]
---
<objective>
Create an AI design contract (AI-SPEC.md) for a phase involving AI system development.
Orchestrates gsd-framework-selector → gsd-ai-researcher → gsd-domain-researcher → gsd-eval-planner.
Flow: Select Framework → Research Docs → Research Domain → Design Eval Strategy → Done
</objective>

<execution_context>
@~/.claude/gsd-core/workflows/ai-integration-phase.md
@~/.claude/gsd-core/references/ai-frameworks.md
@~/.claude/gsd-core/references/ai-evals.md
</execution_context>

<context>
Phase number: $ARGUMENTS — optional; when omitted, the orchestrating workflow reads ROADMAP.md and selects the next unplanned phase. This is not a `gsd-tools.cjs` CLI feature — the CLI's phase-lookup primitives require an explicit phase number.
</context>

<process>
Execute end-to-end.
Preserve all workflow gates.
</process>
