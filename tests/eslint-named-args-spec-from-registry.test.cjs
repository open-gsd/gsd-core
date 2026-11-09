'use strict';

/**
 * eslint-named-args-spec-from-registry.test.cjs
 *
 * RuleTester unit tests for local/named-args-spec-from-registry (#6087, ADR-4909 D1).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { RuleTester } = require('eslint');

const rule = require('../eslint-rules/named-args-spec-from-registry.cjs');

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'commonjs',
  },
});

describe('named-args-spec-from-registry rule', () => {
  test('exports meta and create', () => {
    assert.strictEqual(typeof rule.meta, 'object');
    assert.strictEqual(typeof rule.create, 'function');
    assert.ok(rule.meta.messages.inlineSpec);
    assert.ok(rule.meta.messages.adhocFlag);
  });

  test('valid and invalid cases', () => {
    ruleTester.run('named-args-spec-from-registry', rule, {
      valid: [
        { code: "parseNamedArgsOrExit(args, specFor('x'), error);" },
        { code: "parseNamedArgs(args, specFor('a.b'));" },
        { code: "if (tok.startsWith('--')) {}" },
        { code: "args.indexOf('--');" },
        { code: "foo.indexOf('x');" },
      ],
      invalid: [
        {
          code: 'parseNamedArgsOrExit(args, { flags: {} }, error);',
          errors: [{ messageId: 'inlineSpec' }],
        },
        {
          code: 'parseNamedArgs(args, spec);',
          errors: [{ messageId: 'inlineSpec' }],
        },
        {
          code: "args.indexOf('--raw');",
          errors: [{ messageId: 'adhocFlag', data: { literal: '--raw' } }],
        },
        {
          code: 'args.includes(`--${n}`);',
          errors: [{ messageId: 'adhocFlag', data: { literal: '--' } }],
        },
        {
          code: "a === '--files';",
          errors: [{ messageId: 'adhocFlag', data: { literal: '--files' } }],
        },
        {
          code: "'--x' !== tok;",
          errors: [{ messageId: 'adhocFlag', data: { literal: '--x' } }],
        },
        {
          code: "tok.startsWith('--cwd=');",
          errors: [{ messageId: 'adhocFlag', data: { literal: '--cwd=' } }],
        },
        {
          code: "args.find(a => a.startsWith('--project-dir='));",
          errors: [{ messageId: 'adhocFlag', data: { literal: '--project-dir=' } }],
        },
      ],
    });
  });
});
