'use strict';

/**
 * project-skills-discovery.test.cjs (#4649)
 *
 * Detection cases for the agent-skills-awareness text contract: 21 agents and 15 compact variants
 * share one project-skills discovery reference. Each case copies the files the contract reads into a
 * temporary root, changes one thing, and asserts the contract names it. The real files are checked
 * once, in scripts/run-static-checks.cjs. The converter half of the change (the AGENTS.md strip is
 * gone from both copies) is in tests/runtime-converters.test.cjs.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { cleanup } = require('./helpers.cjs');
const textContracts = require('../scripts/static-checks/text-contracts.cjs');

const {
  REFERENCE,
  INCLUDE,
  REFERENCE_MAX_BYTES: CAP,
  DISCOVERY_FILES,
} = require('../scripts/static-checks/text-contracts/lib/project-skills-discovery.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const CONTRACT = 'agent-skills-awareness';
const FILES = [REFERENCE, ...DISCOVERY_FILES];

function copyOfFiles(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4649-'));
  t.after(() => cleanup(root));
  for (const rel of FILES) {
    const dest = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, ...rel.split('/')), dest);
  }
  return root;
}

function edit(root, rel, change) {
  const abs = path.join(root, ...rel.split('/'));
  const before = fs.readFileSync(abs, 'utf8');
  const after = change(before);
  assert.notEqual(after, before, `the edit changed ${rel}`);
  fs.writeFileSync(abs, after);
}

const run = (root) => textContracts.run({ root, only: [CONTRACT], minContracts: 1 });
const messages = (root) => run(root).map((finding) => `${finding.file}: ${finding.message}`);

describe('#4649: the discovery agents share one project-skills reference', () => {
  test('the copied files satisfy the contract', (t) => {
    assert.deepEqual(messages(copyOfFiles(t)), []);
  });

  test('21 canonical agents and 15 compact variants are covered', () => {
    assert.equal(FILES.length, 1 + 21 + 15);
  });

  test('an agent that drops the include is named', (t) => {
    const root = copyOfFiles(t);
    edit(root, 'agents/gsd-roadmapper.md', (text) => text.split(INCLUDE).join('Project skills: see the reference.'));
    const found = messages(root);
    assert.ok(found.some((line) => line.startsWith('agents/gsd-roadmapper.md') && line.includes('@-include')), found.join('\n'));
  });

  test('a compact variant that drops the include is named', (t) => {
    const root = copyOfFiles(t);
    edit(root, 'agents/gsd-ui-researcher.compact.md', (text) => text.split(INCLUDE).join('Project skills: see the reference.'));
    const found = messages(root);
    assert.ok(found.some((line) => line.startsWith('agents/gsd-ui-researcher.compact.md')), found.join('\n'));
  });

  test('an agent that restores the inline read-every-SKILL.md steps is named', (t) => {
    const root = copyOfFiles(t);
    edit(root, 'agents/gsd-code-fixer.md', (text) => text.replace(INCLUDE, `${INCLUDE}\n2. Read \`SKILL.md\` for each skill (lightweight index ~130 lines)`));
    const found = messages(root);
    assert.ok(found.some((line) => line.startsWith('agents/gsd-code-fixer.md') && line.includes('inline')), found.join('\n'));
  });

  test('an agent that restores the rules/*.md step is named', (t) => {
    const root = copyOfFiles(t);
    edit(root, 'agents/gsd-executor.md', (text) => text.replace(INCLUDE, `${INCLUDE}\n- Load specific \`rules/*.md\` files as needed.`));
    const found = messages(root);
    assert.ok(found.some((line) => line.startsWith('agents/gsd-executor.md') && line.includes('rules/*.md')), found.join('\n'));
  });

  for (const sentence of [
    'Do NOT load full `AGENTS.md` files (100KB+ context cost)',
    'NEVER load full `AGENTS.md` (100KB+ cost)',
    'do not load full AGENTS.md',
  ]) {
    test(`an agent that tells the reader not to load AGENTS.md is named: ${sentence}`, (t) => {
      const root = copyOfFiles(t);
      edit(root, 'agents/gsd-planner.md', (text) => text.replace(INCLUDE, `${INCLUDE}\n- ${sentence}`));
      const found = messages(root);
      assert.ok(found.some((line) => line.startsWith('agents/gsd-planner.md') && line.includes('AGENTS.md')), found.join('\n'));
    });
  }

  test('an include with no application line under it is named', (t) => {
    const root = copyOfFiles(t);
    edit(root, 'agents/gsd-verifier.md', (text) => text.replace(/(@~\/\.claude\/gsd-core\/references\/project-skills-discovery\.md\n)- [^\n]*\n/, '$1'));
    const found = messages(root);
    assert.ok(found.some((line) => line.startsWith('agents/gsd-verifier.md') && line.includes('application line')), found.join('\n'));
  });

  test('an application line that names no skills is named', (t) => {
    const root = copyOfFiles(t);
    edit(root, 'agents/gsd-debugger.md', (text) => text.replace(/(project-skills-discovery\.md\n)- [^\n]*\n/, '$1- Be careful.\n'));
    const found = messages(root);
    assert.ok(found.some((line) => line.startsWith('agents/gsd-debugger.md') && line.includes('application line')), found.join('\n'));
  });

  test('a new agent that includes the reference without being listed is named', (t) => {
    const root = copyOfFiles(t);
    fs.writeFileSync(path.join(root, 'agents', 'gsd-zzz-new.md'), `# New\n\n**Project skills:** ${INCLUDE}\n- Apply skills.\n`);
    const found = messages(root);
    assert.ok(found.some((line) => line.startsWith('agents/gsd-zzz-new.md') && line.includes('not in the agent-skills-awareness list')), found.join('\n'));
  });

  test('CRLF line endings do not change the verdict', (t) => {
    const root = copyOfFiles(t);
    for (const rel of FILES) edit(root, rel, (text) => text.replace(/\r?\n/g, '\r\n'));
    assert.deepEqual(messages(root), []);
  });
});

describe('#4649: the shared reference states the scoped read', () => {
  test('a reference that reads every SKILL.md in full again is named (no frontmatter scoping)', (t) => {
    const root = copyOfFiles(t);
    edit(root, REFERENCE, (text) => text.replace(/only the (?:YAML )?frontmatter/i, 'each'));
    const found = messages(root);
    assert.ok(found.some((line) => line.includes('frontmatter')), found.join('\n'));
  });

  test('a reference that gates nothing on the description is named', (t) => {
    const root = copyOfFiles(t);
    edit(root, REFERENCE, (text) => text.replace(/`description`/g, 'summary'));
    const found = messages(root);
    assert.ok(found.some((line) => line.includes('description')), found.join('\n'));
  });

  test('a reference with no fallback for a skill without a description is named', (t) => {
    const root = copyOfFiles(t);
    edit(root, REFERENCE, (text) => text.replace(/no `description`/g, 'no summary'));
    const found = messages(root);
    assert.ok(found.some((line) => line.includes('without a description')), found.join('\n'));
  });

  test('a reference that makes a skipped skill unreachable is named', (t) => {
    const root = copyOfFiles(t);
    edit(root, REFERENCE, (text) => text.replace(/stays available|remains available/gi, 'is dropped'));
    const found = messages(root);
    assert.ok(found.some((line) => line.includes('stay reachable')), found.join('\n'));
  });

  test('a reference that brings back the agent_skills dedup step is named', (t) => {
    const root = copyOfFiles(t);
    edit(root, REFERENCE, (text) => `${text}\n3. Skip a skill listed by \`gsd_run query config-get agent_skills.<type>\`.\n`);
    const found = messages(root);
    assert.ok(found.some((line) => line.includes('dedup step was dropped')), found.join('\n'));
  });

  test('a reference that names AGENTS.md or the rules/*.md layout is named', (t) => {
    const root = copyOfFiles(t);
    edit(root, REFERENCE, (text) => `${text}\nSee AGENTS.md and rules/*.md.\n`);
    const found = messages(root);
    assert.ok(found.some((line) => line.includes('AGENTS.md')), found.join('\n'));
    assert.ok(found.some((line) => line.includes('rules/*.md')), found.join('\n'));
  });

  test('a reference that loses the resource-loading step is named', (t) => {
    const root = copyOfFiles(t);
    edit(root, REFERENCE, (text) => text.replace(/a `SKILL\.md` references/, 'a `SKILL.md` lists'));
    const found = messages(root);
    assert.ok(found.some((line) => line.includes('resource loading')), found.join('\n'));
  });

  // #6719: the listing step is code-produced, so the reference must name the command, its scope,
  // the failure fallback, and must not pull the launcher into every spawn.
  test('a reference that drops the skill-manifest command is named', (t) => {
    const root = copyOfFiles(t);
    edit(root, REFERENCE, (text) => text.replace(/skill-manifest/g, 'list'));
    const found = messages(root);
    assert.ok(found.some((line) => line.includes('skill-manifest')), found.join('\n'));
  });

  test('a reference that scans more than the project skills dir is named', (t) => {
    const root = copyOfFiles(t);
    edit(root, REFERENCE, (text) => text.replace(/ --skills-dir <dir>/g, ''));
    const found = messages(root);
    assert.ok(found.some((line) => line.includes('--skills-dir')), found.join('\n'));
  });

  test('a reference with no fallback when the command fails is named', (t) => {
    const root = copyOfFiles(t);
    edit(root, REFERENCE, (text) => text.replace(/If the command fails/g, 'When it works'));
    const found = messages(root);
    assert.ok(found.some((line) => line.includes('fallback')), found.join('\n'));
  });

  test('a reference that @-includes the launcher is named', (t) => {
    const root = copyOfFiles(t);
    edit(root, REFERENCE, (text) => `${text}\n@~/.claude/gsd-core/references/gsd-run-resolver.md\n`);
    const found = messages(root);
    assert.ok(found.some((line) => line.includes('launcher')), found.join('\n'));
  });

  // The cap: at limit - 1 and at the limit the reference passes; one byte over it is a finding.
  for (const [delta, passes] of [[-1, true], [0, true], [1, false]]) {
    test(`a reference of ${CAP + delta} bytes ${passes ? 'passes' : 'fails'} the cap (limit ${delta >= 0 ? '+' : '-'} ${Math.abs(delta)})`, (t) => {
      const root = copyOfFiles(t);
      const abs = path.join(root, ...REFERENCE.split('/'));
      const current = Buffer.byteLength(fs.readFileSync(abs, 'utf8'), 'utf8');
      assert.ok(current <= CAP, `the live reference is ${current} bytes, over the ${CAP} cap`);
      fs.writeFileSync(abs, `${fs.readFileSync(abs, 'utf8')}${' '.repeat(CAP + delta - current)}`);
      const found = messages(root);
      assert.equal(found.some((line) => line.includes('expected at most')), !passes, found.join('\n'));
    });
  }
});
