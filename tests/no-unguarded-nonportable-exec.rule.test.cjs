'use strict';

/**
 * no-unguarded-nonportable-exec.rule.test.cjs
 *
 * RuleTester unit tests for the local/no-unguarded-nonportable-exec ESLint rule.
 *
 * Rule: at Program:exit, if the file contains any chmod call with an exec-bit
 * octal (0oNNN & 0o111 !== 0), report each sh/bash -c invocation
 * (execFileSync/spawnSync/spawn/exec/execSync) that is NOT inside a Windows
 * platform guard.
 *
 * DEFECT category: DEFECT.WINDOWS-TEST-PORTABILITY
 *
 * Test cases mirror those in the retired regex-based script
 * scripts/lint-windows-test-portability.cjs.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { RuleTester } = require('eslint');

const rule = require('../eslint-rules/no-unguarded-nonportable-exec.cjs');

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'commonjs',
  },
});

// ─── module shape ─────────────────────────────────────────────────────────────

describe('no-unguarded-nonportable-exec rule module', () => {
  test('exports meta and create', () => {
    assert.strictEqual(typeof rule.meta, 'object');
    assert.strictEqual(typeof rule.create, 'function');
    assert.strictEqual(rule.meta.type, 'problem');
    assert.ok(rule.meta.messages.nonportableExec);
  });
});

// ─── INVALID cases (violation expected) ───────────────────────────────────────

describe('no-unguarded-nonportable-exec invalid cases', () => {
  test('invalid: chmod 0o755 + execFileSync bash -c with no guard', () => {
    ruleTester.run('no-unguarded-nonportable-exec', rule, {
      valid: [],
      invalid: [
        {
          code: `
            fs.chmodSync(fixture, 0o755);
            execFileSync('bash', ['-c', 'echo hi']);
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'nonportableExec' }],
        },
      ],
    });
  });

  test('invalid: chmod 0o111 (pure exec bits) + spawnSync sh -c', () => {
    ruleTester.run('no-unguarded-nonportable-exec', rule, {
      valid: [],
      invalid: [
        {
          code: `
            fs.chmodSync(f, 0o111);
            spawnSync('sh', ['-c', 'x']);
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'nonportableExec' }],
        },
      ],
    });
  });

  test('invalid: string-form exec(sh -c) + chmod 0o755', () => {
    ruleTester.run('no-unguarded-nonportable-exec', rule, {
      valid: [],
      invalid: [
        {
          code: `
            fs.chmodSync(f, 0o755);
            exec('sh -c "run.sh"');
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'nonportableExec' }],
        },
      ],
    });
  });

  test('invalid: /bin/bash prefix in array form + chmod exec bit', () => {
    ruleTester.run('no-unguarded-nonportable-exec', rule, {
      valid: [],
      invalid: [
        {
          code: `
            fs.chmodSync(f, 0o755);
            execFileSync('/bin/bash', ['-c', 'run']);
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'nonportableExec' }],
        },
      ],
    });
  });
});

// ─── VALID cases (no violation expected) ──────────────────────────────────────

describe('no-unguarded-nonportable-exec valid cases', () => {
  test('valid: chmod 0o755 + execFileSync bash -c with process.platform guard', () => {
    ruleTester.run('no-unguarded-nonportable-exec', rule, {
      valid: [
        {
          code: `
            fs.chmodSync(fixture, 0o755);
            if (process.platform !== 'win32') {
              execFileSync('bash', ['-c', 'echo hi']);
            }
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid: chmod 0o644 (no exec bit) + bash -c does not trigger', () => {
    ruleTester.run('no-unguarded-nonportable-exec', rule, {
      valid: [
        {
          code: `
            fs.chmodSync(fixture, 0o644);
            execFileSync('bash', ['-c', 'cat file']);
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid: chmod 0o755 + execFileSync(sh, [path]) no -c flag', () => {
    ruleTester.run('no-unguarded-nonportable-exec', rule, {
      valid: [
        {
          code: `
            fs.chmodSync(fixture, 0o755);
            execFileSync('sh', [fixturePath]);
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid: no chmod at all — bash -c alone is fine', () => {
    ruleTester.run('no-unguarded-nonportable-exec', rule, {
      valid: [
        {
          code: `execFileSync('bash', ['-c', 'echo hi']);`,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid: chmod 0o444 (read-only, no exec bits) + bash -c', () => {
    ruleTester.run('no-unguarded-nonportable-exec', rule, {
      valid: [
        {
          code: `
            fs.chmodSync(f, 0o444);
            execFileSync('bash', ['-c', 'x']);
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid: early-return windows guard before sh -c', () => {
    ruleTester.run('no-unguarded-nonportable-exec', rule, {
      valid: [
        {
          code: `
            fs.chmodSync(f, 0o755);
            if (process.platform === 'win32') return;
            execFileSync('sh', ['-c', 'run']);
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid: hoisted isWindows guard', () => {
    ruleTester.run('no-unguarded-nonportable-exec', rule, {
      valid: [
        {
          code: `
            const isWindows = process.platform === 'win32';
            fs.chmodSync(f, 0o755);
            if (!isWindows) {
              execFileSync('bash', ['-c', 'run']);
            }
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid: chmod 0o755 + exec("finish -c something") — "sh" in "finish" is not a shell invocation (W1 word-boundary)', () => {
    ruleTester.run('no-unguarded-nonportable-exec', rule, {
      valid: [
        {
          code: `
            fs.chmodSync(fixture, 0o755);
            exec('finish -c something');
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid: chmod 0o755 + exec("publish -c") — "sh" in "publish" is not a shell invocation (W1 word-boundary)', () => {
    ruleTester.run('no-unguarded-nonportable-exec', rule, {
      valid: [
        {
          code: `
            fs.chmodSync(fixture, 0o755);
            exec('publish -c');
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  // C1 fix: '-c' must be FIRST element; a script receiving '-c' as a later arg
  // is not a shell -c invocation.
  test('valid (C1): chmod 0o755 + execFileSync(sh, [fixturePath, "-c"]) — script arg, not shell -c', () => {
    ruleTester.run('no-unguarded-nonportable-exec', rule, {
      valid: [
        {
          code: `
            fs.chmodSync(fixturePath, 0o755);
            execFileSync('sh', [fixturePath, '-c']);
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  // C2 fix: 'sh -c' embedded mid-string in data (as arg to printf) must NOT flag.
  test('valid (C2): chmod 0o755 + exec("printf \\"sh -c\\"") — sh -c as data, not a shell invocation', () => {
    ruleTester.run('no-unguarded-nonportable-exec', rule, {
      valid: [
        {
          code: `
            fs.chmodSync(fixture, 0o755);
            exec('printf "sh -c"');
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  // C2 fix: 'sh -c' embedded after other words must NOT flag.
  test('valid (C2): chmod 0o755 + exec("echo run sh -c later") — sh -c mid-string as data', () => {
    ruleTester.run('no-unguarded-nonportable-exec', rule, {
      valid: [
        {
          code: `
            fs.chmodSync(fixture, 0o755);
            exec('echo run sh -c later');
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });
});
