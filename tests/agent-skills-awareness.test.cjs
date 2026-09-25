// allow-test-rule: source-text-is-the-product
// Agent .md files are the installed AI agents — the "Project skills" block IS the deployed
// instruction. Checking text content IS checking what runs in production.
'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');

const AGENTS_DIR = path.join(__dirname, '..', 'agents');

function readAgent(name) {
  return fs.readFileSync(path.join(AGENTS_DIR, `${name}.md`), 'utf8');
}

describe('project skills awareness', () => {
  const agentsRequiringSkills = [
    'gsd-debugger',
    'gsd-integration-checker',
    'gsd-security-auditor',
    'gsd-nyquist-auditor',
    'gsd-codebase-mapper',
    'gsd-roadmapper',
    'gsd-eval-auditor',
    'gsd-intel-updater',
    'gsd-doc-writer',
  ];

  for (const agentName of agentsRequiringSkills) {
    test(`${agentName} has Project skills block`, () => {
      const content = readAgent(agentName);
      assert.ok(content.includes('Project skills'), `${agentName} missing Project skills block`);
    });

    test(`${agentName} does not load full AGENTS.md`, () => {
      const content = readAgent(agentName);
      assert.ok(
        !content.includes('Read AGENTS.md') && !content.includes('load AGENTS.md'),
        `${agentName} should not instruct loading full AGENTS.md`
      );
    });
  }

  test('gsd-doc-writer has security note about doc_assignment user data', () => {
    const content = readAgent('gsd-doc-writer');
    assert.ok(
      content.includes('doc_assignment') && content.includes('SECURITY'),
      'gsd-doc-writer missing security note for doc_assignment block'
    );
  });
});

// #4649: the discovery steps live in exactly one place. Inline copies drifted
// (31 of them across canonical and compact agents) and would silently survive
// any change made to the shared reference.
describe('project skills discovery is consolidated onto the shared reference (#4649)', () => {
  const DISCOVERY_REF = 'gsd-core/references/project-skills-discovery.md';
  const discoveryAgents = [
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

  const agentFiles = fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md'));

  for (const agentName of discoveryAgents) {
    for (const file of [`${agentName}.md`, `${agentName}.compact.md`]) {
      if (!agentFiles.includes(file)) continue;
      test(`${file} @-includes the project skills discovery reference`, () => {
        const content = fs.readFileSync(path.join(AGENTS_DIR, file), 'utf8');
        assert.ok(content.includes(`@~/.claude/${DISCOVERY_REF}`), `${file} must @-include ${DISCOVERY_REF}`);
      });
    }
  }

  test('no agent file carries an inline copy of the discovery steps', () => {
    const inline = agentFiles.filter((f) =>
      fs.readFileSync(path.join(AGENTS_DIR, f), 'utf8').includes('SKILL.md'));
    assert.deepStrictEqual(inline, [], `inline discovery steps belong in ${DISCOVERY_REF}`);
  });

  test('the shared reference still carries the discovery steps', () => {
    const content = fs.readFileSync(path.join(__dirname, '..', DISCOVERY_REF), 'utf8');
    assert.ok(content.includes('SKILL.md'), `${DISCOVERY_REF} must describe the SKILL.md read`);
  });
});

// #4649 direction 1: the index read is scoped to task-relevant skills and follows the
// Agent Skills progressive-disclosure model (metadata, then body, then referenced files)
// instead of the layout of the skill pack the block was written for (#672).
describe('project skills discovery reads task-relevant skills only (#4649)', () => {
  const content = fs.readFileSync(
    path.join(__dirname, '..', 'gsd-core', 'references', 'project-skills-discovery.md'), 'utf8');

  test('the index read covers only the frontmatter of each skill', () => {
    assert.match(content, /read only the YAML frontmatter/);
    assert.doesNotMatch(content, /Read `SKILL\.md` for each skill/);
  });

  test('a full SKILL.md is read only when its description fits the task', () => {
    assert.match(content, /full `SKILL\.md` only for skills whose `description` fits the current task/);
  });

  test('a skill filtered out at the index level stays reachable', () => {
    assert.match(content, /stays available/);
  });

  test('agents that self-load agent_skills skip their configured skills', () => {
    // Keyed on the configured set, not on an <agent_skills> block: discovery runs before
    // the bootstrap self-load, and no block exists on paths without orchestrator
    // injection. config-get returns only the list; `query agent-skills` returns the whole
    // agent persona on non-Claude runtimes when nothing is configured (#2454).
    assert.match(content, /self-loads `agent_skills` \(it references `agent-skills-bootstrap\.md`\)/);
    assert.ok(content.includes('`gsd_run config-get agent_skills.<YOUR-FRONTMATTER-NAME> --default "[]"`'),
      'the configured set must come from config-get');
    assert.ok(!content.includes('query agent-skills'), 'query agent-skills serves the persona fallback');
  });

  test('resources load through the SKILL.md references, not a fixed layout', () => {
    assert.match(content, /files a `SKILL\.md` references/);
    for (const layoutAssumption of ['rules/*.md', '~130', 'AGENTS.md']) {
      assert.ok(!content.includes(layoutAssumption), `reference must not assume ${layoutAssumption}`);
    }
  });

  test('no agent or reference tells the agent not to load AGENTS.md', () => {
    // AGENTS.md is the project instruction file on AGENTS.md-based runtimes, and the
    // converters no longer strip such a line, so it would reach those runtimes verbatim.
    const refsDir = path.join(__dirname, '..', 'gsd-core', 'references');
    const files = [
      ...fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md')).map((f) => path.join(AGENTS_DIR, f)),
      ...fs.readdirSync(refsDir).filter((f) => f.endsWith('.md')).map((f) => path.join(refsDir, f)),
    ];
    const offending = files.filter((f) =>
      splitLines(fs.readFileSync(f, 'utf8')).some((line) => /not load.{0,200}AGENTS\.md/i.test(line)));
    assert.deepStrictEqual(offending.map((f) => path.relative(path.join(__dirname, '..'), f)), []);
  });

  test('no agent file tells its role to load rules/*.md', () => {
    const stale = fs.readdirSync(AGENTS_DIR)
      .filter((f) => f.endsWith('.md'))
      .filter((f) => fs.readFileSync(path.join(AGENTS_DIR, f), 'utf8').includes('rules/*.md'));
    assert.deepStrictEqual(stale, [], 'role lines must follow the files a skill references');
  });
});
