'use strict';

/**
 * RED-evidence classification for `type: tdd` plans (#3770).
 *
 * Module: gsd-core/bin/lib/tdd-red-evidence.cjs (compiled from src/tdd-red-evidence.cts)
 * Gate: `check tdd-red-evidence <record.json>` in gate-tdd-red-evidence.cjs (routed by check-command-router.cjs)
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
const fc = require('fast-check');

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
    const result = classifyRedEvidence(validRedInput({ output: 'TAP version 13\nok 1 - rejects empty email\n1..1\n' }));
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

describe('executor requires format-based RED evidence (#4692)', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  // Read inside each test: a missing reference fails that test instead of
  // throwing before any test registers.
  const canonical = () => read('gsd-core/references/tdd.md');
  const runtime = () => read('gsd-core/references/execute-mvp-tdd.md');

  test('#4692: TAP and JUnit share mandatory classification, with no Vitest exemption', () => {
    assert.match(canonical(), /report format/);
    assert.match(canonical(), /shared TAP adapter[^\n]*Node[^\n]*Vitest/);
    assert.match(canonical(), /JUnit XML adapter[^\n]*Surefire\/Failsafe/);
    assert.match(canonical(), /`gsd_run check tdd-red-evidence <record\.json> --raw`[^\n]*require `RED_EVIDENCE_OK` before GREEN/);
    assert.match(canonical(), /unsupported format requires a supported reporter or a parser adapter before GREEN/);
    assert.match(canonical(), /Classifier rejection never authorizes a fallback to self-attestation/);
  });

  test('#4692: reruns and current Maven reports retain evidence provenance', () => {
    assert.match(canonical(), /reporter is incompatible[^\n]*rerun the planned target[^\n]*submit the rerun's record to the classifier/);
    assert.match(canonical(), /unmodified report/);
    assert.match(canonical(), /target\/surefire-reports\/TEST-\*\.xml[^\n]*target\/failsafe-reports\/TEST-\*\.xml/);
    assert.match(canonical(), /require the report to be newer than the run start/);
    assert.match(canonical(), /Missing, stale, or ambiguous reports require STOP/);
  });

  test('#4692: a parser pass still requires the intended target assertion to fail', () => {
    const assessment = canonical().split('\n').find((line) => line.includes('After machine validation'));
    assert.ok(assessment, 'RED step 4 has a semantic-assessment bullet');
    assert.match(assessment, /target actually executed[^\n]*planned assertion[^\n]*intended reason/);
    for (const stop of ['zero tests', 'skipped', 'setup', 'collection', 'import', 'syntax', 'fixture', 'unrelated', 'unexpected green', 'incomplete', 'ambiguous']) {
      assert.match(assessment, new RegExp(stop, 'i'), stop);
    }
    for (const reason of ['unexpected_green', 'zero_tests_discovered', 'nonzero_exit_without_test_failure', 'fixture_or_load_failure', 'no_target_test_failure', 'invalid_record', 'unreadable_record']) {
      assert.ok(canonical().includes('`' + reason + '`'), reason);
    }
  });

  test('#4692: the runtime gate loads the canonical evidence contract before GREEN', () => {
    assert.match(runtime(), /Read `gsd-core\/references\/tdd\.md`, "Red-Green-Refactor Cycle", RED step 4/);
    assert.match(runtime(), /follow its complete evidence contract before GREEN/);
    assert.match(runtime(), /`INVALID_RED` verdict[^\n]*trips this gate/);
    assert.match(runtime(), /self-attestation cannot substitute for machine validation/);
    assert.match(read('agents/gsd-executor.md'), /references\/tdd\.md[^\n]*"Gate Enforcement Rules"/);
  });
});

// ── #4724 — Surefire/Failsafe XML RED evidence ────────────────────────────────
// A JVM project's genuine red is a Surefire/Failsafe XML report, not node:test
// TAP. The gate used to parse only TAP, so a real Maven red scored
// INVALID_RED while hand-written synthetic TAP scored RED_EVIDENCE_OK — the
// gate was passable only by fabricating its input. The XML scanner walks
// <testcase> tag boundaries (NOT a lazy spanning regex: Surefire writes
// passing cases self-closing, so `(.*?)</testcase>` spans from a green case
// to the next closing tag and reports wrong method names).

describe('#4724 — Surefire/Failsafe XML RED evidence', () => {
  const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n';

  function surefire(cases) {
    const body = cases.join('\n');
    return `${XML_HEAD}<testsuite name="com.example.AppTest" tests="${cases.length}" failures="1" errors="0">\n${body}\n</testsuite>`;
  }

  const failingCase = (cls, name) =>
    `<testcase name="${name}" classname="${cls}" time="0.01"><failure message="expected 1 was 2">1 != 2</failure></testcase>`;
  const errorCase = (cls, name) =>
    `<testcase name="${name}" classname="${cls}" time="0.01"><error message="boom">NullPointerException</error></testcase>`;
  const greenCase = (cls, name) =>
    `<testcase name="${name}" classname="${cls}" time="0.01"/>`;

  const INPUT = {
    command: 'mvn -Dtest=AppTest test',
    exitCode: 1,
    targetTest: 'AppTest',
    targetFile: 'src/test/java/com/example/AppTest.java',
  };

  test('a genuine Surefire red with the target class failing classifies RED_EVIDENCE_OK (#4724)', () => {
    const result = classifyRedEvidence({
      ...INPUT,
      output: surefire([failingCase('com.example.AppTest', 'divides_by_zero')]),
    });
    assert.equal(result.verdict, 'RED_EVIDENCE_OK');
    assert.equal(result.reason, 'target_test_failed');
    assert.equal(result.evidence.fail, 1);
    assert.ok(
      result.evidence.failing_tests.some((n) => n.includes('AppTest')),
      'failing_tests must carry the classname so the target matches',
    );
  });

  test('an unrelated Surefire failure is not the target test', () => {
    const result = classifyRedEvidence({
      ...INPUT,
      output: surefire([failingCase('com.other.UnrelatedTest', 'unrelated_case')]),
    });
    assert.equal(result.verdict, 'INVALID_RED');
    assert.equal(result.reason, 'no_target_test_failure');
  });

  test('an all-green self-closing Surefire report is unexpected_green', () => {
    const result = classifyRedEvidence({
      ...INPUT,
      exitCode: 0,
      output: surefire([greenCase('com.example.AppTest', 'passes'), greenCase('com.example.AppTest', 'passes2')]),
    });
    assert.equal(result.verdict, 'INVALID_RED');
    assert.equal(result.reason, 'unexpected_green');
  });

  test('self-closing passing cases are not spanned into failing names (#4725-class trap)', () => {
    // The issue's trap: a lazy /(.*?)<\/testcase>/ regex starting at the green
    // self-closing case spans to the NEXT closing tag, misreporting the green
    // case's name beside the failing one. Boundary scanning must not.
    const result = classifyRedEvidence({
      ...INPUT,
      output: surefire([
        greenCase('com.example.AppTest', 'green_before_failure'),
        failingCase('com.example.AppTest', 'the_real_failure'),
      ]),
    });
    assert.equal(result.verdict, 'RED_EVIDENCE_OK');
    assert.deepEqual(
      result.evidence.failing_tests,
      ['com.example.AppTest#the_real_failure'],
      'exactly the failing case is reported — no spanned green-case names',
    );
  });

  test('an <error> child counts as a failing testcase', () => {
    const result = classifyRedEvidence({
      ...INPUT,
      output: surefire([errorCase('com.example.AppTest', 'explodes')]),
    });
    assert.equal(result.verdict, 'RED_EVIDENCE_OK');
    assert.equal(result.evidence.fail, 1);
  });

  test('a testcase-free Surefire report is zero_tests_discovered', () => {
    const result = classifyRedEvidence({
      ...INPUT,
      output: `${XML_HEAD}<testsuite name="com.example.AppTest" tests="0" failures="0" errors="0"></testsuite>`,
    });
    assert.equal(result.verdict, 'INVALID_RED');
    assert.equal(result.reason, 'zero_tests_discovered');
  });

  test('Failsafe XML (same schema) classifies like Surefire', () => {
    const result = classifyRedEvidence({
      command: 'mvn -Dtest=AppIT verify',
      exitCode: 1,
      targetTest: 'AppIT',
      targetFile: 'src/test/java/com/example/AppIT.java',
      output: `${XML_HEAD}<testsuite name="com.example.AppIT" tests="1" failures="1" errors="0">\n${failingCase('com.example.AppIT', 'integration_red')}\n</testsuite>`,
    });
    assert.equal(result.verdict, 'RED_EVIDENCE_OK');
    assert.equal(result.reason, 'target_test_failed');
  });
});

// ── #4724 review hardening — scanner edge cases ──────────────────────────────

test('#4724: a <testcase with no > (truncated output) terminates and fails closed', () => {
  // Pre-hardening this hung forever: indexOf('<testcase', -1) clamps to 0 and
  // re-found the same tag. Degrade to what was scanned — an incomplete report
  // proves nothing.
  const result = classifyRedEvidence({
    command: 'mvn test',
    exitCode: 1,
    targetTest: 'AppTest',
    output: '<?xml version="1.0"?><testsuite><testcase name="x" classname="C"',
  });
  assert.equal(result.verdict, 'INVALID_RED');
});

test('#4724: a TAP red whose message quotes <testsuite> stays on the TAP path', () => {
  // Format detection requires BOTH <testsuite and <testcase: a genuine TAP
  // red whose error message merely quotes "<testsuite>" must not flip to the
  // XML path (which would misread it as zero_tests_discovered).
  const tap = [
    'TAP version 13',
    '# Subtest: the test',
    'not ok 1 - expected <testsuite> was 2',
    '  ---',
    '    error: |-',
    '      expected <testsuite> was 2',
    '  ...',
    '1..1',
    '# tests 1',
    '# pass 0',
    '# fail 1',
  ].join('\n');
  const result = classifyRedEvidence({
    command: 'node --test',
    exitCode: 1,
    targetTest: 'the test',
    output: tap,
  });
  assert.equal(result.status ?? result.verdict, 'INVALID_RED');
  assert.equal(result.reason, 'no_target_test_failure',
    'the TAP path must classify it (fail=1), not the XML path (zero tests)');
  assert.equal(result.evidence.fail, 1);
});

test('#4724: CDATA sections in a passing case are never scanned as failures', () => {
  // A passing case whose captured System.out (CDATA) echoes an <error .../>
  // literal must not count as failing — CDATA is verbatim content.
  const cd = '<testcase name="prints" classname="com.example.AppTest"><system-out><![CDATA[echo <error x/></system-out>]]></system-out></testcase>';
  const fl = '<testcase name="x" classname="com.other.Unrelated"><failure message="e">1 != 2</failure></testcase>';
  const result = classifyRedEvidence({
    command: 'mvn test',
    exitCode: 1,
    targetTest: 'UnrelatedTest',
    output: `<?xml version="1.0"?>\n<testsuite>\n${cd}\n${fl}\n</testsuite>`,
  });
  assert.equal(result.reason, 'no_target_test_failure',
    'the CDATA phantom must not flip the unrelated failure into a target match');
  assert.equal(result.evidence.fail, 1, 'only the real failing case counts');
});

// ── #4957 — swift-testing RED evidence ────────────────────────────────────────
// Same class as #4692 (Vitest) and #4724 (Surefire, fixed by #4825): swift-testing's
// console summary (`✘ Test run with N tests in M suites failed after T seconds with
// K issues.` plus per-test lines `✘ Test "name" failed after T seconds with K issues.`)
// matched neither the TAP nor the Surefire detector, so a genuine Swift red silently
// fell through to the TAP parser, which found nothing and reported zero tests.

describe('#4957 — swift-testing RED evidence', () => {
  const INPUT = {
    command: 'swift test',
    exitCode: 1,
    targetTest: 'X',
  };

  function swiftTesting(perTestLines, { tests, passed = false } = {}) {
    const failCount = perTestLines.filter((l) => l.includes('failed')).length;
    const agg = passed
      ? `✔ Test run with ${tests} tests in 1 suite passed after 0.02 seconds.`
      : `✘ Test run with ${tests} tests in 1 suite failed after 0.02 seconds with ${failCount} issues.`;
    return [agg, ...perTestLines].join('\n');
  }
  const failLine = (name) => `✘ Test "${name}" failed after 0.01 seconds with 1 issue.`;
  const passLine = (name) => `✔ Test "${name}" passed after 0.01 seconds.`;

  test('a genuine swift-testing red with the target test failing classifies RED_EVIDENCE_OK (#4957)', () => {
    const result = classifyRedEvidence({
      ...INPUT,
      output: swiftTesting([passLine('Y'), failLine('X')], { tests: 2 }),
    });
    assert.equal(result.verdict, 'RED_EVIDENCE_OK');
    assert.equal(result.reason, 'target_test_failed');
    assert.equal(result.evidence.tests, 2);
    assert.equal(result.evidence.fail, 1);
  });

  test("the issue's literal aggregate-only repro is an incomplete report, not zero_tests_discovered (#4957)", () => {
    // The issue's exact repro JSON: only the aggregate summary line, no per-test
    // lines at all. We cannot identify which named test failed, so this must NOT
    // reach RED_EVIDENCE_OK — but it must also never lie that zero tests ran.
    // Like a TAP plan or JUnit count mismatch, the report is incomplete.
    const result = classifyRedEvidence({
      ...INPUT,
      output: '✘ Test run with 3 tests in 1 suite failed after 0.004 seconds with 6 issues.\n',
    });
    assert.notEqual(result.reason, 'zero_tests_discovered');
    assert.equal(result.verdict, 'INVALID_RED');
    assert.equal(result.reason, 'invalid_record');
    assert.equal(result.evidence.format, 'swift-testing');
    assert.deepEqual(result.evidence.report_errors, ['Incomplete swift-testing report']);
  });

  test('an unrelated swift-testing failure is not the target test', () => {
    const result = classifyRedEvidence({
      ...INPUT,
      output: swiftTesting([failLine('Y')], { tests: 1 }),
    });
    assert.equal(result.verdict, 'INVALID_RED');
    assert.equal(result.reason, 'no_target_test_failure');
  });

  test('an all-passed swift-testing report at exit 0 is unexpected_green', () => {
    const result = classifyRedEvidence({
      ...INPUT,
      exitCode: 0,
      output: swiftTesting([passLine('X'), passLine('Y')], { tests: 2, passed: true }),
    });
    assert.equal(result.verdict, 'INVALID_RED');
    assert.equal(result.reason, 'unexpected_green');
  });

  test('exactly one failing swift-testing test (boundary: fail=1) still matches the target', () => {
    const result = classifyRedEvidence({
      ...INPUT,
      output: swiftTesting([failLine('X')], { tests: 1 }),
    });
    assert.equal(result.verdict, 'RED_EVIDENCE_OK');
    assert.equal(result.evidence.fail, 1);
  });

  test('a target failing among several passing swift-testing tests still matches', () => {
    const result = classifyRedEvidence({
      ...INPUT,
      output: swiftTesting(
        [passLine('A'), passLine('B'), passLine('C'), passLine('D'), failLine('X')],
        { tests: 5 },
      ),
    });
    assert.equal(result.verdict, 'RED_EVIDENCE_OK');
    assert.equal(result.evidence.tests, 5);
    assert.equal(result.evidence.fail, 1);
  });

  test('skipped, cancelled, known-issue and parameterized siblings count toward the aggregate', () => {
    // swift-testing counts started AND skipped tests in "Test run with N tests",
    // and a parameterized test ends with "with N test cases" before its verb.
    // Line shapes come from swiftlang/swift-testing
    // Sources/Testing/Events/Recorder/Event.HumanReadableOutputRecorder.swift
    // (testEnded, testSkipped, _issueCounts) and Event.Symbol.swift (➜ skip, ━ known-issue pass).
    const result = classifyRedEvidence({
      ...INPUT,
      output: swiftTesting([
        '➜ Test "S" skipped.',
        '➜ Test "R" skipped: "needs network"',
        '➜ Test "C" was cancelled after 0.01 seconds.',
        '━ Test "K" passed after 0.01 seconds with 1 known issue.',
        '✔ Test "P" with 3 test cases passed after 0.01 seconds.',
        failLine('X'),
      ], { tests: 6 }),
    });
    assert.equal(result.verdict, 'RED_EVIDENCE_OK');
    assert.equal(result.reason, 'target_test_failed');
    assert.deepEqual(result.evidence.report_errors, []);
    assert.equal(result.evidence.tests, 6);
    assert.equal(result.evidence.pass, 2);
    assert.equal(result.evidence.fail, 1);
  });

  test('a skipped or cancelled target is never RED evidence', () => {
    for (const line of ['➜ Test "X" skipped.', '➜ Test "X" was cancelled after 0.01 seconds: "timeout"']) {
      const result = classifyRedEvidence({ ...INPUT, output: swiftTesting([line, failLine('Y')], { tests: 2 }) });
      assert.equal(result.verdict, 'INVALID_RED', line);
      assert.equal(result.reason, 'no_target_test_failure', line);
      assert.deepEqual(result.evidence.report_errors, [], line);
    }
  });

  test('a known-issue run summary is still swift-testing, and a result line with trailing text is not a result', () => {
    const knownIssueRun = [
      '━ Test "X" passed after 0.01 seconds with 1 known issue.',
      '━ Test run with 1 test in 1 suite passed after 0.02 seconds with 1 known issue.',
    ].join('\n');
    const green = classifyRedEvidence({ ...INPUT, exitCode: 0, output: knownIssueRun });
    assert.equal(green.evidence.format, 'swift-testing');
    assert.equal(green.reason, 'unexpected_green');
    const trailing = classifyRedEvidence({
      ...INPUT,
      output: swiftTesting([`${failLine('X')} (retried)`], { tests: 1 }),
    });
    assert.equal(trailing.reason, 'invalid_record');
    assert.deepEqual(trailing.evidence.report_errors, ['Incomplete swift-testing report']);
  });

  test('a failing parameterized target classifies RED_EVIDENCE_OK', () => {
    const result = classifyRedEvidence({
      ...INPUT,
      output: swiftTesting([
        passLine('Y'),
        '✘ Test "X" with 3 test cases failed after 0.01 seconds with 2 issues.',
      ], { tests: 2 }),
    });
    assert.equal(result.verdict, 'RED_EVIDENCE_OK');
    assert.deepEqual(result.evidence.failing_tests, ['X']);
  });

  test('a stray swift-testing-looking per-test line with no aggregate marker is not a swift-testing report', () => {
    // No "Test run with N tests in M suites ..." aggregate line present at all —
    // must not be confidently classified as swift-testing off a per-test line alone.
    const result = classifyRedEvidence({
      ...INPUT,
      output: failLine('X'),
    });
    assert.equal(result.verdict, 'INVALID_RED');
    assert.equal(result.reason, 'invalid_record');
    assert.equal(result.evidence.format, 'unknown');
  });

  test('property: swift-testing target matching is exactly failing-set membership (#4957)', () => {
    const arb = fc.integer({ min: 1, max: 12 }).chain((n) =>
      fc.record({
        n: fc.constant(n),
        failingIdx: fc.subarray(
          Array.from({ length: n }, (_, i) => i),
          { minLength: 1 },
        ),
        targetIdx: fc.integer({ min: 0, max: n - 1 }),
      }),
    );
    fc.assert(
      fc.property(arb, ({ n, failingIdx, targetIdx }) => {
        const failingSet = new Set(failingIdx);
        const lines = [];
        for (let i = 0; i < n; i++) {
          lines.push(failingSet.has(i) ? failLine(`test${i}`) : passLine(`test${i}`));
        }
        const result = classifyRedEvidence({
          command: 'swift test',
          exitCode: 1,
          targetTest: `test${targetIdx}`,
          output: swiftTesting(lines, { tests: n }),
        });
        assert.equal(result.evidence.tests, n);
        assert.equal(result.evidence.fail, failingSet.size);
        if (failingSet.has(targetIdx)) {
          assert.equal(result.verdict, 'RED_EVIDENCE_OK');
          assert.equal(result.reason, 'target_test_failed');
        } else {
          assert.equal(result.verdict, 'INVALID_RED');
          assert.equal(result.reason, 'no_target_test_failure');
        }
      }),
      { numRuns: 200, seed: 4957 },
    );
  });

  test('a TAP diagnostic merely quoting the swift-testing summary phrase stays on the TAP path (review finding)', () => {
    // The phrase appears mid-line, indented, quoted inside a TAP diagnostic's
    // `actual:` block — NOT at line-start with a checkmark glyph. Must NOT
    // hijack format detection away from the real TAP failure.
    const tap = [
      'TAP version 13',
      '# Subtest: renders a CLI summary',
      'not ok 1 - renders a CLI summary',
      '  ---',
      '  actual: |-',
      '    Got: "Test run with 2 tests in 1 suite passed after 0.02 seconds."',
      '  ...',
      '1..1',
      '# tests 1',
      '# pass 0',
      '# fail 1',
    ].join('\n');
    const result = classifyRedEvidence({
      command: 'node --test',
      exitCode: 1,
      targetTest: 'renders a CLI summary',
      output: tap,
    });
    assert.equal(result.verdict, 'RED_EVIDENCE_OK', 'the real TAP failure must still be classified correctly');
    assert.equal(result.evidence.tests, 1, 'tests must come from the real TAP summary, not the quoted phrase');
  });

  test('concatenated swift-testing blocks report a consistent summed test count (review finding)', () => {
    const block1 = swiftTesting([passLine('A0'), failLine('A1')], { tests: 2 });
    const block2 = swiftTesting([passLine('B'), passLine('C'), failLine('D')], { tests: 3 });
    const result = classifyRedEvidence({
      command: 'swift test',
      exitCode: 1,
      targetTest: 'D',
      output: `${block1}\n${block2}`,
    });
    assert.equal(result.evidence.tests, 5, 'tests must be the sum of every aggregate block, not just the first');
    assert.equal(result.evidence.pass + result.evidence.fail, 5, 'pass+fail must never exceed the reported tests');
    assert.equal(result.verdict, 'RED_EVIDENCE_OK');
  });

  // Event.HumanReadableOutputRecorder names a test by its quoted display name
  // only when it has one; a plain `@Test func` is named by its bare function
  // name, and --verbose adds `(aka 'function()')` after a display name.
  const bare = [
    '✘ Test addsNumbers() failed after 0.001 seconds with 1 issue.',
    '✔ Test subtracts() passed after 0.001 seconds.',
  ];

  test('a test without a display name is named by its bare function name', () => {
    for (const targetTest of ['addsNumbers()', 'addsNumbers']) {
      const result = classifyRedEvidence({ ...INPUT, targetTest, output: swiftTesting(bare, { tests: 2 }) });
      assert.equal(result.verdict, 'RED_EVIDENCE_OK', targetTest);
      assert.deepEqual(result.evidence.report_errors, []);
      assert.equal(result.evidence.matched_test, 'addsNumbers()');
    }
  });

  test('a verbose display name also matches its function name', () => {
    const output = swiftTesting([
      `✘ Test "Adds numbers" (aka 'addsNumbers()') failed after 0.001 seconds with 1 issue.`,
      `✔ Test "Subtracts" (aka 'subtracts()') passed after 0.001 seconds.`,
    ], { tests: 2 });
    for (const targetTest of ['Adds numbers', 'addsNumbers()', 'addsNumbers']) {
      const result = classifyRedEvidence({ ...INPUT, targetTest, output });
      assert.equal(result.verdict, 'RED_EVIDENCE_OK', targetTest);
      assert.equal(result.evidence.matched_test, 'Adds numbers');
    }
  });

  test('Windows console glyphs mark the same results', () => {
    // Event.Symbol substitutes √ × - for ✔ ✘ ━ on Windows.
    const output = [
      '× Test run with 2 tests in 1 suite failed after 0.002 seconds with 1 issue.',
      '× Test addsNumbers() failed after 0.001 seconds with 1 issue.',
      '√ Test subtracts() passed after 0.001 seconds.',
    ].join('\n');
    const result = classifyRedEvidence({ ...INPUT, targetTest: 'addsNumbers()', output });
    assert.equal(result.verdict, 'RED_EVIDENCE_OK');
    assert.deepEqual(result.evidence.report_errors, []);
  });
});

// ── #4970 — Python unittest RED evidence ──────────────────────────────────────
// Python stdlib `unittest` emits neither TAP nor JUnit XML: a genuine red was
// falling through to the TAP parser (which finds nothing) and scoring
// zero_tests_discovered — the Python sibling of #4692 (Vitest) and #4724
// (Surefire). The aggregate line ("Ran N tests in Ts" + "OK"/"FAILED (...)")
// and per-failure headers ("FAIL: name (id)" / "ERROR: name (id)") are parsed
// directly; `tests` comes only from the aggregate (never fabricated from
// counting FAIL lines), and `fail`/`failing_tests` come only from observed
// FAIL:/ERROR: headers (absent headers means fail:0, not a fabricated match).

describe('#4970 — Python unittest RED evidence', () => {
  const INPUT = {
    command: 'python -m unittest discover -s tests -v',
    exitCode: 1,
    targetTest: 'test_adds_two_numbers',
    targetFile: 'tests/test_demo.py',
  };

  // The issue's literal repro (#4970), verbatim shape.
  const ISSUE_REPRO = [
    'test_adds_two_numbers (test_demo.AddTest.test_adds_two_numbers) ... FAIL',
    '',
    '======================================================================',
    'FAIL: test_adds_two_numbers (test_demo.AddTest.test_adds_two_numbers)',
    '----------------------------------------------------------------------',
    'Traceback (most recent call last):',
    '  File "tests/test_demo.py", line 10, in test_adds_two_numbers',
    '    self.assertEqual(add(1, 2), 3)',
    'AssertionError: 0 != 3',
    '',
    '----------------------------------------------------------------------',
    'Ran 1 test in 0.001s',
    '',
    'FAILED (failures=1)',
    '',
  ].join('\n');

  test('the issue-4970 literal repro classifies RED_EVIDENCE_OK', () => {
    const result = classifyRedEvidence({ ...INPUT, output: ISSUE_REPRO });
    assert.equal(result.verdict, 'RED_EVIDENCE_OK');
    assert.equal(result.reason, 'target_test_failed');
    assert.equal(result.evidence.tests, 1, 'tests count comes from "Ran 1 test", not fabricated');
    assert.equal(result.evidence.fail, 1);
    assert.deepEqual(result.evidence.failing_tests, ['test_adds_two_numbers']);
  });

  test('a genuine unittest red with the target test failing classifies RED_EVIDENCE_OK', () => {
    const output = [
      'test_adds_two_numbers (test_demo.AddTest.test_adds_two_numbers) ... FAIL',
      '',
      '======================================================================',
      'FAIL: test_adds_two_numbers (test_demo.AddTest.test_adds_two_numbers)',
      '----------------------------------------------------------------------',
      'AssertionError: 0 != 3',
      '',
      'Ran 1 test in 0.002s',
      '',
      'FAILED (failures=1)',
      '',
    ].join('\n');
    const result = classifyRedEvidence({ ...INPUT, output });
    assert.equal(result.verdict, 'RED_EVIDENCE_OK');
    assert.equal(result.reason, 'target_test_failed');
  });

  test('an unrelated unittest failure is not the target test', () => {
    const output = [
      'test_other (test_demo.AddTest.test_other) ... FAIL',
      '',
      '======================================================================',
      'FAIL: test_other (test_demo.AddTest.test_other)',
      '----------------------------------------------------------------------',
      'AssertionError: boom',
      '',
      'Ran 1 test in 0.001s',
      '',
      'FAILED (failures=1)',
      '',
    ].join('\n');
    const result = classifyRedEvidence({ ...INPUT, output });
    assert.equal(result.verdict, 'INVALID_RED');
    assert.equal(result.reason, 'no_target_test_failure');
  });

  test('an all-pass unittest run (OK) at exit 0 is unexpected_green', () => {
    const output = ['', 'Ran 2 tests in 0.003s', '', 'OK', ''].join('\n');
    const result = classifyRedEvidence({ ...INPUT, exitCode: 0, output });
    assert.equal(result.verdict, 'INVALID_RED');
    assert.equal(result.reason, 'unexpected_green');
  });

  test('an aggregate-only report with no FAIL/ERROR header is incomplete, not fabricated (fail:0)', () => {
    // A truncated/aggregate-only report must never fabricate a target match —
    // a counted failure without its header makes the report incomplete.
    const output = ['', 'Ran 1 test in 0.001s', '', 'FAILED (failures=1)', ''].join('\n');
    const result = classifyRedEvidence({ ...INPUT, output });
    assert.equal(result.verdict, 'INVALID_RED');
    assert.equal(result.reason, 'invalid_record');
    assert.deepEqual(result.evidence.report_errors, ['Incomplete unittest report']);
    assert.equal(result.evidence.fail, 0);
    assert.deepEqual(result.evidence.failing_tests, []);
  });

  test('boundary: exactly one failing test among several classifies on the target', () => {
    const output = [
      'FAIL: test_adds_two_numbers (test_demo.AddTest.test_adds_two_numbers)',
      '----------------------------------------------------------------------',
      'AssertionError: 0 != 3',
      '',
      'Ran 3 tests in 0.004s',
      '',
      'FAILED (failures=1)',
      '',
    ].join('\n');
    const result = classifyRedEvidence({ ...INPUT, output });
    assert.equal(result.verdict, 'RED_EVIDENCE_OK');
    assert.equal(result.evidence.tests, 3);
    assert.equal(result.evidence.fail, 1);
  });

  test('boundary: several failing tests, target among them', () => {
    const output = [
      'FAIL: test_other (test_demo.AddTest.test_other)',
      '----------------------------------------------------------------------',
      'AssertionError: boom',
      '',
      'FAIL: test_adds_two_numbers (test_demo.AddTest.test_adds_two_numbers)',
      '----------------------------------------------------------------------',
      'AssertionError: 0 != 3',
      '',
      'Ran 3 tests in 0.004s',
      '',
      'FAILED (failures=2)',
      '',
    ].join('\n');
    const result = classifyRedEvidence({ ...INPUT, output });
    assert.equal(result.verdict, 'RED_EVIDENCE_OK');
    assert.equal(result.evidence.fail, 2);
    assert.deepEqual(result.evidence.failing_tests, ['test_other', 'test_adds_two_numbers']);
  });

  test('an ERROR header counts as failing, mirroring the Surefire <error> precedent', () => {
    const output = [
      'ERROR: test_adds_two_numbers (test_demo.AddTest.test_adds_two_numbers)',
      '----------------------------------------------------------------------',
      'Traceback (most recent call last):',
      'ZeroDivisionError: division by zero',
      '',
      'Ran 1 test in 0.001s',
      '',
      'FAILED (errors=1)',
      '',
    ].join('\n');
    const result = classifyRedEvidence({ ...INPUT, output });
    assert.equal(result.verdict, 'RED_EVIDENCE_OK');
    assert.equal(result.reason, 'target_test_failed');
  });

  test('a unittest.loader._FailedTest collection/import failure is excluded, never fabricating a target match', () => {
    // The issue's explicit carve-out: a module import/collection crash makes
    // unittest synthesize a _FailedTest whose method name can coincidentally
    // equal the plan's target test. This must NOT be fabricated into a real
    // failure — the load failure invalidates the whole report.
    const output = [
      'ERROR: test_adds_two_numbers (unittest.loader._FailedTest.test_adds_two_numbers)',
      '----------------------------------------------------------------------',
      'ImportError: Failed to import test module: test_demo',
      'Traceback (most recent call last):',
      '  ModuleNotFoundError: No module named \'add\'',
      '',
      'Ran 1 test in 0.000s',
      '',
      'FAILED (errors=1)',
      '',
    ].join('\n');
    const result = classifyRedEvidence({ ...INPUT, output });
    assert.equal(result.verdict, 'INVALID_RED');
    assert.equal(result.reason, 'invalid_record');
    assert.deepEqual(result.evidence.report_errors, ['unittest module failed to load']);
    assert.equal(result.evidence.fail, 0, '_FailedTest must not be counted as a real failure');
    assert.deepEqual(result.evidence.failing_tests, []);
  });

  test('a target failing in several subTests is one failing test, not an ambiguous or overcounted report', () => {
    // Real Python 3.14 `-m unittest -v` output: each failing subTest prints its
    // own identical FAIL: header, and failures= counts subTests while Ran
    // counts methods (3 subTest failures > Ran 2).
    const output = [
      'test_ok (test_demo.AddTest.test_ok) ... ok',
      'test_adds_two_numbers (test_demo.AddTest.test_adds_two_numbers) ... ',
      '  test_adds_two_numbers (test_demo.AddTest.test_adds_two_numbers) (i=0) ... FAIL',
      '  test_adds_two_numbers (test_demo.AddTest.test_adds_two_numbers) (i=1) ... FAIL',
      '  test_adds_two_numbers (test_demo.AddTest.test_adds_two_numbers) (i=2) ... FAIL',
      '',
      ...[0, 1, 2].flatMap((i) => [
        '======================================================================',
        `FAIL: test_adds_two_numbers (test_demo.AddTest.test_adds_two_numbers) (i=${i})`,
        '----------------------------------------------------------------------',
        'Traceback (most recent call last):',
        '  File "tests/test_demo.py", line 10, in test_adds_two_numbers',
        '    self.assertEqual(add(i, 2), i + 2)',
        `AssertionError: 0 != ${i + 2}`,
        '',
      ]),
      '----------------------------------------------------------------------',
      'Ran 2 tests in 0.001s',
      '',
      'FAILED (failures=3)',
      '',
    ].join('\n');
    const result = classifyRedEvidence({ ...INPUT, output });
    assert.equal(result.verdict, 'RED_EVIDENCE_OK');
    assert.equal(result.reason, 'target_test_failed');
    assert.deepEqual(result.evidence.report_errors, []);
    assert.equal(result.evidence.tests, 2);
    assert.equal(result.evidence.pass, 1);
    assert.equal(result.evidence.fail, 1);
    assert.deepEqual(result.evidence.failing_tests, ['test_adds_two_numbers']);
  });

  // Real Python 3.14 `-m unittest -v` output: an @expectedFailure test that
  // passes is listed as UNEXPECTED SUCCESS and counted in the FAILED line, but
  // it is a test that ran and passed, not a failure.
  const UNEXPECTED_SUCCESS = [
    'test_known_bug (test_demo.AddTest.test_known_bug) ... unexpected success',
    '',
    '======================================================================',
    'UNEXPECTED SUCCESS: test_known_bug (test_demo.AddTest.test_known_bug)',
    '----------------------------------------------------------------------',
    'Ran 2 tests in 0.000s',
    '',
  ];

  test('an unexpected success beside the failing target still classifies RED_EVIDENCE_OK', () => {
    const output = [
      'test_adds_two_numbers (test_demo.AddTest.test_adds_two_numbers) ... FAIL',
      ...UNEXPECTED_SUCCESS.slice(0, 2),
      '======================================================================',
      'FAIL: test_adds_two_numbers (test_demo.AddTest.test_adds_two_numbers)',
      '----------------------------------------------------------------------',
      'Traceback (most recent call last):',
      '  File "tests/test_demo.py", line 6, in test_adds_two_numbers',
      '    self.assertEqual(add(1, 2), 3)',
      'AssertionError: 0 != 3',
      '',
      ...UNEXPECTED_SUCCESS.slice(2),
      'FAILED (failures=1, unexpected successes=1)',
      '',
    ].join('\n');
    const result = classifyRedEvidence({ ...INPUT, output });
    assert.equal(result.verdict, 'RED_EVIDENCE_OK');
    assert.equal(result.reason, 'target_test_failed');
    assert.deepEqual(result.evidence.report_errors, []);
    assert.equal(result.evidence.tests, 2);
    assert.equal(result.evidence.pass, 1);
    assert.equal(result.evidence.fail, 1);
  });

  test('an unexpected success alone fails the run without a failing test', () => {
    const output = [
      'test_adds_two_numbers (test_demo.AddTest.test_adds_two_numbers) ... ok',
      ...UNEXPECTED_SUCCESS,
      'FAILED (unexpected successes=1)',
      '',
    ].join('\n');
    const result = classifyRedEvidence({ ...INPUT, output });
    assert.equal(result.verdict, 'INVALID_RED');
    assert.equal(result.reason, 'nonzero_exit_without_test_failure');
    assert.deepEqual(result.evidence.report_errors, []);
    assert.equal(result.evidence.pass, 2);
  });

  test('subTest headers must still account exactly for the counted failures', () => {
    const header = 'FAIL: test_adds_two_numbers (test_demo.AddTest.test_adds_two_numbers) (i=0)\nAssertionError: boom\n';
    for (const [headers, failures, ran] of [[2, 1, 1], [1, 2, 1], [2, 2, 0]]) {
      const output = `${header.repeat(headers)}\nRan ${ran} tests in 0.001s\n\nFAILED (failures=${failures})\n`;
      const result = classifyRedEvidence({ ...INPUT, output });
      assert.equal(result.reason, 'invalid_record', `${headers} headers, failures=${failures}, Ran ${ran}`);
      assert.deepEqual(result.evidence.report_errors, ['Incomplete unittest report']);
    }
  });

  test('subTest failures of an unrelated method still do not satisfy the target', () => {
    const output = [
      ...[0, 1].flatMap((i) => [
        `FAIL: test_other (test_demo.AddTest.test_other) (i=${i})`,
        '----------------------------------------------------------------------',
        'AssertionError: boom',
        '',
      ]),
      'Ran 2 tests in 0.001s',
      '',
      'FAILED (failures=2)',
      '',
    ].join('\n');
    const result = classifyRedEvidence({ ...INPUT, output });
    assert.equal(result.verdict, 'INVALID_RED');
    assert.equal(result.reason, 'no_target_test_failure');
    assert.equal(result.evidence.fail, 1);
    assert.equal(result.evidence.pass, 1);
  });

  test('property: fail count and failing_tests always match the FAIL/ERROR headers actually present (#4970)', () => {
    // Invariant (boundary containment + round-trip): for ANY report built
    // from N distinct test names with exactly K of them given a FAIL: header
    // (1 <= K <= N), parseUnittestSummary-derived evidence.tests === N,
    // evidence.fail === K (never more, never fewer — no fabrication, no
    // under-count), and failing_tests reproduces exactly the K names that
    // were given headers, in order. The first failing name is always used as
    // the target, so the run must always classify RED_EVIDENCE_OK.
    const nameArb = fc
      .string({ unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')), minLength: 3, maxLength: 10 })
      .map((s) => `test_${s}`);
    const namesArb = fc.uniqueArray(nameArb, { minLength: 1, maxLength: 8 });

    fc.assert(
      fc.property(namesArb, fc.nat(), (names, seed) => {
        const failingCount = 1 + (seed % names.length);
        const failingNames = names.slice(0, failingCount);
        const lines = [];
        for (const name of failingNames) {
          lines.push(`FAIL: ${name} (test_demo.AddTest.${name})`);
          lines.push('----------------------------------------------------------------------');
          lines.push('AssertionError: boom');
          lines.push('');
        }
        lines.push(`Ran ${names.length} tests in 0.01s`);
        lines.push('');
        lines.push(`FAILED (failures=${failingCount})`);
        lines.push('');
        const output = lines.join('\n');

        const result = classifyRedEvidence({
          command: 'python -m unittest discover -s tests -v',
          exitCode: 1,
          targetTest: failingNames[0],
          targetFile: 'tests/test_demo.py',
          output,
        });

        return (
          result.evidence.tests === names.length &&
          result.evidence.fail === failingCount &&
          result.evidence.fail <= result.evidence.tests &&
          JSON.stringify(result.evidence.failing_tests) === JSON.stringify(failingNames) &&
          result.verdict === 'RED_EVIDENCE_OK' &&
          result.reason === 'target_test_failed'
        );
      }),
      { numRuns: 200, seed: 20260927 },
    );
  });
});
