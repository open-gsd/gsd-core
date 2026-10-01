'use strict';

/**
 * U5 — in-process GateVerdict tests for `check tdd-review-checkpoint` (#5139, epic #5056, ADR-5057 §4).
 *
 * FAILING-FIRST (RED): `gsd-core/bin/lib/gate-tdd-review-checkpoint.cjs` does not exist yet, so this file
 * fails at require time on origin/next. The module must export
 * `evaluateTddReviewCheckpoint({ projectDir, args })` where `args` is the argv AFTER the verb, returning a
 * GateVerdict ({ outcome, block, payload }) for every arm that prints a payload today and a
 * GateUsageFailure ({ failure: { code, message } }) for every arm that calls `error()` today.
 *
 * Every payload below was captured by EXECUTING the pre-move router (`gsd-tools check tdd-review-checkpoint`)
 * on origin/next in a fixture project; the tests compare the deep value AND the serialized key
 * order (stdout is byte-identical only if the payload's insertion order is preserved).
 * `outcome`/`block` are the new GateVerdict fields; their mapping from today's payload is
 * recorded per case (see 50-test-matrix.md, API contract).
 *
 * Each case also asserts the gate never writes to process.stdout / process.stderr: only the
 * router formats output (design D2).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { GIT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { createTempProject, createTempGitProject, cleanup } = require('./helpers.cjs');
const { tempRootAliases, canonicalizeTempPaths } = require('./helpers/path-compare.cjs');

const gate = require('../gsd-core/bin/lib/gate-tdd-review-checkpoint.cjs');
const { isGateUsageFailure } = require('../gsd-core/bin/lib/gate-verdict.cjs');

function w(dir, rel, content) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function git(dir, ...a) {
  return execFileSync(
    'git',
    ['-c', 'user.name=gate-test', '-c', 'user.email=gate-test@example.invalid', '-c', 'commit.gpgsign=false', ...a],
    { cwd: dir, encoding: 'utf-8', stdio: 'pipe', timeout: GIT_TIMEOUT_MS, windowsHide: true },
  );
}

const h = { w, git };

const CASES = [
  {
    id: 'U5a',
    title: 'phase has no type:tdd plans -> skipped advisory pass',
    git: true,
    setup(dir, h) {
      h.w(dir, '.planning/phases/01-x/01-01-PLAN.md', ['---', 'phase: 1', 'plan: 1', 'type: execute', '---', '# Plan', ''].join('\n'));
    },
    args() { return ['1']; },
    outcome: 'skip',
    block: false,
    expected() {
      return {
        block: false,
        passed: true,
        tddPlans: 0,
        violations: 0,
        table: '',
        rows: [],
        message: 'No type:tdd plans found in phase 1. TDD review skipped.',
      };
    },
  },
  {
    id: 'U5b',
    title: 'unresolvable phase -> same skipped arm, message names the phase',
    git: true,
    args() { return ['9']; },
    outcome: 'skip',
    block: false,
    expected() {
      return {
        block: false,
        passed: true,
        tddPlans: 0,
        violations: 0,
        table: '',
        rows: [],
        message: 'No type:tdd plans found in phase 9. TDD review skipped.',
      };
    },
  },
  {
    id: 'U5c',
    title: 'tdd plan without gate commits -> violation reported, block true, passed true',
    git: true,
    setup(dir, h) {
      h.w(dir, '.planning/phases/01-x/01-01-PLAN.md', ['---', 'phase: 1', 'plan: 1', 'type: tdd', '---', '# Plan', ''].join('\n'));
    },
    args() { return ['1']; },
    outcome: 'advisory',
    block: true,
    expected() {
      return {
        block: true,
        passed: true,
        tddPlans: 1,
        violations: 1,
        table: '### TDD REVIEW — Phase 1\n\nTDD Plans: 1 | Gate violations: 1\n\n| Plan | RED | GREEN | REFACTOR | Status |\n|------|-----|-------|----------|--------|\n| 01-01 |  ✗  |   ✗   |    —     | FAIL   |\n\n⚠ Gate violations are advisory — review before advancing.\n  Plan 01-01 missing: RED, GREEN gate commit(s).\n  Expected commit pattern: test(01-01): ... → feat(01-01): ...',
        rows: [
          {
            planId: '01-01',
            red: false,
            green: false,
            refactor: false,
            status: 'FAIL',
            missing: [
              'RED',
              'GREEN',
            ],
          },
        ],
        message: '### TDD REVIEW — Phase 1\n\nTDD Plans: 1 | Gate violations: 1\n\n| Plan | RED | GREEN | REFACTOR | Status |\n|------|-----|-------|----------|--------|\n| 01-01 |  ✗  |   ✗   |    —     | FAIL   |\n\n⚠ Gate violations are advisory — review before advancing.\n  Plan 01-01 missing: RED, GREEN gate commit(s).\n  Expected commit pattern: test(01-01): ... → feat(01-01): ...',
      };
    },
  },
  {
    id: 'U5d',
    title: 'RED + GREEN + REFACTOR commits present -> Pass row, no violations',
    git: true,
    setup(dir, h) {
      h.w(dir, '.planning/phases/01-x/01-01-PLAN.md', ['---', 'phase: 1', 'plan: 1', 'type: tdd', '---', '# Plan', ''].join('\n'));
      h.w(dir, 'red.txt', 'r');
      h.git(dir, 'add', '-A');
      h.git(dir, 'commit', '-m', 'test(01-01): red');
      h.w(dir, 'green.txt', 'g');
      h.git(dir, 'add', '-A');
      h.git(dir, 'commit', '-m', 'feat(01-01): green');
      h.w(dir, 'tidy.txt', 't');
      h.git(dir, 'add', '-A');
      h.git(dir, 'commit', '-m', 'refactor(01-01): tidy');
    },
    args() { return ['1']; },
    outcome: 'pass',
    block: false,
    expected() {
      return {
        block: false,
        passed: true,
        tddPlans: 1,
        violations: 0,
        table: '### TDD REVIEW — Phase 1\n\nTDD Plans: 1 | Gate violations: 0\n\n| Plan | RED | GREEN | REFACTOR | Status |\n|------|-----|-------|----------|--------|\n| 01-01 |  ✓  |   ✓   |    ✓     | Pass   |',
        rows: [
          {
            planId: '01-01',
            red: true,
            green: true,
            refactor: true,
            status: 'Pass',
            missing: [],
          },
        ],
        message: '### TDD REVIEW — Phase 1\n\nTDD Plans: 1 | Gate violations: 0\n\n| Plan | RED | GREEN | REFACTOR | Status |\n|------|-----|-------|----------|--------|\n| 01-01 |  ✓  |   ✓   |    ✓     | Pass   |',
      };
    },
  },
  {
    id: 'U5e',
    title: 'RED only -> FAIL row missing GREEN',
    git: true,
    setup(dir, h) {
      h.w(dir, '.planning/phases/01-x/01-01-PLAN.md', ['---', 'phase: 1', 'plan: 1', 'type: tdd', '---', '# Plan', ''].join('\n'));
      h.w(dir, 'red.txt', 'r');
      h.git(dir, 'add', '-A');
      h.git(dir, 'commit', '-m', 'test(01-01): red');
    },
    args() { return ['1']; },
    outcome: 'advisory',
    block: true,
    expected() {
      return {
        block: true,
        passed: true,
        tddPlans: 1,
        violations: 1,
        table: '### TDD REVIEW — Phase 1\n\nTDD Plans: 1 | Gate violations: 1\n\n| Plan | RED | GREEN | REFACTOR | Status |\n|------|-----|-------|----------|--------|\n| 01-01 |  ✓  |   ✗   |    —     | FAIL   |\n\n⚠ Gate violations are advisory — review before advancing.\n  Plan 01-01 missing: GREEN gate commit(s).\n  Expected commit pattern: test(01-01): ... → feat(01-01): ...',
        rows: [
          {
            planId: '01-01',
            red: true,
            green: false,
            refactor: false,
            status: 'FAIL',
            missing: [
              'GREEN',
            ],
          },
        ],
        message: '### TDD REVIEW — Phase 1\n\nTDD Plans: 1 | Gate violations: 1\n\n| Plan | RED | GREEN | REFACTOR | Status |\n|------|-----|-------|----------|--------|\n| 01-01 |  ✓  |   ✗   |    —     | FAIL   |\n\n⚠ Gate violations are advisory — review before advancing.\n  Plan 01-01 missing: GREEN gate commit(s).\n  Expected commit pattern: test(01-01): ... → feat(01-01): ...',
      };
    },
  },
  {
    id: 'U5f',
    title: 'missing phase argument is a usage failure',
    args() { return []; },
    usage: { code: 'sdk_missing_arg', message: 'tdd.review-checkpoint requires a phase argument: check tdd.review-checkpoint <phase>' },
  },
  {
    // #5170 (matrix row 21): a plan file that exists but cannot be read used to be read as '' and so
    // as "not a TDD plan" — the review then skipped with a passing outcome over a plan it never saw.
    id: 'U5g',
    title: 'a plan file that cannot be read -> unreadable outcome (advisory block:false), never "not a TDD plan" (read failure injected)',
    git: true,
    setup(dir, h) {
      h.w(dir, '.planning/phases/01-x/01-01-PLAN.md', ['---', 'phase: 1', 'plan: 1', 'type: tdd', '---', '# Plan', ''].join('\n'));
      const real = fs.readFileSync;
      fs.readFileSync = function (p, ...rest) {
        if (String(p).endsWith('01-01-PLAN.md')) {
          const err = new Error('EACCES: simulated read failure');
          err.code = 'EACCES';
          throw err;
        }
        return real.call(fs, p, ...rest);
      };
      return function restore() { fs.readFileSync = real; };
    },
    args() { return ['1']; },
    outcome: 'unreadable',
    block: false,
    expected(dir) {
      const planPath = path.join(dir, '.planning', 'phases', '01-x', '01-01-PLAN.md');
      return {
        block: false,
        passed: false,
        tddPlans: 0,
        violations: 0,
        table: '',
        rows: [],
        unreadable: [{ source: planPath, reason: 'EACCES' }],
        message: `TDD review could not read: ${planPath} (EACCES). Phase 1 was not reviewed.`,
      };
    },
  },
  {
    // Matrix row 22: ABSENT is `none`, which stays the existing skip (exit 0) — only an unreadable
    // thing is `unreadable`. The phase directory disappears between the lookup and the listing.
    id: 'U5h',
    title: 'a phase directory that is absent when listed -> none, the existing skipped arm',
    git: true,
    setup(dir, h) {
      h.w(dir, '.planning/phases/01-x/01-01-PLAN.md', ['---', 'phase: 1', 'plan: 1', 'type: tdd', '---', '# Plan', ''].join('\n'));
      const real = fs.readdirSync;
      fs.readdirSync = function (p, ...rest) {
        if (String(p).endsWith('01-x')) {
          const err = new Error('ENOENT: simulated vanished directory');
          err.code = 'ENOENT';
          throw err;
        }
        return real.call(fs, p, ...rest);
      };
      return function restore() { fs.readdirSync = real; };
    },
    args() { return ['1']; },
    outcome: 'skip',
    block: false,
    expected() {
      return {
        block: false,
        passed: true,
        tddPlans: 0,
        violations: 0,
        table: '',
        rows: [],
        message: 'No type:tdd plans found in phase 1. TDD review skipped.',
      };
    },
  },
];

function run(c) {
  const dir = c.git ? createTempGitProject('gate-u5-') : createTempProject('gate-u5-');
  const real = fs.realpathSync(dir);
  const aliases = tempRootAliases(dir);
  const writes = [];
  const outWrite = process.stdout.write;
  const errWrite = process.stderr.write;
  let restore;
  let result;
  try {
    restore = c.setup ? c.setup(dir, h) : undefined;
    process.stdout.write = (chunk) => {
      writes.push({ stream: 'stdout', chunk: String(chunk) });
      return true;
    };
    process.stderr.write = (chunk) => {
      writes.push({ stream: 'stderr', chunk: String(chunk) });
      return true;
    };
    result = gate.evaluateTddReviewCheckpoint({ projectDir: dir, args: c.args(dir) });
  } finally {
    process.stdout.write = outWrite;
    process.stderr.write = errWrite;
    if (typeof restore === 'function') restore();
    cleanup(dir);
  }
  return { result, writes, dir, real, aliases };
}

describe('U5 evaluateTddReviewCheckpoint', () => {
  for (const c of CASES) {
    test(`${c.id}: ${c.title}`, () => {
      const { result, writes, dir, real, aliases } = run(c);
      const unexpected = writes.filter(
        (w) => !(c.stderrPrefix && w.stream === 'stderr' && w.chunk.startsWith(c.stderrPrefix)),
      );
      assert.deepStrictEqual(unexpected, [], 'a gate module must not write to stdout/stderr');
      if (c.usage) {
        assert.equal(isGateUsageFailure(result), true);
        assert.deepStrictEqual(result, { failure: { code: c.usage.code, message: c.usage.message } });
        return;
      }
      assert.equal(isGateUsageFailure(result), false);
      assert.equal(result.outcome, c.outcome);
      assert.equal(result.block, c.block);
      const expected = canonicalizeTempPaths(c.expected(dir, real), aliases);
      const actual = canonicalizeTempPaths(result.payload, aliases);
      assert.deepStrictEqual(actual, expected);
      assert.equal(JSON.stringify(actual), JSON.stringify(expected), 'payload key order is part of the contract');
    });
  }
});
