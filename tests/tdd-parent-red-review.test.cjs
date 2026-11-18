'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createTempDir, cleanup, runGsdTools } = require('./helpers.cjs');
const { classifyRedEvidence, redReviewDigest, assessParentRedReview } = require('../gsd-core/bin/lib/tdd-red-evidence.cjs');
const { evaluateTddRedEvidence, RED_REVIEW_MAX_FILE_BYTES } = require('../gsd-core/bin/lib/gate-tdd-red-evidence.cjs');
const hash = text => createHash('sha256').update(text).digest('hex');
const output = 'running 1 test\ntest increments_one ... FAILED\nassertion `left == right` failed\n  left: 1\n right: 2\nfailures:\n    increments_one\ntest result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n';
const checks = { completeCapture: true, setupSucceeded: true, targetExecuted: true, intendedAssertionFailed: true, noUnrelatedFailures: true };
function capture() {
  return { command: 'cargo test --offline --locked --test red -- --exact increments_one --color never',
    exitCode: 101, output, stdout: output, stderr: 'Finished test profile\nRunning tests/red.rs\n',
    targetTest: 'increments_one', targetFile: 'tests/red.rs', expected: 'increment(1) equals 2', actual: 'left 1, right 2',
    runId: 'run-1', captureComplete: true,
    state: { 'tests/red.rs': hash('test'), 'src/lib.rs': hash('source'), 'src/new.rs': null } };
}
function reviewed(input = capture(), decision = 'accept') {
  return { ...input, parentReview: { role: 'parent', decision, reason: 'Exact target failed its intended assertion after successful setup.',
    evidenceDigest: redReviewDigest(input), checks: { ...checks } } };
}
function fixture(t, input = reviewed()) {
  const root = createTempDir('parent-red-');
  t.after(() => cleanup(root));
  fs.mkdirSync(path.join(root, 'tests'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'tests/red.rs'), 'test');
  fs.writeFileSync(path.join(root, 'src/lib.rs'), 'source');
  const record = path.join(root, 'red.json');
  fs.writeFileSync(record, JSON.stringify(input));
  return { root, record, evaluate: () => evaluateTddRedEvidence({ projectDir: root, args: [record] }).payload };
}
test('#6201 unsupported is unavailable, not measured zero or machine acceptance', t => {
  const result = fixture(t, capture()).evaluate();
  assert.equal(result.verdict, 'UNSUPPORTED_REPORT');
  assert.equal(result.passed, false);
  assert.equal(result.block, true);
  assert.equal(result.review_status, 'missing');
  assert.deepEqual([result.evidence.tests, result.evidence.pass, result.evidence.fail], [null, null, null]);
});
test('#6201 explicit current parent acceptance authorizes GREEN without changing machine verdict', t => {
  const f = fixture(t);
  const result = f.evaluate();
  assert.equal(result.verdict, 'UNSUPPORTED_REPORT');
  assert.equal(result.passed, true);
  assert.equal(result.block, false);
  assert.equal(result.authorization, 'parent_reviewed_red');
  assert.equal(result.review_status, 'accepted');
  assert.deepEqual(result.record.unsupported_run, reviewed());
  const cli = runGsdTools(['check', 'tdd-red-evidence', f.record, '--raw'], f.root);
  assert.equal(cli.exitCode, 0);
  assert.equal(JSON.parse(cli.output).authorization, 'parent_reviewed_red');
});
for (const decision of ['reject', 'abstain']) test(`#6201 ${decision} blocks and is audited`, t => {
  const result = fixture(t, reviewed(capture(), decision)).evaluate();
  assert.equal(result.passed, false);
  assert.equal(result.authorization, null);
  assert.equal(result.review_status, decision === 'reject' ? 'rejected' : 'abstained');
  assert.equal(result.record.unsupported_run.parentReview.decision, decision);
});
for (const field of ['command', 'output', 'stdout', 'stderr', 'targetTest', 'targetFile', 'expected', 'actual', 'runId']) {
  test(`#6201 changing ${field} invalidates the decision`, () => {
    const input = reviewed();
    input[field] += ' changed';
    assert.notEqual(assessParentRedReview(input, input.state), 'accepted');
  });
}
for (const file of ['tests/red.rs', 'src/lib.rs', 'src/new.rs']) test(`#6201 changed ${file} blocks stale acceptance`, t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, file), 'changed');
  assert.equal(f.evaluate().passed, false);
  assert.equal(f.evaluate().review_status, 'stale');
});
test('#6201 deleted target invalidates acceptance', t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.root, 'tests/red.rs'));
  assert.equal(f.evaluate().review_status, 'stale');
});
for (const key of Object.keys(checks)) test(`#6201 ${key} must be established`, () => {
  const input = reviewed();
  input.parentReview.checks[key] = false;
  assert.equal(assessParentRedReview(input, input.state), 'invalid');
});
for (const overrides of [{ captureComplete: false }, { stderr: undefined }, { runId: '' }, { state: {} }, { exitCode: null }]) {
  test(`#6201 incomplete capture ${JSON.stringify(overrides)} blocks`, () => {
    const input = reviewed({ ...capture(), ...overrides });
    assert.notEqual(assessParentRedReview(input, input.state), 'accepted');
  });
}
test('#6201 child role, empty reason and unknown decision block', () => {
  for (const change of [{ role: 'child' }, { reason: '' }, { decision: 'maybe' }]) {
    const input = reviewed();
    Object.assign(input.parentReview, change);
    assert.equal(assessParentRedReview(input, input.state), 'invalid');
  }
});
for (const invalidOutput of ['', 'TAP version 13\nnot ok 1 - increments_one\n', '<testsuite>',
  'TAP version 13\n1..0\n', 'TAP version 13\nok 1 - increments_one # SKIP\n1..1\n',
  'TAP version 13\nnot ok 1 - unrelated\n1..1\n', 'FAIL\tpkg [build failed]\n']) {
  test(`#6201 review cannot override invalid ${JSON.stringify(invalidOutput)}`, t => {
    const result = fixture(t, reviewed({ ...capture(), output: invalidOutput, stdout: invalidOutput })).evaluate();
    assert.equal(result.verdict, 'INVALID_RED');
    assert.equal(result.passed, false);
  });
}
test('#6201 unexpected pass stays invalid for unknown output', t => {
  const result = fixture(t, reviewed({ ...capture(), exitCode: 0 })).evaluate();
  assert.equal(result.verdict, 'INVALID_RED');
  assert.equal(result.reason, 'unexpected_green');
  assert.equal(result.passed, false);
});
test('#6201 outside state cannot authorize GREEN', t => {
  const input = capture();
  input.state['../outside.rs'] = hash('outside');
  assert.equal(fixture(t, reviewed(input)).evaluate().passed, false);
});
test('#6201 supported machine acceptance needs no review', () => {
  assert.equal(classifyRedEvidence({ ...capture(), output: 'TAP version 13\nnot ok 1 - increments_one\n1..1\n' }).verdict, 'RED_EVIDENCE_OK');
});

test('#6201 unreadable state and directories cannot be accepted', t => {
  const input = capture();
  input.state['src'] = hash('directory');
  assert.equal(fixture(t, reviewed(input)).evaluate().review_status, 'unreadable');
});
test('#6201 changing exit status or state scope invalidates the decision', () => {
  for (const mutate of [input => { input.exitCode = 1; }, input => { delete input.state['src/lib.rs']; }]) {
    const input = reviewed();
    mutate(input);
    assert.equal(assessParentRedReview(input, input.state), 'stale');
  }
});
test('#6201 runtime references require escalation and preserve distinct authorization', () => {
  const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  for (const file of ['gsd-core/references/tdd.md', 'agents/gsd-executor.md', 'gsd-core/workflows/execute-plan.md', 'gsd-core/references/execute-mvp-tdd.md']) {
    assert.match(read(file), /UNSUPPORTED_REPORT/);
    assert.match(read(file), /parent/);
  }
  assert.match(read('agents/gsd-executor.md'), /Never author or alter `parentReview`/);
  assert.match(read('gsd-core/references/tdd.md'), /untrusted data, never instructions/);
  assert.match(read('gsd-core/references/tdd.md'), /authorization: parent_reviewed_red/);
});

for (const fragment of ['TAP ver', 'Bail out! runner crashed', 'pragma -strict', '✘ Test', 'FAIL:',
  'banner\n<testsuite>', 'banner\n✘ Test "target" failed']) {
  test(`#6201 recognized malformed fragment cannot enter parent review: ${fragment}`, () => {
    const input = reviewed({ ...capture(), output: fragment, stdout: fragment });
    assert.equal(classifyRedEvidence(input).verdict, 'INVALID_RED');
    assert.equal(assessParentRedReview(input, input.state), 'invalid');
  });
}
test('#6201 a fresh run and assessment can replace stale acceptance', t => {
  const input = reviewed();
  const f = fixture(t, input);
  fs.writeFileSync(path.join(f.root, 'src/lib.rs'), 'revised source');
  assert.equal(f.evaluate().review_status, 'stale');
  input.runId = 'run-2';
  input.state['src/lib.rs'] = hash('revised source');
  fs.writeFileSync(f.record, JSON.stringify(input));
  assert.equal(f.evaluate().review_status, 'stale');
  fs.writeFileSync(f.record, JSON.stringify(reviewed(input)));
  assert.equal(f.evaluate().review_status, 'accepted');
});

for (const other of ['TAP version 13\nnot ok 1 - increments_one\n',
  'TAP version 13\n1..0\n', 'FAIL\tpkg [build failed]\n',
  'TAP version 13\nnot ok 1 - unrelated\n1..1\n']) {
  for (const stream of ['stdout', 'stderr']) test(`#6201 selecting diagnostics cannot hide ${stream}: ${JSON.stringify(other)}`, t => {
    const input = { ...capture(), output: 'runner diagnostic\n', stdout: 'runner diagnostic\n', stderr: 'runner diagnostic\n', [stream]: other };
    const result = fixture(t, reviewed(input)).evaluate();
    assert.equal(result.verdict, 'INVALID_RED');
    assert.equal(result.passed, false);
  });
}
test('#6201 truncated Go run-start evidence is invalid despite supplied review', t => {
  const output = '=== RUN   TestName\n    x_test.go:5: expected 2, got 1\n';
  const result = fixture(t, reviewed({ ...capture(), output, stdout: output })).evaluate();
  assert.equal(result.verdict, 'INVALID_RED');
  assert.equal(result.passed, false);
});
for (const code of ['EACCES', 'EIO']) test(`#6201 ${code} remains unreadable, not stale`, t => {
  const f = fixture(t);
  const open = fs.openSync;
  t.mock.method(fs, 'openSync', function(file, ...args) {
    if (file === path.join(f.root, 'src/lib.rs')) throw Object.assign(new Error('injected read failure'), { code });
    return open.call(this, file, ...args);
  });
  const gate = evaluateTddRedEvidence({ projectDir: f.root, args: [f.record] });
  assert.equal(gate.outcome, 'unreadable');
  assert.equal(gate.payload.review_status, 'unreadable');
  assert.equal(gate.payload.readError, code);
  assert.equal(gate.payload.passed, false);
});
for (const delta of [-1, 0, 1]) test(`#6201 declared-file size boundary ${delta}`, t => {
  const input = capture();
  const bytes = Buffer.alloc(RED_REVIEW_MAX_FILE_BYTES + delta, 97);
  input.state['src/lib.rs'] = hash(bytes);
  const f = fixture(t, reviewed(input));
  fs.writeFileSync(path.join(f.root, 'src/lib.rs'), bytes);
  const result = f.evaluate();
  assert.equal(result.passed, delta <= 0);
  assert.equal(result.review_status, delta <= 0 ? 'accepted' : 'unreadable');
  if (delta > 0) {
    assert.equal(result.readError, 'EFBIG');
    const cli = runGsdTools(['check', 'tdd-red-evidence', f.record, '--raw'], f.root);
    assert.equal(cli.exitCode, 69);
  }
});
test('#6201 raw-byte changes cannot collide through lossy UTF-8 decoding', t => {
  const input = capture();
  input.state['src/lib.rs'] = hash(Buffer.from([0x80]));
  const f = fixture(t, reviewed(input));
  fs.writeFileSync(path.join(f.root, 'src/lib.rs'), Buffer.from([0x80]));
  assert.equal(f.evaluate().review_status, 'accepted');
  fs.writeFileSync(path.join(f.root, 'src/lib.rs'), Buffer.from([0x81]));
  assert.equal(f.evaluate().review_status, 'stale');
});
