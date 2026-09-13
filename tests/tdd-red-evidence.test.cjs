'use strict';

/**
 * RED-evidence classification for `type: tdd` plans (#3770).
 *
 * Module: gsd-core/bin/lib/tdd-red-evidence.cjs (compiled from src/tdd-red-evidence.cts)
 * Router: `check tdd-red-evidence <record.json>` in check-command-router.cjs
 *
 * #3770: the TDD executor accepted ANY nonzero test command as RED. Syntax
 * errors, zero-test discovery, fixture crashes, parser errors, and unrelated
 * assertions all authorized production edits (GREEN). Only an intentional
 * failure of the TARGET test for the planned behavior may advance to GREEN;
 * every other nonzero outcome is INVALID_RED.
 *
 * Row numbers map to .gsd/bug/fix-3770-tdd-red-evidence/50-test-matrix.md.
 * TAP fixtures below are captured verbatim from `node --test --test-reporter tap`
 * (Node v26) for each failure class.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { cleanup, runGsdTools } = require('./helpers.cjs');
const {
  classifyRedEvidence,
  buildRedEvidenceRecord,
} = require('../gsd-core/bin/lib/tdd-red-evidence.cjs');

// ─── TAP fixtures (captured from node --test --test-reporter tap) ─────────────

/** Row 1: intentional target failure — `not ok 1 - rejects empty email`, # fail 1, exit 1. */
const TARGET_FAILURE_TAP = [
  'TAP version 13',
  '# Subtest: rejects empty email',
  'not ok 1 - rejects empty email',
  '  ---',
  '  duration_ms: 1.15',
  "  error: 'Expected values to be strictly equal. 1 !== 2'",
  "  code: 'ERR_ASSERTION'",
  '  ...',
  '1..1',
  '# tests 1',
  '# suites 0',
  '# pass 0',
  '# fail 1',
  '# cancelled 0',
  '# skipped 0',
  '# todo 0',
  '# duration_ms 46.8',
  '',
].join('\n');

/** Rows 2: zero-test discovery — discovery matched zero tests, harness exits nonzero. */
const ZERO_TESTS_TAP = [
  'TAP version 13',
  '1..0',
  '# tests 0',
  '# suites 0',
  '# pass 0',
  '# fail 0',
  '# cancelled 0',
  '# skipped 0',
  '# todo 0',
  '# duration_ms 3.1',
  '',
].join('\n');

/** Row 3: fixture crash / load throw — the failure is FILE-NAMED, not the target test. */
const FIXTURE_CRASH_TAP = [
  'TAP version 13',
  '# Subtest: crash.test.cjs',
  'not ok 1 - crash.test.cjs',
  '  ---',
  '  duration_ms: 28.3',
  "  type: 'test'",
  '  location: \'crash.test.cjs:1:1\'',
  "  failureType: 'testCodeFailure'",
  '  exitCode: 1',
  "  error: 'test failed'",
  "  code: 'ERR_TEST_FAILURE'",
  '  ...',
  '1..1',
  '# tests 1',
  '# suites 0',
  '# pass 0',
  '# fail 1',
  '# cancelled 0',
  '# skipped 0',
  '# todo 0',
  '# duration_ms 28.3',
  '',
].join('\n');

/** Row 6: an unrelated test fails — a real assertion, but not the target test. */
const UNRELATED_FAILURE_TAP = TARGET_FAILURE_TAP.replaceAll(
  'rejects empty email',
  'unrelated legacy behavior',
);

function validRedInput(overrides = {}) {
  return {
    command: 'node --test tests/email.test.cjs',
    exitCode: 1,
    output: TARGET_FAILURE_TAP,
    targetTest: 'rejects empty email',
    targetFile: 'tests/email.test.cjs',
    expected: 'ValidationError for empty input',
    actual: '1 !== 2',
    ...overrides,
  };
}

// ─── Pure classifier (#3770 regression rows) ─────────────────────────────────

describe('classifyRedEvidence (#3770)', () => {
  test('row 1 — classifyRedEvidence accepts intentional target failure', () => {
    const result = classifyRedEvidence(validRedInput());
    assert.equal(result.verdict, 'RED_EVIDENCE_OK', 'an intentional target failure is the only valid RED');
    assert.equal(result.reason, 'target_test_failed');
    assert.equal(result.evidence.failing_tests[0], 'rejects empty email');
    assert.equal(result.evidence.exit_code, 1);
  });

  test('row 2 — classifyRedEvidence rejects zero-test discovery', () => {
    const result = classifyRedEvidence(validRedInput({ output: ZERO_TESTS_TAP }));
    assert.equal(result.verdict, 'INVALID_RED');
    assert.equal(result.reason, 'zero_tests_discovered');
  });

  test('row 3 — classifyRedEvidence rejects fixture crash', () => {
    const result = classifyRedEvidence(
      validRedInput({ output: FIXTURE_CRASH_TAP, targetFile: 'tests/crash.test.cjs' }),
    );
    assert.equal(result.verdict, 'INVALID_RED');
    assert.equal(result.reason, 'fixture_or_load_failure');
  });

  test('row 4 — classifyRedEvidence rejects nonzero exit without a failing test', () => {
    const result = classifyRedEvidence(validRedInput({ output: TARGET_FAILURE_TAP.replace('# fail 1', '# fail 0') }));
    assert.equal(result.verdict, 'INVALID_RED');
    assert.equal(result.reason, 'nonzero_exit_without_test_failure');
  });

  test('row 5 — classifyRedEvidence rejects unexpected green', () => {
    const result = classifyRedEvidence(validRedInput({ exitCode: 0 }));
    assert.equal(result.verdict, 'INVALID_RED');
    assert.equal(result.reason, 'unexpected_green');
  });

  test('row 6 — classifyRedEvidence rejects unrelated failing test', () => {
    const result = classifyRedEvidence(validRedInput({ output: UNRELATED_FAILURE_TAP }));
    assert.equal(result.verdict, 'INVALID_RED');
    assert.equal(result.reason, 'no_target_test_failure');
  });

  test('fail-closed — malformed record fields are INVALID_RED, never a crash', () => {
    const result = classifyRedEvidence({ command: null, exitCode: '1', output: 42, targetTest: '' });
    assert.equal(result.verdict, 'INVALID_RED');
    assert.equal(result.reason, 'invalid_record');
  });
});

// ─── Persisted record (acceptance: command, exit code, failing test, expected, actual) ──

describe('buildRedEvidenceRecord (#3770)', () => {
  test('row 7 — buildRedEvidenceRecord persists the RED evidence fields', () => {
    const input = validRedInput();
    const result = classifyRedEvidence(input);
    const record = buildRedEvidenceRecord(input, result);
    assert.equal(record.command, 'node --test tests/email.test.cjs');
    assert.equal(record.exit_code, 1);
    assert.equal(record.failing_test, 'rejects empty email');
    assert.equal(record.expected, 'ValidationError for empty input');
    assert.equal(record.actual, '1 !== 2');
    assert.equal(record.verdict, 'RED_EVIDENCE_OK');
    assert.equal(record.reason, 'target_test_failed');
  });
});

// ─── check tdd-red-evidence router arm ────────────────────────────────────────

describe('check tdd-red-evidence verb (#3770)', () => {
  /** Root for record-file fixtures; removed in after(). */
  let ROOT = '';

  before(() => { ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'tdd-red-evidence-')); });
  after(() => cleanup(ROOT));

  function writeRecord(name, record) {
    const file = path.join(ROOT, name);
    fs.writeFileSync(file, JSON.stringify(record), 'utf8');
    return file;
  }

  test('row 8 — check tdd-red-evidence accepts a valid persisted record', () => {
    const file = writeRecord('valid.json', validRedInput());
    const result = runGsdTools(['check', 'tdd-red-evidence', file, '--raw'], ROOT);
    assert.ok(result.success, `expected success, stderr: ${result.error}`);
    const payload = JSON.parse(result.output);
    assert.equal(payload.passed, true);
    assert.equal(payload.verdict, 'RED_EVIDENCE_OK');
    assert.equal(payload.reason, 'target_test_failed');
  });

  test('row 9 — check tdd-red-evidence rejects a crash record', () => {
    const file = writeRecord(
      'crash.json',
      validRedInput({ output: FIXTURE_CRASH_TAP, targetFile: 'tests/crash.test.cjs' }),
    );
    const result = runGsdTools(['check', 'tdd-red-evidence', file, '--raw'], ROOT);
    const payload = JSON.parse(result.output);
    assert.equal(payload.passed, false);
    assert.equal(payload.verdict, 'INVALID_RED');
    assert.equal(payload.reason, 'fixture_or_load_failure');
  });

  test('row 10 — check tdd-red-evidence fails closed on missing record', () => {
    const result = runGsdTools(
      ['check', 'tdd-red-evidence', path.join(ROOT, 'does-not-exist.json'), '--raw'],
      ROOT,
    );
    const payload = JSON.parse(result.output);
    assert.equal(payload.passed, false);
    assert.equal(payload.verdict, 'INVALID_RED');
    assert.equal(payload.reason, 'unreadable_record');
  });
});

// ─── Spec surfaces (#3770 acceptance: gate must require evidence before GREEN) ─

describe('executor spec requires intentional RED evidence before GREEN (#3770)', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

  test('row 11 — executor routes RED evidence by actual runner and requires semantic proof', () => {
    const agent = read('agents/gsd-executor.md');
    const tddRef = read('gsd-core/references/tdd.md');
    const mvpRef = read('gsd-core/references/execute-mvp-tdd.md');

    for (const [name, content] of [['tdd.md', tddRef], ['execute-mvp-tdd.md', mvpRef]]) {
      assert.match(content, /actual command/i, `${name} must select the evidence branch from the actual command`);
      assert.match(content, /command[\s\S]{0,240}(exit (status|code)|status)[\s\S]{0,240}(unmodified|unchanged) output[\s\S]{0,240}target[\s\S]{0,240}expected[\s\S]{0,80}actual/i,
        `${name} must preserve the real command, status, unmodified output, target, and expected/actual result`);
      assert.match(content, /Node('|’)?s built-in test runner[\s\S]{0,300}compatible TAP[\s\S]{0,300}tdd-red-evidence/i,
        `${name} must use the classifier only for an actual Node built-in command with compatible TAP`);
      assert.match(content, /(package\.json|package metadata)[\s\S]{0,180}(npm|pnpm|package manager)[\s\S]{0,180}TAP/i,
        `${name} must reject metadata, package-manager use, and TAP-shaped text as runner signals`);
      assert.match(content, /(other|non-Node|unknown) runner[\s\S]{0,300}(direct|inspect)/i,
        `${name} must directly inspect evidence from every other or unknown runner`);
      assert.match(content, /target[\s\S]{0,200}(executed|ran)[\s\S]{0,200}(planned|intended)[\s\S]{0,120}assertion/i,
        `${name} must prove the planned target assertion executed and failed for the intended reason`);
      for (const stop of ['zero tests', 'skipped', 'setup', 'collection', 'import', 'syntax', 'fixture', 'unrelated', 'unexpected green', 'incomplete', 'ambiguous']) {
        assert.match(content, new RegExp(stop, 'i'), `${name} must stop GREEN on ${stop} evidence`);
      }
      assert.match(content, /(do not|never)[^\n]{0,100}(fabricate|invent)[^\n]{0,100}(parser verdict|Node counters)/i,
        `${name} must not fabricate a parser verdict or Node counters for direct inspection`);
      assert.match(content, /INVALID_RED/, `${name} must retain the INVALID_RED stop`);
    }

    assert.match(tddRef, /Node('|’)?s built-in test runner[\s\S]{0,500}semantic/i,
      'tdd.md must require semantic inspection after the Node parser verdict');
    assert.match(agent, /references\/tdd\.md[\s\S]{0,200}Gate Enforcement Rules/i,
      'gsd-executor.md must keep the canonical Gate Enforcement Rules pointer');
  });
});
