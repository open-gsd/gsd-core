// allow-test-rule: source-text-is-the-product see #1866
// Agent .md files are the installed AI agents — the self-load instruction IS the deployed
// behavior. Checking text content IS checking what runs in production. Same exemption basis
// as tests/agent-skills-awareness.test.cjs (agent_skills is a config/state contract).
'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const fc = require('fast-check');

const AGENTS_DIR = path.join(__dirname, '..', 'agents');
const REFS_DIR = path.join(__dirname, '..', 'gsd-core', 'references');
const BOOTSTRAP_REF = 'agent-skills-bootstrap.md';
const BOOTSTRAP_PATH = path.join(REFS_DIR, BOOTSTRAP_REF);

// The 22 agent_skills consumer agents. This MUST stay in sync with the
// CONSUMER_AGENTS list in tests/agent-skills.test.cjs ("all 22 agent_skills
// consumer agents"). The parity test below enforces the bijection between
// this list and the set of agent files that carry the self-load bootstrap
// (Generative-Fix-Divergence guard — CLAUDE.md "Generative Fix Divergence").
const CONSUMER_AGENTS = [
  'gsd-advisor-researcher',
  'gsd-assumptions-analyzer',
  'gsd-code-fixer',
  'gsd-code-reviewer',
  'gsd-codebase-mapper',
  'gsd-debugger',
  'gsd-doc-writer',
  'gsd-eval-auditor',
  'gsd-executor',
  'gsd-integration-checker',
  'gsd-nyquist-auditor',
  'gsd-phase-researcher',
  'gsd-plan-checker',
  'gsd-planner',
  'gsd-project-researcher',
  'gsd-research-synthesizer',
  'gsd-roadmapper',
  'gsd-security-auditor',
  'gsd-ui-auditor',
  'gsd-ui-checker',
  'gsd-ui-researcher',
  'gsd-verifier',
];

function readAgent(name) {
  return fs.readFileSync(path.join(AGENTS_DIR, `${name}.md`), 'utf8');
}

function allAgentFiles() {
  return fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md'));
}

describe('agent_skills self-load bootstrap', () => {
  test('bootstrap reference file exists at gsd-core/references/', () => {
    assert.ok(fs.existsSync(BOOTSTRAP_PATH), `missing bootstrap reference: ${BOOTSTRAP_PATH}`);
  });

  test('bootstrap documents the dedup guard + frontmatter-name query', () => {
    assert.ok(fs.existsSync(BOOTSTRAP_PATH), 'bootstrap missing');
    const content = fs.readFileSync(BOOTSTRAP_PATH, 'utf8');
    assert.ok(/<agent_skills>/.test(content), 'bootstrap must name the <agent_skills> block');
    // Dedup guard (C2): must instruct the agent to skip self-load when the
    // orchestrator already injected an <agent_skills> block, so the prompt
    // never carries two copies on runtimes where orchestrator injection runs.
    assert.ok(/skip/i.test(content) && /already/i.test(content),
      'bootstrap must document the dedup guard (skip when <agent_skills> already present)');
    // The bootstrap uses the agent's own frontmatter name as the query type —
    // there is no per-agent name baked into each agent file (keeps each file
    // small and the wording uniform). Assert the bootstrap says so.
    assert.ok(/frontmatter/i.test(content) && /query agent-skills/i.test(content),
      'bootstrap must instruct query agent-skills using the frontmatter name');
  });

  describe('every consumer agent carries the self-load bootstrap reference', () => {
    for (const name of CONSUMER_AGENTS) {
      test(`${name} @-includes the bootstrap reference`, () => {
        const content = readAgent(name);
        assert.ok(
          content.includes(BOOTSTRAP_REF),
          `${name} must @-include references/${BOOTSTRAP_REF} (self-load contract)`
        );
      });
    }
  });

  test('parity: set of agents referencing the bootstrap == CONSUMER_AGENTS (bijection)', () => {
    const withBootstrap = allAgentFiles()
      .filter((f) =>
        fs.readFileSync(path.join(AGENTS_DIR, f), 'utf8').includes(BOOTSTRAP_REF))
      .map((f) => f.replace(/\.md$/, ''));

    const consumer = new Set(CONSUMER_AGENTS);
    const bootstrap = new Set(withBootstrap);
    const missing = [...consumer].filter((a) => !bootstrap.has(a));
    const extra = [...bootstrap].filter((a) => !consumer.has(a));
    assert.deepStrictEqual(
      { missing, extra },
      { missing: [], extra: [] },
      `bootstrap presence must exactly match CONSUMER_AGENTS (Generative-Fix-Divergence)\n` +
        `  missing bootstrap: ${missing.join(', ') || '(none)'}\n` +
        `  extra bootstrap: ${extra.join(', ') || '(none)'}`
    );
  });

  test('property (fast-check): for any sampled agent file, bootstrap-presence iff consumer-status', () => {
    const files = allAgentFiles();
    fc.assert(
      fc.property(fc.shuffledSubarray(files, { minLength: 1 }), (sample) => {
        for (const f of sample) {
          const stem = f.replace(/\.md$/, '');
          const content = fs.readFileSync(path.join(AGENTS_DIR, f), 'utf8');
          const hasBootstrap = content.includes(BOOTSTRAP_REF);
          const isConsumer = CONSUMER_AGENTS.includes(stem);
          if (hasBootstrap !== isConsumer) return false;
        }
        return true;
      }),
      { numRuns: 60 }
    );
  });
});
