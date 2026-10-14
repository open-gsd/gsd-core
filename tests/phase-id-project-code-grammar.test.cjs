'use strict';

/**
 * One grammar for a `project_code` VALUE (#5271 Nit 2), shared with the evaluation-scope reader's
 * optional-prefix group and with the `#5177` workstream-qualified `<CODE>-<phase>-<plan>` id.
 *
 * The phase-id module owns the answer; every other surface reads it here rather than restating the
 * class, so `config-set`'s acceptance, the reader's re-validation and a pattern-building consumer
 * cannot drift apart (`RULESET.GENERATIVE-FIX`).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const phaseId = require('../gsd-core/bin/lib/phase-id.cjs');
const {
  PROJECT_CODE_VALUE_RE,
  PROJECT_CODE_VALUE_SOURCE,
  optionalProjectCodeGroupSource,
} = phaseId;

describe('phase-id: the ONE project_code grammar (#5271 Nit 2)', () => {
  test('the ERE source and the matcher accept exactly the same set', () => {
    const fromSource = new RegExp(`^${PROJECT_CODE_VALUE_SOURCE}$`);
    for (const code of ['PRJ', 'PROJ_V2', 'A', 'APP_CODE', 'X1']) {
      assert.ok(PROJECT_CODE_VALUE_RE.test(code), `${code} is a project code`);
      assert.ok(fromSource.test(code), `${code} is accepted by the ERE source too`);
    }
    for (const code of ['', 'prj', '_PRJ', '1PRJ', 'AUTH-X', 'PRJ-', 'PRJ X', 'PRJ\n']) {
      assert.ok(!PROJECT_CODE_VALUE_RE.test(code), `${JSON.stringify(code)} is not a project code`);
      assert.ok(!fromSource.test(code), `${JSON.stringify(code)} is rejected by the ERE source too`);
    }
  });

  test('[property] the two halves never disagree on a generated string', () => {
    const fromSource = new RegExp(`^${PROJECT_CODE_VALUE_SOURCE}$`);
    fc.assert(fc.property(fc.string(), (s) => {
      assert.equal(PROJECT_CODE_VALUE_RE.test(s), fromSource.test(s));
    }), { numRuns: 200 });
  });

  test('the grammar admits no ERE metacharacter, so the group needs no escaping', () => {
    fc.assert(fc.property(
      fc.stringMatching(/^[A-Z][A-Z0-9_]*$/),
      (code) => {
        assert.ok(optionalProjectCodeGroupSource(code) === `(${code}-)?`,
          `${code} interpolates into an ERE group verbatim`);
        assert.equal(code.search(/[.[\]{}()*+?^$|\\/-]/), -1,
          `${code} carries no ERE metacharacter`);
      },
    ), { numRuns: 200 });
  });

  test('a code outside the grammar binds no group at all (null, never a wider one)', () => {
    assert.equal(optionalProjectCodeGroupSource('prj'), null);
    assert.equal(optionalProjectCodeGroupSource('AUTH-X'), null);
    assert.equal(optionalProjectCodeGroupSource(''), null);
  });

  test('the group is a REAL POSIX-ERE capture group, never `(?:…)`', () => {
    // `git log --extended-regexp` compiles with POSIX ERE, which has no non-capturing group: a
    // `(?:…)` is a git-side syntax error while the JS-side `RegExp` stays green.
    const group = optionalProjectCodeGroupSource('PRJ');
    assert.equal(group, '(PRJ-)?');
    assert.ok(!group.startsWith('(?:'), 'no non-capturing group on the git side');
    assert.ok(new RegExp(`^${group}01-01$`).test('01-01'), 'the group really is optional');
  });

  test('the #5177 workstream-qualified shape resolves through the same grammar', () => {
    // `WS-01-01` and its bare spelling `01-01` are the SAME plan; the group is what makes the
    // reader accept both, so the workstream form rides the project's own code owner.
    const group = optionalProjectCodeGroupSource('WS');
    assert.equal(group, '(WS-)?');
    const re = new RegExp(`^${group}0*1-0*1$`);
    assert.ok(re.test('01-01'), 'the bare spelling resolves');
    assert.ok(re.test('WS-01-01'), 'the workstream-qualified spelling resolves');
  });
});