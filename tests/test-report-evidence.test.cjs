'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setImmediate: yieldToReporter } = require('node:timers/promises');
const { cleanup, runGsdTools } = require('./helpers.cjs');
const { runMinimalInstall } = require('./helpers/install-shared.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { throwIfFailed } = require('./helpers/git-fixture.cjs');
const { classifyRedEvidence, buildRedEvidenceRecord } = require('../gsd-core/bin/lib/tdd-red-evidence.cjs');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures/tdd-red-evidence', name), 'utf8');
const input = (output, overrides = {}) => ({
  command: 'npm run --silent test', exitCode: 1, output,
  targetTest: 'rejects empty email', targetFile: 'evidence.test.js', ...overrides,
});

test('#4692: a real nested Vitest TAP report proves the target failure without Node summary comments', () => {
  const result = classifyRedEvidence(input(fixture('vitest.tap')));
  assert.equal(result.verdict, 'RED_EVIDENCE_OK');
  assert.equal(result.evidence.tests, 2);
  assert.equal(result.evidence.pass, 1);
  assert.equal(result.evidence.fail, 1);
  assert.deepEqual(result.evidence.failing_tests, ['rejects empty email']);
});

test('#4692: an XML report truncated after the target failure cannot authorize GREEN', () => {
  const result = classifyRedEvidence(input(
    '<testsuite><testcase name="rejects empty email"><failure message="expected 2"/></testcase>',
  ));
  assert.equal(result.verdict, 'INVALID_RED');
});

test('#4692: a failed assertion inside a TODO suite is not usable RED evidence', () => {
  const report = 'TAP version 13\n# Subtest: future\n    not ok 1 - rejects empty email\n    1..1\nnot ok 1 - future # TODO later\n1..1\n';
  assert.equal(classifyRedEvidence(input(report)).verdict, 'INVALID_RED');
});

for (const [report, target] of [
  ['node.tap', 'rejects empty email'],
  ['vitest.tap', 'evidence.test.js > email validation > rejects empty email'],
  ['vitest-flat.tap', 'evidence.test.js > email validation > rejects empty email'],
]) {
  test(`#4692: ${report} accepts the target independent of the command spelling`, () => {
    const result = classifyRedEvidence(input(fixture(report), { targetTest: target, command: 'custom-wrapper tests' }));
    assert.equal(result.verdict, 'RED_EVIDENCE_OK');
    assert.equal(result.evidence.tests, 2);
    assert.equal(result.evidence.fail, 1);
    assert.equal(result.evidence.format, 'tap');
  });
}

const tap = (body) => `TAP version 13\n${body}\n`;
for (const [name, output] of [
  ['skipped target', tap('not ok 1 - rejects empty email # SKIP disabled\n1..1')],
  ['TODO target', tap('not ok 1 - rejects empty email # TODO later\n1..1')],
  ['bailout after failure', tap('not ok 1 - rejects empty email\nBail out! crashed\n1..1')],
  ['missing plan after failure', tap('not ok 1 - rejects empty email')],
  ['incomplete plan', tap('1..2\nnot ok 1 - rejects empty email')],
  ['too many test points', tap('1..1\nnot ok 1 - rejects empty email\nok 2 - surplus')],
  ['garbage after valid report', tap('not ok 1 - rejects empty email\n1..1\nSyntaxError: crashed')],
  ['strictness disabled by report', tap('pragma -strict\nnot ok 1 - rejects empty email\n1..1\nSyntaxError: crashed')],
  ['suite summary named as target', fixture('vitest.tap').replaceAll('email validation', 'rejects empty email').replace('not ok 1 - rejects empty email # time=4.67ms', 'not ok 1 - unrelated assertion # time=4.67ms')],
  ['truncated buffered suite', fixture('vitest.tap').slice(0, -4)],
  ['passing target with unrelated failure', tap('ok 1 - rejects empty email\nnot ok 2 - unrelated\n1..2')],
  ['unknown report format', 'FAIL rejects empty email: expected 2, received 1'],
  ['cancelled target', tap("not ok 1 - rejects empty email\n  ---\n  failureType: cancelledByParent\n  ...\n1..1")],
]) {
  test(`#4692: ${name} cannot authorize GREEN`, () => {
    assert.equal(classifyRedEvidence(input(output)).verdict, 'INVALID_RED');
  });
}

test('#4692: optional summary comments cannot override actual TAP test results', () => {
  const result = classifyRedEvidence(input(tap('not ok 1 - rejects empty email\n1..1\n# tests 0\n# fail 0')));
  assert.equal(result.verdict, 'RED_EVIDENCE_OK');
  assert.equal(result.evidence.tests, 1);
  assert.equal(result.evidence.fail, 1);
});

test('#4692: an ambiguous leaf name needs a qualified TAP identity', () => {
  const output = tap('# Subtest: first\n    not ok 1 - rejects empty email\n    1..1\nnot ok 1 - first\n# Subtest: second\n    ok 1 - rejects empty email\n    1..1\nok 2 - second\n1..2');
  assert.equal(classifyRedEvidence(input(output)).reason, 'no_target_test_failure');
  assert.equal(classifyRedEvidence(input(output, { targetTest: 'first > rejects empty email' })).verdict, 'RED_EVIDENCE_OK');
});

test('#4692: TAP assertion text containing XML tags does not select the XML adapter', () => {
  const targetTest = 'expected <testsuite><testcase> value';
  assert.equal(classifyRedEvidence(input(tap(`not ok 1 - ${targetTest}\n1..1`), { targetTest })).verdict, 'RED_EVIDENCE_OK');
});

const xmlCase = (cls, name, body = '') => `<testcase classname="${cls}" name="${name}">${body}</testcase>`;
const failure = '<failure message="expected 2">received 1</failure>';
const xml = (...cases) => `<testsuite tests="${cases.length}">${cases.join('')}</testsuite>`;

test('#4692: a JUnit class target can contain several methods and persists the matching failure', () => {
  const record = input(xml(
    xmlCase('other.Unrelated', 'first failure', failure),
    xmlCase('example.AppTest', 'passes'),
    xmlCase('example.AppTest', 'rejects empty email', failure),
  ), { targetTest: 'AppTest', command: 'mvn test' });
  const result = classifyRedEvidence(record);
  assert.equal(result.verdict, 'RED_EVIDENCE_OK');
  assert.equal(result.evidence.tests, 3);
  assert.equal(result.evidence.format, 'junit');
  assert.equal(buildRedEvidenceRecord(record, result).failing_test, 'example.AppTest#rejects empty email');
});

test('#4692: an ambiguous JUnit class name requires the fully qualified class', () => {
  const output = xml(xmlCase('one.AppTest', 'a', failure), xmlCase('two.AppTest', 'b'));
  assert.equal(classifyRedEvidence(input(output, { targetTest: 'AppTest' })).verdict, 'INVALID_RED');
  assert.equal(classifyRedEvidence(input(output, { targetTest: 'one.AppTest' })).verdict, 'RED_EVIDENCE_OK');
});

test('#4692: JUnit decodes attribute entities and supports single quotes and nested suites', () => {
  const output = "<?xml version='1.0'?><testsuites><testsuite tests='1'><testsuite tests='1'><testcase classname='AppTest' name='rejects &lt;empty&gt;'><failure/></testcase></testsuite></testsuite></testsuites>";
  const result = classifyRedEvidence(input(output, { targetTest: 'rejects <empty>' }));
  assert.equal(result.verdict, 'RED_EVIDENCE_OK');
  assert.deepEqual(result.evidence.failing_tests, ['AppTest#rejects <empty>']);
});

for (const [name, output] of [
  ['skipped target', xml(xmlCase('AppTest', 'rejects empty email', '<skipped/>'))],
  ['contradictory skipped failure', xml(xmlCase('AppTest', 'rejects empty email', '<skipped/>' + failure))],
  ['incomplete wrapper count', '<testsuites tests="2">' + xml(xmlCase('AppTest', 'rejects empty email', failure)) + '</testsuites>'],
  ['incomplete suite count', '<testsuite tests="2">' + xmlCase('AppTest', 'rejects empty email', failure) + '</testsuite>'],
  ['non-JUnit XML root', '<log><testsuite>' + xmlCase('AppTest', 'rejects empty email', failure) + '</testsuite></log>'],
  ['DTD declaration', '<!DOCTYPE testsuite [<!ENTITY x "value">]>' + xml(xmlCase('AppTest', 'rejects empty email', failure))],
  ['captured failure markup', xml(xmlCase('AppTest', 'rejects empty email', '<system-out><![CDATA[<failure/>]]></system-out>'))],
  ['failure in an XML comment', xml(xmlCase('AppTest', 'rejects empty email', '<!-- <failure/> -->'))],
]) {
  test(`#4692: JUnit ${name} cannot authorize GREEN`, () => {
    assert.equal(classifyRedEvidence(input(output)).verdict, 'INVALID_RED');
  });
}

test('#4692: the CLI accepts Vitest TAP and returns the same blocking verdict with and without --raw', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'report-adapter-'));
  try {
    const record = path.join(root, 'record.json');
    for (const [output, expected] of [[fixture('vitest.tap'), true], [tap('not ok 1 - rejects empty email'), false]]) {
      fs.writeFileSync(record, JSON.stringify(input(output)));
      for (const flags of [[], ['--raw']]) {
        const result = runGsdTools(['check', 'tdd-red-evidence', record, ...flags], root);
        assert.ok(result.success, result.error);
        const payload = JSON.parse(result.output);
        assert.equal(payload.passed, expected);
        assert.equal(payload.block, !expected);
      }
    }
  } finally { cleanup(root); }
});

for (const runtime of ['claude', 'codex', 'antigravity']) {
  test(`#4692: ${runtime} installed runtime validates TAP and XML without node_modules`, async () => {
    const { root, configDir } = runMinimalInstall({ runtime, scope: 'global' });
    try {
      assert.equal(fs.existsSync(path.join(configDir, 'node_modules')), false);
      for (const name of ['tap-parser', 'saxes']) {
        assert.ok(fs.existsSync(path.join(configDir, `gsd-core/bin/lib/vendor/${name}.cjs.LICENSE.txt`)));
      }
      const record = path.join(root, 'record.json');
      const cli = path.join(configDir, 'gsd-core/bin/gsd-tools.cjs');
      for (const output of [fixture('vitest.tap'), xml(xmlCase('AppTest', 'rejects empty email', failure))]) {
        fs.writeFileSync(record, JSON.stringify(input(output)));
        const result = runNode([cli, 'check', 'tdd-red-evidence', record, '--raw'], { cwd: root, env: { ...process.env, NODE_PATH: '' } });
        throwIfFailed(result, 'installed RED-evidence classifier');
        assert.equal(JSON.parse(result.stdout).verdict, 'RED_EVIDENCE_OK');
      }
    } finally {
      cleanup(root);
      // The test runner uses --test-force-exit. Let its reporter drain between
      // synchronous installer/CLI subprocesses instead of losing trailing results.
      await yieldToReporter();
    }
  });
}
