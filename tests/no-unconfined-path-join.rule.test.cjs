'use strict';

/**
 * no-unconfined-path-join.rule.test.cjs
 *
 * RuleTester unit tests for the local/no-unconfined-path-join ESLint rule.
 *
 * Arm 1: hand-rolled containment comparison `x.startsWith(y + sep)`.
 * Arm 2: a discarded containment-predicate result (bare statement call).
 * Plus the `allow-handrolled-containment: <reason>` marker escape and the
 * allowlist ratchet mechanics.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { RuleTester } = require('eslint');

const rule = require('../eslint-rules/no-unconfined-path-join.cjs');

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'commonjs',
  },
});

// ─── module shape ─────────────────────────────────────────────────────────────

describe('no-unconfined-path-join rule module', () => {
  test('exports meta and create', () => {
    assert.strictEqual(typeof rule.meta, 'object');
    assert.strictEqual(typeof rule.create, 'function');
    assert.strictEqual(rule.meta.type, 'problem');
    assert.ok(rule.meta.messages.handRolledContainment, 'handRolledContainment message must exist');
    assert.ok(
      rule.meta.messages.discardedContainmentResult,
      'discardedContainmentResult message must exist',
    );
    assert.ok(rule.meta.messages.staleAllowlistEntry, 'staleAllowlistEntry message must exist');
  });
});

// ─── Arm 1: hand-rolled containment — fires ──────────────────────────────────

describe('no-unconfined-path-join: arm 1 fires', () => {
  test('invalid: resolved.startsWith(root + path.sep)', () => {
    ruleTester.run('no-unconfined-path-join', rule, {
      valid: [],
      invalid: [
        {
          code: `resolved.startsWith(root + path.sep);`,
          filename: 'src/foo.cts',
          errors: [{ messageId: 'handRolledContainment' }],
        },
      ],
    });
  });

  test('invalid: resolved !== root && !resolved.startsWith(root + path.sep) reports exactly one error', () => {
    ruleTester.run('no-unconfined-path-join', rule, {
      valid: [],
      invalid: [
        {
          code: `if (resolved !== root && !resolved.startsWith(root + path.sep)) { throw new Error('x'); }`,
          filename: 'src/foo.cts',
          errors: [{ messageId: 'handRolledContainment' }],
        },
      ],
    });
  });

  test('invalid: x.startsWith(y + "/")', () => {
    ruleTester.run('no-unconfined-path-join', rule, {
      valid: [],
      invalid: [
        {
          code: `x.startsWith(y + '/');`,
          filename: 'src/foo.cts',
          errors: [{ messageId: 'handRolledContainment' }],
        },
      ],
    });
  });

  test('invalid: x.startsWith(y + "\\\\")', () => {
    ruleTester.run('no-unconfined-path-join', rule, {
      valid: [],
      invalid: [
        {
          code: `x.startsWith(y + '\\\\');`,
          filename: 'src/foo.cts',
          errors: [{ messageId: 'handRolledContainment' }],
        },
      ],
    });
  });

  test('invalid: x.startsWith(y + p.sep)', () => {
    ruleTester.run('no-unconfined-path-join', rule, {
      valid: [],
      invalid: [
        {
          code: `x.startsWith(y + p.sep);`,
          filename: 'src/foo.cts',
          errors: [{ messageId: 'handRolledContainment' }],
        },
      ],
    });
  });
});

// ─── Arm 1: hand-rolled containment — silent ─────────────────────────────────

describe('no-unconfined-path-join: arm 1 silent', () => {
  test('valid: x.startsWith(prefix) — bare identifier argument', () => {
    ruleTester.run('no-unconfined-path-join', rule, {
      valid: [{ code: `x.startsWith(prefix);`, filename: 'src/foo.cts' }],
      invalid: [],
    });
  });

  test('valid: x.startsWith("gsd-") — plain literal argument', () => {
    ruleTester.run('no-unconfined-path-join', rule, {
      valid: [{ code: `x.startsWith('gsd-');`, filename: 'src/foo.cts' }],
      invalid: [],
    });
  });

  test('valid: x.startsWith(y + "-") — right side is not a separator', () => {
    ruleTester.run('no-unconfined-path-join', rule, {
      valid: [{ code: `x.startsWith(y + '-');`, filename: 'src/foo.cts' }],
      invalid: [],
    });
  });

  test('valid: x.startsWith(y + z) — right side is an unresolvable identifier', () => {
    ruleTester.run('no-unconfined-path-join', rule, {
      valid: [{ code: `x.startsWith(y + z);`, filename: 'src/foo.cts' }],
      invalid: [],
    });
  });

  test('valid: x.startsWith(a, b) — wrong arity', () => {
    ruleTester.run('no-unconfined-path-join', rule, {
      valid: [{ code: `x.startsWith(a, b);`, filename: 'src/foo.cts' }],
      invalid: [],
    });
  });
});

// ─── Arm 2: discarded containment result — fires ─────────────────────────────

describe('no-unconfined-path-join: arm 2 fires', () => {
  test('invalid: assertWithinRoot(p, root); as a bare statement', () => {
    ruleTester.run('no-unconfined-path-join', rule, {
      valid: [],
      invalid: [
        {
          code: `assertWithinRoot(p, root);`,
          filename: 'src/foo.cts',
          errors: [{ messageId: 'discardedContainmentResult' }],
        },
      ],
    });
  });

  test('invalid: tryWithinRoot(p, root); as a bare statement', () => {
    ruleTester.run('no-unconfined-path-join', rule, {
      valid: [],
      invalid: [
        {
          code: `tryWithinRoot(p, root);`,
          filename: 'src/foo.cts',
          errors: [{ messageId: 'discardedContainmentResult' }],
        },
      ],
    });
  });
});

// ─── Arm 2: discarded containment result — silent ────────────────────────────

describe('no-unconfined-path-join: arm 2 silent', () => {
  test('valid: const x = assertWithinRoot(p, root); — VariableDeclarator init', () => {
    ruleTester.run('no-unconfined-path-join', rule, {
      valid: [{ code: `const x = assertWithinRoot(p, root);`, filename: 'src/foo.cts' }],
      invalid: [],
    });
  });

  test('valid: if (tryWithinRoot(p, root) === null) {} — inside a comparison', () => {
    ruleTester.run('no-unconfined-path-join', rule, {
      valid: [
        { code: `if (tryWithinRoot(p, root) === null) {}`, filename: 'src/foo.cts' },
      ],
      invalid: [],
    });
  });

  test('valid: return assertWithinRoot(p, root); — return value', () => {
    ruleTester.run('no-unconfined-path-join', rule, {
      valid: [
        {
          code: `function f() { return assertWithinRoot(p, root); }`,
          filename: 'src/foo.cts',
        },
      ],
      invalid: [],
    });
  });

  test('valid: fs.readFileSync(assertWithinRoot(p, root)); — call argument', () => {
    ruleTester.run('no-unconfined-path-join', rule, {
      valid: [
        { code: `fs.readFileSync(assertWithinRoot(p, root));`, filename: 'src/foo.cts' },
      ],
      invalid: [],
    });
  });

  test('valid: someOtherFn(p, root); — unrelated callee name', () => {
    ruleTester.run('no-unconfined-path-join', rule, {
      valid: [{ code: `someOtherFn(p, root);`, filename: 'src/foo.cts' }],
      invalid: [],
    });
  });
});

// ─── marker escape ────────────────────────────────────────────────────────────

describe('no-unconfined-path-join: marker escape', () => {
  test('valid: suppressed with a real reason', () => {
    ruleTester.run('no-unconfined-path-join', rule, {
      valid: [
        {
          code: `resolved.startsWith(root + path.sep); // allow-handrolled-containment: legacy call site pending migration`,
          filename: 'src/foo.cts',
        },
      ],
      invalid: [],
    });
  });

  test('invalid: does NOT suppress with an empty reason', () => {
    ruleTester.run('no-unconfined-path-join', rule, {
      valid: [],
      invalid: [
        {
          code: `resolved.startsWith(root + path.sep); // allow-handrolled-containment:`,
          filename: 'src/foo.cts',
          errors: [{ messageId: 'handRolledContainment' }],
        },
      ],
    });
  });

  test('invalid: does NOT suppress without a colon', () => {
    ruleTester.run('no-unconfined-path-join', rule, {
      valid: [],
      invalid: [
        {
          code: `resolved.startsWith(root + path.sep); // allow-handrolled-containment`,
          filename: 'src/foo.cts',
          errors: [{ messageId: 'handRolledContainment' }],
        },
      ],
    });
  });

  test('invalid: does NOT suppress when the marker is on a different line', () => {
    ruleTester.run('no-unconfined-path-join', rule, {
      valid: [],
      invalid: [
        {
          code: `// allow-handrolled-containment: legacy call site pending migration\nresolved.startsWith(root + path.sep);`,
          filename: 'src/foo.cts',
          errors: [{ messageId: 'handRolledContainment' }],
        },
      ],
    });
  });

  test('valid: suppressed with a justification (b) reason — pre-build bootstrap file', () => {
    ruleTester.run('no-unconfined-path-join', rule, {
      valid: [
        {
          code: `resolved.startsWith(root + path.sep); // allow-handrolled-containment: this is a committed .cjs that must run before npm run build:lib, so src/security.cts is unreachable here`,
          filename: 'gsd-core/bin/lib/capability-validator.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('invalid: the old spelling allow-lexical-prefix-match no longer suppresses', () => {
    ruleTester.run('no-unconfined-path-join', rule, {
      valid: [],
      invalid: [
        {
          code: `resolved.startsWith(root + path.sep); // allow-lexical-prefix-match: legacy call site pending migration`,
          filename: 'src/foo.cts',
          errors: [{ messageId: 'handRolledContainment' }],
        },
      ],
    });
  });
});

// ─── allowlist ratchet ────────────────────────────────────────────────────────

describe('no-unconfined-path-join: allowlist', () => {
  test('valid: allowlisted file with violations reports nothing', () => {
    ruleTester.run('no-unconfined-path-join', rule, {
      valid: [
        {
          code: `resolved.startsWith(root + path.sep);`,
          filename: 'src/legacy.cts',
          options: [{ allowlist: ['src/legacy.cts'] }],
        },
      ],
      invalid: [],
    });
  });

  test('invalid: allowlisted file with ZERO violations reports staleAllowlistEntry', () => {
    ruleTester.run('no-unconfined-path-join', rule, {
      valid: [],
      invalid: [
        {
          code: `const x = 1;`,
          filename: 'src/legacy.cts',
          options: [{ allowlist: ['src/legacy.cts'] }],
          errors: [{ messageId: 'staleAllowlistEntry' }],
        },
      ],
    });
  });

  test('invalid: allowlisted file whose only occurrence is marker-suppressed reports staleAllowlistEntry', () => {
    ruleTester.run('no-unconfined-path-join', rule, {
      valid: [],
      invalid: [
        {
          code: `resolved.startsWith(root + path.sep); // allow-handrolled-containment: legacy call site pending migration`,
          filename: 'src/legacy.cts',
          options: [{ allowlist: ['src/legacy.cts'] }],
          errors: [{ messageId: 'staleAllowlistEntry' }],
        },
      ],
    });
  });

  test('invalid: non-allowlisted file with violations reports', () => {
    ruleTester.run('no-unconfined-path-join', rule, {
      valid: [],
      invalid: [
        {
          code: `resolved.startsWith(root + path.sep);`,
          filename: 'src/other.cts',
          options: [{ allowlist: ['src/legacy.cts'] }],
          errors: [{ messageId: 'handRolledContainment' }],
        },
      ],
    });
  });

  test('valid: rule configured with no options at all does not crash', () => {
    ruleTester.run('no-unconfined-path-join', rule, {
      valid: [{ code: `x.startsWith(prefix);`, filename: 'src/foo.cts' }],
      invalid: [],
    });
  });
});
