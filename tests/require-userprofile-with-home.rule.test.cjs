'use strict';

/**
 * require-userprofile-with-home.rule.test.cjs
 *
 * RuleTester unit tests for the local/require-userprofile-with-home ESLint rule.
 *
 * Rule (G6): at Program:exit, if the file assigns process.env.HOME and
 * never references USERPROFILE, report each HOME assignment.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { RuleTester } = require('eslint');

const rule = require('../eslint-rules/require-userprofile-with-home.cjs');

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'commonjs',
  },
});

// ─── module shape ─────────────────────────────────────────────────────────────

describe('require-userprofile-with-home rule module', () => {
  test('exports meta and create', () => {
    assert.strictEqual(typeof rule.meta, 'object');
    assert.strictEqual(typeof rule.create, 'function');
    assert.strictEqual(rule.meta.type, 'problem');
    assert.ok(rule.meta.messages.missingUserProfile, 'missingUserProfile message must exist');
  });
});

// ─── INVALID cases ────────────────────────────────────────────────────────────

describe('require-userprofile-with-home: invalid cases', () => {
  test('invalid: process.env.HOME = "/home/user" with no USERPROFILE reference', () => {
    ruleTester.run('require-userprofile-with-home', rule, {
      valid: [],
      invalid: [
        {
          code: `process.env.HOME = '/home/user';`,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'missingUserProfile' }],
        },
      ],
    });
  });

  test('invalid: process.env["HOME"] = dir with no USERPROFILE reference', () => {
    ruleTester.run('require-userprofile-with-home', rule, {
      valid: [],
      invalid: [
        {
          code: `process.env['HOME'] = tmpDir;`,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'missingUserProfile' }],
        },
      ],
    });
  });

  test('invalid: beforeEach sets HOME with no USERPROFILE anywhere', () => {
    ruleTester.run('require-userprofile-with-home', rule, {
      valid: [],
      invalid: [
        {
          code: `
            beforeEach(() => {
              process.env.HOME = '/tmp/test-home';
            });
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'missingUserProfile' }],
        },
      ],
    });
  });

  test('invalid: multiple HOME assignments — all reported when USERPROFILE absent', () => {
    ruleTester.run('require-userprofile-with-home', rule, {
      valid: [],
      invalid: [
        {
          code: `
            process.env.HOME = orig;
            process.env.HOME = tmpDir;
          `,
          filename: 'tests/foo.test.cjs',
          errors: [
            { messageId: 'missingUserProfile' },
            { messageId: 'missingUserProfile' },
          ],
        },
      ],
    });
  });
});

// ─── VALID cases ──────────────────────────────────────────────────────────────

describe('require-userprofile-with-home: valid cases', () => {
  test('valid: process.env.HOME assigned AND process.env.USERPROFILE assigned', () => {
    ruleTester.run('require-userprofile-with-home', rule, {
      valid: [
        {
          code: `
            process.env.HOME = tmpDir;
            process.env.USERPROFILE = tmpDir;
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('invalid: process.env.HOME assigned AND USERPROFILE only read (not assigned) — read is insufficient', () => {
    ruleTester.run('require-userprofile-with-home', rule, {
      valid: [],
      invalid: [
        {
          // Reading process.env.USERPROFILE is not enough — the rule requires
          // an actual assignment so Windows test environments are set up correctly.
          code: `
            process.env.HOME = tmpDir;
            const up = process.env.USERPROFILE;
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'missingUserProfile' }],
        },
      ],
    });
  });

  test('valid: process.env.HOME assigned AND process.env["USERPROFILE"] assigned', () => {
    ruleTester.run('require-userprofile-with-home', rule, {
      valid: [
        {
          code: `
            process.env.HOME = tmpDir;
            process.env['USERPROFILE'] = tmpDir;
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid: no HOME assignment at all', () => {
    ruleTester.run('require-userprofile-with-home', rule, {
      valid: [
        {
          code: `const home = process.env.HOME;`,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('invalid: USERPROFILE only in a comment does NOT satisfy the rule (comment is not an assignment)', () => {
    ruleTester.run('require-userprofile-with-home', rule, {
      valid: [],
      invalid: [
        {
          // A comment mentioning USERPROFILE is insufficient — the rule requires
          // an actual process.env.USERPROFILE = … assignment.
          code: `
            // also set USERPROFILE on Windows
            process.env.HOME = tmpDir;
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'missingUserProfile' }],
        },
      ],
    });
  });

  test('valid: process.env.HOME assigned AND process.env.USERPROFILE actually assigned', () => {
    ruleTester.run('require-userprofile-with-home', rule, {
      valid: [
        {
          code: `
            process.env.HOME = tmpDir;
            process.env.USERPROFILE = tmpDir;
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });
});
