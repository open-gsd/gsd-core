const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runGsdTools, cleanup, TEST_ENV_BASE } = require('./helpers.cjs');
const processSeam = require('./helpers/process-seam.cjs');
const { createFixture, seedPhase } = require('./fixtures/index.cjs');

describe('planning threat-ID revision issues from fresh plans', () => {
  let root;
  const fragment = path.join(__dirname, '..', 'gsd-core/workflows/plan-phase/steps/threat-id-check.md');
  const content = fs.readFileSync(fragment, 'utf8');
  const marker = "THREAT_SCAN=\"$THREAT_SCAN\" node -e '";
  const start = content.indexOf(marker);
  assert.ok(start >= 0, 'the shipped scan must contain the issue projection');
  const end = content.indexOf("'", start + marker.length);
  assert.ok(end > start + marker.length, 'the shipped projection must be delimited');
  const source = content.slice(start + marker.length, end);
  beforeEach(() => { root = fs.realpathSync(createFixture()); });
  afterEach(() => cleanup(root));
  function plan(id) {
    return `---\nphase: 47\nplan: 01\n---\n<threat_model>\n| Threat ID | Category |\n|---|---|\n| ${id} | Tampering |\n| T-47-SC | Tampering |\n</threat_model>\n`;
  }
  function scan() {
    const result = runGsdTools('init plan-phase 47', root);
    assert.ok(result.success, result.error);
    const parsed = processSeam.runNode(['-e', source], { cwd: root, env: { ...TEST_ENV_BASE, THREAT_SCAN: result.output } });
    assert.equal(parsed.exitCode, 0, parsed.stderr);
    return JSON.parse(parsed.stdout);
  }
  test('zero register claimants produces no revision issues', () => {
    seedPhase(root, '47-security', { '47-01-PLAN.md': '# No register' });
    assert.deepEqual(scan(), []);
  });
  test('one claimant produces no revision issues', () => {
    seedPhase(root, '47-security', { '47-01-PLAN.md': plan('T-47-01') });
    assert.deepEqual(scan(), []);
  });
  test('fresh scan catches a second claimant written after initialization', () => {
    seedPhase(root, '47-security', { '47-01-PLAN.md': plan('T-47-01') });
    assert.deepEqual(scan(), []);
    seedPhase(root, '47-security', { '47-02-PLAN.md': plan('T-47-01') });
    const issues = scan();
    assert.equal(issues.length, 1);
    assert.equal(issues[0].severity, 'blocker');
    assert.equal(issues[0].dimension, 'threat_id_uniqueness');
    assert.equal(issues[0].plan, '47-01-PLAN.md, 47-02-PLAN.md');
    assert.match(issues[0].description, /T-47-01/);
  });
  test('distinct rows and shared reserved SC produce no revision issues', () => {
    seedPhase(root, '47-security', { '47-01-PLAN.md': plan('T-47-01'), '47-02-PLAN.md': plan('T-47-02') });
    assert.deepEqual(scan(), []);
  });
  test('an unresolved phase cannot pass as an empty issue list', () => {
    const result = processSeam.runNode(['-e', source], { cwd: root, env: { ...TEST_ENV_BASE, THREAT_SCAN: JSON.stringify({ phase_found: false, threat_id_duplicates: [], threat_id_duplicate_count: 0 }) } });
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /invalid threat-ID scan/);
  });
  test('missing scan fields fail rather than report an empty issue list', () => {
    const result = processSeam.runNode(['-e', source], { cwd: root, env: { ...TEST_ENV_BASE, THREAT_SCAN: '{}' } });
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /invalid threat-ID scan/);
  });
});
