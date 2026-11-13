'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('./helpers/fast-check-setup.cjs');
const { parseTestReport } = require('../gsd-core/bin/lib/report-parser.cjs');
const { classifyRedEvidence } = require('../gsd-core/bin/lib/tdd-red-evidence.cjs');

// Independent report models are serialized as input, never derived from parser
// output. Shared fast-check setup supplies 200 runs, seed 42 and GSD_FC_SEED replay.
const label = fc.array(fc.constantFrom('a', 'Z', '7', '-', '_', 'ü'), { maxLength: 24 }).map(chars => chars.join(''));
const cases = statuses => fc.array(fc.record({ label, status: fc.constantFrom(...statuses) }), { minLength: 1, maxLength: 8 })
  .map(rows => rows.map((row, index) => ({ name: `case-${index}-${row.label}`, status: row.status })));
const tapCases = cases(['passed', 'failed', 'skipped', 'todo']);
const junitCases = cases(['passed', 'failed', 'skipped']);
const failedCases = tapCases.map(rows => [{ name: 'target', status: 'failed' }, ...rows]);
const failedXmlCases = junitCases.map(rows => [{ name: 'target', status: 'failed' }, ...rows]);
const evidence = (output, targetTest = 'target') => ({ command: 'custom-wrapper', exitCode: 1, output, targetTest });

function tapReport(rows, style = 'flat', planFirst = false) {
  const points = rows.map((row, index) => {
    const directive = row.status === 'skipped' ? ' # SKIP disabled' : row.status === 'todo' ? ' # TODO later' : '';
    return `${row.status === 'passed' ? 'ok' : 'not ok'} ${index + 1} - ${row.name}${directive}\n`;
  }).join('');
  const plan = `1..${rows.length}\n`;
  const body = planFirst ? plan + points : points + plan;
  if (style === 'flat') return `TAP version 13\n${body}`;
  const indented = body.split('\n').filter(Boolean).map(line => `    ${line}\n`).join('');
  const result = rows.some(row => row.status === 'failed') ? 'not ok' : 'ok';
  return style === 'buffered'
    ? `TAP version 13\n1..1\n${result} 1 - suite {\n${indented}}\n`
    : `TAP version 13\n# Subtest: suite\n${indented}${result} 1 - suite\n1..1\n`;
}

function xmlEscape(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function junitReport(rows, depth = 0, quote = '"') {
  const body = rows.map(row => {
    const opening = `<testcase classname=${quote}example.AppTest${quote} name=${quote}${xmlEscape(row.name)}${quote}`;
    if (row.status === 'passed') return `${opening}/>`;
    return `${opening}><${row.status === 'failed' ? 'failure' : 'skipped'}/></testcase>`;
  }).join('');
  let output = `<testsuite tests=${quote}${rows.length}${quote}>${body}</testsuite>`;
  for (let i = 0; i < depth; i++) output = `<testsuites tests=${quote}${rows.length}${quote}>${output}</testsuites>`;
  return output;
}

function assertBlocked(output) {
  const report = parseTestReport(output);
  assert.equal(report.valid, false, output);
  assert.ok(report.issues.length > 0);
  assert.equal(classifyRedEvidence(evidence(output)).verdict, 'INVALID_RED');
}

test('#4692 property: arbitrary report strings return a deterministic result without throwing', () => {
  fc.assert(fc.property(fc.string({ unit: 'binary', maxLength: 300 }), payload => {
    // Exercise both adapter entry points as well as unsupported raw output.
    for (const output of [payload, `TAP version 13\n${payload}`, `<testsuite>${payload}`]) {
      const report = parseTestReport(output);
      assert.deepEqual(parseTestReport(output), report);
      assert.equal(typeof report.valid, 'boolean');
      assert.ok(Array.isArray(report.tests));
      assert.ok(Array.isArray(report.issues));
      if (!report.valid) assert.equal(classifyRedEvidence(evidence(output)).verdict, 'INVALID_RED');
    }
  }));
});

test('#4692 property: empty and whitespace-only evidence never authorizes GREEN', () => {
  fc.assert(fc.property(fc.array(fc.constantFrom(' ', '\t', '\r', '\n'), { maxLength: 100 }), chars => {
    assertBlocked(chars.join(''));
    for (const output of ['TAP version 13\n1..0\n', '<testsuite tests="0"/>', '<testsuites/>']) {
      assert.equal(classifyRedEvidence(evidence(chars.join('') + output)).verdict, 'INVALID_RED');
    }
  }));
});

test('#4692 property: TAP round-trips leaf identities and statuses across flat, nested and buffered reports', () => {
  fc.assert(fc.property(tapCases, fc.boolean(), (rows, planFirst) => {
    for (const style of ['flat', 'nested', 'buffered']) {
      const output = tapReport(rows, style, planFirst);
      const report = parseTestReport(output);
      assert.equal(report.valid, true, report.issues.join('; '));
      assert.equal(report.format, 'tap');
      assert.deepEqual(report.tests.map(({ name, status }) => ({ name, status })), rows);
      for (const row of rows) {
        assert.equal(classifyRedEvidence(evidence(output, row.name)).verdict,
          row.status === 'failed' ? 'RED_EVIDENCE_OK' : 'INVALID_RED');
      }
    }
  }));
});

test('#4692 property: incomplete TAP prefixes cannot use a parsed target failure as RED evidence', () => {
  fc.assert(fc.property(failedCases, fc.nat(), (rows, cut) => {
    const output = tapReport(rows);
    assert.equal(classifyRedEvidence(evidence(output)).verdict, 'RED_EVIDENCE_OK');
    // Stop before the final plan, including the boundary after every assertion.
    const beforePlan = output.slice(0, output.lastIndexOf('1..'));
    assertBlocked(beforePlan);
    const prefix = beforePlan.slice(0, cut % (beforePlan.length + 1));
    // Header-only TAP can normalize to an empty report. It must still block;
    // once any assertion survives truncation, the missing plan is invalid.
    const truncated = parseTestReport(prefix);
    assert.ok(truncated.tests.length === 0 || !truncated.valid);
    assert.equal(classifyRedEvidence(evidence(prefix)).verdict, 'INVALID_RED');
    assertBlocked(`${beforePlan}1..${rows.length - 1}\n`);
    assertBlocked(`${beforePlan}1..${rows.length + 1}\n`);
  }));
});

test('#4692 property: a buffered TAP report needs its closing brace even after complete inner plans', () => {
  fc.assert(fc.property(failedCases, fc.boolean(), (rows, planFirst) => {
    const output = tapReport(rows, 'buffered', planFirst);
    assert.equal(classifyRedEvidence(evidence(output)).verdict, 'RED_EVIDENCE_OK');
    assertBlocked(output.slice(0, -2));
  }));
});

test('#4692 property: TAP bailouts and non-TAP garbage invalidate otherwise usable failures', () => {
  fc.assert(fc.property(failedCases, label, (rows, reason) => {
    const output = tapReport(rows);
    assert.equal(classifyRedEvidence(evidence(output)).verdict, 'RED_EVIDENCE_OK');
    assertBlocked(`${output}Bail out! ${reason}\n`);
    assertBlocked(`${output}SyntaxError: ${reason}\n`);
  }));
});

test('#4692 property: suite-level SKIP and TODO cannot promote nested failures to usable RED', () => {
  fc.assert(fc.property(failedCases, fc.constantFrom('SKIP', 'TODO'), (rows, directive) => {
    const output = tapReport(rows, 'nested');
    assert.equal(classifyRedEvidence(evidence(output)).verdict, 'RED_EVIDENCE_OK');
    const ignored = output.replace('not ok 1 - suite\n', `not ok 1 - suite # ${directive} deferred\n`);
    const report = parseTestReport(ignored);
    assert.equal(report.valid, true);
    assert.equal(report.tests.some(row => row.status === 'failed'), false);
    assert.equal(classifyRedEvidence(evidence(ignored)).verdict, 'INVALID_RED');
  }));
});

test('#4692 property: JUnit round-trips case identities and statuses through nested wrappers', () => {
  fc.assert(fc.property(junitCases, fc.integer({ min: 0, max: 3 }), fc.constantFrom('"', "'"), (rows, depth, quote) => {
    const output = junitReport(rows, depth, quote);
    const report = parseTestReport(output);
    assert.equal(report.valid, true, report.issues.join('; '));
    assert.equal(report.format, 'junit');
    assert.deepEqual(report.tests.map(({ name, status }) => ({ name, status })),
      rows.map(row => ({ name: `example.AppTest#${row.name}`, status: row.status })));
    for (const row of rows) {
      assert.equal(classifyRedEvidence(evidence(output, row.name)).verdict,
        row.status === 'failed' ? 'RED_EVIDENCE_OK' : 'INVALID_RED');
    }
  }));
});

test('#4692 property: XML attribute escaping preserves the exact failing test identity', () => {
  const text = fc.array(fc.constantFrom('a', '&', '<', '>', '"', "'", 'ü', '🧪'), { minLength: 1, maxLength: 30 });
  fc.assert(fc.property(text, fc.constantFrom('"', "'"), (chars, quote) => {
    const name = `target-${chars.join('')}`;
    const output = junitReport([{ name, status: 'failed' }], 0, quote);
    const report = parseTestReport(output);
    assert.equal(report.valid, true);
    assert.deepEqual(report.tests[0].identities, [name, `example.AppTest#${name}`]);
    assert.equal(classifyRedEvidence(evidence(output, name)).verdict, 'RED_EVIDENCE_OK');
  }));
});

test('#4692 property: every sampled proper JUnit prefix is invalid even after a complete failed testcase', () => {
  fc.assert(fc.property(failedXmlCases, fc.integer({ min: 0, max: 3 }), fc.nat(), (rows, depth, cut) => {
    const output = junitReport(rows, depth);
    assert.equal(classifyRedEvidence(evidence(output)).verdict, 'RED_EVIDENCE_OK');
    assertBlocked(output.slice(0, cut % output.length));
    assertBlocked(output.slice(0, -1));
    assertBlocked(output.slice(0, output.indexOf('</testcase>') + '</testcase>'.length));
  }));
});

test('#4692 property: malformed XML and mismatched suite counts cannot authorize GREEN', () => {
  fc.assert(fc.property(failedXmlCases, fc.integer({ min: 0, max: 3 }), (rows, depth) => {
    const output = junitReport(rows, depth);
    assert.equal(classifyRedEvidence(evidence(output)).verdict, 'RED_EVIDENCE_OK');
    assertBlocked(output.replace('</testcase>', '</wrong>'));
    assertBlocked(output.replace('name="target"', 'name="&undefined;"'));
    for (const count of [rows.length - 1, rows.length + 1]) {
      assertBlocked(output.replace(`tests="${rows.length}"`, `tests="${count}"`));
    }
  }));
});

// swift-testing and unittest print their aggregate summary last, so a
// truncated capture loses it before any usable failure can be proved.
const plainCases = cases(['passed', 'failed']).map(rows => [{ name: 'target', status: 'failed' }, ...rows]);
const swiftCases = cases(['passed', 'failed', 'skipped']).map(rows => [{ name: 'target', status: 'failed' }, ...rows]);

function swiftReport(rows) {
  const lines = rows.map(row => ({
    failed: `✘ Test "${row.name}" failed after 0.01 seconds with 1 issue.`,
    passed: `✔ Test "${row.name}" passed after 0.01 seconds.`,
    skipped: [
      `➜ Test "${row.name}" skipped.`,
      `➜ Test "${row.name}" skipped: "reason"`,
      `➜ Test "${row.name}" was cancelled after 0.01 seconds.`,
    ][row.name.length % 3],
  })[row.status]);
  const failures = rows.filter(row => row.status === 'failed').length;
  return [...lines, `✘ Test run with ${rows.length} tests in 1 suite failed after 0.02 seconds with ${failures} issues.`, ''].join('\n');
}

// A failing subTest repeats its method's header and adds to failures=, while
// Ran still counts the method once.
function unittestReport(rows) {
  const failed = rows.filter(row => row.status === 'failed');
  const blocks = failed.flatMap(row => Array.from({ length: 1 + (row.name.length % 3) }, (_, i) => [
    '======================================================================',
    `FAIL: ${row.name} (test_demo.AppTest.${row.name}) (i=${i})`,
    '----------------------------------------------------------------------',
    'AssertionError: boom',
    '',
  ]).flat());
  const headers = blocks.filter(line => line.startsWith('FAIL:')).length;
  return [...blocks, `Ran ${rows.length} tests in 0.010s`, '', `FAILED (failures=${headers})`, ''].join('\n');
}

test('#4692 property: swift-testing round-trips result lines and truncation before the summary is blocked', () => {
  fc.assert(fc.property(swiftCases, fc.nat(), (rows, cut) => {
    const output = swiftReport(rows);
    const report = parseTestReport(output);
    assert.equal(report.format, 'swift-testing');
    assert.equal(report.valid, true);
    assert.deepEqual(report.tests.map(({ name, status }) => ({ name, status })), rows);
    assert.equal(classifyRedEvidence(evidence(output)).verdict, 'RED_EVIDENCE_OK');
    const summary = output.indexOf('✘ Test run with');
    assertBlocked(output.slice(0, cut % (summary + 1)));
    assertBlocked(output.replace(/^.*"target".*\n/m, ''));
  }));
});

test('#4692 property: unittest failures must all be headed and truncation before the outcome is blocked', () => {
  fc.assert(fc.property(plainCases, fc.nat(), (rows, cut) => {
    const output = unittestReport(rows);
    const report = parseTestReport(output);
    const failed = rows.filter(row => row.status === 'failed').map(row => row.name);
    assert.equal(report.format, 'unittest');
    assert.equal(report.valid, true);
    assert.equal(report.tests.length, rows.length);
    assert.deepEqual(report.tests.filter(t => t.status === 'failed').map(t => t.name), failed);
    assert.equal(classifyRedEvidence(evidence(output)).verdict, 'RED_EVIDENCE_OK');
    assertBlocked(output.slice(0, cut % output.lastIndexOf(')')));
    assertBlocked(output.replace('FAIL: target (', 'FAIL: target (unittest.loader._FailedTest.'));
    assertBlocked(output.replace(/failures=(\d+)/, (_, n) => `failures=${Number(n) + 1}`));
  }));
});

// #5106 — go test. The model is the SET of failing test names; the serialization (verbose or not,
// one package or several) is independent of the parser, so a parser that mis-reads any of them
// disagrees with the model rather than with itself.
const goNames = fc.uniqueArray(fc.constantFrom('TestA', 'TestB', 'TestC', 'TestD', 'TestE', 'TestF'), { minLength: 1, maxLength: 6 });
const goRun = fc.record({ names: goNames, failMask: fc.array(fc.boolean(), { minLength: 6, maxLength: 6 }), verbose: fc.boolean() });

function goOutput(run) {
  const rows = run.names.map((name, i) => ({ name, failed: run.failMask[i] }));
  if (!rows.some(r => r.failed)) rows[0].failed = true;
  const lines = [];
  for (const r of rows) {
    if (run.verbose) lines.push(`=== RUN   ${r.name}`);
    if (r.failed) lines.push(`--- FAIL: ${r.name} (0.00s)`, '    x_test.go:1: nope');
    else if (run.verbose) lines.push(`--- PASS: ${r.name} (0.00s)`);
  }
  lines.push('FAIL', 'FAIL\texample.com/p\t0.001s', 'FAIL', '');
  return { output: lines.join('\n'), failed: rows.filter(r => r.failed).map(r => r.name) };
}

test('property: a go test report yields exactly the failing-name set, verbose or not', () => {
  fc.assert(fc.property(goRun, (run) => {
    const { output, failed } = goOutput(run);
    const report = parseTestReport(output);
    assert.equal(report.format, 'go-test');
    assert.equal(report.valid, true, report.issues.join('; '));
    assert.deepEqual(report.tests.filter(t => t.status === 'failed').map(t => t.name).sort(), [...failed].sort());
    for (const name of run.names) {
      const verdict = classifyRedEvidence({ command: 'go test', exitCode: 1, output, targetTest: name }).verdict;
      assert.equal(verdict, failed.includes(name) ? 'RED_EVIDENCE_OK' : 'INVALID_RED', name);
    }
  }));
});

test('property: arbitrary go-shaped noise never throws and never accepts without a failing target', () => {
  const noise = fc.array(fc.constantFrom('--- FAIL: TestA (0.00s)', '--- PASS: TestB (0.00s)', 'FAIL', 'ok  \tp\t0.1s', 'FAIL\tp [build failed]', '=== RUN   TestA', 'panic: x', '', '    --- FAIL: TestA/s (0.01s)'), { maxLength: 12 }).map(l => l.join('\n'));
  fc.assert(fc.property(noise, (output) => {
    const result = classifyRedEvidence({ command: 'go test', exitCode: 1, output, targetTest: 'TestA' });
    if (result.verdict === 'RED_EVIDENCE_OK') {
      assert.ok(result.evidence.failing_tests.includes('TestA'));
      assert.ok(!/\[build failed\]/.test(output));
    }
  }));
});

test('#5721 property: a file-named load-failure entry is never a RED target; the real failure still is', () => {
  const ext = fc.constantFrom('.test.js', '.spec.ts', '.test.mjs', '.test.cts', '.spec.mts', '.test.tsx', '.test.jsx');
  const stem = fc.array(fc.constantFrom('a', 'Z', '7', '-', '_'), { minLength: 1, maxLength: 12 }).map(c => c.join(''));
  // equal classname/name is the load-failure shape; any differing pair is a real test (and so a valid target).
  fc.assert(fc.property(stem, ext, stem, fc.boolean(), (loadStem, extension, realStem, same) => {
    const file = `L${loadStem}${extension}`;
    const real = `R${realStem}`;
    const sibling = `${file}x`;
    const pair = parseTestReport(`<testsuite tests="1"><testcase classname="${file}" name="${same ? file : sibling}"><failure/></testcase></testsuite>`);
    assert.equal(pair.tests[0].loadFailure === true, same);
    const output = `<testsuites><testsuite tests="1"><testcase classname="${file}" name="${file}"><failure/></testcase></testsuite>`
      + `<testsuite tests="1"><testcase classname="ok.test.js" name="${real}"><failure/></testcase></testsuite></testsuites>`;
    const load = classifyRedEvidence(evidence(output, file));
    assert.equal(load.verdict, 'INVALID_RED');
    assert.equal(load.evidence.matched_test, null);
    assert.equal(classifyRedEvidence(evidence(output, real)).verdict, 'RED_EVIDENCE_OK');
  }));
});

test('#5721 property: classname "Test suite failed to run" is always flagged, whatever the name', () => {
  const name = fc.string({ unit: fc.constantFrom('a', 'Z', '7', '-', '_', ' ', '.', '#', '>', 'ü'), maxLength: 30 });
  fc.assert(fc.property(name, (title) => {
    const report = parseTestReport(`<testsuite tests="1"><testcase classname="Test suite failed to run" name="${xmlEscape(title)}"><error/></testcase></testsuite>`);
    assert.equal(report.tests[0].loadFailure, true);
  }));
});

// #5819: node:test repeats error/stack keys in an assert.throws(fn, /re/)
// diagnostic block. Tolerance for exactly that defect must not change the
// target-failure judgment (accept), must not soften interruption refusals, and
// must never recover a block whose repeated key is the interruption signal.
const INTERRUPTION_ERROR = 'Test run interrupted by cancellation, hook failure, or timeout';

// Bare labels may be empty (maxLength only); names and scalar values below must not be.
const word = label.map(chars => chars.length > 0 ? chars : 'x');

function dupDiagReport(target, { failureType = "  failureType: 'testCodeFailure'", messages } = {}) {
  const [e1, e2, s1, s2] = messages;
  return [
    'TAP version 13',
    `# Subtest: ${target}`,
    `not ok 1 - ${target}`,
    '  ---',
    '  duration_ms: 0.5',
    failureType,
    `  error: '${e1}'`,
    `  error: '${e2}'`,
    `  stack: '${s1}'`,
    `  stack: '${s2}'`,
    '  ...',
    '1..1\n',
  ].join('\n');
}

test('#5819 property: repeated error/stack diagnostic keys keep the target-failure judgment', () => {
  fc.assert(fc.property(word, word, word, word, word, (target, e1, e2, s1, s2) => {
    const output = dupDiagReport(target, { messages: [e1, e2, s1, s2] });
    const report = parseTestReport(output);
    assert.equal(report.valid, true, report.issues.join('; '));
    assert.deepEqual(report.tests.map(({ name, status }) => ({ name, status })), [{ name: target, status: 'failed' }]);
    const result = classifyRedEvidence(evidence(output, target));
    assert.equal(result.verdict, 'RED_EVIDENCE_OK');
    assert.equal(result.reason, 'target_test_failed');
    assert.equal(result.evidence.matched_test, target);
    assert.deepEqual(result.evidence.report_errors, []);
    // Review finding: the old determinism assertion compared two parses of the same
    // string, which cannot fail unless the parser keeps hidden state. The invariant
    // that matters: the recovered judgment equals the SINGLE-KEY control for the same
    // target — recovery changes nothing about which failure proves RED.
    const controlOutput = [
      'TAP version 13',
      `# Subtest: ${target}`,
      `not ok 1 - ${target}`,
      '  ---',
      '  duration_ms: 0.5',
      "  failureType: 'testCodeFailure'",
      `  error: '${e1}'`,
      `  stack: '${s1}'`,
      '  ...',
      '1..1\n',
    ].join('\n');
    const control = classifyRedEvidence(evidence(controlOutput, target));
    assert.equal(control.verdict, result.verdict);
    assert.equal(control.reason, result.reason);
    assert.equal(control.evidence.matched_test, result.evidence.matched_test);
  }));
});

test('#5819 property: a recovered block still refuses every interruption failureType', () => {
  fc.assert(fc.property(word, fc.constantFrom('testTimeoutFailure', 'cancelledByParent', 'hookFailed'), (target, failureType) => {
    const output = dupDiagReport(target, {
      failureType: `  failureType: '${failureType}'`,
      messages: ['ran the test', 'ran the test', 'frame one', 'frame two'],
    });
    const result = classifyRedEvidence(evidence(output, target));
    assert.equal(result.verdict, 'INVALID_RED');
    assert.equal(result.reason, 'invalid_record');
    assert.deepEqual(result.evidence.report_errors, [INTERRUPTION_ERROR]);
  }));
});

test('#5819 property: a repeated failureType key is never recovered, in any spelling', () => {
  // Review finding: the property generated only the plain spelling. The second key is
  // now drawn from every double-quoted escape form js-yaml decodes to failureType.
  const BS = String.fromCharCode(92);
  const spellings = [
    'failureType',
    `"failureType"`,
    `'failureType'`,
    `"${BS}x66ailureType"`,
    `"${BS}u0066ailureType"`,
    `"${BS}U00000066ailureType"`,
  ];
  fc.assert(fc.property(word, fc.constantFrom(...spellings), (target, secondKey) => {
    const output = dupDiagReport(target, {
      failureType: `  failureType: 'testTimeoutFailure'\n  ${secondKey}: 'testCodeFailure'`,
      messages: ['ran the test', 'ran the test', 'frame one', 'frame two'],
    });
    assertBlocked(output);
    assert.ok(parseTestReport(output).issues.includes('Malformed TAP'));
  }));
});

// Third review finding: the masked-signature guard (#5721 per-write judgment) needs
// a property. The generator writes the load-failure signature keys first and a
// benign value last, in either key order; the block must always be refused.
test('#5819 property: a masked load-failure signature is never recovered, in either key order', () => {
  const maskedDiagReport = (target, benignError, benignCode, codeFirst) => [
    'TAP version 13',
    `# Subtest: ${target}`,
    `not ok 1 - ${target}`,
    '  ---',
    '  duration_ms: 0.5',
    "  failureType: 'testCodeFailure'",
    ...(codeFirst
      ? ["  code: 'ERR_TEST_FAILURE'", `  error: 'test failed'`]
      : ["  error: 'test failed'", "  code: 'ERR_TEST_FAILURE'"]),
    `  error: '${benignError}'`,
    `  code: '${benignCode}'`,
    '  ...',
    '1..1\n',
  ].join('\n');
  fc.assert(fc.property(word, word, word, fc.boolean(), (target, benignError, benignCode, codeFirst) => {
    const output = maskedDiagReport(target, benignError, benignCode, codeFirst);
    assertBlocked(output);
    assert.ok(parseTestReport(output).issues.includes('Malformed TAP'));
  }));
});
