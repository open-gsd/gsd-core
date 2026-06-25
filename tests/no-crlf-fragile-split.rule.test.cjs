'use strict';

/**
 * no-crlf-fragile-split.rule.test.cjs
 *
 * RuleTester unit tests for the local/no-crlf-fragile-split ESLint rule.
 *
 * Rule covers three sub-patterns:
 *   G1 — .split('\n') on readFileSync-derived content (crlfFragileSplit)
 *   G2 — RegExp with bare \n on readFileSync-derived content (crlfFragileRegex)
 *   G3 — RegExp with bare \n containing markdown fence or frontmatter anchor
 *        (crlfFragileRegex) — caught even without direct data-flow
 *
 * NOTE: Fixture code strings must encode actual \n characters as \\n inside
 * the JavaScript string literals used for RuleTester `code` fields, so that
 * the ESLint parser receives the intended source text.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { RuleTester } = require('eslint');

const rule = require('../eslint-rules/no-crlf-fragile-split.cjs');

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'commonjs',
  },
});

// ─── module shape ─────────────────────────────────────────────────────────────

describe('no-crlf-fragile-split rule module', () => {
  test('exports meta and create', () => {
    assert.strictEqual(typeof rule.meta, 'object');
    assert.strictEqual(typeof rule.create, 'function');
    assert.strictEqual(rule.meta.type, 'problem');
    assert.ok(rule.meta.messages.crlfFragileSplit, 'crlfFragileSplit message must exist');
    assert.ok(rule.meta.messages.crlfFragileRegex, 'crlfFragileRegex message must exist');
  });
});

// ─── G1: INVALID cases ────────────────────────────────────────────────────────

describe('G1 — no-crlf-fragile-split: invalid (crlfFragileSplit)', () => {
  test('G1-invalid: readFileSync(p).split("\\n") — direct chain', () => {
    ruleTester.run('no-crlf-fragile-split', rule, {
      valid: [],
      invalid: [
        {
          // code that ESLint will parse: fs.readFileSync(p, 'utf8').split('\n')
          code: "const lines = fs.readFileSync(p, 'utf8').split('\\n');",
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'crlfFragileSplit' }],
        },
      ],
    });
  });

  test('G1-invalid: readFileSync(p).toString().split("\\n") — chained call', () => {
    ruleTester.run('no-crlf-fragile-split', rule, {
      valid: [],
      invalid: [
        {
          code: "const lines = readFileSync(p).toString().split('\\n');",
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'crlfFragileSplit' }],
        },
      ],
    });
  });

  test('G1-invalid: content = readFileSync(...); content.split("\\n") — via variable', () => {
    ruleTester.run('no-crlf-fragile-split', rule, {
      valid: [],
      invalid: [
        {
          code: [
            "const content = fs.readFileSync(filePath, 'utf8');",
            "const lines = content.split('\\n');",
          ].join('\n'),
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'crlfFragileSplit' }],
        },
      ],
    });
  });

  test('G1-invalid: double-quoted "\\n" in split', () => {
    ruleTester.run('no-crlf-fragile-split', rule, {
      valid: [],
      invalid: [
        {
          code: 'const lines = fs.readFileSync(\'file.txt\', \'utf8\').split("\\n");',
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'crlfFragileSplit' }],
        },
      ],
    });
  });
});

// ─── G1: VALID cases ──────────────────────────────────────────────────────────

describe('G1 — no-crlf-fragile-split: valid cases', () => {
  test('G1-valid: .split(/\\r?\\n/) — correct regex', () => {
    ruleTester.run('no-crlf-fragile-split', rule, {
      valid: [
        {
          // /\r?\n/ in source — no bare \n in a string argument
          code: "const lines = fs.readFileSync(p, 'utf8').split(/\\r?\\n/);",
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('G1-valid: non-file content split — "\\n" on a plain string literal', () => {
    ruleTester.run('no-crlf-fragile-split', rule, {
      valid: [
        {
          code: "const lines = someString.split('\\n');",
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('G1-valid: non-file content split — "\\n" on variable not from readFileSync', () => {
    ruleTester.run('no-crlf-fragile-split', rule, {
      valid: [
        {
          code: [
            "const content = 'hello\\\\nworld';",
            "const lines = content.split('\\n');",
          ].join('\n'),
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('G1-valid: .split("\\n") on a fetch/HTTP response (not readFileSync)', () => {
    ruleTester.run('no-crlf-fragile-split', rule, {
      valid: [
        {
          code: "const lines = response.text.split('\\n');",
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });
});

// ─── G2/G3: INVALID cases ─────────────────────────────────────────────────────

describe('G2/G3 — no-crlf-fragile-split: invalid (crlfFragileRegex)', () => {
  test('G2-invalid: bare \\n in regex on readFileSync content via .match()', () => {
    ruleTester.run('no-crlf-fragile-split', rule, {
      valid: [],
      invalid: [
        {
          // /foo\nbar/ — regex with bare \n; .match() on readFileSync result
          code: "const m = fs.readFileSync(p, 'utf8').match(/foo\\nbar/);",
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'crlfFragileRegex' }],
        },
      ],
    });
  });

  test('G2-invalid: bare \\n in regex on readFileSync content via .test()', () => {
    ruleTester.run('no-crlf-fragile-split', rule, {
      valid: [],
      invalid: [
        {
          // /hello\nworld/.test(readFileSync(...))
          code: "const ok = /hello\\nworld/.test(fs.readFileSync(p, 'utf8'));",
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'crlfFragileRegex' }],
        },
      ],
    });
  });

  test('G2-invalid: bare \\n in regex on readFileSync content via .replace()', () => {
    ruleTester.run('no-crlf-fragile-split', rule, {
      valid: [],
      invalid: [
        {
          code: "const out = fs.readFileSync(p, 'utf8').replace(/foo\\nbar/, 'x');",
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'crlfFragileRegex' }],
        },
      ],
    });
  });

  test('G3-invalid: markdown fence regex with bare \\n (```bash\\n)', () => {
    ruleTester.run('no-crlf-fragile-split', rule, {
      valid: [],
      invalid: [
        {
          // content.match(/```bash\nsome/) — fence regex with bare \n
          code: "const m = content.match(/```bash\\nsome/);",
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'crlfFragileRegex' }],
        },
      ],
    });
  });

  test('G3-invalid: frontmatter anchor regex with bare \\n (/^---\\n/)', () => {
    ruleTester.run('no-crlf-fragile-split', rule, {
      valid: [],
      invalid: [
        {
          // /^---\ntitle/.test(content) — frontmatter with bare \n
          code: "const hasFM = /^---\\ntitle/.test(content);",
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'crlfFragileRegex' }],
        },
      ],
    });
  });
});

// ─── G2/G3: VALID cases ───────────────────────────────────────────────────────

describe('G2/G3 — no-crlf-fragile-split: valid cases', () => {
  test('G2-valid: regex with \\r?\\n (already CRLF-safe) on readFileSync content', () => {
    ruleTester.run('no-crlf-fragile-split', rule, {
      valid: [
        {
          // /foo\r?\nbar/ — has \r?\n so it's safe
          code: "const m = fs.readFileSync(p, 'utf8').match(/foo\\r?\\nbar/);",
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('G2-valid: regex with bare \\n but used on a non-file string (ok per known boundaries)', () => {
    ruleTester.run('no-crlf-fragile-split', rule, {
      valid: [
        {
          // /hello\nworld/.test(someRuntimeString) — not file content
          code: "const ok = /hello\\nworld/.test(someRuntimeString);",
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('G3-valid: markdown fence regex but with \\r?\\n (already CRLF-safe)', () => {
    ruleTester.run('no-crlf-fragile-split', rule, {
      valid: [
        {
          code: "const m = content.match(/```bash\\r?\\nsome/);",
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('G3-valid: frontmatter regex with \\r\\n (explicitly CRLF-safe)', () => {
    ruleTester.run('no-crlf-fragile-split', rule, {
      valid: [
        {
          code: "const hasFM = /^---\\r\\ntitle/.test(content);",
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  // C3 per-occurrence classification cases
  test('C3-valid: /\\r?\\n/ — single safe occurrence, not flagged', () => {
    ruleTester.run('no-crlf-fragile-split', rule, {
      valid: [
        {
          code: "const m = fs.readFileSync(p, 'utf8').match(/\\r?\\n/);",
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });

  test('C3-invalid: regex with both safe \\r?\\n AND a separate bare \\n — flagged', () => {
    ruleTester.run('no-crlf-fragile-split', rule, {
      valid: [],
      invalid: [
        {
          // /\r?\nfoo|\nbar/ — the second \n (after |) is bare and fragile
          code: "const m = fs.readFileSync(p, 'utf8').match(/\\r?\\nfoo|\\nbar/);",
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'crlfFragileRegex' }],
        },
      ],
    });
  });

  test('C3-invalid: [^\\n] — \\n in class without \\r is fragile', () => {
    ruleTester.run('no-crlf-fragile-split', rule, {
      valid: [],
      invalid: [
        {
          // /[^\n]+/ — class has \n but no \r
          code: "const m = fs.readFileSync(p, 'utf8').match(/[^\\n]+/);",
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'crlfFragileRegex' }],
        },
      ],
    });
  });

  test('C3-valid: [^\\r\\n] — \\n in class with \\r is safe', () => {
    ruleTester.run('no-crlf-fragile-split', rule, {
      valid: [
        {
          code: "const m = fs.readFileSync(p, 'utf8').match(/[^\\r\\n]+/);",
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });
});
