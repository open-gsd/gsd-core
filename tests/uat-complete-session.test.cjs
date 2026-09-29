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
  test('pure core: changed:false, no restore, content is the untouched live bytes', () => {
    const completeUatSession = loadCompleteUatSession();
    assert.strictEqual(typeof completeUatSession, 'function', 'completeUatSession must be exported by uat.cjs (R1)');
    const live = completeUatContent({ updated: '2020-01-01T00:00:00Z' });
    const baseline = completeUatContent({ updated: '2019-06-06T00:00:00Z' });
    const mockClock = () => new Date('2026-05-05T00:00:00Z');
    const result = completeUatSession(live, { clock: mockClock, baseline });
    assert.strictEqual(result.changed, false, 'an updated-only diff against baseline is not material');
    assert.strictEqual(result.restored, undefined, 'an updated-only diff must never trigger a restore write (the #5105 R1 decision)');
    assert.strictEqual(result.content, live, 'content must be the untouched live bytes, never re-rendered');
  });
});

describe('#5105 M1/m1: restore is restricted to a live-vs-candidate diff beyond `updated:`, and is byte-exact to baseline', () => {
  test('(i) pure core: baseline complete, live is the "testing" variant of the same rows → restored:true, content === baseline bytes', () => {
    const completeUatSession = loadCompleteUatSession();
    const baseline = completeUatContent();
    const live = testingCompleteUatContent();
    const result = completeUatSession(live, { clock: () => new Date('2026-05-05T00:00:00Z'), baseline });
    assert.strictEqual(result.changed, false);
    assert.strictEqual(result.restored, true, 'live differs from the normalized candidate in status/Current Test, not just updated');
    assert.strictEqual(result.content, baseline, 'restored content must be byte-identical to the committed baseline');
  });

  test('(ii) pure core: live differs from baseline/candidate ONLY in `updated:` → no restore, content untouched (already covered by T3, asserted again here for the M1 grouping)', () => {
    const completeUatSession = loadCompleteUatSession();
    const baseline = completeUatContent({ updated: '2019-06-06T00:00:00Z' });
    const live = completeUatContent({ updated: '2020-01-01T00:00:00Z' });
    const result = completeUatSession(live, { clock: () => new Date('2026-05-05T00:00:00Z'), baseline });
    assert.strictEqual(result.changed, false);
    assert.strictEqual(result.restored, undefined);
    assert.strictEqual(result.content, live);
  });

  test('(iii) pure core: baseline `updated:X` with no space is restored byte-exact (not re-rendered as `updated: X`)', () => {
    const completeUatSession = loadCompleteUatSession();
    const baseline = completeUatContent().replace('updated: 2026-01-01T00:00:00Z', 'updated:2026-01-01T00:00:00Z');
    const live = testingCompleteUatContent();
    const result = completeUatSession(live, { clock: () => new Date('2026-05-05T00:00:00Z'), baseline });
    assert.strictEqual(result.changed, false);
    assert.strictEqual(result.restored, true);
    assert.strictEqual(result.content, baseline, 'restored content must preserve baseline\'s exact `updated:` spacing byte-for-byte');
    assert.match(result.content, /^updated:2026-01-01T00:00:00Z$/m, 'no space must be introduced after the colon');
  });

  test('CLI (i): restored case — file bytes equal `git show HEAD:<path>`, tree clean, HEAD unchanged, output restored:true', (t) => {
    const projectDir = createTempGitProject();
    t.after(() => cleanup(projectDir));
    const phaseDir = path.join(projectDir, '.planning', 'phases', '01-foo');
    fs.mkdirSync(phaseDir, { recursive: true });
    const uatPath = path.join(phaseDir, '01-UAT.md');
    const { execFileSync } = require('child_process');
    fs.writeFileSync(uatPath, completeUatContent());
    execFileSync('git', ['add', '-A'], { cwd: projectDir, timeout: GIT_TIMEOUT_MS });
    execFileSync('git', ['commit', '-q', '-m', 'seed complete UAT'], { cwd: projectDir, timeout: GIT_TIMEOUT_MS });
    const headBefore = gitHeadCount(projectDir);

    // Re-open the session on disk without committing: status flips back to
    // testing with a pending Current Test, but every row is still resolved —
    // completeUatSession will normalize this back to the committed baseline.
    fs.writeFileSync(uatPath, testingCompleteUatContent());

    const result = runGsdTools(['query', 'uat.complete-session', '.planning/phases/01-foo/01-UAT.md'], projectDir);
    assert.ok(result.success, `expected success: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.changed, false);
    assert.strictEqual(parsed.restored, true);

    const headBlob = execFileSync('git', ['show', `HEAD:.planning/phases/01-foo/01-UAT.md`], { cwd: projectDir, encoding: 'utf-8', timeout: GIT_TIMEOUT_MS });
    assert.strictEqual(fs.readFileSync(uatPath, 'utf-8'), headBlob, 'restored file bytes must equal the HEAD blob exactly');
    const statusOut = execFileSync('git', ['status', '--porcelain', '.'], { cwd: projectDir, encoding: 'utf-8', timeout: GIT_TIMEOUT_MS });
    assert.strictEqual(statusOut.trim(), '', 'a byte-exact restore must leave the tree clean');
    assert.strictEqual(gitHeadCount(projectDir), headBefore, 'a restore is not a commit');
  });

  test('CLI (ii): updated-only diff against baseline — file bytes unchanged, no commit', (t) => {
    const projectDir = createTempGitProject();
    t.after(() => cleanup(projectDir));
    const phaseDir = path.join(projectDir, '.planning', 'phases', '01-foo');
    fs.mkdirSync(phaseDir, { recursive: true });
    const uatPath = path.join(phaseDir, '01-UAT.md');
    const before = completeUatContent({ updated: '2020-01-01T00:00:00Z' });
    fs.writeFileSync(uatPath, before);
    const { execFileSync } = require('child_process');
    execFileSync('git', ['add', '-A'], { cwd: projectDir, timeout: GIT_TIMEOUT_MS });
    execFileSync('git', ['commit', '-q', '-m', 'seed UAT with an updated timestamp'], { cwd: projectDir, timeout: GIT_TIMEOUT_MS });
    const headBefore = gitHeadCount(projectDir);

    // Live differs from the committed baseline ONLY in `updated:`.
    fs.writeFileSync(uatPath, completeUatContent({ updated: '2021-02-02T00:00:00Z' }));
    const liveBytesBefore = fs.readFileSync(uatPath, 'utf-8');

    const result = runGsdTools(['query', 'uat.complete-session', '.planning/phases/01-foo/01-UAT.md'], projectDir);
    assert.ok(result.success, `expected success: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.changed, false);
    assert.strictEqual(parsed.restored, undefined, 'must never restore/write on an updated-only diff');
    assert.strictEqual(fs.readFileSync(uatPath, 'utf-8'), liveBytesBefore, 'file bytes must be unchanged');
    assert.strictEqual(gitHeadCount(projectDir), headBefore, 'no commit on an updated-only diff');
  });
});

// Found while implementing #5105 (review security finding 1): the baseline's `updated:` line
// is committed file content, so the restore must splice it as literal text — a
// String.prototype.replace replacement string would expand `$'`, `` $` ``, `$&`, `$$` (and
// `$1` when a group exists), writing an early `---` fence or duplicated keys. The restore now
// writes the baseline bytes themselves (no splice, so no replacement pattern is evaluated); the
// `$` cases stay as regression locks, and the restore target is the baseline wherever its
// `updated:` line sits.
describe('#5105: the restore splices the baseline `updated:` line literally and verifies it', () => {
  const clock = () => new Date('2026-05-05T00:00:00Z');

  for (const value of ["$'", '$`', '$&', '$1', '$$', "x$'y$`z$&"]) {
    test(`baseline \`updated: ${value}\` → restored byte-exact to the baseline`, () => {
      const completeUatSession = loadCompleteUatSession();
      const baseline = completeUatContent({ updated: value });
      const live = testingCompleteUatContent();
      const result = completeUatSession(live, { clock, baseline });
      assert.strictEqual(result.changed, false);
      assert.strictEqual(result.restored, true);
      assert.strictEqual(result.content, baseline, 'the restored bytes must be the baseline bytes, not a `$`-pattern expansion');
    });
  }

  test('baseline `updated:` mid-block, live lacks it → restored byte-exact to the baseline', () => {
    const completeUatSession = loadCompleteUatSession();
    const midBlock = (s) => s.replace('status: complete\nphase: 01-foo\n', 'status: complete\nupdated: 2026-01-01T00:00:00Z\nphase: 01-foo\n');
    const baseline = midBlock(completeUatContent().replace(/^updated: .*\n/m, ''));
    const live = testingCompleteUatContent().replace(/^updated: .*\n/m, '');
    const result = completeUatSession(live, { clock, baseline });
    assert.strictEqual(result.changed, false);
    assert.strictEqual(result.restored, true);
    assert.strictEqual(result.content, baseline, 'the restore target is the baseline bytes, wherever its `updated:` line sits');
  });

  test('CLI: baseline `updated:` mid-block, live lacks it → restored to HEAD, nothing committed, tree clean', (t) => {
    const projectDir = createTempGitProject();
    t.after(() => cleanup(projectDir));
    const phaseDir = path.join(projectDir, '.planning', 'phases', '01-foo');
    fs.mkdirSync(phaseDir, { recursive: true });
    const uatPath = path.join(phaseDir, '01-UAT.md');
    const { execFileSync } = require('child_process');
    const seeded = completeUatContent().replace(/^updated: .*\n/m, '').replace('status: complete\nphase: 01-foo\n', 'status: complete\nupdated: 2026-01-01T00:00:00Z\nphase: 01-foo\n');
    fs.writeFileSync(uatPath, seeded);
    execFileSync('git', ['add', '-A'], { cwd: projectDir, timeout: GIT_TIMEOUT_MS });
    execFileSync('git', ['commit', '-q', '-m', 'seed UAT with updated mid-block'], { cwd: projectDir, timeout: GIT_TIMEOUT_MS });
    const headBefore = gitHeadCount(projectDir);
    fs.writeFileSync(uatPath, testingCompleteUatContent().replace(/^updated: .*\n/m, ''));

    const result = runGsdTools(['query', 'uat.complete-session', '.planning/phases/01-foo/01-UAT.md'], projectDir);
    assert.ok(result.success, `expected success: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.changed, false);
    assert.strictEqual(parsed.restored, true);
    assert.strictEqual(fs.readFileSync(uatPath, 'utf-8'), seeded, 'restored bytes equal the HEAD bytes');
    assert.strictEqual(gitHeadCount(projectDir), headBefore, 'nothing committed');
    const statusOut = execFileSync('git', ['status', '--porcelain', '.'], { cwd: projectDir, encoding: 'utf-8', timeout: GIT_TIMEOUT_MS });
    assert.strictEqual(statusOut.trim(), '', 'the restore leaves the tree clean');
  });
});

// Found while implementing #5105 (review m7): presence of the `updated:` line is not
// material either — a side LACKING the line differs "only in updated" from a side
// carrying any value, in both directions, and a restore re-creates or removes the line
// byte-exactly to match the baseline.
describe('#5105 m7: a missing `updated:` line is equivalent to any `updated:` value', () => {
  const clock = () => new Date('2026-05-05T00:00:00Z');
  const withoutUpdated = (s) => s.replace(/^updated: .*\n/m, '');

  test('baseline lacks `updated:`, live carries one → changed:false, no restore, live untouched', () => {
    const completeUatSession = loadCompleteUatSession();
    const baseline = withoutUpdated(completeUatContent());
    const live = completeUatContent({ updated: '2021-02-02T00:00:00Z' });
    const result = completeUatSession(live, { clock, baseline });
    assert.strictEqual(result.changed, false);
    assert.strictEqual(result.restored, undefined);
    assert.strictEqual(result.content, live);
  });

  test('baseline carries `updated:`, live lacks it → changed:false, no restore, live untouched', () => {
    const completeUatSession = loadCompleteUatSession();
    const baseline = completeUatContent();
    const live = withoutUpdated(completeUatContent());
    const result = completeUatSession(live, { clock, baseline });
    assert.strictEqual(result.changed, false);
    assert.strictEqual(result.restored, undefined);
    assert.strictEqual(result.content, live);
  });

  test('re-opened live with `updated:`, baseline without → restored byte-exact (line removed)', () => {
    const completeUatSession = loadCompleteUatSession();
    const baseline = withoutUpdated(completeUatContent());
    const live = testingCompleteUatContent();
    const result = completeUatSession(live, { clock, baseline });
    assert.strictEqual(result.changed, false);
    assert.strictEqual(result.restored, true);
    assert.strictEqual(result.content, baseline);
  });

  test('re-opened live without `updated:`, baseline with one → restored byte-exact (line re-created)', () => {
    const completeUatSession = loadCompleteUatSession();
    // completeUatContent's `updated:` is the LAST frontmatter key, so the re-created line
    // (appended before the closing fence) lands exactly where the baseline has it.
    const baseline = completeUatContent();
    const live = withoutUpdated(testingCompleteUatContent());
    const result = completeUatSession(live, { clock, baseline });
    assert.strictEqual(result.changed, false);
    assert.strictEqual(result.restored, true);
    assert.strictEqual(result.content, baseline);
  });
});

// Found while implementing #5105 (review M4): a CRLF document behaves exactly like its
// LF counterpart — no spurious material change from a re-emitted bare-LF line.
describe('#5105 M4: CRLF documents behave exactly as LF', () => {
  const crlf = (s) => s.replace(/\n/g, '\r\n');
  const clock = () => new Date('2026-05-05T00:00:00Z');

  test('live byte-identical to a CRLF baseline → changed:false, content untouched', () => {
    const completeUatSession = loadCompleteUatSession();
    const doc = crlf(completeUatContent());
    const result = completeUatSession(doc, { clock, baseline: doc });
    assert.strictEqual(result.changed, false);
    assert.strictEqual(result.restored, undefined);
    assert.strictEqual(result.content, doc);
  });

  test('CRLF live differing only in `updated:` → changed:false, no restore, content untouched', () => {
    const completeUatSession = loadCompleteUatSession();
    const baseline = crlf(completeUatContent({ updated: '2019-06-06T00:00:00Z' }));
    const live = crlf(completeUatContent({ updated: '2020-01-01T00:00:00Z' }));
    const result = completeUatSession(live, { clock, baseline });
    assert.strictEqual(result.changed, false);
    assert.strictEqual(result.restored, undefined);
    assert.strictEqual(result.content, live);
  });

  test('CRLF re-opened session → restored:true, byte-exact to the CRLF baseline', () => {
    const completeUatSession = loadCompleteUatSession();
    const baseline = crlf(completeUatContent());
    const live = crlf(testingCompleteUatContent());
    const result = completeUatSession(live, { clock, baseline });
    assert.strictEqual(result.changed, false);
    assert.strictEqual(result.restored, true);
    assert.strictEqual(result.content, baseline);
  });

  test('CRLF material change → changed:true, every line still CRLF', () => {
    const completeUatSession = loadCompleteUatSession();
    const live = crlf(testingCompleteUatContent());
    const result = completeUatSession(live, { clock, baseline: null });
    assert.strictEqual(result.changed, true);
    assert.match(result.content, /^status: complete\r$/m);
    assert.match(result.content, /^updated: 2026-05-05T00:00:00\.000Z\r$/m);
    assert.ok(!/(^|[^\r])\n/.test(result.content), 'no bare-LF line ending');
  });

  test('CLI: CRLF live byte-identical to HEAD → changed:false, bytes untouched, no commit', (t) => {
    const projectDir = createTempGitProject();
    t.after(() => cleanup(projectDir));
    const phaseDir = path.join(projectDir, '.planning', 'phases', '01-foo');
    fs.mkdirSync(phaseDir, { recursive: true });
    const uatPath = path.join(phaseDir, '01-UAT.md');
    const before = crlf(completeUatContent());
    fs.writeFileSync(uatPath, before);
    const { execFileSync } = require('child_process');
    execFileSync('git', ['-c', 'core.autocrlf=false', 'add', '-A'], { cwd: projectDir, timeout: GIT_TIMEOUT_MS });
    execFileSync('git', ['-c', 'core.autocrlf=false', 'commit', '-q', '-m', 'seed CRLF UAT'], { cwd: projectDir, timeout: GIT_TIMEOUT_MS });
    const headBefore = gitHeadCount(projectDir);

    const result = runGsdTools(['query', 'uat.complete-session', '.planning/phases/01-foo/01-UAT.md'], projectDir);
    assert.ok(result.success, `expected success: ${result.error}`);
    assert.strictEqual(JSON.parse(result.output).changed, false);
    assert.strictEqual(fs.readFileSync(uatPath, 'utf-8'), before);
    assert.strictEqual(gitHeadCount(projectDir), headBefore);
  });
});

// Found while implementing #5105 (review Majors 2/3/5): an unparseable frontmatter
// block (here the no-space `status:complete`) is never regenerated — the session
// fails closed with a clear error, writing and committing nothing.
describe('#5105: an unparseable frontmatter block fails closed', () => {
  const nospace = (s) => s.replace('status: complete', 'status:complete');

  test('pure core: throws the frontmatter write refusal', () => {
    const completeUatSession = loadCompleteUatSession();
    const doc = nospace(completeUatContent());
    assert.throws(
      () => completeUatSession(doc, { clock: () => new Date('2026-05-05T00:00:00Z'), baseline: doc }),
      { name: 'FrontmatterWriteRefusedError', code: 'FRONTMATTER_UNPARSEABLE' },
    );
  });

  test('CLI: exits with the refusal; file bytes and HEAD unchanged', (t) => {
    const projectDir = createTempGitProject();
    t.after(() => cleanup(projectDir));
    const phaseDir = path.join(projectDir, '.planning', 'phases', '01-foo');
    fs.mkdirSync(phaseDir, { recursive: true });
    const uatPath = path.join(phaseDir, '01-UAT.md');
    const before = nospace(completeUatContent());
    fs.writeFileSync(uatPath, before);
    const { execFileSync } = require('child_process');
    execFileSync('git', ['add', '-A'], { cwd: projectDir, timeout: GIT_TIMEOUT_MS });
    execFileSync('git', ['commit', '-q', '-m', 'seed UAT'], { cwd: projectDir, timeout: GIT_TIMEOUT_MS });
    const headBefore = gitHeadCount(projectDir);

    const result = runGsdTools(['query', 'uat.complete-session', '.planning/phases/01-foo/01-UAT.md'], projectDir);
    assert.strictEqual(result.success, false, `must fail closed; stdout: ${result.output}`);
    assert.match(String(result.error), /not parseable YAML/);
    assert.strictEqual(fs.readFileSync(uatPath, 'utf-8'), before, 'nothing written');
    assert.strictEqual(gitHeadCount(projectDir), headBefore, 'nothing committed');
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

// #5105 (Windows CI, PR #5114 windows-latest shards 2/3 + 3/3): every CLI row expecting
// changed:false got changed:true because the HEAD baseline pathspec was derived in JS from two
// spellings of the same directory (the LONG forward-slash `rev-parse --show-toplevel` form vs the
// caller's 8.3 SHORT `C:\Users\RUNNER~1\...` form), which never shared a prefix, so the baseline
// was null. The baseline is now read git-natively (`git show HEAD:./<basename>` from the file's
// own directory), so git resolves the path and no JS-side spelling can produce a null baseline.
// The alternate-spelling scenario is driven on POSIX through a symlinked parent directory.
describe('#5105: the HEAD baseline resolves however the project path is spelled', () => {
  const { execFileSync } = require('child_process');

  function seedCompleteUat(repoRoot, subRoot) {
    const phaseDir = path.join(subRoot, '.planning', 'phases', '01-foo');
    fs.mkdirSync(phaseDir, { recursive: true });
    const uatPath = path.join(phaseDir, '01-UAT.md');
    fs.writeFileSync(uatPath, completeUatContent());
    execFileSync('git', ['add', '-A'], { cwd: repoRoot, timeout: GIT_TIMEOUT_MS });
    execFileSync('git', ['commit', '-q', '-m', 'seed UAT'], { cwd: repoRoot, timeout: GIT_TIMEOUT_MS });
    return uatPath;
  }

  test('project reached through a symlinked parent directory: unchanged session is a no-op', (t) => {
    const projectDir = createTempGitProject();
    t.after(() => cleanup(projectDir));
    const uatPath = seedCompleteUat(projectDir, projectDir);
    const headBefore = gitHeadCount(projectDir);

    const linkParent = fs.mkdtempSync(path.join(require('os').tmpdir(), 'gsd-uat-link-'));
    t.after(() => cleanup(linkParent));
    const linked = path.join(linkParent, 'alias');
    try {
      fs.symlinkSync(projectDir, linked, 'dir');
    } catch (err) {
      // Symlink creation needs a privilege on some Windows hosts; the Windows spelling scenario
      // is then covered by the OS's own 8.3 short-name path, which the native call also resolves.
      t.skip(`symlink unavailable: ${err.code}`);
      return;
    }

    const result = runGsdTools(['query', 'uat.complete-session', '.planning/phases/01-foo/01-UAT.md'], linked);
    assert.ok(result.success, `expected success: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.changed, false, 'the baseline must resolve through the alternate spelling');
    assert.strictEqual(fs.readFileSync(uatPath, 'utf-8'), completeUatContent(), 'bytes must be untouched');
    assert.strictEqual(gitHeadCount(projectDir), headBefore, 'no spurious commit from a null baseline');
  });

  test('project root in a subdirectory reached through a symlinked parent: unchanged session is a no-op', (t) => {
    const projectDir = createTempGitProject();
    t.after(() => cleanup(projectDir));
    const subRoot = path.join(projectDir, 'nested-project');
    seedCompleteUat(projectDir, subRoot);
    const headBefore = gitHeadCount(projectDir);

    const linkParent = fs.mkdtempSync(path.join(require('os').tmpdir(), 'gsd-uat-link-'));
    t.after(() => cleanup(linkParent));
    const linked = path.join(linkParent, 'alias');
    try {
      fs.symlinkSync(projectDir, linked, 'dir');
    } catch (err) {
      t.skip(`symlink unavailable: ${err.code}`);
      return;
    }

    const result = runGsdTools(['query', 'uat.complete-session', '.planning/phases/01-foo/01-UAT.md'], path.join(linked, 'nested-project'));
    assert.ok(result.success, `expected success: ${result.error}`);
    assert.strictEqual(JSON.parse(result.output).changed, false);
    assert.strictEqual(gitHeadCount(projectDir), headBefore);
  });

  test('an untracked UAT file has no baseline: changed:true', (t) => {
    const projectDir = createTempGitProject();
    t.after(() => cleanup(projectDir));
    const phaseDir = path.join(projectDir, '.planning', 'phases', '01-foo');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-UAT.md'), completeUatContent());

    const result = runGsdTools(['query', 'uat.complete-session', '.planning/phases/01-foo/01-UAT.md'], projectDir);
    assert.ok(result.success, `expected success: ${result.error}`);
    assert.strictEqual(JSON.parse(result.output).changed, true, 'no HEAD blob → no baseline → material');
  });

  test('a directory that is not a repository degrades to a null baseline: changed:true, no throw', (t) => {
    const plainDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'gsd-uat-nogit-'));
    t.after(() => cleanup(plainDir));
    const phaseDir = path.join(plainDir, '.planning', 'phases', '01-foo');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-UAT.md'), completeUatContent());
    // No repository to commit into: skip the commit so the outcome under test is the baseline alone.
    fs.writeFileSync(path.join(plainDir, '.planning', 'config.json'), JSON.stringify({ commit_docs: false }));

    const result = runGsdTools(['query', 'uat.complete-session', '.planning/phases/01-foo/01-UAT.md'], plainDir);
    assert.ok(result.success, `expected success: ${result.error}`);
    assert.strictEqual(JSON.parse(result.output).changed, true);
  });
});
