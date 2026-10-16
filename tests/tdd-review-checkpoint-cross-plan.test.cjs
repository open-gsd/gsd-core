'use strict';

/**
 * #4867 — the end-of-phase TDD review pairs RED with GREEN across a declared dependency.
 *
 * A gap closure is planned as a RED-only probe plan plus the GREEN plan that `depends_on` it. The
 * review used to score every `type: tdd` plan by its OWN `test(<id>):` / `feat(<id>):` commits only,
 * so the probe plan failed forever ("missing GREEN") and the dependent fix plan was not reviewed.
 * Credit now follows an explicit `depends_on` link, and only that.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { GIT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { createTempGitProject, cleanup } = require('./helpers.cjs');

const gate = require('../gsd-core/bin/lib/gate-tdd-review-checkpoint.cjs');

function write(dir, rel, content) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function git(dir, ...args) {
  return execFileSync(
    'git',
    ['-c', 'user.name=gate-test', '-c', 'user.email=gate-test@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd: dir, encoding: 'utf-8', stdio: 'pipe', timeout: GIT_TIMEOUT_MS, windowsHide: true },
  );
}

function plan(dir, phaseDir, id, { type, dependsOn } = {}) {
  const fm = ['---', `phase: ${id.split('-')[0]}`, `plan: ${id.split('-')[1]}`, `type: ${type}`];
  if (dependsOn) fm.push(`depends_on: [${dependsOn.join(', ')}]`);
  fm.push('---', '# Plan', '');
  write(dir, `.planning/phases/${phaseDir}/${id}-PLAN.md`, fm.join('\n'));
}

function commit(dir, subject) {
  write(dir, `${subject.replace(/[^a-z0-9]+/gi, '-')}.txt`, subject);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', subject);
}

function review(scenario, phaseArg = '1') {
  const dir = createTempGitProject('gate-4867-');
  try {
    scenario(dir);
    const result = gate.evaluateTddReviewCheckpoint({ projectDir: dir, args: [phaseArg] });
    return result.payload;
  } finally {
    cleanup(dir);
  }
}

const rowOf = (payload, id) => payload.rows.find((r) => r.planId === id);

describe('#4867 TDD review pairs RED and GREEN across depends_on', () => {
  test('a RED-only probe plan passes when the plan that depends on it carries the GREEN', () => {
    const payload = review((dir) => {
      plan(dir, '01-x', '01-20', { type: 'tdd' });
      plan(dir, '01-x', '01-21', { type: 'execute', dependsOn: ['01-20'] });
      commit(dir, 'test(01-20): RED probe');
      commit(dir, 'feat(01-21): GREEN fix');
    });
    assert.equal(rowOf(payload, '01-20').status, 'Pass');
    assert.equal(payload.violations, 0);
    assert.equal(payload.block, false);
    assert.deepEqual(rowOf(payload, '01-20').greenFrom, ['01-21']);
    assert.match(payload.table, /01-20 GREEN is supplied by dependent plan 01-21/);
  });

  test('works for a decimal phase such as 01.1 (the reported shape)', () => {
    const payload = review((dir) => {
      plan(dir, '01.1-x', '01.1-20', { type: 'tdd' });
      plan(dir, '01.1-x', '01.1-21', { type: 'execute', dependsOn: ['01.1-20'] });
      commit(dir, 'test(01.1-20): RED probe');
      commit(dir, 'feat(01.1-21): GREEN fix');
    }, '01.1');
    assert.equal(rowOf(payload, '01.1-20').status, 'Pass');
    assert.equal(payload.violations, 0);
  });

  test('credit follows a dependency chain, not only a direct dependent', () => {
    const payload = review((dir) => {
      plan(dir, '01-x', '01-20', { type: 'tdd' });
      plan(dir, '01-x', '01-21', { type: 'execute', dependsOn: ['01-20'] });
      plan(dir, '01-x', '01-22', { type: 'execute', dependsOn: ['01-21'] });
      commit(dir, 'test(01-20): RED probe');
      commit(dir, 'feat(01-22): GREEN fix');
    });
    assert.equal(rowOf(payload, '01-20').status, 'Pass');
    assert.deepEqual(rowOf(payload, '01-20').greenFrom, ['01-22']);
  });

  test('a RED-only plan that nothing depends on still fails', () => {
    const payload = review((dir) => {
      plan(dir, '01-x', '01-20', { type: 'tdd' });
      plan(dir, '01-x', '01-21', { type: 'execute' });
      commit(dir, 'test(01-20): RED probe');
      commit(dir, 'feat(01-21): unrelated work');
    });
    const row = rowOf(payload, '01-20');
    assert.equal(row.status, 'FAIL');
    assert.deepEqual(row.missing, ['GREEN']);
    assert.equal(payload.violations, 1);
    assert.equal(payload.block, true);
  });

  test('a dependent plan with no feat commit gives no credit', () => {
    const payload = review((dir) => {
      plan(dir, '01-x', '01-20', { type: 'tdd' });
      plan(dir, '01-x', '01-21', { type: 'execute', dependsOn: ['01-20'] });
      commit(dir, 'test(01-20): RED probe');
      commit(dir, 'docs(01-21): notes only');
    });
    assert.equal(rowOf(payload, '01-20').status, 'FAIL');
    assert.equal(payload.violations, 1);
  });

  test('a dependent plan that only has a test commit gives no credit', () => {
    const payload = review((dir) => {
      plan(dir, '01-x', '01-20', { type: 'tdd' });
      plan(dir, '01-x', '01-21', { type: 'execute', dependsOn: ['01-20'] });
      commit(dir, 'test(01-20): RED probe');
      commit(dir, 'test(01-21): more tests');
    });
    assert.equal(rowOf(payload, '01-20').status, 'FAIL');
  });

  test('the RED must still exist: a dependent GREEN does not excuse a missing RED', () => {
    const payload = review((dir) => {
      plan(dir, '01-x', '01-20', { type: 'tdd' });
      plan(dir, '01-x', '01-21', { type: 'execute', dependsOn: ['01-20'] });
      commit(dir, 'feat(01-21): GREEN fix');
    });
    const row = rowOf(payload, '01-20');
    assert.equal(row.status, 'FAIL');
    assert.deepEqual(row.missing, ['RED']);
  });

  test('a standalone plan is scored exactly as before: its own RED and GREEN', () => {
    const payload = review((dir) => {
      plan(dir, '01-x', '01-01', { type: 'tdd' });
      commit(dir, 'test(01-01): red');
      commit(dir, 'feat(01-01): green');
    });
    const row = rowOf(payload, '01-01');
    assert.equal(row.status, 'Pass');
    assert.equal(row.greenFrom, undefined);
    assert.doesNotMatch(payload.table, /supplied by dependent/);
  });

  test('a plan that is a dependent but not the other way round gets no reverse credit', () => {
    const payload = review((dir) => {
      plan(dir, '01-x', '01-20', { type: 'execute' });
      plan(dir, '01-x', '01-21', { type: 'tdd', dependsOn: ['01-20'] });
      commit(dir, 'test(01-21): RED probe');
      commit(dir, 'feat(01-20): work the tdd plan depends on');
    });
    assert.equal(rowOf(payload, '01-21').status, 'FAIL');
  });
});
