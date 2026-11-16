'use strict';

/**
 * #6213: the dispatch-isolation record names the plan's executor (`executor_type`, ADR-4630 record).
 * `record-dispatch-isolation` takes an explicit `--executor-type`; `dispatch-isolation` derives the
 * executor from the plan itself (tests/dispatch-isolation-derived-executor.test.cjs) and declares no
 * such flag, so neither it nor the inspection verb accepts one. The writer-side and reader-side
 * validators accept exactly the same strings.
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('fast-check');

const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const sentinelLib = require('../hooks/lib/isolation-sentinel.js');
const writerLib = require('../gsd-core/bin/lib/executor-type.cjs');

const TOOLS = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');
const HINTED = 'acme-rails-executor';
const LEGACY = path.join('.gsd', 'dispatch-isolation-sentinel.json');
const KEYED = path.join('.gsd', 'dispatch-isolation', '02--02-01-api.json');
const GRAMMAR = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const WRITTEN_AT = 1_000_000;
const NOW_ENV = { GSD_TEST_MODE: '1', GSD_NOW_MS: String(WRITTEN_AT) };

function readRecord(root, rel) {
  return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf-8'));
}

function recordIsolation(dir, executorType) {
  const args = ['record-dispatch-isolation', '--isolation', 'harness-worktree', '--harness-flag=isolation="worktree"', '--phase', '02', '--plan', '02-01-api'];
  if (executorType !== undefined) args.push('--executor-type', executorType);
  return runGsdTools(args, dir, NOW_ENV);
}

describe('#6213 the dispatch-isolation record carries executor_type', () => {
  let root;
  before(() => { root = createTempProject('gsd-hinted-exec-record-'); });
  after(() => { cleanup(root); });

  test('dispatch-isolation for a plan with no hint records gsd-executor in the legacy and the keyed record', () => {
    const r = runGsdTools(['dispatch-isolation', '--raw', '--phase', '02', '--plan', '02-01-api'], root, NOW_ENV);
    assert.ok(r.success, r.error);
    assert.strictEqual(readRecord(root, LEGACY).executor_type, 'gsd-executor', 'legacy slot');
    assert.strictEqual(readRecord(root, KEYED).executor_type, 'gsd-executor', 'keyed record');
  });

  test('dispatch-isolation and inspect-dispatch-isolation declare no --executor-type', () => {
    for (const verb of ['dispatch-isolation', 'inspect-dispatch-isolation']) {
      const r = runGsdTools([verb, '--raw', '--executor-type', HINTED], root, NOW_ENV);
      assert.notStrictEqual(r.exitCode, 0, verb);
      assert.match(`${r.output}\n${r.error}`, /unknown flag "--executor-type"/, verb);
    }
  });

  test('record-dispatch-isolation --executor-type lands in the record', () => {
    const r = recordIsolation(root, HINTED);
    assert.ok(r.success, r.error);
    assert.deepStrictEqual(JSON.parse(r.output), { recorded: true, path: '.gsd/dispatch-isolation-sentinel.json' });
    assert.strictEqual(readRecord(root, LEGACY).executor_type, HINTED, 'legacy slot');
    assert.strictEqual(readRecord(root, KEYED).executor_type, HINTED, 'keyed record');
  });

  test('record-dispatch-isolation refuses a GSD non-executor role as --executor-type: null record, stderr warning; acme-x still lands', () => {
    for (const role of ['gsd-verifier', ' GSD-Planner ']) {
      // runGsdTools drops stderr on a zero exit, so spawn the CLI directly to read the warning.
      const r = runNode([TOOLS, 'record-dispatch-isolation', '--isolation', 'harness-worktree', '--harness-flag=isolation="worktree"', '--phase', '02', '--plan', '02-01-api', '--executor-type', role], { cwd: root, env: { ...process.env, ...NOW_ENV }, timeoutMs: PROBE_TIMEOUT_MS });
      assert.strictEqual(r.exitCode, 0, `${role}: ${r.stderr}`);
      assert.strictEqual(JSON.parse(r.stdout).recorded, true, role);
      assert.strictEqual(readRecord(root, LEGACY).executor_type, null, `legacy ${role}`);
      assert.strictEqual(readRecord(root, KEYED).executor_type, null, `keyed ${role}`);
      assert.ok(r.stderr.includes(`"${role.trim()}"`), `stderr names ${role}: ${r.stderr}`);
      assert.ok(r.stderr.includes('recording no executor'), `stderr says recording no executor: ${r.stderr}`);
      assert.ok(!r.stderr.includes('dispatching'), `stderr does not claim a dispatch: ${r.stderr}`);
    }
    const ok = recordIsolation(root, 'acme-x');
    assert.ok(ok.success, ok.error);
    assert.strictEqual(readRecord(root, LEGACY).executor_type, 'acme-x');
    assert.strictEqual(readRecord(root, KEYED).executor_type, 'acme-x');
  });

  test('omitting --executor-type on the explicit verb records null; dispatch-isolation stdout is unchanged', () => {
    const r = recordIsolation(root);
    assert.ok(r.success, r.error);
    assert.deepStrictEqual(JSON.parse(r.output), { recorded: true, path: '.gsd/dispatch-isolation-sentinel.json' });
    assert.strictEqual(readRecord(root, LEGACY).executor_type, null);
    assert.strictEqual(readRecord(root, KEYED).executor_type, null);
    const q = runGsdTools(['dispatch-isolation', '--raw', '--phase', '02', '--plan', '02-01-api'], root, NOW_ENV);
    assert.ok(q.success, q.error);
    assert.ok(['harness-worktree', 'orchestrator-worktree', 'none'].includes(q.output), `stdout is the bare isolation mode: ${q.output}`);
    assert.strictEqual(readRecord(root, LEGACY).executor_type, 'gsd-executor', 'the query derives its own executor');
  });

  test('an invalid --executor-type is recorded as null and the call still succeeds', () => {
    for (const bad of ['../x', 'a/b', 'a..b', 'a\\b']) {
      const r = recordIsolation(root, bad);
      assert.strictEqual(r.exitCode, 0, `${bad}: ${r.error}`);
      assert.strictEqual(JSON.parse(r.output).recorded, true, bad);
      assert.strictEqual(readRecord(root, LEGACY).executor_type, null, `legacy ${bad}`);
      assert.strictEqual(readRecord(root, KEYED).executor_type, null, `keyed ${bad}`);
    }
  });

  test('length boundary: 127 and 128 characters are recorded, 129 is not', () => {
    const at = `a${'b'.repeat(127)}`;
    for (const [value, expected] of [[at.slice(0, -1), at.slice(0, -1)], [at, at], [`${at}b`, null]]) {
      const r = recordIsolation(root, value);
      assert.ok(r.success, r.error);
      assert.strictEqual(readRecord(root, LEGACY).executor_type, expected, `length ${value.length}`);
    }
  });
});

describe('#6213 the writer-side and reader-side validators agree', () => {
  const candidate = fc.oneof(
    fc.stringMatching(GRAMMAR),
    fc.string({ maxLength: 140 }),
    fc.constantFrom('..', 'a..b', '-a', 'a/b', 'a\\b', '', 'a'.repeat(128), 'a'.repeat(129), 'a.b-c_d'),
    fc.anything(),
  );
  const expected = (v) => typeof v === 'string' && GRAMMAR.test(v) && !v.includes('..');

  test('property: both validators accept exactly the grammar without ".."', () => {
    fc.assert(fc.property(candidate, (v) => {
      assert.strictEqual(sentinelLib.isValidExecutorType(v), expected(v));
      assert.strictEqual(writerLib.isValidExecutorType(v), expected(v));
    }), { numRuns: 400 });
  });

  test('property: a record round-trips every accepted value and drops every rejected one', () => {
    const dir = createTempProject('gsd-hinted-exec-roundtrip-');
    try {
      const file = path.join(dir, LEGACY);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const clock = { now: () => WRITTEN_AT + 1000 };
      fc.assert(fc.property(candidate, (v) => {
        fs.writeFileSync(file, JSON.stringify({ isolation: 'harness-worktree', harness_flag: 'isolation="worktree"', phase: '02', plan: '02-01-api', written_at: WRITTEN_AT, executor_type: v }));
        const read = sentinelLib.readSentinel(dir, { clock });
        assert.strictEqual(read.malformed, false, 'an invalid executor_type never makes the record malformed');
        assert.strictEqual(read.executorType, expected(v) ? v : null);
      }), { numRuns: 60 });
    } finally {
      cleanup(dir);
    }
  });

  test('property: executor_types follows the same rule on both sides (valid entries only, sorted, de-duplicated, at most 64)', () => {
    const dir = createTempProject('gsd-hinted-exec-types-roundtrip-');
    try {
      const file = path.join(dir, LEGACY);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const clock = { now: () => WRITTEN_AT + 1000 };
      const list = fc.oneof(
        fc.array(candidate, { maxLength: 70 }),
        fc.array(fc.stringMatching(/^[a-z][a-z0-9-]{0,6}$/), { maxLength: 70 }),
        fc.array(fc.stringMatching(/^[a-z][a-z0-9-]{3,12}$/), { minLength: 60, maxLength: 70 }),
        fc.anything(),
      );
      fc.assert(fc.property(list, (v) => {
        const written = writerLib.normalizeExecutorTypes(v);
        assert.ok(written.length <= writerLib.MAX_EXECUTOR_TYPES);
        assert.ok(written.every((t) => expected(t)));
        assert.deepStrictEqual(written, [...new Set(written)].sort());
        assert.strictEqual(writerLib.MAX_EXECUTOR_TYPES, sentinelLib.MAX_EXECUTOR_TYPES);
        fs.writeFileSync(file, JSON.stringify({ isolation: 'harness-worktree', harness_flag: 'isolation="worktree"', phase: '02', plan: null, written_at: WRITTEN_AT, executor_types: v }));
        const read = sentinelLib.readSentinel(dir, { clock });
        assert.strictEqual(read.malformed, false);
        const rawValid = Array.isArray(v) ? v.filter(expected).slice(0, sentinelLib.MAX_EXECUTOR_TYPES) : [];
        assert.deepStrictEqual(read.executorTypes, rawValid, 'the reader keeps the first 64 valid entries');
        // A writer-produced list round-trips unchanged.
        fs.writeFileSync(file, JSON.stringify({ isolation: 'harness-worktree', harness_flag: 'isolation="worktree"', phase: '02', plan: null, written_at: WRITTEN_AT, executor_types: written }));
        assert.deepStrictEqual(sentinelLib.readSentinel(dir, { clock }).executorTypes, written);
      }), { numRuns: 80 });
    } finally {
      cleanup(dir);
    }
  });
});
