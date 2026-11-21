'use strict';

/**
 * comment-ratchet.rule.test.cjs
 *
 * RuleTester cases for local/directive-names-issue and local/max-comment-block-lines
 * (ADR-6315 item 24, #6342), and unit cases for eslint-rules/lib/comment-ratchet.cjs.
 * The directive keywords appear only inside strings built by concatenation, so
 * this file holds no directive of its own.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { RuleTester } = require('eslint');

const directiveRule = require('../eslint-rules/directive-names-issue.cjs');
const blockRule = require('../eslint-rules/max-comment-block-lines.cjs');
const lib = require('../eslint-rules/lib/comment-ratchet.cjs');

const KW = 'eslint-' + 'disable';
const KW_NEXT = 'eslint-' + 'disable-next-line';

const tester = new RuleTester({ languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs' } });

const lines = (n, prefix = '// line') => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n');
const block = (n) => `/*\n${Array.from({ length: n - 2 }, (_, i) => ` * line ${i + 1}`).join('\n')}\n */`;

describe('lib: isDirective and bareDirectives', () => {
  test('a comment beginning with a directive is a directive; prose mentioning one is not', () => {
    assert.equal(lib.isDirective(` ${KW_NEXT} no-console`), true);
    assert.equal(lib.isDirective(` ${KW} `), true);
    assert.equal(lib.isDirective(' allow-test-rule: product text'), true);
    assert.equal(lib.isDirective(' allow-unbounded-subprocess: a fixture'), true);
    assert.equal(lib.isDirective(` see ${KW_NEXT} for how this works`), false);
    assert.equal(lib.isDirective(' an ordinary comment'), false);
  });

  test('a directive naming #NNN is not bare; one without is', () => {
    const comments = [
      { type: 'Line', value: ` ${KW_NEXT} no-console -- #123 the CLI prints`, loc: {} },
      { type: 'Line', value: ` ${KW_NEXT} no-console`, loc: {} },
      { type: 'Line', value: ' allow-test-rule: reads product text', loc: {} },
      { type: 'Line', value: ' allow-test-rule: reads product text (#6342)', loc: {} },
    ];
    assert.deepEqual(lib.bareDirectives(comments).map((c) => c.value.trim().split(' ')[0]), [KW_NEXT, 'allow-test-rule:']);
  });

  test('a bare "#" with no digits is not an issue reference', () => {
    assert.equal(lib.bareDirectives([{ type: 'Line', value: ` ${KW} -- see # later`, loc: {} }]).length, 1);
  });
});

describe('lib: longBlocks', () => {
  const at = (line, type = 'Line', endLine = line) => ({ type, value: 'x', loc: { start: { line }, end: { line: endLine } } });

  test('15 consecutive line comments are allowed and 16 are one block (limit-1, limit, limit+1)', () => {
    const run = (n) => Array.from({ length: n }, (_, i) => at(i + 1));
    assert.equal(lib.longBlocks(run(14)).length, 0);
    assert.equal(lib.longBlocks(run(15)).length, 0);
    const over = lib.longBlocks(run(16));
    assert.equal(over.length, 1);
    assert.equal(over[0].lines, 16);
  });

  test('a gap in line numbers starts a new block', () => {
    const comments = [...Array.from({ length: 10 }, (_, i) => at(i + 1)), ...Array.from({ length: 10 }, (_, i) => at(i + 12))];
    assert.equal(lib.longBlocks(comments).length, 0);
  });

  test('a block comment counts its own lines, and does not merge with line comments', () => {
    assert.equal(lib.longBlocks([at(1, 'Block', 15)]).length, 0);
    assert.equal(lib.longBlocks([at(1, 'Block', 16)]).length, 1);
    assert.equal(lib.longBlocks([...Array.from({ length: 10 }, (_, i) => at(i + 1)), at(11, 'Block', 20)]).length, 0);
  });

  test('the ceiling is a parameter', () => {
    assert.equal(lib.longBlocks([at(1, 'Block', 5)], 4).length, 1);
    assert.equal(lib.MAX_COMMENT_BLOCK_LINES, 15);
  });
});

describe('lib: longBlocks properties and trailing comments', () => {
  const fc = require('fast-check');
  const at = (line) => ({ type: 'Line', value: 'x', loc: { start: { line }, end: { line } } });

  test('property: n consecutive own-line comments are one block exactly when n exceeds the ceiling', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 60 }), fc.integer({ min: 1, max: 30 }), (n, max) => {
      const found = lib.longBlocks(Array.from({ length: n }, (_, i) => at(i + 1)), max);
      return n > max ? found.length === 1 && found[0].lines === n : found.length === 0;
    }));
  });

  test('property: a gap of any width splits a run into two blocks that are each judged alone', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 40 }), fc.integer({ min: 1, max: 40 }), fc.integer({ min: 2, max: 5 }), (a, b, gap) => {
      const comments = [
        ...Array.from({ length: a }, (_, i) => at(i + 1)),
        ...Array.from({ length: b }, (_, i) => at(a + gap + i)),
      ];
      return lib.longBlocks(comments, 15).length === (a > 15 ? 1 : 0) + (b > 15 ? 1 : 0);
    }));
  });

  test('a trailing comment after code does not merge into a block', () => {
    const trailing = (line) => ({ type: 'Line', value: 'x', loc: { start: { line }, end: { line } } });
    const comments = Array.from({ length: 20 }, (_, i) => trailing(i + 1));
    assert.equal(lib.longBlocks(comments, 15, () => false).length, 0);
    assert.equal(lib.longBlocks(comments, 15, () => true).length, 1);
  });
});

describe('local/max-comment-block-lines: trailing comments', () => {
  test('sixteen lines of code with a trailing comment each are not a block', () => {
    tester.run('max-comment-block-lines', blockRule, {
      valid: [{
        code: Array.from({ length: 16 }, (_, i) => `f(${i}); // note ${i}`).join('\n'),
        filename: 'tests/a.cjs',
        options: [{ baseline: {} }],
      }],
      invalid: [],
    });
  });
});

describe('the committed baseline', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const baseline = require('../eslint-rules/comment-ratchet.baseline.json');
  const root = path.join(__dirname, '..');

  test('every entry names a file that exists, with a positive count of a known kind', () => {
    for (const [file, entry] of Object.entries(baseline)) {
      assert.ok(fs.existsSync(path.join(root, ...file.split('/'))), `${file}: baselined but absent (renamed or deleted: drop the entry)`);
      const kinds = Object.keys(entry);
      assert.ok(kinds.length > 0 && kinds.every((k) => k === 'directive' || k === 'block'), `${file}: unknown kind in ${JSON.stringify(entry)}`);
      for (const kind of kinds) assert.ok(Number.isInteger(entry[kind]) && entry[kind] > 0, `${file}: ${kind} must be a positive integer`);
    }
  });

  test('both rules report through a Linter configured the way eslint.config.mjs configures them', () => {
    const { Linter } = require('eslint');
    const linter = new Linter({ cwd: root });
    const plugin = { rules: { d: directiveRule, m: blockRule } };
    const config = [{
      files: ['**/*.cjs'],
      plugins: { local: plugin },
      languageOptions: { sourceType: 'commonjs' },
      rules: { 'local/d': ['error', { baseline: {} }], 'local/m': ['error', { baseline: {} }] },
    }];
    const messages = linter.verify(`// ${KW_NEXT} no-console\nf();\n${lines(16)}\ng();`, config, 'tests/x.cjs');
    assert.deepEqual(messages.filter((m) => m.ruleId).map((m) => m.ruleId).sort(), ['local/d', 'local/m']);
  });
});

describe('known limit: a directive that disables all rules hides its own report', () => {
  test('a bare disable-line is not reported by the rule (the portability static check bans it in tests and src)', () => {
    const { Linter } = require('eslint');
    const linter = new Linter({ cwd: process.cwd() });
    const config = [{
      files: ['**/*.cjs'],
      plugins: { local: { rules: { d: directiveRule } } },
      languageOptions: { sourceType: 'commonjs' },
      rules: { 'local/d': ['error', { baseline: {} }] },
    }];
    const hidden = linter.verify(`f(); // ${KW}-line`, config, 'tests/x.cjs');
    assert.deepEqual(hidden, []);
  });
});

describe('lib: judge', () => {
  test('excess is sites beyond the baseline and stale is baseline beyond the sites', () => {
    assert.deepEqual(lib.judge(3, 3), { excess: 0, stale: 0 });
    assert.deepEqual(lib.judge(4, 3), { excess: 1, stale: 0 });
    assert.deepEqual(lib.judge(2, 3), { excess: 0, stale: 1 });
    assert.deepEqual(lib.judge(0, 0), { excess: 0, stale: 0 });
  });
});

describe('local/directive-names-issue', () => {
  test('RuleTester cases', () => {
    tester.run('directive-names-issue', directiveRule, {
      valid: [
        { code: `// ${KW_NEXT} no-console -- #123 the CLI prints\nconsole.log(1);`, filename: 'tests/a.cjs', options: [{ baseline: {} }] },
        { code: '// allow-test-rule: reads product text (#6342)\nconst x = 1;', filename: 'tests/a.cjs', options: [{ baseline: {} }] },
        { code: '// a note that mentions allow-test-rule: in prose\nconst x = 1;', filename: 'tests/a.cjs', options: [{ baseline: {} }] },
        // The baseline covers a file's existing bare directive.
        { code: `// ${KW_NEXT} no-console\nconsole.log(1);`, filename: 'tests/old.cjs', options: [{ baseline: { 'tests/old.cjs': { directive: 1 } } }] },
        // A file under its baseline is not an error: a PR that merged first and removed a site must not
        // break every PR queued behind it (the queue ejection of #6427). The generator lowers the entry.
        { code: 'const x = 1;', filename: 'tests/old.cjs', options: [{ baseline: { 'tests/old.cjs': { directive: 2 } } }] },
      ],
      invalid: [
        {
          code: `// ${KW_NEXT} no-console\nconsole.log(1);`,
          filename: 'tests/new.cjs',
          options: [{ baseline: {} }],
          errors: [{ messageId: 'bare', line: 1 }],
        },
        {
          code: '// allow-unbounded-subprocess: a fixture\nconst x = 1;',
          filename: 'tests/new.cjs',
          options: [{ baseline: {} }],
          errors: [{ messageId: 'bare' }],
        },
        {
          // A second bare directive in a file whose baseline is 1: the baseline covers the first, the new one is reported.
          code: `// ${KW_NEXT} no-console\nconsole.log(1);\n// ${KW_NEXT} no-undef\nundefinedThing();`,
          filename: 'tests/old.cjs',
          options: [{ baseline: { 'tests/old.cjs': { directive: 1 } } }],
          errors: [{ messageId: 'excess', line: 3 }],
        },
      ],
    });
  });
});

describe('local/max-comment-block-lines', () => {
  test('RuleTester cases', () => {
    tester.run('max-comment-block-lines', blockRule, {
      valid: [
        { code: `${lines(15)}\nconst x = 1;`, filename: 'tests/a.cjs', options: [{ baseline: {} }] },
        { code: `${block(15)}\nconst x = 1;`, filename: 'tests/a.cjs', options: [{ baseline: {} }] },
        { code: `${lines(16)}\nconst x = 1;`, filename: 'tests/old.cjs', options: [{ baseline: { 'tests/old.cjs': { block: 1 } } }] },
        // Under the baseline is not an error (see the directive rule).
        { code: 'const x = 1;', filename: 'tests/old.cjs', options: [{ baseline: { 'tests/old.cjs': { block: 2 } } }] },
      ],
      invalid: [
        { code: `${lines(16)}\nconst x = 1;`, filename: 'tests/new.cjs', options: [{ baseline: {} }], errors: [{ messageId: 'long', line: 1 }] },
        { code: `${block(16)}\nconst x = 1;`, filename: 'tests/new.cjs', options: [{ baseline: {} }], errors: [{ messageId: 'long', line: 1 }] },
        {
          code: `${lines(16)}\nconst x = 1;\n${lines(16)}\nconst y = 2;`,
          filename: 'tests/old.cjs',
          options: [{ baseline: { 'tests/old.cjs': { block: 1 } } }],
          errors: [{ messageId: 'excess', line: 18 }],
        },
      ],
    });
  });
});
