'use strict';

// This file is an eslint-rule RuleTester fixture. It contains npm exec
// command strings as TEST DATA (fixtures the rule must lint) — not real
// invocations. See ALLOWLIST in scripts/prompt-injection-scan.sh.

/**
 * no-bare-npm-exec.rule.test.cjs
 *
 * RuleTester unit tests for the local/no-bare-npm-exec ESLint rule.
 *
 * Rule (G5): flag execFileSync/spawnSync/spawn('npm', ...) without
 * { shell: true } — Windows needs npm.cmd via a shell.
 *
 * execSync('npm ...') is explicitly NOT flagged: execSync always runs through
 * a shell (cmd.exe on Windows resolves npm.cmd automatically), so it is safe
 * without shell: true.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { RuleTester } = require('eslint');

const rule = require('../eslint-rules/no-bare-npm-exec.cjs');

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'commonjs',
  },
});

// ─── module shape ─────────────────────────────────────────────────────────────

describe('no-bare-npm-exec rule module', () => {
  test('exports meta and create', () => {
    assert.strictEqual(typeof rule.meta, 'object');
    assert.strictEqual(typeof rule.create, 'function');
    assert.strictEqual(rule.meta.type, 'problem');
    assert.ok(rule.meta.messages.bareNpmExec, 'bareNpmExec message must exist');
  });
});

// ─── INVALID cases ────────────────────────────────────────────────────────────

describe('no-bare-npm-exec: invalid cases', () => {
  test('invalid: execFileSync("npm", ["install"]) with no options', () => {
    ruleTester.run('no-bare-npm-exec', rule, {
      valid: [],
      invalid: [
        {
          code: `execFileSync('npm', ['install']);`,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'bareNpmExec' }],
        },
      ],
    });
  });

  test('invalid: execFileSync("npm", ["ci"], { cwd }) without shell', () => {
    ruleTester.run('no-bare-npm-exec', rule, {
      valid: [],
      invalid: [
        {
          code: `execFileSync('npm', ['ci'], { cwd: '/some/dir' });`,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'bareNpmExec' }],
        },
      ],
    });
  });

  test('invalid: spawnSync("npm", ["run", "build"]) with no options', () => {
    ruleTester.run('no-bare-npm-exec', rule, {
      valid: [],
      invalid: [
        {
          code: `spawnSync('npm', ['run', 'build']);`,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'bareNpmExec' }],
        },
      ],
    });
  });

  test('invalid: spawn("npm", ["install"]) with no options', () => {
    ruleTester.run('no-bare-npm-exec', rule, {
      valid: [],
      invalid: [
        {
          code: `spawn('npm', ['install']);`,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'bareNpmExec' }],
        },
      ],
    });
  });

});

// ─── VALID cases ──────────────────────────────────────────────────────────────

describe('no-bare-npm-exec: valid cases', () => {
  test('valid: execFileSync("npm", ["install"], { shell: true })', () => {
    ruleTester.run('no-bare-npm-exec', rule, {
      valid: [
        {
          code: `execFileSync('npm', ['install'], { shell: true });`,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid: execFileSync("npm", ["ci"], { shell: true, cwd: dir })', () => {
    ruleTester.run('no-bare-npm-exec', rule, {
      valid: [
        {
          code: `execFileSync('npm', ['ci'], { shell: true, cwd: dir });`,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid: execFileSync("npm", ...) with shell: isWindows', () => {
    ruleTester.run('no-bare-npm-exec', rule, {
      valid: [
        {
          code: `execFileSync('npm', ['install'], { shell: isWindows });`,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid: execFileSync("npm", ...) with shell: process.platform === "win32"', () => {
    ruleTester.run('no-bare-npm-exec', rule, {
      valid: [
        {
          code: `execFileSync('npm', ['install'], { shell: process.platform === 'win32' });`,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid: spawnSync("npm", ["run", "test"], { shell: true })', () => {
    ruleTester.run('no-bare-npm-exec', rule, {
      valid: [
        {
          code: `spawnSync('npm', ['run', 'test'], { shell: true });`,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid: execFileSync("node", ["script.js"]) — not npm, no flag needed', () => {
    ruleTester.run('no-bare-npm-exec', rule, {
      valid: [
        {
          code: `execFileSync('node', ['script.js']);`,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid: execFileSync("npx", ["mocha"]) — not npm, different command', () => {
    ruleTester.run('no-bare-npm-exec', rule, {
      valid: [
        {
          code: `execFileSync('npx', ['mocha']);`,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid: execSync("npm install") — execSync uses a shell by default, safe without shell:true', () => {
    ruleTester.run('no-bare-npm-exec', rule, {
      valid: [
        {
          // execSync always invokes a shell (cmd.exe on Windows resolves npm.cmd),
          // so it does NOT need shell: true. Rule only flags execFileSync/spawnSync/spawn.
          code: `execSync('npm install');`,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });
});
