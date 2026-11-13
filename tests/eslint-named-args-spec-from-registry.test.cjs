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
        // A spec variable initialised from specFor() in the same scope is a registry spec.
        { code: "const spec = specFor('x'); parseNamedArgsOrExit(args, spec, error); positionalWords(args, spec);" },
        { code: "function f() { const spec = specFor('x'); parseNamedArgs(args, spec); }" },
        // Generic shape tests and non-flag cases stay valid.
        { code: "switch (tok) { case 'plain': break; case '--': break; }" },
        { code: "/^--$/.test(tok); /^foo/.test(tok); tok.match(/^-x/);" },
        { code: "['a', 'b'].includes(tok); new Set(['a', '--']).has(tok);" },
        { code: "const F = 'raw'; args.includes(F);" },
        { code: "let F = '--raw'; args.includes(F);" },
        { code: "const F = '--raw'; other.includes(F2);" },
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
        // switch cases
        {
          code: "switch (tok) { case '--raw': break; }",
          errors: [{ messageId: 'adhocFlag', data: { literal: '--raw' } }],
        },
        {
          code: "switch (tok) { case 'a': case '--x': break; default: break; }",
          errors: [{ messageId: 'adhocFlag', data: { literal: '--x' } }],
        },
        // regex literals
        {
          code: '/^--dry-run$/.test(tok);',
          errors: [{ messageId: 'adhocFlag', data: { literal: '/^--dry-run$/' } }],
        },
        {
          code: 'tok.match(/^--cwd=(.*)$/);',
          errors: [{ messageId: 'adhocFlag', data: { literal: '/^--cwd=(.*)$/' } }],
        },
        {
          code: '/^--ws(?:=|$)/.exec(tok);',
          errors: [{ messageId: 'adhocFlag', data: { literal: '/^--ws(?:=|$)/' } }],
        },
        // flag sets and arrays
        {
          code: "new Set(['--raw', '--json']).has(tok);",
          errors: [{ messageId: 'adhocFlag', data: { literal: '--raw' } }],
        },
        {
          code: "const KNOWN = new Set(['a', '--x']);",
          errors: [{ messageId: 'adhocFlag', data: { literal: '--x' } }],
        },
        {
          code: "['--raw', '--json'].includes(tok);",
          errors: [{ messageId: 'adhocFlag', data: { literal: '--raw' } }],
        },
        {
          code: "['x', '--json'].indexOf(tok);",
          errors: [{ messageId: 'adhocFlag', data: { literal: '--json' } }],
        },
        // an identifier bound to a flag literal
        {
          code: "const FLAG = '--raw'; args.includes(FLAG);",
          errors: [{ messageId: 'adhocFlag', data: { literal: '--raw' } }],
        },
        {
          code: "const FLAG = '--files'; function f() { return args.indexOf(FLAG); }",
          errors: [{ messageId: 'adhocFlag', data: { literal: '--files' } }],
        },
        // a spec that is not initialised from specFor()
        {
          code: "const spec = { valueFlags: [] }; parseNamedArgs(args, spec);",
          errors: [{ messageId: 'inlineSpec' }],
        },
        {
          code: "let spec = specFor('x'); parseNamedArgs(args, spec);",
          errors: [{ messageId: 'inlineSpec' }],
        },
        {
          code: "const spec = other(); parseNamedArgs(args, spec);",
          errors: [{ messageId: 'inlineSpec' }],
        },
      ],
    });
  });
});
