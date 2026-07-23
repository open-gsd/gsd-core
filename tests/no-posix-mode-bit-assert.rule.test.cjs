'use strict';

/**
 * no-posix-mode-bit-assert.rule.test.cjs
 *
 * RuleTester unit tests for the local/no-posix-mode-bit-assert ESLint rule.
 * Mirrors the style of tests/no-path-literal-in-assert.rule.test.cjs.
 *
 * Rule: report when a file-mode expression is compared to an octal literal in
 * an assert.*() or expect(…).<matcher>() assertion — a DEFECT that fails on
 * Windows because Windows reports 0o666/0o444 (DOS attributes), never the
 * requested POSIX octal.
 *
 * "File-mode expression" is:
 *   M0. Direct/chained `.mode` MemberExpression (non-computed)
 *   M1. Computed member `x['mode']`
 *   M2. Variable capture: `const m = stat.mode` / `const m = stat['mode']`
 *       resolved via scope — m & 0o777 or m === 0o644 is flagged.
 *       Unresolvable bare identifier (no in-file binding) is NOT flagged.
 *   M3. Destructure: `const { mode } = fs.statSync(p)` — mode binding flagged.
 *   M4. Wrapper: `Number(stat.mode & 0o777)` / `parseInt(stat.mode, 8)` inside
 *       the assertion operand — recurses into the wrapper's first argument.
 *
 * DEFECT category: DEFECT.WINDOWS-POSIX-MODE-BIT-ASSERT
 *
 * VALID (no report) when:
 *   - the assertion is inside a Windows-excluded block (platform guard,
 *     early-return guard, hoisted isWindows) as detected by platform-guard.cjs
 *   - neither operand resolves to a mode expression
 *   - the mode field is compared to a variable (not an octal literal)
 *   - a bare Identifier whose binding is unresolvable in-file is NOT flagged
 *     (conservative — avoids false positives on non-fs identifiers)
 *
 * Note on non-fs `.mode`: the rule intentionally flags ANY `.mode`-vs-octal-
 * literal equality assertion. It cannot distinguish `fs.statSync().mode` from
 * an unrelated `obj.mode`, and a non-fs `.mode` compared to an octal literal
 * is vanishingly rare in test code. The defect shape (POSIX-mode assertion that
 * fails on Windows) is the primary concern.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { RuleTester } = require('eslint');

const noPosixModeBitAssert = require('../eslint-rules/no-posix-mode-bit-assert.cjs');

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'commonjs',
  },
});

// ─── module shape ─────────────────────────────────────────────────────────────

describe('no-posix-mode-bit-assert rule module', () => {
  test('exports meta and create', () => {
    assert.strictEqual(typeof noPosixModeBitAssert.meta, 'object');
    assert.strictEqual(typeof noPosixModeBitAssert.create, 'function');
    assert.strictEqual(noPosixModeBitAssert.meta.type, 'problem');
    assert.ok(noPosixModeBitAssert.meta.messages.posixModeBit);
  });
});

// ─── INVALID cases (violation expected) ───────────────────────────────────────

describe('no-posix-mode-bit-assert invalid cases', () => {
  test('invalid: assert.strictEqual(fs.statSync(p).mode & 0o777, 0o644)', () => {
    ruleTester.run('no-posix-mode-bit-assert', noPosixModeBitAssert, {
      valid: [],
      invalid: [
        {
          code: `assert.strictEqual(fs.statSync(p).mode & 0o777, 0o644);`,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'posixModeBit' }],
        },
      ],
    });
  });

  test('invalid: assert.equal(statSync(p).mode & 0o111, 0)', () => {
    // 0 is a decimal literal but the mode mask 0o111 is an octal — the mask side
    // determines the defect shape (bitwise mask on .mode with an octal).
    ruleTester.run('no-posix-mode-bit-assert', noPosixModeBitAssert, {
      valid: [],
      invalid: [
        {
          code: `assert.equal(statSync(p).mode & 0o111, 0);`,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'posixModeBit' }],
        },
      ],
    });
  });

  test('invalid: direct .mode in the assertion — assert.strictEqual(fs.statSync(p).mode & 0o777, 0o755)', () => {
    // The assertion operand contains `.mode` directly (not via a variable).
    // This is always detected regardless of surrounding context.
    ruleTester.run('no-posix-mode-bit-assert', noPosixModeBitAssert, {
      valid: [],
      invalid: [
        {
          // .mode is directly in the masked expression inside the assert
          code: `const m = fs.statSync(p).mode; assert.strictEqual(fs.statSync(p).mode & 0o777, 0o755);`,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'posixModeBit' }],
        },
      ],
    });
  });

  test('invalid: assert.strictEqual(fs.statSync(p).mode, 0o100644) — direct mode comparison', () => {
    ruleTester.run('no-posix-mode-bit-assert', noPosixModeBitAssert, {
      valid: [],
      invalid: [
        {
          code: `assert.strictEqual(fs.statSync(p).mode, 0o100644);`,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'posixModeBit' }],
        },
      ],
    });
  });

  test('invalid: expect(statSync(p).mode & 0o777).toBe(0o644)', () => {
    ruleTester.run('no-posix-mode-bit-assert', noPosixModeBitAssert, {
      valid: [],
      invalid: [
        {
          code: `expect(statSync(p).mode & 0o777).toBe(0o644);`,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'posixModeBit' }],
        },
      ],
    });
  });

  test('invalid: assert.deepEqual with mode mask', () => {
    ruleTester.run('no-posix-mode-bit-assert', noPosixModeBitAssert, {
      valid: [],
      invalid: [
        {
          code: `assert.deepEqual(fs.statSync(p).mode & 0o777, 0o755);`,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'posixModeBit' }],
        },
      ],
    });
  });

  test('invalid: assert.deepStrictEqual with direct mode comparison', () => {
    ruleTester.run('no-posix-mode-bit-assert', noPosixModeBitAssert, {
      valid: [],
      invalid: [
        {
          code: `assert.deepStrictEqual(fs.statSync(f).mode, 0o100755);`,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'posixModeBit' }],
        },
      ],
    });
  });

  test('invalid: expect(statSync(p).mode & 0o777).toEqual(0o644)', () => {
    ruleTester.run('no-posix-mode-bit-assert', noPosixModeBitAssert, {
      valid: [],
      invalid: [
        {
          code: `expect(statSync(p).mode & 0o777).toEqual(0o644);`,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'posixModeBit' }],
        },
      ],
    });
  });

  test('invalid: expect(statSync(p).mode & 0o777).toStrictEqual(0o644)', () => {
    ruleTester.run('no-posix-mode-bit-assert', noPosixModeBitAssert, {
      valid: [],
      invalid: [
        {
          code: `expect(statSync(p).mode & 0o777).toStrictEqual(0o644);`,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'posixModeBit' }],
        },
      ],
    });
  });

  test.skip('invalid: legacy octal (0644) — espree ecmaVersion:2022 rejects the syntax; out of scope', () => {});

  test('invalid: x.mode compared to octal (simple MemberExpression .mode)', () => {
    ruleTester.run('no-posix-mode-bit-assert', noPosixModeBitAssert, {
      valid: [],
      invalid: [
        {
          code: `assert.strictEqual(x.mode, 0o644);`,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'posixModeBit' }],
        },
      ],
    });
  });

  test('invalid: reversed operands — assert.strictEqual(0o644, fs.statSync(p).mode & 0o777)', () => {
    ruleTester.run('no-posix-mode-bit-assert', noPosixModeBitAssert, {
      valid: [],
      invalid: [
        {
          code: `assert.strictEqual(0o644, fs.statSync(p).mode & 0o777);`,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'posixModeBit' }],
        },
      ],
    });
  });

  // ── M1: computed member x['mode'] ─────────────────────────────────────────

  test('invalid M1: assert.strictEqual(stat["mode"] & 0o777, 0o644) — computed member', () => {
    ruleTester.run('no-posix-mode-bit-assert', noPosixModeBitAssert, {
      valid: [],
      invalid: [
        {
          code: `assert.strictEqual(stat['mode'] & 0o777, 0o644);`,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'posixModeBit' }],
        },
      ],
    });
  });

  test('invalid M1: assert.strictEqual(fs.statSync(p)["mode"], 0o100644) — computed member direct', () => {
    ruleTester.run('no-posix-mode-bit-assert', noPosixModeBitAssert, {
      valid: [],
      invalid: [
        {
          code: `assert.strictEqual(fs.statSync(p)['mode'], 0o100644);`,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'posixModeBit' }],
        },
      ],
    });
  });

  // ── M2: variable capture const m = stat.mode ──────────────────────────────

  test('invalid M2: const m = fs.statSync(p).mode; assert.strictEqual(m & 0o777, 0o644)', () => {
    ruleTester.run('no-posix-mode-bit-assert', noPosixModeBitAssert, {
      valid: [],
      invalid: [
        {
          code: `const m = fs.statSync(p).mode; assert.strictEqual(m & 0o777, 0o644);`,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'posixModeBit' }],
        },
      ],
    });
  });

  test('invalid M2: const m = stat["mode"]; assert.strictEqual(m & 0o777, 0o644) — computed-member capture', () => {
    ruleTester.run('no-posix-mode-bit-assert', noPosixModeBitAssert, {
      valid: [],
      invalid: [
        {
          code: `const m = stat['mode']; assert.strictEqual(m & 0o777, 0o644);`,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'posixModeBit' }],
        },
      ],
    });
  });

  test('invalid M2: const m = fs.statSync(p).mode; assert.strictEqual(m, 0o100644) — direct comparison', () => {
    ruleTester.run('no-posix-mode-bit-assert', noPosixModeBitAssert, {
      valid: [],
      invalid: [
        {
          code: `const m = fs.statSync(p).mode; assert.strictEqual(m, 0o100644);`,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'posixModeBit' }],
        },
      ],
    });
  });

  // ── M3: destructuring const { mode } = fs.statSync(p) ────────────────────

  test('invalid M3: const { mode } = fs.statSync(p); assert.strictEqual(mode & 0o777, 0o644)', () => {
    ruleTester.run('no-posix-mode-bit-assert', noPosixModeBitAssert, {
      valid: [],
      invalid: [
        {
          code: `const { mode } = fs.statSync(p); assert.strictEqual(mode & 0o777, 0o644);`,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'posixModeBit' }],
        },
      ],
    });
  });

  test('invalid M3: const { mode } = lstatSync(p); assert.strictEqual(mode, 0o100755)', () => {
    ruleTester.run('no-posix-mode-bit-assert', noPosixModeBitAssert, {
      valid: [],
      invalid: [
        {
          code: `const { mode } = lstatSync(p); assert.strictEqual(mode, 0o100755);`,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'posixModeBit' }],
        },
      ],
    });
  });

  // ── M4: wrapper Number(...) / parseInt(...) ────────────────────────────────

  test('invalid M4: assert.strictEqual(Number(fs.statSync(p).mode & 0o777), 0o644)', () => {
    ruleTester.run('no-posix-mode-bit-assert', noPosixModeBitAssert, {
      valid: [],
      invalid: [
        {
          code: `assert.strictEqual(Number(fs.statSync(p).mode & 0o777), 0o644);`,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'posixModeBit' }],
        },
      ],
    });
  });

  test('invalid M4: assert.strictEqual(parseInt(fs.statSync(p).mode, 8) & 0o777, 0o644)', () => {
    ruleTester.run('no-posix-mode-bit-assert', noPosixModeBitAssert, {
      valid: [],
      invalid: [
        {
          code: `assert.strictEqual(parseInt(fs.statSync(p).mode, 8) & 0o777, 0o644);`,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'posixModeBit' }],
        },
      ],
    });
  });

  test('invalid M4: assert.strictEqual(Number(stat.mode), 0o644) — Number wrapper direct', () => {
    ruleTester.run('no-posix-mode-bit-assert', noPosixModeBitAssert, {
      valid: [],
      invalid: [
        {
          code: `assert.strictEqual(Number(stat.mode), 0o644);`,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'posixModeBit' }],
        },
      ],
    });
  });
});

// ─── VALID cases (no violation expected) ─────────────────────────────────────

describe('no-posix-mode-bit-assert valid cases', () => {
  test('valid: guarded by if (process.platform !== "win32") { ... }', () => {
    ruleTester.run('no-posix-mode-bit-assert', noPosixModeBitAssert, {
      valid: [
        {
          code: `
            if (process.platform !== 'win32') {
              assert.strictEqual(statSync(p).mode & 0o777, 0o644);
            }
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid: early-return guard — if (process.platform === "win32") return; assert.strictEqual(mode)', () => {
    ruleTester.run('no-posix-mode-bit-assert', noPosixModeBitAssert, {
      valid: [
        {
          code: `
            function test() {
              if (process.platform === 'win32') return;
              assert.strictEqual(statSync(p).mode & 0o777, 0o644);
            }
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid: assert.equal(config.timeout, 0o644) — octal but no .mode → not flagged', () => {
    ruleTester.run('no-posix-mode-bit-assert', noPosixModeBitAssert, {
      valid: [
        {
          code: `assert.equal(config.timeout, 0o644);`,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid: assert.equal(result.mode, "r") — .mode but no octal → not flagged', () => {
    ruleTester.run('no-posix-mode-bit-assert', noPosixModeBitAssert, {
      valid: [
        {
          code: `assert.equal(result.mode, 'r');`,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid: assert.equal(file.mode, expectedMode) — .mode but expected is a variable → not flagged', () => {
    ruleTester.run('no-posix-mode-bit-assert', noPosixModeBitAssert, {
      valid: [
        {
          code: `assert.equal(file.mode, expectedMode);`,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid: assert.ok(fs.statSync(p).mode) — not an equality assertion', () => {
    ruleTester.run('no-posix-mode-bit-assert', noPosixModeBitAssert, {
      valid: [
        {
          code: `assert.ok(fs.statSync(p).mode);`,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid: assert.equal(x, y) — no .mode, no octal', () => {
    ruleTester.run('no-posix-mode-bit-assert', noPosixModeBitAssert, {
      valid: [
        {
          code: `assert.equal(x, y);`,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid: assert.strictEqual(count, 0o777) — octal but no .mode in assertion operands → not flagged', () => {
    // 0o777 is an octal, count is a bare identifier, no .mode → out of scope
    ruleTester.run('no-posix-mode-bit-assert', noPosixModeBitAssert, {
      valid: [
        {
          code: `assert.strictEqual(count, 0o777);`,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid: assert.notStrictEqual(fs.statSync(p).mode & 0o777, 0o644) — inequality assertion, not flagged', () => {
    // Inequality assertions pass on Windows regardless, so are out of scope.
    ruleTester.run('no-posix-mode-bit-assert', noPosixModeBitAssert, {
      valid: [
        {
          code: `assert.notStrictEqual(fs.statSync(p).mode & 0o777, 0o644);`,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid: hoisted isWindows guard', () => {
    ruleTester.run('no-posix-mode-bit-assert', noPosixModeBitAssert, {
      valid: [
        {
          code: `
            const isWindows = process.platform === 'win32';
            if (!isWindows) {
              assert.strictEqual(statSync(p).mode & 0o777, 0o644);
            }
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid: assert.equal(result.mode, result.mode) — no octal involved', () => {
    ruleTester.run('no-posix-mode-bit-assert', noPosixModeBitAssert, {
      valid: [
        {
          code: `assert.equal(result.mode, result.mode);`,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid (conservative): unresolvable bare identifier m & 0o777 — no in-file binding → NOT flagged', () => {
    // `m` has no in-file `const m = …mode` declaration (it could be an import,
    // a function parameter, or an unrelated local). The rule is conservative:
    // it only flags when the binding RESOLVES to a mode expression in-file.
    ruleTester.run('no-posix-mode-bit-assert', noPosixModeBitAssert, {
      valid: [
        {
          code: `assert.strictEqual(m & 0o777, 0o644);`,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid (conservative): variable capture with non-mode init — assert.strictEqual(m & 0o777, 0o644) NOT flagged when m = config.timeout', () => {
    // `m` is initialized to something that is NOT a mode expression; should not flag.
    ruleTester.run('no-posix-mode-bit-assert', noPosixModeBitAssert, {
      valid: [
        {
          code: `const m = config.timeout; assert.strictEqual(m & 0o777, 0o644);`,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('valid (conservative): M2 variable reassigned before assert — NOT flagged (reassignment invalidates alias)', () => {
    // `m` was initialized to a mode expression but then reassigned; conservative
    // approach — do not flag when init cannot be trusted as the current value.
    ruleTester.run('no-posix-mode-bit-assert', noPosixModeBitAssert, {
      valid: [
        {
          code: `const m = fs.statSync(p).mode; m = 0; assert.strictEqual(m & 0o777, 0o644);`,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });
});
