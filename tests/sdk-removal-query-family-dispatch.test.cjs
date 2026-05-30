'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

describe('SDK-removal CJS query family dispatch', () => {
  let tmpDir;
  let phaseDir;
  let contextPath;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-query-families-');
    phaseDir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(phaseDir, { recursive: true });
    contextPath = path.join(phaseDir, '01-CONTEXT.md');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('query agent.classify-failure classifies quota text', () => {
    const result = runGsdTools(['query', 'agent.classify-failure', '--', '429 retry-after: 45'], tmpDir);
    assert.strictEqual(result.success, true, result.error);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.class, 'quota-exceeded');
    assert.equal(parsed.sentinel, '429');
    assert.equal(parsed.retryAfterSeconds, 45);
  });

  test('query task.is-behavior-adding supports --pick for workflow gate usage', () => {
    const task = [
      '<task tdd="true">',
      '<behavior>User can save a profile</behavior>',
      '<files>',
      '- src/profile.js',
      '- tests/profile.test.js',
      '</files>',
      '</task>',
    ].join('\n');

    const result = runGsdTools(['query', 'task.is-behavior-adding', '--task-content', task, '--pick', 'is_behavior_adding'], tmpDir);
    assert.strictEqual(result.success, true, result.error);
    assert.equal(result.output, 'true');
  });

  test('query check auto-mode reads workflow flags from config', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'config.json'), JSON.stringify({
      workflow: {
        auto_advance: false,
        _auto_chain_active: true,
      },
    }, null, 2));

    const result = runGsdTools(['query', 'check', 'auto-mode', '--pick', 'source'], tmpDir);
    assert.strictEqual(result.success, true, result.error);
    assert.equal(result.output, 'auto_chain');
  });

  test('query check.decision-coverage-plan reaches the CJS gate and passes covered decisions', () => {
    fs.writeFileSync(contextPath, [
      '<decisions>',
      '### Product',
      '- **D-01:** Keep the runtime command path installed and portable for users.',
      '</decisions>',
    ].join('\n'));
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), [
      '---',
      'objective: "Implement D-01 in the runtime launcher"',
      'must_haves:',
      '  - "D-01 remains covered"',
      '---',
      '',
      '<tasks>',
      '<task><action>Preserve D-01.</action></task>',
      '</tasks>',
    ].join('\n'));

    const result = runGsdTools(['query', 'check.decision-coverage-plan', phaseDir, contextPath, '--pick', 'passed'], tmpDir);
    assert.strictEqual(result.success, true, result.error);
    assert.equal(result.output, 'true');
  });

  test('query state.add-roadmap-evolution refuses with current runtime wording', () => {
    const result = runGsdTools(['query', 'state.add-roadmap-evolution'], tmpDir);
    const combinedOutput = `${result.output}\n${result.error || ''}`;

    assert.strictEqual(result.success, false, 'expected unsupported state command to fail');
    assert.match(combinedOutput, /current gsd-tools runtime/);
    assert.doesNotMatch(combinedOutput, /gsd-sdk|SDK-only/);
  });

  test('query phase.uat-passed is explicitly unsupported in current runtime', () => {
    const result = runGsdTools(['query', 'phase.uat-passed'], tmpDir);
    const combinedOutput = `${result.output}\n${result.error || ''}`;

    assert.strictEqual(result.success, false, 'expected unsupported phase command to fail');
    assert.match(combinedOutput, /phase uat-passed is not implemented in the current gsd-tools runtime/);
    assert.doesNotMatch(combinedOutput, /gsd-sdk|SDK-only/);
  });

  test('query check.decision-coverage-verify returns non-blocking misses', () => {
    fs.writeFileSync(contextPath, [
      '<decisions>',
      '### Product',
      '- **D-02:** Keep verification warnings visible when decisions are missing.',
      '</decisions>',
    ].join('\n'));

    const result = runGsdTools(['query', 'check.decision-coverage-verify', phaseDir, contextPath], tmpDir);
    assert.strictEqual(result.success, true, result.error);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.blocking, false);
    assert.equal(parsed.not_honored[0].id, 'D-02');
  });
});
