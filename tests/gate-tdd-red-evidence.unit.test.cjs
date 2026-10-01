'use strict';

/**
 * U6 — in-process GateVerdict tests for `check tdd-red-evidence` (#5139, epic #5056, ADR-5057 §4).
 *
 * FAILING-FIRST (RED): `gsd-core/bin/lib/gate-tdd-red-evidence.cjs` does not exist yet, so this file
 * fails at require time on origin/next. The module must export
 * `evaluateTddRedEvidence({ projectDir, args })` where `args` is the argv AFTER the verb, returning a
 * GateVerdict ({ outcome, block, payload }) for every arm that prints a payload today and a
 * GateUsageFailure ({ failure: { code, message } }) for every arm that calls `error()` today.
 *
 * Every payload below was captured by EXECUTING the pre-move router (`gsd-tools check tdd-red-evidence`)
 * on origin/next in a fixture project; the tests compare the deep value AND the serialized key
 * order (stdout is byte-identical only if the payload's insertion order is preserved).
 * `outcome`/`block` are the new GateVerdict fields; their mapping from today's payload is
 * recorded per case (see 50-test-matrix.md, API contract).
 *
 * U6c and U6d were re-captured after the format-adapter classifier (#4692): their records carry
 * complete Node TAP (plan and YAML diagnostic block) because the TAP adapter rejects a bare
 * indented `error:` line as non-TAP data, and `evidence` gains `matched_test`, `format` and
 * `report_errors`. Verdicts and reasons are unchanged.
 *
 * Each case also asserts the gate never writes to process.stdout / process.stderr: only the
 * router formats output (design D2).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempProject, cleanup } = require('./helpers.cjs');
const { tempRootAliases, canonicalizeTempPaths } = require('./helpers/path-compare.cjs');

const gate = require('../gsd-core/bin/lib/gate-tdd-red-evidence.cjs');
const { isGateUsageFailure } = require('../gsd-core/bin/lib/gate-verdict.cjs');

function w(dir, rel, content) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

const h = { w };

const CASES = [
  {
    id: 'U6a',
    title: 'record file absent -> unreadable_record, INVALID_RED, blocks',
    args(dir) { return [dir + '/red.json']; },
    outcome: 'block',
    block: true,
    expected(dir) {
      return {
        passed: false,
        block: true,
        verdict: 'INVALID_RED',
        reason: 'unreadable_record',
        record: `${dir}/red.json`,
        readError: `record not found or unreadable: ${dir}/red.json`,
      };
    },
  },
  {
    id: 'U6b',
    title: 'record is not valid JSON -> unreadable_record naming the parse failure',
    setup(dir, h) {
      h.w(dir, 'red.json', '{not json');
    },
    args(dir) { return [dir + '/red.json']; },
    outcome: 'block',
    block: true,
    expected(dir) {
      return {
        passed: false,
        block: true,
        verdict: 'INVALID_RED',
        reason: 'unreadable_record',
        record: `${dir}/red.json`,
        readError: `record is not valid JSON: ${dir}/red.json`,
      };
    },
  },
  {
    id: 'U6c',
    title: 'unexpected green (exit 0) -> INVALID_RED blocks GREEN',
    setup(dir, h) {
      h.w(dir, 'red.json', JSON.stringify({ command: 'node --test t.test.cjs', exitCode: 0, output: 'TAP version 13\n# Subtest: target\nok 1 - target\n  ---\n  duration_ms: 0.41\n  type: \'test\'\n  ...\n1..1\n# tests 1\n# suites 0\n# pass 1\n# fail 0\n', targetTest: 'target', targetFile: 't.test.cjs' }));
    },
    args(dir) { return [dir + '/red.json']; },
    outcome: 'block',
    block: true,
    expected() {
      return {
        passed: false,
        block: true,
        verdict: 'INVALID_RED',
        reason: 'unexpected_green',
        evidence: {
          command: 'node --test t.test.cjs',
          exit_code: 0,
          target_test: 'target',
          tests: 1,
          pass: 1,
          fail: 0,
          failing_tests: [],
          matched_test: null,
          format: 'tap',
          report_errors: [],
        },
        record: {
          command: 'node --test t.test.cjs',
          exit_code: 0,
          failing_test: null,
          target_test: 'target',
          expected: null,
          actual: null,
          verdict: 'INVALID_RED',
          reason: 'unexpected_green',
        },
        message: 'INVALID_RED (unexpected_green): GREEN blocked. Fix the RED phase — only an intentional failure of target test "target" authorizes production edits.',
      };
    },
  },
  {
    id: 'U6d',
    title: 'intentional failure of the target test -> RED_EVIDENCE_OK authorizes GREEN',
    setup(dir, h) {
      h.w(dir, 'red.json', JSON.stringify({ command: 'node --test t.test.cjs', exitCode: 1, output: 'TAP version 13\n# Subtest: target\nnot ok 1 - target\n  ---\n  duration_ms: 0.97\n  type: \'test\'\n  failureType: \'testCodeFailure\'\n  error: \'expected 1 to equal 2\'\n  code: \'ERR_ASSERTION\'\n  ...\n1..1\n# tests 1\n# suites 0\n# pass 0\n# fail 1\n', targetTest: 'target', targetFile: 't.test.cjs', expected: '2', actual: '1' }));
    },
    args(dir) { return [dir + '/red.json']; },
    outcome: 'pass',
    block: false,
    expected() {
      return {
        passed: true,
        block: false,
        verdict: 'RED_EVIDENCE_OK',
        reason: 'target_test_failed',
        evidence: {
          command: 'node --test t.test.cjs',
          exit_code: 1,
          target_test: 'target',
          tests: 1,
          pass: 0,
          fail: 1,
          failing_tests: [
            'target',
          ],
          matched_test: 'target',
          format: 'tap',
          report_errors: [],
        },
        record: {
          command: 'node --test t.test.cjs',
          exit_code: 1,
          failing_test: 'target',
          target_test: 'target',
          expected: '2',
          actual: '1',
          verdict: 'RED_EVIDENCE_OK',
          reason: 'target_test_failed',
        },
        message: 'RED evidence verified: target test "target" failed as expected (exit 1). GREEN authorized.',
      };
    },
  },
  {
    id: 'U6e',
    title: 'missing record path is a usage failure',
    args() { return []; },
    usage: { code: 'sdk_missing_arg', message: 'tdd-red-evidence requires a record path: check tdd-red-evidence <record.json>' },
  },
];

function run(c) {
  const dir = createTempProject('gate-u6-');
  const real = fs.realpathSync(dir);
  const aliases = tempRootAliases(dir);
  const writes = [];
  const outWrite = process.stdout.write;
  const errWrite = process.stderr.write;
  let restore;
  let result;
  try {
    restore = c.setup ? c.setup(dir, h) : undefined;
    process.stdout.write = (chunk) => {
      writes.push({ stream: 'stdout', chunk: String(chunk) });
      return true;
    };
    process.stderr.write = (chunk) => {
      writes.push({ stream: 'stderr', chunk: String(chunk) });
      return true;
    };
    result = gate.evaluateTddRedEvidence({ projectDir: dir, args: c.args(dir) });
  } finally {
    process.stdout.write = outWrite;
    process.stderr.write = errWrite;
    if (typeof restore === 'function') restore();
    cleanup(dir);
  }
  return { result, writes, dir, real, aliases };
}

describe('U6 evaluateTddRedEvidence', () => {
  for (const c of CASES) {
    test(`${c.id}: ${c.title}`, () => {
      const { result, writes, dir, real, aliases } = run(c);
      const unexpected = writes.filter(
        (w) => !(c.stderrPrefix && w.stream === 'stderr' && w.chunk.startsWith(c.stderrPrefix)),
      );
      assert.deepStrictEqual(unexpected, [], 'a gate module must not write to stdout/stderr');
      if (c.usage) {
        assert.equal(isGateUsageFailure(result), true);
        assert.deepStrictEqual(result, { failure: { code: c.usage.code, message: c.usage.message } });
        return;
      }
      assert.equal(isGateUsageFailure(result), false);
      assert.equal(result.outcome, c.outcome);
      assert.equal(result.block, c.block);
      const expected = canonicalizeTempPaths(c.expected(dir, real), aliases);
      const actual = canonicalizeTempPaths(result.payload, aliases);
      assert.deepStrictEqual(actual, expected);
      assert.equal(JSON.stringify(actual), JSON.stringify(expected), 'payload key order is part of the contract');
    });
  }
});
