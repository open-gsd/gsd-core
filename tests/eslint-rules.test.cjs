'use strict';

/**
 * eslint-rules.test.cjs
 *
 * RuleTester unit tests for the local ESLint rules:
 *   - local/no-source-grep
 *   - local/no-magic-sleep-in-tests
 *   - local/no-elapsed-assertion
 *   - local/no-raw-rmsync-in-tests
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { RuleTester } = require('eslint');

const noSourceGrep = require('../eslint-rules/no-source-grep.cjs');
const noMagicSleepInTests = require('../eslint-rules/no-magic-sleep-in-tests.cjs');
const noElapsedAssertion = require('../eslint-rules/no-elapsed-assertion.cjs');
const noRawRmsyncInTests = require('../eslint-rules/no-raw-rmsync-in-tests.cjs');

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'commonjs',
  },
});

// ─── no-source-grep ──────────────────────────────────────────────────────────

describe('no-source-grep rule', () => {
  test('valid: readFileSync on .md file is allowed', () => {
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [
        {
          code: `
            const fs = require('fs');
            const path = require('path');
            const content = fs.readFileSync(path.join(__dirname, '..', 'docs', 'readme.md'), 'utf-8');
            content.includes('hello');
          `,
          filename: 'tests/foo.test.cjs',
        },
        {
          code: `
            const fs = require('fs');
            const path = require('path');
            const content = fs.readFileSync(path.join(__dirname, '..', 'gsd-core', 'workflows', 'config.json'), 'utf-8');
            content.includes('key');
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
    assert.ok(true, 'no-source-grep valid cases passed');
  });

  test('invalid: readFileSync on .cjs source file followed by .includes()', () => {
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [],
      invalid: [
        {
          code: `
            const fs = require('fs');
            const path = require('path');
            const src = fs.readFileSync(path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'core.cjs'), 'utf-8');
            src.includes('someFunction');
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'noSourceGrep' }],
        },
      ],
    });
    assert.ok(true, 'no-source-grep invalid case detected');
  });

  test('invalid: readFileSync on .cjs source file followed by .match()', () => {
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [],
      invalid: [
        {
          code: `
            const fs = require('fs');
            const path = require('path');
            const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'foo.cjs'), 'utf-8');
            src.match(/pattern/);
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'noSourceGrep' }],
        },
      ],
    });
    assert.ok(true, 'no-source-grep match case detected');
  });

  test('valid: file with allow-test-rule annotation is exempt', () => {
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [
        {
          // The allow annotation exempts the whole file
          code: `
            // allow-test-rule: pending migration
            const fs = require('fs');
            const path = require('path');
            const src = fs.readFileSync(path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'core.cjs'), 'utf-8');
            src.includes('someFunction');
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
    assert.ok(true, 'no-source-grep allow-test-rule annotation works');
  });

  test('valid: require() of a .cjs file is allowed (not readFileSync)', () => {
    ruleTester.run('no-source-grep', noSourceGrep, {
      valid: [
        {
          code: `
            const mod = require('../gsd-core/bin/lib/core.cjs');
            mod.someMethod();
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
    assert.ok(true, 'no-source-grep require() is allowed');
  });
});

// ─── no-magic-sleep-in-tests ─────────────────────────────────────────────────

describe('no-magic-sleep-in-tests rule', () => {
  test('valid: setTimeout used outside tests (no-op since rule only applies to *.test.cjs)', () => {
    // Rule only applies to *.test.cjs files; a non-test filename is always valid
    ruleTester.run('no-magic-sleep-in-tests', noMagicSleepInTests, {
      valid: [
        {
          code: `
            const delay = new Promise(resolve => setTimeout(resolve, 100));
          `,
          filename: 'scripts/some-script.cjs',
        },
      ],
      invalid: [],
    });
    assert.ok(true, 'no-magic-sleep-in-tests does not apply outside test files');
  });

  test('invalid: Atomics.wait() in test file', () => {
    ruleTester.run('no-magic-sleep-in-tests', noMagicSleepInTests, {
      valid: [],
      invalid: [
        {
          code: `
            const shared = new SharedArrayBuffer(4);
            const arr = new Int32Array(shared);
            Atomics.wait(arr, 0, 0, 100);
          `,
          filename: 'tests/some.test.cjs',
          errors: [{ messageId: 'atomicsWaitSleep' }],
        },
      ],
    });
    assert.ok(true, 'no-magic-sleep-in-tests flags Atomics.wait()');
  });

  test('invalid: setTimeout used for synchronization in Promise in test file', () => {
    ruleTester.run('no-magic-sleep-in-tests', noMagicSleepInTests, {
      valid: [],
      invalid: [
        {
          code: `
            async function waitABit() {
              await new Promise(resolve => setTimeout(resolve, 50));
            }
          `,
          filename: 'tests/some.test.cjs',
          errors: [{ messageId: 'setTimeoutSync' }],
        },
      ],
    });
    assert.ok(true, 'no-magic-sleep-in-tests flags setTimeout in Promise');
  });

  test('valid: setTimeout with callback (not synchronization pattern) in test file', () => {
    // A setTimeout with no second arg or with a callback that does real work
    // is allowed. The rule only flags the await-new-Promise(setTimeout) pattern.
    ruleTester.run('no-magic-sleep-in-tests', noMagicSleepInTests, {
      valid: [
        {
          code: `
            function doSomethingLater(cb) {
              setTimeout(cb, 100);
            }
          `,
          filename: 'tests/some.test.cjs',
        },
      ],
      invalid: [],
    });
    assert.ok(true, 'no-magic-sleep-in-tests allows simple callback setTimeout');
  });
});

// ─── no-elapsed-assertion ─────────────────────────────────────────────────────

describe('no-elapsed-assertion rule', () => {
  test('valid: assert on non-timing property', () => {
    ruleTester.run('no-elapsed-assertion', noElapsedAssertion, {
      valid: [
        {
          code: `
            const assert = require('node:assert/strict');
            const result = { count: 5 };
            assert.equal(result.count, 5);
          `,
          filename: 'tests/foo.test.cjs',
        },
        {
          code: `
            const assert = require('node:assert/strict');
            assert.ok(result.success);
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
    assert.ok(true, 'no-elapsed-assertion valid cases passed');
  });

  test('invalid: assert on .elapsed property', () => {
    ruleTester.run('no-elapsed-assertion', noElapsedAssertion, {
      valid: [],
      invalid: [
        {
          code: `
            const assert = require('node:assert/strict');
            const result = { elapsed: 150 };
            assert.ok(result.elapsed < 200);
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'noElapsedAssertion' }],
        },
      ],
    });
    assert.ok(true, 'no-elapsed-assertion flags assert on .elapsed');
  });

  test('invalid: assert on .duration property', () => {
    ruleTester.run('no-elapsed-assertion', noElapsedAssertion, {
      valid: [],
      invalid: [
        {
          code: `
            const assert = require('node:assert/strict');
            assert.equal(stats.duration, 100);
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'noElapsedAssertion' }],
        },
      ],
    });
    assert.ok(true, 'no-elapsed-assertion flags assert on .duration');
  });

  test('invalid: assert on .took property', () => {
    ruleTester.run('no-elapsed-assertion', noElapsedAssertion, {
      valid: [],
      invalid: [
        {
          code: `
            const assert = require('node:assert/strict');
            assert.ok(result.took < 500);
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'noElapsedAssertion' }],
        },
      ],
    });
    assert.ok(true, 'no-elapsed-assertion flags assert on .took');
  });

  test('invalid: assert on .ms property', () => {
    ruleTester.run('no-elapsed-assertion', noElapsedAssertion, {
      valid: [],
      invalid: [
        {
          code: `
            const assert = require('node:assert/strict');
            assert.ok(result.ms > 0);
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'noElapsedAssertion' }],
        },
      ],
    });
    assert.ok(true, 'no-elapsed-assertion flags assert on .ms');
  });

  test('invalid: assert.equal with timing comparison', () => {
    ruleTester.run('no-elapsed-assertion', noElapsedAssertion, {
      valid: [],
      invalid: [
        {
          code: `
            const assert = require('node:assert/strict');
            assert.equal(result.elapsed > 0, true);
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'noElapsedAssertion' }],
        },
      ],
    });
    assert.ok(true, 'no-elapsed-assertion flags assert.equal with timing comparison');
  });
});

// ─── no-raw-rmsync-in-tests ──────────────────────────────────────────────────

describe('no-raw-rmsync-in-tests rule', () => {
  // ── INVALID cases (must error) ────────────────────────────────────────────

  test('invalid: fs.rmSync() in a test file', () => {
    ruleTester.run('no-raw-rmsync-in-tests', noRawRmsyncInTests, {
      valid: [],
      invalid: [
        {
          code: `
            const fs = require('fs');
            fs.rmSync(tmpDir, { recursive: true, force: true });
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'noRawRmSync' }],
        },
      ],
    });
    assert.ok(true, 'no-raw-rmsync-in-tests flags fs.rmSync() in test file');
  });

  test('invalid: computed member fs["rmSync"]() in a test file', () => {
    ruleTester.run('no-raw-rmsync-in-tests', noRawRmsyncInTests, {
      valid: [],
      invalid: [
        {
          code: `
            const fs = require('fs');
            fs['rmSync'](d, { recursive: true, force: true });
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'noRawRmSync' }],
        },
      ],
    });
    assert.ok(true, 'no-raw-rmsync-in-tests flags fs["rmSync"]() in test file');
  });

  test('invalid: destructured rmSync from require("fs") in a test file', () => {
    ruleTester.run('no-raw-rmsync-in-tests', noRawRmsyncInTests, {
      valid: [],
      invalid: [
        {
          code: `
            const { rmSync } = require('fs');
            rmSync(d, { recursive: true, force: true });
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'noRawRmSync' }],
        },
      ],
    });
    assert.ok(true, 'no-raw-rmsync-in-tests flags destructured rmSync from require("fs")');
  });

  test('invalid: aliased const del = fs.rmSync; del() in a test file', () => {
    ruleTester.run('no-raw-rmsync-in-tests', noRawRmsyncInTests, {
      valid: [],
      invalid: [
        {
          code: `
            const fs = require('fs');
            const del = fs.rmSync;
            del(d, { recursive: true, force: true });
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'noRawRmSync' }],
        },
      ],
    });
    assert.ok(true, 'no-raw-rmsync-in-tests flags aliased fs.rmSync');
  });

  test('invalid: allow-test-rule annotation no longer suppresses this rule (Defect 1 fixed)', () => {
    // A file with // allow-test-rule: <source-grep reason> must still error
    // on raw rmSync calls. The file-level annotation is for no-source-grep only.
    ruleTester.run('no-raw-rmsync-in-tests', noRawRmsyncInTests, {
      valid: [],
      invalid: [
        {
          code: `
            // allow-test-rule: source-text-is-the-product
            const fs = require('fs');
            fs.rmSync(d, { recursive: true, force: true });
          `,
          filename: 'tests/foo.test.cjs',
          errors: [{ messageId: 'noRawRmSync' }],
        },
      ],
    });
    assert.ok(true, 'no-raw-rmsync-in-tests is NOT suppressed by allow-test-rule annotation');
  });

  // ── VALID cases (must NOT error) ──────────────────────────────────────────

  test('valid: helpers.cleanup() in a test file (no error)', () => {
    ruleTester.run('no-raw-rmsync-in-tests', noRawRmsyncInTests, {
      valid: [
        {
          code: `
            const { cleanup } = require('../helpers.cjs');
            cleanup(tmpDir);
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
    assert.ok(true, 'no-raw-rmsync-in-tests allows helpers.cleanup()');
  });

  test('valid: bare rmSync() that is NOT fs-derived (local function) is not flagged', () => {
    // A locally defined function named rmSync must not be flagged — the rule
    // only tracks names that were bound from require("fs").
    ruleTester.run('no-raw-rmsync-in-tests', noRawRmsyncInTests, {
      valid: [
        {
          code: `
            const rmSync = () => {};
            rmSync(d);
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
    assert.ok(true, 'no-raw-rmsync-in-tests does not flag a locally-defined rmSync()');
  });

  // NOTE: The inline `// eslint-disable-next-line local/no-raw-rmsync-in-tests -- reason`
  // escape hatch is handled entirely by ESLint's own disable-comment mechanism and
  // cannot be unit-tested here via RuleTester (RuleTester runs the rule under a
  // different internal namespace so the comment's rule-id doesn't match). The escape
  // hatch works correctly when ESLint processes real files via `npx eslint`.

  test('valid: fs.rmSync() in a non-test file (rule is inert outside *.test.cjs)', () => {
    ruleTester.run('no-raw-rmsync-in-tests', noRawRmsyncInTests, {
      valid: [
        {
          code: `
            const fs = require('fs');
            fs.rmSync(tmpDir, { recursive: true, force: true });
          `,
          filename: 'scripts/foo.cjs',
        },
      ],
      invalid: [],
    });
    assert.ok(true, 'no-raw-rmsync-in-tests is inert in non-test files');
  });

  test('valid: member access / assignment without calling (not a CallExpression)', () => {
    ruleTester.run('no-raw-rmsync-in-tests', noRawRmsyncInTests, {
      valid: [
        {
          code: `
            const fs = require('fs');
            const orig = fs.rmSync;
            fs.rmSync = orig;
          `,
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
    assert.ok(true, 'no-raw-rmsync-in-tests ignores member access / assignment without call');
  });
});
