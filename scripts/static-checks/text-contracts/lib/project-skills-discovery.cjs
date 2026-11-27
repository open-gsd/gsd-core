'use strict';

// The one list of agents that run project-skills discovery (#4649), shared by the
// agent-skills-awareness contract and the test that exercises it, so the two cannot drift.

const REFERENCE = 'gsd-core/references/project-skills-discovery.md';
const INCLUDE = '@~/.claude/gsd-core/references/project-skills-discovery.md';
// A guard against regrowth, not a measure of delivery: the reference is prompt text every spawn of
// every discovery agent pays for. LF-normalised bytes, as the emitted-attribution gate counts.
const REFERENCE_MAX_BYTES = 1600;

// The 21 canonical agents that run project-skills discovery.
const DISCOVERY_AGENTS = [
  'gsd-code-fixer',
  'gsd-code-reviewer',
  'gsd-codebase-mapper',
  'gsd-debugger',
  'gsd-doc-verifier',
  'gsd-doc-writer',
  'gsd-eval-auditor',
  'gsd-executor',
  'gsd-integration-checker',
  'gsd-intel-updater',
  'gsd-nyquist-auditor',
  'gsd-pattern-mapper',
  'gsd-phase-researcher',
  'gsd-plan-checker',
  'gsd-planner',
  'gsd-roadmapper',
  'gsd-security-auditor',
  'gsd-ui-auditor',
  'gsd-ui-checker',
  'gsd-ui-researcher',
  'gsd-verifier',
];

// Agents the compact generator does not ship a variant for.
const WITHOUT_COMPACT = [
  'gsd-debugger',
  'gsd-executor',
  'gsd-phase-researcher',
  'gsd-plan-checker',
  'gsd-planner',
  'gsd-verifier',
];

const COMPACT_AGENTS = DISCOVERY_AGENTS.filter((name) => !WITHOUT_COMPACT.includes(name));

// Every agent file the contract covers: 21 canonical + 15 compact.
const DISCOVERY_FILES = [
  ...DISCOVERY_AGENTS.map((name) => `agents/${name}.md`),
  ...COMPACT_AGENTS.map((name) => `agents/${name}.compact.md`),
];

// The files whose spawn prompts carry a "Project skills" line for the executor, planner or phase
// researcher (#5248). Each line must state the same scoped read as the reference, because on a
// runtime where the agent's @-include does not resolve the line is the only discovery instruction.
const SPAWN_PROMPT_FILES = [
  'gsd-core/workflows/execute-phase.md',
  'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md',
  'gsd-core/workflows/plan-phase.md',
  'gsd-core/workflows/quick.md',
  'capabilities/research/fragments/plan-pre.md',
];

module.exports = {
  SPAWN_PROMPT_FILES,
  REFERENCE,
  INCLUDE,
  REFERENCE_MAX_BYTES,
  DISCOVERY_AGENTS,
  COMPACT_AGENTS,
  DISCOVERY_FILES,
};
