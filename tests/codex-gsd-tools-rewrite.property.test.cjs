process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('./helpers/fast-check-setup.cjs');

const {
  rewriteBareGsdToolsCommandsForCodex,
} = require('../bin/install.js');

const CODEX_GSD_TOOLS_INVOCATION = 'node "$HOME/.codex/gsd-core/bin/gsd-tools.cjs"';

function countOccurrences(content, needle) {
  return content.split(needle).length - 1;
}

function assertNoCodexBareGsdToolsInvocation(content) {
  const patterns = [
    /(^|\n)[ \t]*gsd-tools\s/,
    /\$\(\s*gsd-tools\s/,
    /`\s*gsd-tools\s/,
    /(?:&&|\|\||[;|])\s*gsd-tools\s/,
  ];
  for (const pattern of patterns) {
    assert.doesNotMatch(
      content,
      pattern,
      'converted Codex content must not contain a command-position bare gsd-tools invocation',
    );
  }
}

function renderInvocation(form, command) {
  switch (form) {
    case 'line':
      return `  gsd-tools query ${command}`;
    case 'substitution':
      return `VALUE=$(gsd-tools query ${command})`;
    case 'backtick':
      return `VALUE=\`gsd-tools query ${command}\``;
    case 'and':
      return `echo ok && gsd-tools query ${command}`;
    case 'or':
      return `false || gsd-tools query ${command}`;
    case 'semicolon':
      return `echo ok; gsd-tools query ${command}`;
    case 'pipe':
      return `cat state.json | gsd-tools query ${command}`;
    default:
      throw new Error(`unknown form: ${form}`);
  }
}

describe('Codex gsd-tools command rewrite property', () => {
  test('property: command-position gsd-tools rewrites while probes and identifiers are preserved', () => {
    const commandName = fc.stringMatching(/^[a-z][a-z0-9.-]{0,24}$/);
    const invocationLine = fc.record({
      form: fc.constantFrom('line', 'substitution', 'backtick', 'and', 'or', 'semicolon', 'pipe'),
      command: commandName,
    }).map(({ form, command }) => ({
      kind: 'rewrite',
      line: renderInvocation(form, command),
    }));
    const protectedLine = fc.constantFrom(
      'if command -v gsd-tools >/dev/null 2>&1; then echo ok; fi',
      'which gsd-tools >/dev/null',
      'type gsd-tools >/dev/null',
      'my_gsd-tools_var=1',
    ).map((line) => ({ kind: 'preserve', line }));

    fc.assert(
      fc.property(
        fc.array(fc.oneof(invocationLine, protectedLine), { minLength: 1, maxLength: 40 }),
        (items) => {
          const input = items.map((item) => item.line).join('\n');
          const output = rewriteBareGsdToolsCommandsForCodex(input);
          const expectedRewriteCount = items.filter((item) => item.kind === 'rewrite').length;

          assertNoCodexBareGsdToolsInvocation(output);
          assert.strictEqual(
            countOccurrences(output, CODEX_GSD_TOOLS_INVOCATION),
            expectedRewriteCount,
            'every command-position invocation must be rewritten exactly once',
          );

          for (const item of items.filter((entry) => entry.kind === 'preserve')) {
            assert.ok(output.includes(item.line), `protected probe/identifier line changed: ${item.line}`);
          }
        },
      ),
    );
  });
});
