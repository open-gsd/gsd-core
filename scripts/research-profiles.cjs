#!/usr/bin/env node
'use strict';

/**
 * research-profiles.cjs — hand-authored profile table for the 7 researcher agents.
 *
 * Each profile field is derived verbatim from the agent's current committed state so
 * that the initial --check in gen-research-agents.cjs is green by construction.
 *
 * Fields:
 *   name             — verbatim frontmatter `name:` value
 *   description      — verbatim frontmatter `description:` value
 *   color            — verbatim frontmatter `color:` value
 *   tools            — verbatim frontmatter `tools:` value (single string, comma-separated)
 *   requiredIncludes — @~/.claude/gsd-core/references/<file>.md strings the body MUST contain
 *   requiredSeamCalls — `gsd_run query <cmd>` strings the body MUST contain
 *   outputContract   — strings the body MUST contain (output path, return marker, etc.)
 */

const PROFILES = [
  {
    name: 'gsd-project-researcher',
    description:
      'Researches domain ecosystem before roadmap creation. Produces files in .planning/research/ consumed during roadmap creation. Spawned by /gsd:new-project or /gsd:new-milestone orchestrators.',
    color: 'cyan',
    tools:
      'Read, Write, Bash, Grep, Glob, WebSearch, WebFetch, mcp__context7__*, mcp__firecrawl__*, mcp__exa__*, mcp__tavily__*, mcp__ref__*, mcp__jina__*',
    requiredIncludes: [
      '@~/.claude/gsd-core/references/research-documentation-lookup.md',
      '@~/.claude/gsd-core/references/research-philosophy.md',
      '@~/.claude/gsd-core/references/research-verification-protocol.md',
    ],
    requiredSeamCalls: [
      'gsd_run query research-plan',
      'gsd_run query research-store put',
      'gsd_run query classify-confidence',
    ],
    outputContract: [
      '.planning/research/',
      '## RESEARCH COMPLETE',
    ],
  },
  {
    name: 'gsd-phase-researcher',
    description:
      'Researches how to implement a phase before planning. Produces RESEARCH.md consumed by gsd-planner. Spawned by /gsd:plan-phase orchestrator.',
    color: 'cyan',
    tools:
      'Read, Write, Edit, Bash, Grep, Glob, WebSearch, WebFetch, mcp__context7__*, mcp__firecrawl__*, mcp__exa__*, mcp__tavily__*, mcp__ref__*, mcp__jina__*',
    requiredIncludes: [
      '@~/.claude/gsd-core/references/research-documentation-lookup.md',
      '@~/.claude/gsd-core/references/research-philosophy.md',
      '@~/.claude/gsd-core/references/research-verification-protocol.md',
    ],
    requiredSeamCalls: [
      'gsd_run query research-plan',
      'gsd_run query research-store put',
      'gsd_run query classify-confidence',
      'gsd_run query package-legitimacy check',
    ],
    outputContract: [
      '.planning/phases/XX-name/{phase_num}-RESEARCH.md',
      '## RESEARCH COMPLETE',
    ],
  },
  {
    name: 'gsd-advisor-researcher',
    description:
      'Researches a single gray area decision and returns a structured comparison table with rationale. Spawned by discuss-phase advisor mode.',
    color: 'cyan',
    tools: 'Read, Bash, Grep, Glob, WebSearch, WebFetch, mcp__context7__*',
    requiredIncludes: [
      '@~/.claude/gsd-core/references/research-documentation-lookup.md',
    ],
    requiredSeamCalls: [],
    outputContract: [
      '| Option | Pros | Cons | Complexity | Recommendation |',
      '**Rationale:**',
    ],
  },
  {
    name: 'gsd-ai-researcher',
    description:
      'Researches a chosen AI framework\'s official docs to produce implementation-ready guidance — best practices, syntax, core patterns, and pitfalls distilled for the specific use case. Writes the Framework Quick Reference and Implementation Guidance sections of AI-SPEC.md. Spawned by /gsd:ai-integration-phase orchestrator.',
    color: 'green',
    tools:
      'Read, Write, Edit, Bash, Grep, Glob, WebFetch, WebSearch, mcp__context7__*',
    requiredIncludes: [
      '@~/.claude/gsd-core/references/research-documentation-lookup.md',
    ],
    requiredSeamCalls: [],
    outputContract: [
      'AI-SPEC.md',
      'Section 3',
      'Section 4',
    ],
  },
  {
    name: 'gsd-domain-researcher',
    description:
      'Researches the business domain and real-world application context of the AI system being built. Surfaces domain expert evaluation criteria, industry-specific failure modes, regulatory context, and what "good" looks like for practitioners in this field — before the eval-planner turns it into measurable rubrics. Spawned by /gsd:ai-integration-phase orchestrator.',
    color: 'purple',
    tools:
      'Read, Write, Edit, Bash, Grep, Glob, WebSearch, WebFetch, mcp__context7__*',
    requiredIncludes: [
      '@~/.claude/gsd-core/references/research-documentation-lookup.md',
    ],
    requiredSeamCalls: [],
    outputContract: [
      'AI-SPEC.md',
      'Section 1b',
    ],
  },
  {
    name: 'gsd-ui-researcher',
    description:
      'Produces UI-SPEC.md design contract for frontend phases. Reads upstream artifacts, detects design system state, asks only unanswered questions. Spawned by /gsd:ui-phase orchestrator.',
    color: 'purple',
    tools:
      'Read, Write, Edit, Bash, Grep, Glob, WebSearch, WebFetch, mcp__context7__*, mcp__firecrawl__*, mcp__exa__*, mcp__tavily__*, mcp__ref__*, mcp__jina__*',
    requiredIncludes: [
      '@~/.claude/gsd-core/references/research-documentation-lookup.md',
    ],
    requiredSeamCalls: [
      'gsd_run query commit',
    ],
    outputContract: [
      'UI-SPEC.md',
      '## UI-SPEC COMPLETE',
    ],
  },
  {
    name: 'gsd-research-synthesizer',
    description:
      'Synthesizes research outputs from parallel researcher agents into SUMMARY.md. Spawned by /gsd:new-project after 4 researcher agents complete.',
    color: 'purple',
    tools: 'Read, Write, Bash',
    requiredIncludes: [],
    requiredSeamCalls: [
      'gsd_run query commit',
    ],
    outputContract: [
      '.planning/research/SUMMARY.md',
      '## SYNTHESIS COMPLETE',
    ],
  },
];

module.exports = { PROFILES };
