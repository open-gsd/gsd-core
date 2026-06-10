'use strict';
/**
 * bug-974-graphify-budget-missing-value.test.cjs
 *
 * Regression guard: `gsd-tools graphify query <term> --budget` with no value
 * following --budget must emit a USAGE error and exit non-zero.
 *
 * Bug: args[budgetIdx + 1] was undefined → parseInt(undefined, 10) → NaN.
 * NaN is falsy so the budget guard `if (options.budget)` silently skipped
 * trimming and the query ran unbounded with no warning. (#974)
 *
 * Test categories:
 *   1. BEHAVIORAL (recording mock) — direct routeGraphifyCommand call, no I/O
 *   2. SUBPROCESS — end-to-end via runGsdTools
 *   3. PROPERTY — budget arg parser: non-numeric/absent → usage error, valid int → passes
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');
const {
  enableGraphify,
  writeGraphJson,
  SAMPLE_GRAPH,
} = require('./helpers/graphify.cjs');
const fc = require('./helpers/fast-check-setup.cjs');

const { routeGraphifyCommand } = require('../gsd-core/bin/lib/graphify-command-router.cjs');

// ─── Recording-mock helpers (mirrors graphify-command-cutover.test.cjs) ────────

function makeGraphifyMock() {
  const calls = [];
  function recorder(name, ...fnArgs) {
    const sentinel = { _mock: name, args: fnArgs };
    calls.push(sentinel);
    return sentinel;
  }
  return {
    calls,
    mock: {
      graphifyQuery: (cwd, term, opts) => recorder('graphifyQuery', cwd, term, opts),
      graphifyStatus: (cwd) => recorder('graphifyStatus', cwd),
      graphifyDiff: (cwd) => recorder('graphifyDiff', cwd),
      graphifyBuild: (cwd) => recorder('graphifyBuild', cwd),
      writeSnapshot: (cwd) => recorder('writeSnapshot', cwd),
    },
  };
}

function makeErrorRecorder() {
  const calls = [];
  const fn = (msg, reason) => calls.push({ msg, reason });
  fn.calls = calls;
  return fn;
}

function runJsonErrors(args, tmpDir, env = {}) {
  const result = runGsdTools(args, tmpDir, { ...env, GSD_JSON_ERRORS: '1' });
  assert.strictEqual(result.success, false,
    `Expected failure with GSD_JSON_ERRORS=1 for args: ${args.join(' ')}\n` +
    `stdout: ${result.output}\nstderr: ${result.error}`);
  let parsed;
  try {
    parsed = JSON.parse(result.error);
  } catch (e) {
    throw new Error(
      `GSD_JSON_ERRORS=1 must emit valid JSON on stderr.\n` +
      `Args: ${args.join(' ')}\nstderr: ${result.error}\nparse error: ${e.message}`,
    );
  }
  return parsed;
}

function assertTypedError(parsed, expectedReason, label) {
  assert.strictEqual(parsed.ok, false, `${label}: error object must have ok: false`);
  assert.strictEqual(parsed.reason, expectedReason,
    `${label}: reason must be "${expectedReason}", got: ${parsed.reason}`);
  assert.ok(typeof parsed.message === 'string' && parsed.message.length > 0,
    `${label}: message must be a non-empty string`);
}

// ─── 1. BEHAVIORAL — direct routeGraphifyCommand (recording mock, no I/O) ─────

describe('bug #974: --budget missing value → usage error (unit, recording mock)', () => {
  const CWD = '/fake/cwd';
  const RAW = false;

  // (a) --budget as last arg (no value following)
  test('(a) --budget last arg (missing value) → error(USAGE); graphifyQuery NOT called', () => {
    const { calls, mock } = makeGraphifyMock();
    const errFn = makeErrorRecorder();
    routeGraphifyCommand({
      args: ['graphify', 'query', 'myterm', '--budget'],
      cwd: CWD, raw: RAW, error: errFn, _graphify: mock,
    });
    assert.strictEqual(errFn.calls.length, 1,
      `error must be called exactly once; got ${errFn.calls.length} calls`);
    assert.strictEqual(errFn.calls[0].reason, 'usage',
      `reason must be 'usage'; got: ${errFn.calls[0].reason}`);
    assert.ok(
      errFn.calls[0].msg.includes('graphify query'),
      `usage message must mention "graphify query"; got: ${errFn.calls[0].msg}`,
    );
    assert.strictEqual(calls.length, 0,
      'graphifyQuery must NOT be called when --budget has no value');
  });

  // (b) --budget with a non-numeric value
  test('(b) --budget foo (non-numeric value) → error(USAGE); graphifyQuery NOT called', () => {
    const { calls, mock } = makeGraphifyMock();
    const errFn = makeErrorRecorder();
    routeGraphifyCommand({
      args: ['graphify', 'query', 'myterm', '--budget', 'foo'],
      cwd: CWD, raw: RAW, error: errFn, _graphify: mock,
    });
    assert.strictEqual(errFn.calls.length, 1,
      `error must be called exactly once; got ${errFn.calls.length} calls`);
    assert.strictEqual(errFn.calls[0].reason, 'usage',
      `reason must be 'usage'; got: ${errFn.calls[0].reason}`);
    assert.strictEqual(calls.length, 0,
      'graphifyQuery must NOT be called when --budget value is non-numeric');
  });

  // (c) --budget 0 → 0 is a valid integer, must NOT error
  test('(c) --budget 0 (explicit zero) → budget passed as 0, no error', () => {
    const { calls, mock } = makeGraphifyMock();
    const errFn = makeErrorRecorder();
    routeGraphifyCommand({
      args: ['graphify', 'query', 'myterm', '--budget', '0'],
      cwd: CWD, raw: RAW, error: errFn, _graphify: mock,
    });
    assert.strictEqual(errFn.calls.length, 0,
      `error must NOT be called for --budget 0; got: ${JSON.stringify(errFn.calls)}`);
    assert.strictEqual(calls.length, 1,
      'graphifyQuery MUST be called for --budget 0');
    assert.strictEqual(calls[0]._mock, 'graphifyQuery');
    assert.strictEqual(calls[0].args[2].budget, 0,
      `budget must be 0, got: ${calls[0].args[2].budget}`);
  });

  // (d) valid --budget 500 → regression: still works after fix
  test('(d) --budget 500 (valid positive integer) → budget: 500, no error', () => {
    const { calls, mock } = makeGraphifyMock();
    const errFn = makeErrorRecorder();
    routeGraphifyCommand({
      args: ['graphify', 'query', 'myterm', '--budget', '500'],
      cwd: CWD, raw: RAW, error: errFn, _graphify: mock,
    });
    assert.strictEqual(errFn.calls.length, 0,
      `error must NOT be called for --budget 500; got: ${JSON.stringify(errFn.calls)}`);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0]._mock, 'graphifyQuery');
    assert.strictEqual(calls[0].args[2].budget, 500,
      `budget must be integer 500; got: ${calls[0].args[2].budget}`);
    assert.strictEqual(typeof calls[0].args[2].budget, 'number',
      'budget must be a number, not string');
  });

});

// ─── 2. SUBPROCESS — end-to-end via runGsdTools ───────────────────────────────

describe('bug #974: --budget missing value → usage error (subprocess)', () => {
  let tmpDir;
  let planningDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    planningDir = path.join(tmpDir, '.planning');
    enableGraphify(planningDir);
    writeGraphJson(planningDir, SAMPLE_GRAPH);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('subprocess: --budget last arg → non-zero exit', () => {
    const result = runGsdTools(
      ['graphify', 'query', 'AuthService', '--budget'],
      tmpDir,
    );
    assert.strictEqual(result.success, false,
      `--budget with no value must exit non-zero; stderr: ${result.error}`);
  });

  test('subprocess: --budget last arg → stderr contains usage hint', () => {
    const result = runGsdTools(
      ['graphify', 'query', 'AuthService', '--budget'],
      tmpDir,
    );
    assert.ok(
      result.error.includes('Usage') || result.error.includes('graphify query'),
      `stderr must contain usage hint; got: ${result.error}`,
    );
  });

  test('subprocess: --budget foo (non-numeric) → non-zero exit', () => {
    const result = runGsdTools(
      ['graphify', 'query', 'AuthService', '--budget', 'foo'],
      tmpDir,
    );
    assert.strictEqual(result.success, false,
      `--budget with non-numeric value must exit non-zero; stderr: ${result.error}`);
  });

  test('subprocess: --budget last arg → GSD_JSON_ERRORS=1 → usage reason', () => {
    const parsed = runJsonErrors(
      ['graphify', 'query', 'AuthService', '--budget'],
      tmpDir,
    );
    assertTypedError(parsed, 'usage', '--budget missing value json-error');
    assert.ok(
      parsed.message.includes('graphify query'),
      `message must include "graphify query"; got: ${parsed.message}`,
    );
  });

  test('subprocess: --budget foo → GSD_JSON_ERRORS=1 → usage reason', () => {
    const parsed = runJsonErrors(
      ['graphify', 'query', 'AuthService', '--budget', 'foo'],
      tmpDir,
    );
    assertTypedError(parsed, 'usage', '--budget non-numeric json-error');
  });

  // Regression: valid --budget still works after the fix
  test('subprocess: --budget 500 (valid) → success, term echoed', () => {
    const result = runGsdTools(
      ['graphify', 'query', 'AuthService', '--budget', '500'],
      tmpDir,
    );
    assert.ok(result.success,
      `--budget 500 must still succeed after fix; error: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.term, 'AuthService',
      'term must be echoed in query response');
    assert.ok('nodes' in parsed, 'response must include nodes array');
    assert.ok('total_nodes' in parsed, 'response must include total_nodes field');
  });
});

// ─── 3. PROPERTY — budget parse: non-numeric/absent → usage error, valid int → passes
//    Per RULESET.TESTS.property-based-testing: parsing/budget-limit modules
//    must include ≥1 fast-check property test.

describe('bug #974: budget arg parser property tests', () => {
  const CWD = '/fake/cwd';
  const RAW = false;

  // Property (a): any non-numeric, non-parseable string for --budget → usage error
  test('property: non-numeric --budget value always produces usage error', () => {
    fc.assert(
      fc.property(
        // Strings where parseInt returns NaN: no leading digit, no sign+digit
        fc.oneof(
          // Alphabetic-start strings (parseInt('abc') = NaN)
          fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_-]{0,20}$/),
          // Empty string (parseInt('') = NaN)
          fc.constant(''),
          // Strings starting with special chars
          fc.stringMatching(/^[!@#$%^&*()_+={}\][|\\:;"'<,>?/~`][^\s]{0,10}$/),
        ),
        (badValue) => {
          // Verify parseInt actually yields NaN for the generated value (sanity guard)
          const parsed = parseInt(badValue, 10);
          // Only proceed with values that are genuinely NaN to parseInt
          if (!Number.isNaN(parsed)) return; // skip — the shrinker may produce digit-leading strings

          const { mock } = makeGraphifyMock();
          const errFn = makeErrorRecorder();
          routeGraphifyCommand({
            args: ['graphify', 'query', 'myterm', '--budget', badValue],
            cwd: CWD, raw: RAW, error: errFn, _graphify: mock,
          });
          assert.strictEqual(errFn.calls.length, 1,
            `--budget "${badValue}" (NaN) must produce exactly one error call`);
          assert.strictEqual(errFn.calls[0].reason, 'usage',
            `--budget "${badValue}" error must have reason 'usage'; got: ${errFn.calls[0].reason}`);
        },
      ),
    );
  });

  // Property (b): missing --budget value (last arg) → usage error
  test('property: --budget as last arg always produces usage error', () => {
    // We can't parameterize the "missing" case further, but we can verify
    // that any prefix of args with --budget terminal → error
    const { mock } = makeGraphifyMock();
    const errFn = makeErrorRecorder();
    routeGraphifyCommand({
      args: ['graphify', 'query', 'someterm', '--budget'],
      cwd: CWD, raw: RAW, error: errFn, _graphify: mock,
    });
    assert.strictEqual(errFn.calls.length, 1,
      'missing --budget value must always produce exactly one error call');
    assert.strictEqual(errFn.calls[0].reason, 'usage');
  });

  // Property (c): valid positive integer strings → budget passed through as number, no error
  test('property: positive integer string for --budget is always accepted', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000_000 }),
        (n) => {
          const { calls, mock } = makeGraphifyMock();
          const errFn = makeErrorRecorder();
          routeGraphifyCommand({
            args: ['graphify', 'query', 'myterm', '--budget', String(n)],
            cwd: CWD, raw: RAW, error: errFn, _graphify: mock,
          });
          assert.strictEqual(errFn.calls.length, 0,
            `--budget ${n} (valid positive integer) must not produce an error`);
          assert.strictEqual(calls.length, 1, 'graphifyQuery must be called');
          assert.strictEqual(calls[0].args[2].budget, n,
            `budget must equal ${n}; got: ${calls[0].args[2].budget}`);
          assert.strictEqual(typeof calls[0].args[2].budget, 'number',
            `budget must be a number, not string "${calls[0].args[2].budget}"`);
        },
      ),
    );
  });

  // Property (d): budget: null when --budget flag absent → always no error
  test('property: absence of --budget flag yields budget:null and no error', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 30 }).filter(s => !s.startsWith('--')),
        (term) => {
          const { calls, mock } = makeGraphifyMock();
          const errFn = makeErrorRecorder();
          routeGraphifyCommand({
            args: ['graphify', 'query', term],
            cwd: CWD, raw: RAW, error: errFn, _graphify: mock,
          });
          assert.strictEqual(errFn.calls.length, 0,
            `no --budget flag must not produce an error for term "${term}"`);
          if (calls.length > 0) {
            assert.strictEqual(calls[0].args[2].budget, null,
              `absent --budget must pass budget:null; got: ${calls[0].args[2].budget}`);
          }
        },
      ),
    );
  });
});
