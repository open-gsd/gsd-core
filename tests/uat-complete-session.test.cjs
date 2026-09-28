/**
 * tests/uat-complete-session.test.cjs — #5105 test matrix rows T1-T4.
 *
 * FAILING-FIRST: `uat.complete-session` (CLI verb) and `completeUatSession`
 * (pure core, src/uat.cts / compiled gsd-core/bin/lib/uat.cjs) do not exist
 * yet — design 40-design.md §R "R1". These tests encode the required
 * contract; they are expected to fail until R1 lands, then pass unchanged.
 *
 * Design: .gsd/phase/fix-5105-verify-lifecycle-writes/40-design.md §R.
 * Matrix: .gsd/phase/fix-5105-verify-lifecycle-writes/50-test-matrix.md T1-T4.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const fc = require('./helpers/fast-check-setup.cjs');
const { runGsdTools, createTempGitProject, cleanup } = require('./helpers.cjs');
const { GIT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

// Lazy — this module does not export completeUatSession yet (fail-first).
// Requiring it up front (rather than inside each test) would crash the whole
// file before a single test() registers if the compiled lib itself failed to
// load for an unrelated reason; requiring the FUNCTION lazily per-test keeps
// each row's failure isolated and diagnosable.
function loadCompleteUatSession() {
  const lib = require('../gsd-core/bin/lib/uat.cjs');
  return lib.completeUatSession;
}

function gitHeadCount(cwd) {
  const { execFileSync } = require('child_process');
  return execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd, encoding: 'utf-8', timeout: GIT_TIMEOUT_MS }).trim();
}

// A UAT that is already fully complete: status complete, Current Test
// cleared, every row resolved (pass).
function completeUatContent({ updated = '2026-01-01T00:00:00Z' } = {}) {
  return [
    '---',
    'status: complete',
    'phase: 01-foo',
    'started: 2026-01-01T00:00:00Z',
    `updated: ${updated}`,
    '---',
    '',
    '## Current Test',
    '',
    '[testing complete]',
    '',
    '## Tests',
    '',
    '### 1. Login Form',
    'expected: Form displays with email and password fields',
    'result: pass',
    '',
    '### 2. Submit Button',
    'expected: Submitting shows loading state',
    'result: pass',
    '',
  ].join('\n');
}

// A UAT with every row passed, but status still `testing` and a Current Test
// section still naming a pending test (T2).
function testingCompleteUatContent() {
  return [
    '---',
    'status: testing',
    'phase: 01-foo',
    'started: 2026-01-01T00:00:00Z',
    'updated: 2026-01-01T00:00:00Z',
    '---',
    '',
    '## Current Test',
    '',
    '### 2. Submit Button',
    'expected: Submitting shows loading state',
    '',
    '## Tests',
    '',
    '### 1. Login Form',
    'expected: Form displays with email and password fields',
    'result: pass',
    '',
    '### 2. Submit Button',
    'expected: Submitting shows loading state',
    'result: pass',
    '',
  ].join('\n');
}

describe('T1: uat.complete-session on an already-complete UAT — no writes, no commit (#4981 UAT)', () => {
  test('CLI: changed:false; bytes identical; HEAD unchanged', (t) => {
    const projectDir = createTempGitProject();
    t.after(() => cleanup(projectDir));
    const phaseDir = path.join(projectDir, '.planning', 'phases', '01-foo');
    fs.mkdirSync(phaseDir, { recursive: true });
    const uatPath = path.join(phaseDir, '01-UAT.md');
    const before = completeUatContent();
    fs.writeFileSync(uatPath, before);
    const { execFileSync } = require('child_process');
    execFileSync('git', ['add', '-A'], { cwd: projectDir, timeout: GIT_TIMEOUT_MS });
    execFileSync('git', ['commit', '-q', '-m', 'seed UAT'], { cwd: projectDir, timeout: GIT_TIMEOUT_MS });
    const headBefore = gitHeadCount(projectDir);

    const result = runGsdTools(['query', 'uat.complete-session', '.planning/phases/01-foo/01-UAT.md'], projectDir);
    assert.ok(result.success, `expected success: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.changed, false);
    assert.strictEqual(fs.readFileSync(uatPath, 'utf-8'), before, 'bytes must be untouched');
    assert.strictEqual(gitHeadCount(projectDir), headBefore, 'no new commit on a no-op session');
  });
});

describe('T2: uat.complete-session with every row passed but status testing and a pending Current Test', () => {
  test('CLI: changed:true; status complete; Current Test cleared; one commit', (t) => {
    const projectDir = createTempGitProject();
    t.after(() => cleanup(projectDir));
    const phaseDir = path.join(projectDir, '.planning', 'phases', '01-foo');
    fs.mkdirSync(phaseDir, { recursive: true });
    const uatPath = path.join(phaseDir, '01-UAT.md');
    fs.writeFileSync(uatPath, testingCompleteUatContent());
    const { execFileSync } = require('child_process');
    execFileSync('git', ['add', '-A'], { cwd: projectDir, timeout: GIT_TIMEOUT_MS });
    execFileSync('git', ['commit', '-q', '-m', 'seed UAT'], { cwd: projectDir, timeout: GIT_TIMEOUT_MS });
    const headBefore = gitHeadCount(projectDir);

    const result = runGsdTools(['query', 'uat.complete-session', '.planning/phases/01-foo/01-UAT.md'], projectDir);
    assert.ok(result.success, `expected success: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.changed, true);
    const after = fs.readFileSync(uatPath, 'utf-8');
    assert.match(after, /status: complete/);
    assert.match(after, /\[testing complete\]/);
    const headAfter = gitHeadCount(projectDir);
    assert.strictEqual(Number(headAfter) - Number(headBefore), 1, 'exactly one new commit');
  });
});

describe('T3: boundary — live differs from result only in `updated:` value', () => {
  test('pure core: changed:false when only `updated` differs', () => {
    const completeUatSession = loadCompleteUatSession();
    assert.strictEqual(typeof completeUatSession, 'function', 'completeUatSession must be exported by uat.cjs (R1)');
    const live = completeUatContent({ updated: '2020-01-01T00:00:00Z' });
    const mockClock = () => new Date('2026-05-05T00:00:00Z');
    const result = completeUatSession(live, { clock: mockClock });
    assert.strictEqual(result.changed, false, 'an updated-only diff is not material');
  });
});

describe('T3b: boundary — live complete, one row flips to an issue', () => {
  test('pure core: changed:true, status:partial', () => {
    const completeUatSession = loadCompleteUatSession();
    const live = completeUatContent().replace(
      'result: pass\n\n### 2. Submit Button',
      'result: [issue]\n\n### 2. Submit Button',
    );
    const result = completeUatSession(live, { clock: () => new Date('2026-05-05T00:00:00Z') });
    assert.strictEqual(result.changed, true);
    assert.strictEqual(result.status, 'partial');
  });
});

describe('T4: property — idempotence and non-updated-byte sensitivity (seed pinned via fast-check-setup)', () => {
  test('completeUatSession(completeUatSession(x).content).changed === false', () => {
    const completeUatSession = loadCompleteUatSession();
    const results = ['pass', 'pass', 'pass'];
    fc.assert(
      fc.property(
        fc.constantFrom('complete', 'testing'),
        fc.date({ min: new Date('2020-01-01'), max: new Date('2030-01-01') }),
        (status, updatedDate) => {
          const content = [
            '---',
            `status: ${status}`,
            'phase: 01-foo',
            'started: 2026-01-01T00:00:00Z',
            `updated: ${updatedDate.toISOString()}`,
            '---',
            '',
            '## Current Test',
            '',
            status === 'complete' ? '[testing complete]' : '### 1. Login Form\nexpected: x',
            '',
            '## Tests',
            '',
            ...results.flatMap((r, i) => [
              `### ${i + 1}. Test ${i + 1}`,
              'expected: something',
              `result: ${r}`,
              '',
            ]),
          ].join('\n');
          const clock = () => new Date('2026-06-01T00:00:00Z');
          const first = completeUatSession(content, { clock });
          const second = completeUatSession(first.content, { clock });
          assert.strictEqual(second.changed, false, 'second call over the first result must be a no-op');
        },
      ),
    );
  });

  test('changing any non-`updated` byte of a complete doc gives changed:true', () => {
    const completeUatSession = loadCompleteUatSession();
    const clock = () => new Date('2026-06-01T00:00:00Z');
    const live = completeUatContent();
    const first = completeUatSession(live, { clock });
    assert.strictEqual(first.changed, false, 'sanity: already-complete doc is a no-op');
    const mutated = first.content.replace('result: pass\n\n### 2. Submit Button', 'result: [issue]\n\n### 2. Submit Button');
    const second = completeUatSession(mutated, { clock });
    assert.strictEqual(second.changed, true, 'a material byte change must be detected');
  });
});
