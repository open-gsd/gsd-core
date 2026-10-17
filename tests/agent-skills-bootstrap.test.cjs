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
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');

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
  // #4407: .compact.md variant siblings carry the same self-load line as their
  // canonical agent (preserved verbatim by design) but are not a distinct
  // consumer identity — exclude them from the CONSUMER_AGENTS bijection.
  return fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md') && !f.endsWith('.compact.md'));
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

// ── #5122: the self-load must be runnable, name the agent's own type, and not
// re-ingest the agent's persona ───────────────────────────────────────────────
// Every file that carries the bootstrap pointer — canonical agents and their
// .compact.md siblings, which are what a non-Claude runtime serves — states its
// own agent type on the pointer line. The type lives in the body because Claude
// Code never shows frontmatter to a subagent, the Kimi converter drops it, and
// Codex keeps it in a TOML key. The query itself, the launcher and the
// per-runtime contract live once, in the bootstrap reference (agent files sit
// at their size caps and gsd-ui-auditor carries no gsd_run by design).
function selfLoadFiles() {
  return fs.readdirSync(AGENTS_DIR)
    .filter((f) => f.endsWith('.md'))
    .filter((f) => fs.readFileSync(path.join(AGENTS_DIR, f), 'utf8').includes(BOOTSTRAP_REF));
}

function agentTypeOf(file) {
  return file.replace(/\.compact\.md$/, '').replace(/\.md$/, '');
}

describe('#5122 every self-loading agent states its own type', () => {
  const files = selfLoadFiles();

  test('the sweep covers canonical agents and compact siblings', () => {
    assert.ok(files.length >= CONSUMER_AGENTS.length * 2 - 8, `only ${files.length} files found`);
    for (const name of CONSUMER_AGENTS) {
      assert.ok(files.includes(`${name}.md`), `${name}.md missing from the sweep`);
    }
  });

  for (const file of files) {
    const type = agentTypeOf(file);
    test(`${file} names its own type on the bootstrap pointer line`, () => {
      const content = fs.readFileSync(path.join(AGENTS_DIR, file), 'utf8');
      const pointer = splitLines(content).filter((l) => l.includes(BOOTSTRAP_REF));
      assert.strictEqual(pointer.length, 1, `${file} must carry exactly one bootstrap pointer`);
      assert.ok(pointer[0].includes(`(agent type: \`${type}\`)`),
        `${file} pointer must state "(agent type: \`${type}\`)": ${pointer[0].slice(0, 160)}`);
      const fm = /^name:\s*"?([A-Za-z0-9-]{1,64})"?\s*$/m.exec(content);
      if (fm) assert.strictEqual(fm[1], type, 'frontmatter name must match the stated type');
    });
  }
});

describe('#5122 bootstrap states how to run the self-load and what each runtime returns', () => {
  const doc = fs.readFileSync(BOOTSTRAP_PATH, 'utf8');

  test('the query takes the stated agent type and --skills-only, and its failure stays visible', () => {
    const cmd = splitLines(doc).find((l) => l.includes('gsd_run query agent-skills'));
    assert.ok(cmd, 'bootstrap must carry the query command');
    assert.ok(cmd.includes('--skills-only'), 'the self-load must pass --skills-only');
    assert.ok(!cmd.includes('2>/dev/null') && !cmd.includes('|| true'),
      'stderr and the exit status must stay visible so a failure is not read as "nothing configured"');
    assert.ok(/agent type/i.test(doc), 'bootstrap must tell the agent to use the type stated in its own file');
  });

  test('supplies the launcher instead of assuming the agent defines it', () => {
    assert.ok(doc.includes('gsd-run-resolver.md'), 'bootstrap must point at the shared resolver reference');
    assert.ok(!/your own init already defines/i.test(doc), 'gsd_run is not defined by every agent init');
    const resolver = fs.readFileSync(path.join(REFS_DIR, 'gsd-run-resolver.md'), 'utf8');
    assert.ok(resolver.includes('gsd_run() {'), 'the referenced resolver must define gsd_run');
  });

  test('documents --skills-only and the per-runtime return contract', () => {
    assert.ok(doc.includes('--skills-only'), 'bootstrap must tell the agent to pass --skills-only');
    assert.ok(/non-Claude/.test(doc) && /persona/i.test(doc),
      'bootstrap must state that a non-Claude runtime returns the agent persona without --skills-only');
    assert.ok(!/exits 0 with an empty\s+block when nothing is configured for your type/i.test(doc),
      'the empty-block claim must be scoped to --skills-only');
  });

  test('does not send the agent to frontmatter it may not be able to see', () => {
    assert.ok(!/the `name:` value in\s+your frontmatter/i.test(doc));
    assert.ok(/Claude Code/.test(doc) && /frontmatter/i.test(doc),
      'bootstrap must explain why the type is not read from frontmatter');
  });
});
