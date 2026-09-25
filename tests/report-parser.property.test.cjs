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
