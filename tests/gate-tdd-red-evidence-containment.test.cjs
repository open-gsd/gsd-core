'use strict';

/**
 * `check tdd-red-evidence <record.json>` containment (#5139, epic #5056, ADR-5057 Phase 6 security
 * review). The gate used to read ANY readable path (`path.resolve(recordPath)`, no containment) and
 * echo fields of it. It now requires the resolved record path to stay inside the project directory
 * (realpath containment, ADR-4650) BEFORE anything is read; an escaping path is the usage failure
 * `path escapes its allowed directory: <arg>`, exactly like every sibling gate. A record inside the
 * project is read and reported exactly as before (the echoed path is unchanged).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempProject, cleanup } = require('./helpers.cjs');

const { evaluateTddRedEvidence } = require('../gsd-core/bin/lib/gate-tdd-red-evidence.cjs');
const { isGateUsageFailure } = require('../gsd-core/bin/lib/gate-verdict.cjs');

// Complete Node TAP (plan and YAML diagnostic block): the #4692 TAP adapter rejects non-TAP lines.
const RED_OK = {
  command: 'node --test t.test.cjs',
  exitCode: 1,
  output: 'TAP version 13\n# Subtest: target\nnot ok 1 - target\n  ---\n  duration_ms: 0.97\n  type: \'test\'\n  failureType: \'testCodeFailure\'\n  error: \'expected 1 to equal 2\'\n  code: \'ERR_ASSERTION\'\n  ...\n1..1\n# tests 1\n# suites 0\n# pass 0\n# fail 1\n',
  targetTest: 'target',
  targetFile: 't.test.cjs',
  expected: '2',
  actual: '1',
};

function withDirs(fn) {
  const project = createTempProject('gate-red-contain-project-');
  const outside = createTempProject('gate-red-contain-outside-');
  try {
    return fn(project, outside);
  } finally {
    cleanup(project);
    cleanup(outside);
  }
}

/** Run the gate while recording every file path `fs.readFileSync` is asked for. */
function withReadLog(fn) {
  const reads = [];
  const real = fs.readFileSync;
  fs.readFileSync = function patched(file, ...rest) {
    reads.push(String(file));
    return real.call(fs, file, ...rest);
  };
  try {
    return { result: fn(), reads };
  } finally {
    fs.readFileSync = real;
  }
}

describe('tdd-red-evidence record path containment', () => {
  test('an absolute record path outside the project is a usage failure and is never read', () => {
    withDirs((project, outside) => {
      const record = path.join(outside, 'red.json');
      fs.writeFileSync(record, JSON.stringify(RED_OK));
      const { result, reads } = withReadLog(() => evaluateTddRedEvidence({ projectDir: project, args: [record] }));
      assert.equal(isGateUsageFailure(result), true);
      assert.deepStrictEqual(result, { failure: { code: 'usage', message: `path escapes its allowed directory: ${record}` } });
      assert.deepStrictEqual(reads.filter((file) => file.includes('red.json')), [], 'the escaping record was never opened');
    });
  });

  test('a relative record path that climbs out of the project is a usage failure', () => {
    withDirs((project) => {
      const arg = path.join('..', '..', '..', 'etc', 'hosts');
      const result = evaluateTddRedEvidence({ projectDir: project, args: [arg] });
      assert.deepStrictEqual(result, { failure: { code: 'usage', message: `path escapes its allowed directory: ${arg}` } });
    });
  });

  test('an absent file outside the project is an escape, not "record not found"', () => {
    withDirs((project, outside) => {
      const record = path.join(outside, 'absent.json');
      const result = evaluateTddRedEvidence({ projectDir: project, args: [record] });
      assert.equal(isGateUsageFailure(result), true);
    });
  });

  test('a symlink inside the project that points outside is refused', { skip: process.platform === 'win32' }, () => {
    withDirs((project, outside) => {
      const target = path.join(outside, 'red.json');
      fs.writeFileSync(target, JSON.stringify(RED_OK));
      const link = path.join(project, 'link.json');
      fs.symlinkSync(target, link);
      const { result, reads } = withReadLog(() => evaluateTddRedEvidence({ projectDir: project, args: [link] }));
      assert.deepStrictEqual(result, { failure: { code: 'usage', message: `path escapes its allowed directory: ${link}` } });
      assert.deepStrictEqual(reads.filter((file) => file.endsWith('red.json') || file.endsWith('link.json')), []);
    });
  });

  test('a record inside the project is read and reported exactly as before (echoed path unchanged)', () => {
    withDirs((project) => {
      const record = path.join(project, 'records', 'red.json');
      fs.mkdirSync(path.dirname(record), { recursive: true });
      fs.writeFileSync(record, JSON.stringify(RED_OK));
      const result = evaluateTddRedEvidence({ projectDir: project, args: [record] });
      assert.equal(isGateUsageFailure(result), false);
      assert.equal(result.outcome, 'pass');
      assert.equal(result.payload.verdict, 'RED_EVIDENCE_OK');
    });
  });

  test('cwd != projectDir: a project-relative path resolves against the cwd and is the usage failure; an absolute in-project path works', () => {
    withDirs((project, elsewhere) => {
      fs.writeFileSync(path.join(project, 'r.json'), JSON.stringify(RED_OK));
      const priorCwd = process.cwd();
      process.chdir(elsewhere);
      try {
        const relative = evaluateTddRedEvidence({ projectDir: project, args: ['r.json'] });
        assert.deepStrictEqual(relative, { failure: { code: 'usage', message: 'path escapes its allowed directory: r.json' } });
        const absolute = evaluateTddRedEvidence({ projectDir: project, args: [path.join(project, 'r.json')] });
        assert.equal(absolute.outcome, 'pass');
        assert.equal(absolute.payload.verdict, 'RED_EVIDENCE_OK');
      } finally {
        process.chdir(priorCwd);
      }
    });
  });

  test('an absent record inside the project is still the INVALID_RED unreadable_record arm, echoing the resolved path', () => {
    withDirs((project) => {
      const record = path.join(project, 'nope.json');
      const result = evaluateTddRedEvidence({ projectDir: project, args: [record] });
      assert.equal(result.outcome, 'block');
      assert.equal(result.payload.reason, 'unreadable_record');
      assert.equal(result.payload.record, record);
      assert.equal(result.payload.readError, `record not found or unreadable: ${record}`);
    });
  });
});
