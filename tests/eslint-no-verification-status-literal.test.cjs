'use strict';

/**
 * RuleTester unit tests for `local/no-verification-status-literal`
 * (#5118, ADR-5057 Phase 4).
 *
 * Design:       .gsd/phase/fix-5118-verification-status-enum/40-design.md §R7
 * Test matrix:  .gsd/phase/fix-5118-verification-status-enum/50-test-matrix.md — rows V57–V59
 *
 * TDD RED: `eslint-rules/no-verification-status-literal.cjs` does not exist
 * yet — this file's require() throws MODULE_NOT_FOUND until the implementing
 * phase adds it. That is the intended starting state.
 *
 * Contract this file locks for the not-yet-written rule:
 *   - FIRES in `src/` when a VerificationStatus value is spelled as a string
 *     literal and compared (===, !==, switch case) against a verification
 *     status — `x.verification.status`, or an identifier/property named like
 *     `verificationStatus`, `verifyStatus`, `verification_status`,
 *     `vStatus`, `verStatus` (V57). Use `VERIFICATION_STATUS.*` instead.
 *   - Does NOT fire inside `src/verification.cts` (the owner), on an
 *     unrelated vocabulary that shares a word (`uatResult === 'passed'`), on
 *     a comparison against the owner's constant, on a non-member literal
 *     (`'VERIFIED'` — plan-drift-guard's unrelated vocabulary), or outside
 *     `src/` (V58).
 *   - Is wired in eslint.config.mjs at error for `src/*.cts` (V59).
 *
 * RuleTester setup mirrors tests/eslint-no-adhoc-regex-escape.test.cjs.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { RuleTester, ESLint } = require('eslint');

const noVerificationStatusLiteral = require('../eslint-rules/no-verification-status-literal.cjs');

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'commonjs',
  },
});

const ERR = [{ messageId: 'verificationStatusLiteral' }];

describe('no-verification-status-literal rule', () => {
  test('rule module exports a create function', () => {
    assert.strictEqual(typeof noVerificationStatusLiteral.create, 'function');
  });

  test('V57 invalid: a status literal compared against a verification status outside the owner', () => {
    ruleTester.run('no-verification-status-literal', noVerificationStatusLiteral, {
      valid: [],
      invalid: [
        {
          code: 'function f(verification) { if (verification.status === \'passed\') return 1; return 0; }',
          filename: 'src/phase.cts',
          errors: ERR,
        },
        {
          code: 'function f(verificationStatus) { return verificationStatus === \'human_needed\'; }',
          filename: 'src/phase-status.cts',
          errors: ERR,
        },
        {
          code: 'function f(verifyStatus) { switch (verifyStatus) { case \'gaps_found\': return 1; default: return 0; } }',
          filename: 'src/quick-batch-dispatch.cts',
          errors: ERR,
        },
        {
          code: 'function f(p) { return p.verification_status !== \'stale\'; }',
          filename: 'src/init.cts',
          errors: ERR,
        },
        {
          code: 'function f(result) { return \'phase_dir_not_found\' === result.verificationStatus; }',
          filename: 'src/init.cts',
          errors: ERR,
        },
      ],
    });
  });

  test('V58 valid: the owner, an unrelated vocabulary, the owner constant, a non-member literal, and non-src files', () => {
    ruleTester.run('no-verification-status-literal', noVerificationStatusLiteral, {
      valid: [
        {
          code: 'function f(verification) { if (verification.status === \'passed\') return 1; return 0; }',
          filename: 'src/verification.cts',
        },
        {
          code: 'function f(uatResult) { return uatResult === \'passed\'; }',
          filename: 'src/uat.cts',
        },
        {
          code: 'const { VERIFICATION_STATUS } = require(\'./verification.cjs\'); function f(verification) { return verification.status === VERIFICATION_STATUS.PASSED; }',
          filename: 'src/phase.cts',
        },
        {
          code: 'function f(vStatus) { return vStatus === \'VERIFIED\'; }',
          filename: 'src/plan-drift-guard.cts',
        },
        {
          code: 'function f(verification) { return verification.status === \'passed\'; }',
          filename: 'tests/foo.test.cjs',
        },
      ],
      invalid: [],
    });
  });
});

describe('no-verification-status-literal config wiring', () => {
  test('V59: eslint.config.mjs applies local/no-verification-status-literal at error to src/*.cts', async () => {
    const root = path.join(__dirname, '..');
    const eslint = new ESLint({ cwd: root });
    const config = await eslint.calculateConfigForFile(path.join(root, 'src', 'phase.cts'));
    const setting = config && config.rules ? config.rules['local/no-verification-status-literal'] : undefined;
    assert.ok(setting !== undefined, 'the rule must be configured for src/*.cts');
    const severity = Array.isArray(setting) ? setting[0] : setting;
    assert.ok(severity === 2 || severity === 'error', `expected severity error, got ${JSON.stringify(setting)}`);
  });
});

describe('no-verification-status-literal member parity', () => {
  // The rule cannot import the compiled owner at lint time, so it carries the
  // enum's values; this pins them to the owner so the two cannot diverge
  // (CLAUDE.md "Generative Fix Divergence").
  test('the rule\'s member list equals the owner\'s VERIFICATION_STATUS values', () => {
    const { VERIFICATION_STATUS } = require('../gsd-core/bin/lib/verification.cjs');
    assert.deepEqual(
      [...noVerificationStatusLiteral.VERIFICATION_STATUS_MEMBERS].sort(),
      Object.values(VERIFICATION_STATUS).sort(),
    );
  });
});
