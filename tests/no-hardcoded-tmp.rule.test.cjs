'use strict';

/**
 * no-hardcoded-tmp.rule.test.cjs
 *
 * RuleTester unit tests for the local/no-hardcoded-tmp ESLint rule.
 *
 * Rule (G4): flag a string Literal starting with `/tmp/` (or exactly `/tmp`)
 * passed to an `fs.<method>(...)` call or `path.join('/tmp/...', …)`.
 * Message: use `os.tmpdir()`.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { RuleTester } = require('eslint');

const rule = require('../eslint-rules/no-hardcoded-tmp.cjs');

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'commonjs',
  },
});

// ─── module shape ─────────────────────────────────────────────────────────────

describe('no-hardcoded-tmp rule module', () => {
  test('exports meta and create', () => {
    assert.strictEqual(typeof rule.meta, 'object');
    assert.strictEqual(typeof rule.create, 'function');
    assert.strictEqual(rule.meta.type, 'problem');
    assert.ok(rule.meta.messages.hardcodedTmp, 'hardcodedTmp message must exist');
  });
});

// ─── INVALID cases ────────────────────────────────────────────────────────────

describe('no-hardcoded-tmp: invalid cases', () => {
  test('invalid: fs.writeFileSync("/tmp/x", data)', () => {
    ruleTester.run('no-hardcoded-tmp', rule, {
      valid: [],
      invalid: [
        {
          code: `fs.writeFileSync('/tmp/x', data);`,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'hardcodedTmp' }],
        },
      ],
    });
  });

  test('invalid: fs.readFileSync("/tmp/file.txt", "utf8")', () => {
    ruleTester.run('no-hardcoded-tmp', rule, {
      valid: [],
      invalid: [
        {
          code: `const c = fs.readFileSync('/tmp/file.txt', 'utf8');`,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'hardcodedTmp' }],
        },
      ],
    });
  });

  test('invalid: fs.mkdirSync("/tmp/mydir", { recursive: true })', () => {
    ruleTester.run('no-hardcoded-tmp', rule, {
      valid: [],
      invalid: [
        {
          code: `fs.mkdirSync('/tmp/mydir', { recursive: true });`,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'hardcodedTmp' }],
        },
      ],
    });
  });

  test('invalid: path.join("/tmp/dir", "sub")', () => {
    ruleTester.run('no-hardcoded-tmp', rule, {
      valid: [],
      invalid: [
        {
          code: `const p = path.join('/tmp/dir', 'sub');`,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'hardcodedTmp' }],
        },
      ],
    });
  });

  test('invalid: fs.existsSync("/tmp")', () => {
    ruleTester.run('no-hardcoded-tmp', rule, {
      valid: [],
      invalid: [
        {
          code: `fs.existsSync('/tmp');`,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'hardcodedTmp' }],
        },
      ],
    });
  });

  test('invalid: fs.rmSync("/tmp/x", { recursive: true })', () => {
    ruleTester.run('no-hardcoded-tmp', rule, {
      valid: [],
      invalid: [
        {
          code: `fs.rmSync('/tmp/x', { recursive: true });`,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'hardcodedTmp' }],
        },
      ],
    });
  });
});

// ─── VALID cases ──────────────────────────────────────────────────────────────

describe('no-hardcoded-tmp: valid cases', () => {
  test('valid: os.tmpdir() — portable temp directory', () => {
    ruleTester.run('no-hardcoded-tmp', rule, {
      valid: [
        {
          code: `
            const tmpDir = os.tmpdir();
            fs.writeFileSync(path.join(tmpDir, 'x'), data);
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid: fs.writeFileSync with a variable (not hardcoded /tmp/)', () => {
    ruleTester.run('no-hardcoded-tmp', rule, {
      valid: [
        {
          code: `fs.writeFileSync(tmpFile, data);`,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid: path.join with non-tmp first arg', () => {
    ruleTester.run('no-hardcoded-tmp', rule, {
      valid: [
        {
          code: `const p = path.join(__dirname, 'fixtures', 'test.txt');`,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid: /tmp/ string not passed to fs or path.join (assignment)', () => {
    ruleTester.run('no-hardcoded-tmp', rule, {
      valid: [
        {
          code: `const note = 'uses /tmp/ on POSIX';`,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid: /tmp/ as a non-first arg to path.join', () => {
    ruleTester.run('no-hardcoded-tmp', rule, {
      valid: [
        {
          code: `const p = path.join(os.tmpdir(), '/tmp/subdir');`,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });
});
