'use strict';

/**
 * U8 — in-process GateVerdict tests for `check verify-failure-directions` (#5139, epic #5056, ADR-5057 §4).
 *
 * FAILING-FIRST (RED): `gsd-core/bin/lib/gate-verify-failure-directions.cjs` does not exist yet, so this file
 * fails at require time on origin/next. The module must export
 * `evaluateVerifyFailureDirections({ projectDir, args })` where `args` is the argv AFTER the verb, returning a
 * GateVerdict ({ outcome, block, payload }) for every arm that prints a payload today and a
 * GateUsageFailure ({ failure: { code, message } }) for every arm that calls `error()` today.
 *
 * Every payload below was captured by EXECUTING the pre-move router (`gsd-tools check verify-failure-directions`)
 * on origin/next in a fixture project; the tests compare the deep value AND the serialized key
 * order (stdout is byte-identical only if the payload's insertion order is preserved).
 * `outcome`/`block` are the new GateVerdict fields; their mapping from today's payload is
 * recorded per case (see 50-test-matrix.md, API contract).
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

const gate = require('../gsd-core/bin/lib/gate-verify-failure-directions.cjs');
const { isGateUsageFailure } = require('../gsd-core/bin/lib/gate-verdict.cjs');

function w(dir, rel, content) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function failsWhenPlan(parts) {
  return ['# Plan', '', '<task type="auto">', '  <name>task-0</name>', '  <action>do the thing</action>']
    .concat(
      parts.map((p) =>
        'automated' in p
          ? '  <verify><automated>' + p.automated + '</automated></verify>'
          : '  <fails_when>' + p.failsWhen + '</fails_when>',
      ),
    )
    .concat(['  <done>committed</done>', '</task>'])
    .join('\n');
}

const h = { w, failsWhenPlan };

const CASES = [
  {
    id: 'U8a',
    title: 'no phase argument -> unresolvable degraded payload',
    args() { return []; },
    outcome: 'unreadable',
    block: false,
    expected() {
      return {
        status: 'unresolvable',
        commands: [],
        counts: {
          blocker: 0,
          warning: 0,
          total: 0,
        },
        readError: 'verify-failure-directions requires a phase argument: check verify-failure-directions <phase>',
      };
    },
  },
  {
    id: 'U8b',
    title: 'phase that cannot be resolved -> unresolvable degraded payload',
    args() { return ['99']; },
    outcome: 'unreadable',
    block: false,
    expected() {
      return {
        status: 'unresolvable',
        commands: [],
        counts: {
          blocker: 0,
          warning: 0,
          total: 0,
        },
        readError: 'could not resolve phase directory for phase 99',
      };
    },
  },
  {
    id: 'U8c',
    title: 'every command states its failing direction -> ok passthrough',
    setup(dir, h) {
      h.w(dir, '.planning/phases/01-x/01-01-PLAN.md', h.failsWhenPlan([{ automated: 'npm test' }, { failsWhen: 'non-zero exit' }]));
    },
    args() { return ['1']; },
    outcome: 'pass',
    block: false,
    expected() {
      return {
        status: 'ok',
        commands: [
          {
            command: 'npm test',
            statement: 'non-zero exit',
            status: 'ok',
            severity: 'none',
            plan: '01-01-PLAN.md',
            task: 'task-0',
          },
        ],
        counts: {
          blocker: 0,
          warning: 0,
          total: 1,
        },
        readError: null,
      };
    },
  },
  {
    id: 'U8d',
    title: 'a command with no stated failing direction -> blocked passthrough',
    setup(dir, h) {
      h.w(dir, '.planning/phases/01-x/01-01-PLAN.md', h.failsWhenPlan([{ automated: 'npm test' }]));
    },
    args() { return ['1']; },
    outcome: 'block',
    block: true,
    expected() {
      return {
        status: 'blocked',
        commands: [
          {
            command: 'npm test',
            statement: null,
            status: 'missing',
            severity: 'blocker',
            plan: '01-01-PLAN.md',
            task: 'task-0',
          },
        ],
        counts: {
          blocker: 1,
          warning: 0,
          total: 1,
        },
        readError: null,
      };
    },
  },
];

function run(c) {
  const dir = createTempProject('gate-u8-');
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
    result = gate.evaluateVerifyFailureDirections({ projectDir: dir, args: c.args(dir) });
  } finally {
    process.stdout.write = outWrite;
    process.stderr.write = errWrite;
    if (typeof restore === 'function') restore();
    cleanup(dir);
  }
  return { result, writes, dir, real, aliases };
}

describe('U8 evaluateVerifyFailureDirections', () => {
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
