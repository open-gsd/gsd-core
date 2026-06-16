// Property-based tests for the prohibition-enforcement parsing/transform helpers (#1259, ADR-550 D5d).
// RULESET.TESTS.property-based-testing: the producer is a parsing module (parseNodeTestSummary,
// tapTestNames, eslintJsonHasRule, eslintHasFatalError, eslintFileResultCount), so it carries
// fast-check invariants — especially the fail-closed safety invariants of the verify-time gate.
'use strict';
process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fc = require('./helpers/fast-check-setup.cjs');

const ENFORCEMENT_LIB = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'prohibition-enforcement.cjs');

describe('prohibition-enforcement properties (#1259)', () => {
  test('parseNodeTestSummary never throws and returns non-negative integer counts', () => {
    const enforce = require(ENFORCEMENT_LIB);
    fc.assert(fc.property(fc.string(), (s) => {
      const r = enforce.parseNodeTestSummary(s);
      for (const k of ['tests', 'pass', 'fail', 'cancelled']) {
        assert.ok(Number.isInteger(r[k]) && r[k] >= 0, `${k} is a non-negative integer`);
      }
    }));
  });

  test('isNonVacuousNodeTestPass FAIL-CLOSED: a run with any failure or cancellation never greens', () => {
    const enforce = require(ENFORCEMENT_LIB);
    fc.assert(fc.property(
      fc.nat({ max: 50 }), fc.integer({ min: 1, max: 50 }), fc.nat({ max: 50 }), fc.string(),
      (tests, failOrCancel, pass, name) => {
        // A summary with fail>=1 (and, separately, cancelled>=1) must NEVER be a non-vacuous pass,
        // regardless of the reported test name.
        const failing = `ok 1 - ${name}\n# tests ${tests + 1}\n# pass ${pass}\n# fail ${failOrCancel}\n# cancelled 0\n`;
        assert.equal(enforce.isNonVacuousNodeTestPass(failing, 'neg.test.cjs'), false);
        const cancelled = `ok 1 - ${name}\n# tests ${tests + 1}\n# pass ${pass}\n# fail 0\n# cancelled ${failOrCancel}\n`;
        assert.equal(enforce.isNonVacuousNodeTestPass(cancelled, 'neg.test.cjs'), false);
      },
    ));
  });

  test('eslintJsonHasRule / eslintHasFatalError FAIL-CLOSED on any non-JSON / non-array input', () => {
    const enforce = require(ENFORCEMENT_LIB);
    fc.assert(fc.property(fc.string(), (s) => {
      // Only exercise strings that are NOT a valid JSON array (the unreadable-report branch).
      let isArray = false;
      try { isArray = Array.isArray(JSON.parse(s)); } catch { isArray = false; }
      fc.pre(!isArray);
      assert.equal(enforce.eslintJsonHasRule(s, 'local/no-source-grep'), true, 'unreadable report -> violation (fail-closed)');
      assert.equal(enforce.eslintHasFatalError(s), true, 'unreadable report -> fatal (fail-closed)');
    }));
  });

  test('eslintFileResultCount never throws and is non-negative', () => {
    const enforce = require(ENFORCEMENT_LIB);
    fc.assert(fc.property(fc.string(), (s) => {
      const n = enforce.eslintFileResultCount(s);
      assert.ok(Number.isInteger(n) && n >= 0);
    }));
  });

  // ─── #1279 isNodeTestRed (FF-03 / FF-06) ───
  test('isNodeTestRed agrees with parseNodeTestSummary().fail >= 1 and never throws', () => {
    const enforce = require(ENFORCEMENT_LIB);
    fc.assert(fc.property(fc.string(), (s) => {
      const red = enforce.isNodeTestRed(s);
      assert.equal(red, enforce.parseNodeTestSummary(s).fail >= 1,
        'isNodeTestRed(s) === (parseNodeTestSummary(s).fail >= 1)');
    }));
  });

  // ─── #1279 proven-fail-first is NECESSARY for green (FF-08 necessity invariant) ───
  test('NO clean pass greens when the prover did not prove fail-first — proof is necessary for green (FF-08)', () => {
    const enforce = require(ENFORCEMENT_LIB);
    const TEST_TIER = Object.freeze({
      requirement_id: 'R1', category: 'safety', status: 'resolved', verification: 'test',
      resolution: null, reason: null, statement: 'MUST NOT do the forbidden thing',
    });
    fc.assert(fc.property(
      fc.constantFrom('node-test', 'lint-rule'),
      fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0),
      fc.boolean(),
      fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0),
      (kind, target, attest, rule) => {
        // ANY well-formed descriptor + a CLEAN pass + a prover that did NOT prove fail-first must
        // NEVER green, regardless of the caller's `failFirst` attestation. Proof is necessary for green.
        const descriptor = kind === 'lint-rule'
          ? { kind, target, rule, failFirst: attest }
          : { kind, target, failFirst: attest };
        const result = enforce.runProhibitionEnforcement(TEST_TIER, descriptor, {
          runCheck: () => ({ passed: true }),
          proveFailFirst: () => ({ provenFailFirst: false }),
        });
        assert.notEqual(result.status, 'green',
          'an un-proven-fail-first check must never green even on a clean pass (FF-08 necessity)');
      },
    ));
  });
});
