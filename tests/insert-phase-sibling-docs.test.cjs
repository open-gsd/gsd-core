/**
 * #5583 — `/gsd-phase --insert` must document and forward `--sibling`
 * (#4569), accept a decimal <after> phase, and say that inserting after a
 * decimal phase nests by default. Text pins on the shipped prompt files and
 * the four docs pages the docs-guard registry maps to this test.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const WF = 'gsd-core/workflows/insert-phase.md';
const ROUTERS = [
  'commands/gsd/phase.md',
  'skills/gsd-phase/SKILL.md',
  'pi/package-skills/gsd-phase/SKILL.md',
];

const DOCS = {
  'docs/COMMANDS.md': '--insert 15.2 --sibling',
  'docs/USER-GUIDE.md': '--insert 15.2 --sibling',
  'docs/FEATURES.md': '--insert [N] [--sibling]',
  'docs/features/phase-management.md': '--insert [N] [--sibling]',
};
const NEST_SITES = [
  WF,
  ...ROUTERS,
  'gsd-core/workflows/help/modes/full.md',
  'gsd-core/workflows/help/modes/full.compact.md',
  'docs/COMMANDS.md',
];

describe('#5583 insert-phase --sibling', () => {
  test('workflow accepts a decimal <after> phase', () => {
    const WORKFLOW = read(WF);
    assert.doesNotMatch(WORKFLOW, /integer phase number to insert after/);
    assert.doesNotMatch(WORKFLOW, /Validate first argument is an integer/);
    assert.doesNotMatch(WORKFLOW, /between existing integer phases/);
    assert.doesNotMatch(WORKFLOW, /\{next_integer\}/);
    assert.match(WORKFLOW, /Validate first argument is a phase number \(integer or dotted decimal\)/);
  });

  test('workflow parses --sibling out of the description and forwards it', () => {
    const WORKFLOW = read(WF);
    assert.match(WORKFLOW, /Usage: \/gsd:phase --insert <after> \[--sibling\] <description>/);
    assert.match(WORKFLOW, /the token directly after the first argument/);
    const cmds = WORKFLOW.match(/^RESULT=\$\(gsd_run query phase\.insert .*$/gm) || [];
    assert.equal(cmds.length, 1, 'one phase.insert call per run');
    assert.match(cmds[0], /\$\{GSD_SIBLING:\+--sibling\}\)$/);
    assert.ok(WORKFLOW.split('```').every((f) => (f.match(/phase\.insert/g) || []).length < 2), 'no fence holds two phase.insert calls');
    const fence = WORKFLOW.split('```').find((f, i) => i % 2 && /phase\.insert/.test(f));
    assert.match(fence, /^GSD_ARGS=\$\{GSD_ARGS%\$'\\n'\}$/m, 'the insert fence captures GSD_ARGS itself');
    assert.match(fence, /^GSD_SIBLING=; /m, 'the insert fence derives GSD_SIBLING itself');
    assert.match(fence, /"\$\{GSD_DESC\}"/, 'the description reaches the CLI through a quoted heredoc variable');
  });

  // Run the shipped detection line: the flag counts only directly after the first argument.
  const sibLine = read(WF).match(/^GSD_SIBLING=; .*$/m)[0];
  const sibling = (args) => spawnSync('bash', ['-c', `${sibLine}; printf %s "$GSD_SIBLING"`], { env: { ...process.env, GSD_ARGS: args }, encoding: 'utf8' }).stdout;
  for (const [args, want] of [
    ['15.2 --sibling x', '1'],
    ['--insert 15.2 --sibling x', '1'],
    ['15.2\t--sibling x', '1'],
    ['15.2 x', ''],
    ['15.2 x --sibling', ''],
    ['72 fix the --sibling flag', ''],
    ['15.2 --siblings x', ''],
    ['15.2 x--sibling y', ''],
  ]) {
    test(`GSD_SIBLING for "${args}" is "${want}"`, () => assert.equal(sibling(args), want));
  }

  test('workflow documents nest-by-default and the top-level fallback', () => {
    const WORKFLOW = read(WF);
    assert.match(WORKFLOW, /inserting after a decimal phase nests by default/i);
    assert.match(WORKFLOW, /15\.2 --sibling[\s\S]*15\.3/);
    assert.match(WORKFLOW, /top-level[^\n]*falls back to nested/i);
  });

  for (const file of ['commands/gsd/phase.md', 'skills/gsd-phase/SKILL.md']) {
    test(`${file} argument-hint carries --insert [--sibling]`, () => {
      assert.match(read(file), /argument-hint: "\[--insert \[--sibling\] \|/);
    });
  }

  for (const f of ROUTERS) {
    test(`${f} objective bullet mentions --sibling`, () => {
      assert.match(read(f), /- \*\*--insert\*\*:[^\n]*--sibling/);
    });
  }

  for (const f of ['gsd-core/workflows/help/modes/full.md', 'gsd-core/workflows/help/modes/full.compact.md']) {
    test(`${f} pins --sibling`, () => {
      assert.match(read(f), /--insert <after> \[--sibling\] <description>/);
    });
  }

  for (const [f, text] of Object.entries(DOCS)) {
    test(`${f} pins ${text}`, () => {
      assert.ok(read(f).includes(text));
    });
  }

  for (const f of NEST_SITES) {
    test(`${f} says bracket ids refuse a nested insert after a decimal phase`, () => {
      assert.match(read(f), /bracket[^\n]*decimal phase[^\n]*--sibling/i);
    });
  }

  for (const file of ROUTERS) {
    test(`${file} lists --sibling in the insert routing`, () => {
      const text = read(file);
      assert.match(text, /\[--sibling\]/);
      assert.match(text, /nests? by default/i);
    });
  }
});
