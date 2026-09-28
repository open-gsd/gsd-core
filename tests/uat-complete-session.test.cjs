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

describe('T3: boundary — candidate differs from baseline only in `updated:` value', () => {
  test('pure core: changed:false when only `updated` differs from baseline', () => {
    const completeUatSession = loadCompleteUatSession();
    assert.strictEqual(typeof completeUatSession, 'function', 'completeUatSession must be exported by uat.cjs (R1)');
    const live = completeUatContent({ updated: '2020-01-01T00:00:00Z' });
    const baseline = completeUatContent({ updated: '2019-06-06T00:00:00Z' });
    const mockClock = () => new Date('2026-05-05T00:00:00Z');
    const result = completeUatSession(live, { clock: mockClock, baseline });
    assert.strictEqual(result.changed, false, 'an updated-only diff against baseline is not material');
  });
});

describe('T3b: boundary — live complete, one row flips to blocked', () => {
  test('pure core: changed:true, status:partial', () => {
    const completeUatSession = loadCompleteUatSession();
    const live = completeUatContent().replace(
      'result: pass\n\n### 2. Submit Button',
      'result: blocked\n\n### 2. Submit Button',
    );
    const result = completeUatSession(live, { clock: () => new Date('2026-05-05T00:00:00Z') });
    assert.strictEqual(result.changed, true);
    assert.strictEqual(result.status, 'partial');
  });
});

describe('T3c: boundary — an `issue` row with everything else resolved is a definitive result', () => {
  test('pure core: status:complete (issue never blocks completion on its own)', () => {
    const completeUatSession = loadCompleteUatSession();
    const live = completeUatContent().replace(
      'result: pass\n\n### 2. Submit Button',
      'result: issue\n\n### 2. Submit Button',
    );
    const result = completeUatSession(live, { clock: () => new Date('2026-05-05T00:00:00Z') });
    assert.strictEqual(result.status, 'complete');
  });
});

describe('T3d: boundary — a `skipped` row WITH a reason is a definitive result', () => {
  test('pure core: status:complete', () => {
    const completeUatSession = loadCompleteUatSession();
    const live = completeUatContent().replace(
      'result: pass\n\n### 2. Submit Button',
      'result: skipped\nreason: not applicable on this platform\n\n### 2. Submit Button',
    );
    const result = completeUatSession(live, { clock: () => new Date('2026-05-05T00:00:00Z') });
    assert.strictEqual(result.status, 'complete');
  });
});

describe('T3e: boundary — a `skipped` row with NO reason is partial', () => {
  test('pure core: status:partial', () => {
    const completeUatSession = loadCompleteUatSession();
    const live = completeUatContent().replace(
      'result: pass\n\n### 2. Submit Button',
      'result: skipped\n\n### 2. Submit Button',
    );
    const result = completeUatSession(live, { clock: () => new Date('2026-05-05T00:00:00Z') });
    assert.strictEqual(result.status, 'partial');
  });
});

describe('T3f: boundary — a `[pending]` row is partial', () => {
  test('pure core: status:partial', () => {
    const completeUatSession = loadCompleteUatSession();
    const live = completeUatContent().replace(
      'result: pass\n\n### 2. Submit Button',
      'result: [pending]\n\n### 2. Submit Button',
    );
    const result = completeUatSession(live, { clock: () => new Date('2026-05-05T00:00:00Z') });
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
          // Idempotence: baseline = live = the first call's own result content.
          const second = completeUatSession(first.content, { clock, baseline: first.content });
          assert.strictEqual(second.changed, false, 'second call over the first result must be a no-op');
        },
      ),
    );
  });

  test('changing any non-`updated` byte of a complete doc gives changed:true', () => {
    const completeUatSession = loadCompleteUatSession();
    const clock = () => new Date('2026-06-01T00:00:00Z');
    const live = completeUatContent();
    const first = completeUatSession(live, { clock, baseline: live });
    assert.strictEqual(first.changed, false, 'sanity: already-complete doc is a no-op against its own baseline');
    // baseline = the original complete doc; live = the same doc with one
    // non-`updated` byte mutated.
    const mutated = live.replace('result: pass\n\n### 2. Submit Button', 'result: [issue]\n\n### 2. Submit Button');
    const second = completeUatSession(mutated, { clock, baseline: live });
    assert.strictEqual(second.changed, true, 'a material byte change must be detected');
  });
});

describe('S7: `## Current Test` replacement is fence-aware (#5105 review)', () => {
  test('a `## `-looking line inside a fenced code block does not end the section early', () => {
    const completeUatSession = loadCompleteUatSession();
    const content = [
      '---',
      'status: testing',
      'phase: 01-foo',
      'started: 2026-01-01T00:00:00Z',
      'updated: 2026-01-01T00:00:00Z',
      '---',
      '',
      '## Current Test',
      '',
      '```',
      'some code',
      '## not a real heading',
      '```',
      '',
      '### 2. Submit Button',
      'expected: Submitting shows loading state',
      '',
      '## Tests',
      '',
      '### 1. Login Form',
      'expected: Form displays correctly',
      'result: pass',
      '',
      '### 2. Submit Button',
      'expected: Submitting shows loading state',
      'result: pass',
      '',
    ].join('\n');
    const result = completeUatSession(content, { clock: () => new Date('2026-05-05T00:00:00Z') });
    assert.strictEqual(result.changed, true);
    assert.match(result.content, /\[testing complete\]/);
    const testsHeadingCount = (result.content.match(/^## Tests$/gm) || []).length;
    assert.strictEqual(testsHeadingCount, 1, 'the real ## Tests heading must survive exactly once');
    assert.doesNotMatch(
      result.content,
      /not a real heading/,
      'a hand-rolled `^## ` scanner would stop at the fenced fake heading, leaving it (and the ' +
      'orphaned real content past it) in the output instead of replacing through to ## Tests',
    );
  });
});

describe('S8: frontmatter-scoped status/updated writes (#5105 review)', () => {
  test('a body line `status: foo` (outside frontmatter) is untouched', () => {
    const completeUatSession = loadCompleteUatSession();
    const content = completeUatContent().replace(
      'expected: Submitting shows loading state',
      'expected: Submitting shows loading state\nstatus: foo',
    );
    const result = completeUatSession(content, { clock: () => new Date('2026-05-05T00:00:00Z'), baseline: null });
    assert.match(result.content, /^status: foo$/m, 'the body line must survive verbatim');
    // The frontmatter's own status line is the only one this call may alter.
    const frontmatterBlock = result.content.slice(0, result.content.indexOf('\n---', 4) + 4);
    assert.match(frontmatterBlock, /^status: complete$/m);
  });

  test('frontmatter lacking `updated:` gains one when changed', () => {
    const completeUatSession = loadCompleteUatSession();
    const content = [
      '---',
      'status: testing',
      'phase: 01-foo',
      'started: 2026-01-01T00:00:00Z',
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
      'expected: Form displays correctly',
      'result: pass',
      '',
      '### 2. Submit Button',
      'expected: Submitting shows loading state',
      'result: pass',
      '',
    ].join('\n');
    const result = completeUatSession(content, { clock: () => new Date('2026-05-05T12:00:00Z'), baseline: null });
    assert.strictEqual(result.changed, true);
    assert.match(result.content, /^updated: 2026-05-05T12:00:00\.000Z$/m, 'a gained `updated:` key must be stamped from the clock');
  });
});

describe('#5105 review findings 1/2/3: HEAD baseline wiring end-to-end', () => {
  test('(a) committed complete UAT + a changed row in the live file: committed:true, clean tree, HEAD carries the change', (t) => {
    const projectDir = createTempGitProject();
    t.after(() => cleanup(projectDir));
    const phaseDir = path.join(projectDir, '.planning', 'phases', '01-foo');
    fs.mkdirSync(phaseDir, { recursive: true });
    const uatPath = path.join(phaseDir, '01-UAT.md');
    const { execFileSync } = require('child_process');
    fs.writeFileSync(uatPath, completeUatContent());
    execFileSync('git', ['add', '-A'], { cwd: projectDir, timeout: GIT_TIMEOUT_MS });
    execFileSync('git', ['commit', '-q', '-m', 'seed UAT'], { cwd: projectDir, timeout: GIT_TIMEOUT_MS });

    // Live already reads status: complete / [testing complete] (unchanged
    // from HEAD in that respect), but one row's result was edited afterward
    // — a genuine material change the HEAD-baseline comparison must catch.
    const changedRowContent = completeUatContent().replace(
      'result: pass\n\n### 2. Submit Button',
      'result: issue\n\n### 2. Submit Button',
    );
    fs.writeFileSync(uatPath, changedRowContent);

    const result = runGsdTools(['query', 'uat.complete-session', '.planning/phases/01-foo/01-UAT.md'], projectDir);
    assert.ok(result.success, `expected success: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.changed, true, 'a changed row vs the committed HEAD baseline is material');
    assert.strictEqual(parsed.committed, true);

    const statusOut = execFileSync('git', ['status', '--porcelain', '.'], { cwd: projectDir, encoding: 'utf-8', timeout: GIT_TIMEOUT_MS });
    assert.strictEqual(statusOut.trim(), '', 'the commit must leave the tree clean');

    const headBlob = execFileSync('git', ['show', 'HEAD:.planning/phases/01-foo/01-UAT.md'], { cwd: projectDir, encoding: 'utf-8', timeout: GIT_TIMEOUT_MS });
    assert.match(headBlob, /result: issue/, 'the committed HEAD blob must carry the changed row');
  });

  test('(b) an untracked (never-committed) UAT file: committed:true on first completion', (t) => {
    const projectDir = createTempGitProject();
    t.after(() => cleanup(projectDir));
    const phaseDir = path.join(projectDir, '.planning', 'phases', '01-foo');
    fs.mkdirSync(phaseDir, { recursive: true });
    const uatPath = path.join(phaseDir, '01-UAT.md');
    fs.writeFileSync(uatPath, testingCompleteUatContent());
    // No `git add`/`git commit` — the UAT file is untracked; HEAD has no blob
    // for it, so readBaselineAtHead must return null (not throw), and the
    // pure core must treat that as "no baseline" (material change).

    const result = runGsdTools(['query', 'uat.complete-session', '.planning/phases/01-foo/01-UAT.md'], projectDir);
    assert.ok(result.success, `expected success: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.changed, true);
    assert.strictEqual(parsed.committed, true, 'an untracked UAT must still commit cleanly on first completion');
  });

  test('(c) project root is a subdirectory of the git toplevel: baseline still resolves; a second unchanged run is a no-op', (t) => {
    const projectDir = createTempGitProject();
    t.after(() => cleanup(projectDir));
    // Nest an independent "project root" a level below the git toplevel
    // (`createTempGitProject`'s own root) — #5105 review finding 1's
    // reproduction: `git show HEAD:<path>` resolves from the TOPLEVEL, not
    // from this nested cwd, so a `relPath` computed relative to the nested
    // cwd must be re-anchored to the toplevel before use.
    const subRoot = path.join(projectDir, 'nested-project');
    const phaseDir = path.join(subRoot, '.planning', 'phases', '01-foo');
    fs.mkdirSync(phaseDir, { recursive: true });
    const uatPath = path.join(phaseDir, '01-UAT.md');
    const before = completeUatContent();
    fs.writeFileSync(uatPath, before);
    const { execFileSync } = require('child_process');
    execFileSync('git', ['add', '-A'], { cwd: projectDir, timeout: GIT_TIMEOUT_MS });
    execFileSync('git', ['commit', '-q', '-m', 'seed nested UAT'], { cwd: projectDir, timeout: GIT_TIMEOUT_MS });
    const headBefore = gitHeadCount(projectDir);

    const result = runGsdTools(['query', 'uat.complete-session', '.planning/phases/01-foo/01-UAT.md'], subRoot);
    assert.ok(result.success, `expected success: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.changed, false, 'an already-complete doc against its own correctly-resolved HEAD baseline is a no-op');
    assert.strictEqual(fs.readFileSync(uatPath, 'utf-8'), before, 'bytes must be untouched');
    assert.strictEqual(gitHeadCount(projectDir), headBefore, 'no spurious commit from a mis-resolved (toplevel-relative) baseline path');

    const statusOut = execFileSync('git', ['status', '--porcelain', '.'], { cwd: projectDir, encoding: 'utf-8', timeout: GIT_TIMEOUT_MS });
    assert.strictEqual(statusOut.trim(), '', 'the nested-project tree must stay clean');
  });
});

describe('S9: committed/reason reporting (#5105 review — no fs.writeSync monkeypatch)', () => {
  test('a normal material change reports committed:true', (t) => {
    const projectDir = createTempGitProject();
    t.after(() => cleanup(projectDir));
    const phaseDir = path.join(projectDir, '.planning', 'phases', '01-foo');
    fs.mkdirSync(phaseDir, { recursive: true });
    const uatPath = path.join(phaseDir, '01-UAT.md');
    fs.writeFileSync(uatPath, testingCompleteUatContent());
    const { execFileSync } = require('child_process');
    execFileSync('git', ['add', '-A'], { cwd: projectDir, timeout: GIT_TIMEOUT_MS });
    execFileSync('git', ['commit', '-q', '-m', 'seed UAT'], { cwd: projectDir, timeout: GIT_TIMEOUT_MS });

    const result = runGsdTools(['query', 'uat.complete-session', '.planning/phases/01-foo/01-UAT.md'], projectDir);
    assert.ok(result.success, `expected success: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.changed, true);
    assert.strictEqual(parsed.committed, true, 'a real commit must be reported, not assumed');
    assert.strictEqual(parsed.reason, undefined, 'no reason is reported on a successful commit');
  });

  test('commit_docs:false reports committed:false with the skip reason', (t) => {
    const projectDir = createTempGitProject();
    t.after(() => cleanup(projectDir));
    const phaseDir = path.join(projectDir, '.planning', 'phases', '01-foo');
    fs.mkdirSync(phaseDir, { recursive: true });
    const uatPath = path.join(phaseDir, '01-UAT.md');
    fs.writeFileSync(uatPath, testingCompleteUatContent());
    const configPath = path.join(projectDir, '.planning', 'config.json');
    const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf-8')) : {};
    config.commit_docs = false;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    const { execFileSync } = require('child_process');
    execFileSync('git', ['add', '-A'], { cwd: projectDir, timeout: GIT_TIMEOUT_MS });
    execFileSync('git', ['commit', '-q', '-m', 'seed UAT + commit_docs:false'], { cwd: projectDir, timeout: GIT_TIMEOUT_MS });
    const headBefore = gitHeadCount(projectDir);

    const result = runGsdTools(['query', 'uat.complete-session', '.planning/phases/01-foo/01-UAT.md'], projectDir);
    assert.ok(result.success, `expected success: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.changed, true, 'the session status/Current Test change is still material');
    assert.match(fs.readFileSync(uatPath, 'utf-8'), /status: complete/, 'the file is still written even when the commit is skipped');
    assert.strictEqual(parsed.committed, false);
    assert.strictEqual(parsed.reason, 'skipped_commit_docs_false');
    assert.strictEqual(gitHeadCount(projectDir), headBefore, 'no commit was made');
  });
});
