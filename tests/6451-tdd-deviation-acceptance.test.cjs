'use strict';

/**
 * 6451 — TDD review deviation acceptance.
 *
 * Under TDD mode a blocked end-of-phase review must be releasable by a
 * recorded, attributed acceptance: one `deviations:` entry per violating plan
 * in the phase directory's `TDD-DEVIATIONS.md`, shaped like must-have
 * `overrides:` (reason / accepted_by / accepted_at, references/
 * verification-overrides.md). The gate excludes accepted violations from
 * `violations`/`block` but keeps the FAIL row and annotates it; an unreadable
 * record is never an acceptance (fail-closed, #5170); the absent-record verdict
 * is byte-identical to today's.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { GIT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { createTempGitProject, cleanup } = require('./helpers.cjs');

const { evaluateTddReviewCheckpoint } = require('../gsd-core/bin/lib/gate-tdd-review-checkpoint.cjs');

const WORKFLOW_STEP = path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-phase', 'steps', 'verify-phase-goal.md');
const WORKFLOW = path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-phase.md');
const COMMAND_DOC = path.join(__dirname, '..', 'commands', 'gsd', 'execute-phase.md');

function git(dir, ...args) {
  return execFileSync(
    'git',
    ['-c', 'user.name=gate-test', '-c', 'user.email=gate-test@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd: dir, encoding: 'utf-8', stdio: 'pipe', timeout: GIT_TIMEOUT_MS, windowsHide: true },
  );
}

function withProject(planFiles, commits, fn) {
  const dir = createTempGitProject('gate-tdd-dev-');
  try {
    for (const [name, content] of Object.entries(planFiles)) {
      const file = path.join(dir, '.planning', 'phases', '01-x', name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
    // The gate scopes `git log` to `-- .`, so each commit must touch a file.
    commits.forEach((message, index) => {
      fs.writeFileSync(path.join(dir, `commit-${index}.txt`), `${message}\n`);
      git(dir, 'add', '-A');
      git(dir, 'commit', '-m', message);
    });
    return fn(dir);
  } finally {
    cleanup(dir);
  }
}

const plan = (planNo) => `---\nphase: 1\nplan: ${planNo}\ntype: tdd\n---\n# Plan\n`;

function review(dir) {
  const result = evaluateTddReviewCheckpoint({ projectDir: dir, args: ['1'] });
  assert.equal(result.failure, undefined, 'not a usage failure');
  return result.payload;
}

function writeDeviations(dir, body) {
  fs.writeFileSync(path.join(dir, '.planning', 'phases', '01-x', 'TDD-DEVIATIONS.md'), body);
}

describe('6451 recorded TDD deviations release the review', () => {
  test('an attributed acceptance releases the violating plan', () => {
    withProject({ '01-01-PLAN.md': plan('1') }, [], (dir) => {
      writeDeviations(dir, '---\ndeviations:\n  - plan: 01-01\n    violation: missing_RED_GREEN\n    reason: "test-only plan: behavioural tests for already-shipped code"\n    accepted_by: "dave"\n    accepted_at: "2026-11-25T12:00:00Z"\n---\n');
      const out = review(dir);
      assert.equal(out.violations, 0);
      assert.equal(out.block, false);
      assert.equal(out.rows[0].status, 'FAIL');
      assert.equal(out.rows[0].deviationAccepted, true);
    });
  });

  test('an acceptance without a specific reason does not release', () => {
    withProject({ '01-01-PLAN.md': plan('1') }, [], (dir) => {
      writeDeviations(dir, '---\ndeviations:\n  - plan: 01-01\n    violation: missing_RED_GREEN\n    reason: ""\n    accepted_by: "dave"\n    accepted_at: "2026-11-25T12:00:00Z"\n---\n');
      const out = review(dir);
      assert.equal(out.violations, 1);
      assert.equal(out.block, true);
      assert.equal(out.rows[0].deviationAccepted, undefined);
    });
  });

  test('an acceptance without an author does not release', () => {
    withProject({ '01-01-PLAN.md': plan('1') }, [], (dir) => {
      writeDeviations(dir, '---\ndeviations:\n  - plan: 01-01\n    violation: missing_RED_GREEN\n    reason: "deferred, tracked in ROADMAP.md"\n    accepted_at: "2026-11-25T12:00:00Z"\n---\n');
      const out = review(dir);
      assert.equal(out.violations, 1);
      assert.equal(out.block, true);
    });
  });

  test('only the accepted plan is released', () => {
    withProject({ '01-01-PLAN.md': plan('1'), '01-02-PLAN.md': plan('2') }, [], (dir) => {
      writeDeviations(dir, '---\ndeviations:\n  - plan: 01-01\n    violation: missing_RED_GREEN\n    reason: "test-only plan"\n    accepted_by: "dave"\n    accepted_at: "2026-11-25T12:00:00Z"\n---\n');
      const out = review(dir);
      assert.equal(out.violations, 1);
      assert.equal(out.block, true);
      const byId = Object.fromEntries(out.rows.map((r) => [r.planId, r]));
      assert.equal(byId['01-01'].deviationAccepted, true);
      assert.equal(byId['01-02'].deviationAccepted, undefined);
    });
  });

  test('a re-run with the record present returns the same verdict', () => {
    withProject({ '01-01-PLAN.md': plan('1') }, [], (dir) => {
      writeDeviations(dir, '---\ndeviations:\n  - plan: 01-01\n    violation: missing_RED_GREEN\n    reason: "test-only plan"\n    accepted_by: "dave"\n    accepted_at: "2026-11-25T12:00:00Z"\n---\n');
      assert.deepStrictEqual(review(dir), review(dir));
    });
  });

  test('an unreadable deviation record fails closed, never passes', () => {
    withProject({ '01-01-PLAN.md': plan('1') }, [], (dir) => {
      writeDeviations(dir, '---\ndeviations: [ this is not : valid yaml\n---\n');
      const out = review(dir);
      assert.equal(out.passed, false);
      assert.ok(Array.isArray(out.unreadable) && out.unreadable.length > 0, 'the unreadable envelope names the record');
    });
  });

  test('no record keeps today verdict exactly', () => {
    withProject({ '01-01-PLAN.md': plan('1') }, [], (dir) => {
      const out = review(dir);
      assert.equal(out.violations, 1);
      assert.equal(out.block, true);
      assert.equal(out.rows[0].deviationAccepted, undefined);
      assert.equal(out.passed, true);
    });
  });
});

describe('6451 the Phase blocked message names only real flags', () => {
  test('every --flag in the TDD block message is parsed by execute-phase', () => {
    // allow-test-rule: runtime-contract-is-the-product see #6451
    const step = fs.readFileSync(WORKFLOW_STEP, 'utf8');
    const block = step.match(/```\n(Phase blocked[\s\S]*?)```/);
    assert.ok(block, 'the Phase blocked message block exists in verify-phase-goal.md');
    const flags = [...new Set(block[1].match(/--[a-z][a-z-]+/g) || [])];
    assert.ok(flags.length > 0, 'the message names at least one flag');
    const surface = fs.readFileSync(WORKFLOW, 'utf8') + fs.readFileSync(COMMAND_DOC, 'utf8');
    for (const flag of flags) {
      assert.ok(surface.includes(flag), `${flag} is named in the block message but parsed nowhere in execute-phase`);
    }
  });
});
