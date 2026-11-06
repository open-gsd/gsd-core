/**
 * #5583 — `/gsd-phase --insert` must document and forward `--sibling`
 * (#4569), accept a decimal <after> phase, and say that inserting after a
 * decimal phase nests by default, except under bracket phase ids, which
 * refuse the nested insert and need `--sibling`. Text pins on the shipped
 * prompt files and the four docs pages the docs-guard registry maps to this test.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { have, skipUnless } = require('./helpers/bash-probe.cjs');
const { span, runBash } = require('./helpers/doc-bash-span.cjs');
const path = require('node:path');
const fc = require('fast-check');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const SKIP = skipUnless('bash');
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

  test('workflow splits GSD_ARGS in the insert fence and forwards --sibling', () => {
    const WORKFLOW = read(WF);
    assert.match(WORKFLOW, /Usage: \/gsd:phase --insert <after> \[--sibling\] <description>/);
    assert.match(WORKFLOW, /\(optional, any position, like the CLI router\)/);
    const cmds = WORKFLOW.match(/^RESULT=\$\(gsd_run query phase\.insert .*$/gm) || [];
    assert.equal(cmds.length, 1, 'one phase.insert call per run');
    assert.match(cmds[0], / "\$@"\)$/);
    assert.ok(WORKFLOW.split('```').every((f) => (f.match(/phase\.insert/g) || []).length < 2), 'no fence holds two phase.insert calls');
    const fence = WORKFLOW.split('```').find((f, i) => i % 2 && /phase\.insert/.test(f));
    assert.match(fence, /^GSD_ARGS=\$\{GSD_ARGS%\$'\\n'\}$/m, 'the insert fence captures GSD_ARGS itself');
    assert.match(fence, /^GSD_F=1; set --; while IFS= read -r GSD_T; do .* done <<<"\$\(printf '%s\\n' "\$GSD_ARGS" \| tr -s '\[:space:\]' '\\n'\)"$/m);
    assert.doesNotMatch(fence, /read -a|GSD_WSV|\[0\]/, 'no array read or index: zsh counts from 1 and spells read -A');
    assert.doesNotMatch(fence, /GSD_SIBLING/, 'the CLI router owns --sibling');
    assert.doesNotMatch(WORKFLOW, /GSD_DESC_END/, 'GSD_ARGS_END stays the only capture terminator');
  });

  // Run the shipped split of the insert fence over typed arguments.
  describe('insert fence argument split', { skip: SKIP }, () => {
    const split = (args, shell = 'bash') => {
      const quoted = "'" + args.replace(/'/g, "'\\''") + "'";
      const r = runBash(
        span(WF, 'GSD_F=1;', 'RESULT=$(gsd_run query phase.insert'),
        { stdout: '', rc: 0 },
        { shell, setE: false, preamble: ['GSD_ARGS=' + quoted, "gsd_run() { printf '[%s]\\n' \"$@\"; }"], probe: 'printf "%s\\n" "$RESULT"' },
      );
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.split('\n').slice(2, -1);
    };
    for (const [args, want] of [
      ['15.2 --sibling x', ['[15.2]', '[--sibling]', '[x]']],
      ['15.2 x --sibling', ['[15.2]', '[x]', '[--sibling]']],
      ['--sibling 15.2 x', ['[--sibling]', '[15.2]', '[x]']],
      ['15.2\t--sibling x', ['[15.2]', '[--sibling]', '[x]']],
      ['15.2 --ws feature --sibling x', ['[15.2]', '[--ws]', '[feature]', '[--sibling]', '[x]']],
      ['--ws feature 15.2 x --sibling', ['[--ws]', '[feature]', '[15.2]', '[x]', '[--sibling]']],
      ['15.2 x --ws', ['[15.2]', '[x]', '[--ws]']],
      ['15.2 --ws "feature" x', ['[15.2]', '[--ws]', '[feature]', '[x]']],
      ['  --insert 15.2 x', ['[15.2]', '[x]']],
      ['15.2 x\ny', ['[15.2]', '[x]', '[y]']],
      ['5 fix "" x', ['[5]', '[fix]', '[x]']],
      ['15.2 x', ['[15.2]', '[x]']],
      ['--insert 15.2 --sibling x', ['[15.2]', '[--sibling]', '[x]']],
      ['--insert 5 fix --insert flag', ['[5]', '[fix]', '[--insert]', '[flag]']],
      ['15.2 --sibling "x"', ['[15.2]', '[--sibling]', '[x]']],
      ['5 "Critical security fix"', ['[5]', '[Critical]', '[security]', '[fix]']],
      ["5 don't stop", ['[5]', "[don't]", '[stop]']],
      ['72 fix the --siblings flag', ['[72]', '[fix]', '[the]', '[--siblings]', '[flag]']],
      ['72 x--sibling y', ['[72]', '[x--sibling]', '[y]']],
      ['72 *', ['[72]', '[*]']],
      ['72 $(touch pwned) "q" GSD_ARGS_END', ['[72]', '[$(touch]', '[pwned)]', '[q]', '[GSD_ARGS_END]']],
    ]) {
      test('split of "' + args.replace(/\n/g, '\\n') + '"', () => assert.deepEqual(split(args), want));
      test('zsh split of "' + args.replace(/\n/g, '\\n') + '"', { skip: !have('zsh') && 'zsh is not installed' }, () => assert.deepEqual(split(args, 'zsh'), want));
    }

    // Every typed word reaches the router in order; only edge double quotes go.
    test('property: words keep their order and --ws, --sibling pass through', () => {
      const word = fc.constantFrom('15.2', 'x', '--sibling', '"q"', 'a-b', '*', '--siblings', '--ws', 'feature');
      fc.assert(fc.property(fc.array(word, { minLength: 1, maxLength: 6 }), (words) => {
        assert.deepEqual(split(words.join(' ')), words.map((w) => '[' + w.replace(/^"|"$/g, '') + ']'));
      }), { numRuns: 25 });
    });
  });

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
