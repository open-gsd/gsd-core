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

    test(`${agentName} names CLAUDE.md, not AGENTS.md, as the project instructions to read`, () => {
      const content = readAgent(agentName);
      assert.ok(
        !content.includes('Read AGENTS.md') && !content.includes('load AGENTS.md'),
        `${agentName} must point at CLAUDE.md; the converters map it to each runtime's instruction file`
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
const DISCOVERY_REF = 'gsd-core/references/project-skills-discovery.md';
const DISCOVERY_INCLUDE = `@~/.claude/${DISCOVERY_REF}`;
const REPO_ROOT = path.join(__dirname, '..');

function readDiscoveryRef() {
  return fs.readFileSync(path.join(REPO_ROOT, DISCOVERY_REF), 'utf8');
}

function markdownFilesUnder(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...markdownFilesUnder(full));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

/**
 * The statement after the discovery @-include: the rest of the include line
 * (compact variants) plus the non-blank lines right below it (canonical
 * variants). A blank line ends it, so later boilerplate does not count.
 */
function applicationStatement(content) {
  const lines = splitLines(content);
  const at = lines.findIndex((line) => line.includes(DISCOVERY_INCLUDE));
  if (at === -1) return '';
  const inline = lines[at].slice(lines[at].indexOf(DISCOVERY_INCLUDE) + DISCOVERY_INCLUDE.length).split('**agent_skills:**')[0];
  const following = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() === '') break;
    following.push(line);
  }
  // A restated step 6 ("Load files the skill references ...") says nothing about the role.
  return [inline, ...following.filter((line) => !/^\s*- Load files the skill references/.test(line))]
    .join('\n').replace(/^\s*—\s*/, '').trim();
}

describe('project skills discovery is consolidated onto the shared reference (#4649)', () => {
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
        assert.ok(content.includes(DISCOVERY_INCLUDE), `${file} must @-include ${DISCOVERY_REF}`);
      });

      // The reference defers "Application" to the calling agent's file, so each
      // discovery agent must say how its role applies the skills it loads.
      test(`${file} states how its role applies the project skills it loads`, () => {
        const content = fs.readFileSync(path.join(AGENTS_DIR, file), 'utf8');
        assert.match(applicationStatement(content), /\bskills?\b/i,
          `${file} must follow the discovery @-include with how its role applies the skills`);
      });
    }
  }

  test('every agent that @-includes the reference is a listed discovery agent', () => {
    const including = agentFiles
      .filter((f) => fs.readFileSync(path.join(AGENTS_DIR, f), 'utf8').includes(DISCOVERY_INCLUDE))
      .map((f) => f.replace(/(\.compact)?\.md$/, ''));
    assert.deepStrictEqual([...new Set(including)].filter((name) => !discoveryAgents.includes(name)), []);
  });

  test('no agent file carries an inline copy of the discovery steps', () => {
    const inlineStep = /List available skills|Read `?SKILL\.md`? (for each|per skill)|read each `?SKILL\.md`?|Load (specific )?`?rules\/\*\.md`?/i;
    const inline = agentFiles.filter((f) => inlineStep.test(fs.readFileSync(path.join(AGENTS_DIR, f), 'utf8')));
    assert.deepStrictEqual(inline, [], `inline discovery steps belong in ${DISCOVERY_REF}`);
  });

  test('the shared reference carries the numbered discovery steps', () => {
    const content = readDiscoveryRef();
    assert.match(content, /^1\. Check `\.claude\/skills\/` or `\.agents\/skills\/`/m);
    assert.match(content, /^6\. Load files a `SKILL\.md` references/m);
  });
});

// #4649 direction 1: the index read is scoped to task-relevant skills and follows the
// Agent Skills progressive-disclosure model (metadata, then body, then referenced files)
// instead of the layout of the skill pack the block was written for
// (gsd-build/get-shit-done#672, before this repository's numbering restarted). gsd-allow-legacy-name
describe('project skills discovery reads task-relevant skills only (#4649)', () => {
  test('the index read covers only the frontmatter of each skill', () => {
    const content = readDiscoveryRef();
    assert.match(content, /read only the YAML frontmatter/);
    assert.doesNotMatch(content, /Read `SKILL\.md` for each skill/);
  });

  test('a full SKILL.md is read only when its description fits the task', () => {
    assert.match(readDiscoveryRef(), /full `SKILL\.md` only for skills whose `description` fits the current task/);
  });

  test('a skill filtered out at the index level stays reachable', () => {
    assert.match(readDiscoveryRef(), /stays available/);
  });

  test("GSD's own gsd-* skills are not listed as project skills", () => {
    assert.match(readDiscoveryRef(), /^2\. .*except GSD's own `gsd-\*` directories/m);
  });

  test('agents that self-load agent_skills skip only the project skills configured for their type', () => {
    // Keyed on the configured set, not on an <agent_skills> block: discovery runs before
    // the bootstrap self-load, and no block exists on paths without orchestrator
    // injection. config-get returns only the list; `query agent-skills` returns the whole
    // agent persona on non-Claude runtimes when nothing is configured (#2454).
    const content = readDiscoveryRef();
    assert.match(content, /self-loads `agent_skills` \(it references `agent-skills-bootstrap\.md`\)/);
    assert.ok(content.includes('`gsd_run query config-get agent_skills.<YOUR-FRONTMATTER-NAME> --raw --default "[]"`'),
      'the configured set must come from config-get, in the repository form');
    assert.ok(!content.includes('query agent-skills'), 'query agent-skills serves the persona fallback');
    // davesienkowski, #5079: match on the configured project-relative path, never on a
    // global: entry, so no project skill becomes unreachable.
    assert.match(content, /only when its project-relative directory .* is one of those entries/);
    assert.match(content, /a `global:` entry never skips a project skill/);
    assert.match(content, /If the command fails, skip nothing\./);
  });

  test('resources load through the SKILL.md references, not a fixed layout', () => {
    const content = readDiscoveryRef();
    assert.match(content, /files a `SKILL\.md` references/);
    for (const layoutAssumption of ['rules/*.md', '~130', 'AGENTS.md']) {
      assert.ok(!content.includes(layoutAssumption), `reference must not assume ${layoutAssumption}`);
    }
  });

  test('no agent, reference, workflow or command tells the agent not to load AGENTS.md', () => {
    // AGENTS.md is the project instruction file on AGENTS.md-based runtimes, and the
    // converters no longer strip such a line, so it would reach those runtimes verbatim.
    const files = [
      ...markdownFilesUnder(AGENTS_DIR),
      ...markdownFilesUnder(path.join(REPO_ROOT, 'gsd-core', 'references')),
      ...markdownFilesUnder(path.join(REPO_ROOT, 'gsd-core', 'workflows')),
      ...markdownFilesUnder(path.join(REPO_ROOT, 'commands')),
    ];
    const prohibition = /\b(not|never)\b.{0,40}\bload\b.{0,200}AGENTS\.md/i;
    const offending = files.filter((f) =>
      splitLines(fs.readFileSync(f, 'utf8')).some((line) => prohibition.test(line)));
    assert.deepStrictEqual(offending.map((f) => path.relative(REPO_ROOT, f)), []);
  });

  test('no agent file tells its role to load rules/*.md', () => {
    const stale = fs.readdirSync(AGENTS_DIR)
      .filter((f) => f.endsWith('.md'))
      .filter((f) => fs.readFileSync(path.join(AGENTS_DIR, f), 'utf8').includes('rules/*.md'));
    assert.deepStrictEqual(stale, [], 'role lines must follow the files a skill references');
  });
});
