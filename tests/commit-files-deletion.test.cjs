/**
 * Regression test for #2014: gsd-tools commit --files silently deletes
 * planning files when a filename passed via --files does not exist on disk.
 *
 * Prior to this fix, when --files STATE.md was passed and STATE.md did not
 * exist on disk, the code called `git rm --cached --ignore-unmatch STATE.md`
 * which staged and committed a deletion. The caller passed explicit --files
 * expecting only those specific files to be staged -- missing files should
 * be skipped, not deleted.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createTempGitProject, cleanup, runGsdTools } = require('./helpers.cjs');
const fc = require('fast-check');
const { collectListFlagValues, COMMIT_LIST_FLAGS } = require('../gsd-core/bin/gsd-tools.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
// #3145: class-norm timeout, not a per-suite value — see helpers/timeouts.cjs.
const { GIT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

describe('commit --files: missing files must not stage deletions (#2014)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempGitProject();
    // Commit STATE.md so it exists in git history
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), '# State\n\nInitial state.\n');
    gitOrThrow(['add', '.planning/STATE.md'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS });
    gitOrThrow(['commit', '-m', 'add STATE.md'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS });
    // Delete STATE.md from disk -- now missing but tracked in git
    fs.unlinkSync(path.join(tmpDir, '.planning', 'STATE.md'));
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('passing --files for a missing tracked file does not commit a deletion', () => {
    // STATE.md is tracked in git but deleted from disk.
    // commit --files .planning/STATE.md should skip it (no deletion committed).
    runGsdTools(
      ['commit', 'test commit', '--files', '.planning/STATE.md'],
      tmpDir
    );

    // Check git log: the new commit (HEAD) must NOT have deleted STATE.md.
    // git diff HEAD~1 HEAD --name-status shows what changed between commits.
    let diffOutput = '';
    try {
      diffOutput = gitOrThrow(['diff', 'HEAD~1', 'HEAD', '--name-status'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS });
    } catch (e) {
      // If nothing to commit, there is no HEAD~1 -- that's also acceptable
      return;
    }
    assert.ok(
      !diffOutput.includes('D\t.planning/STATE.md'),
      'commit --files must not commit a deletion of a missing file, diff was:\n' + diffOutput
    );
  });

  test('passing --files for a file that exists stages and commits it normally', () => {
    // Create ROADMAP.md -- this file exists, should be staged normally
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), '# Roadmap\n\nPhase 01.\n');

    const result = runGsdTools(
      ['commit', 'add roadmap', '--files', '.planning/ROADMAP.md'],
      tmpDir
    );

    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.committed, true, 'should have committed when file exists');

    // Verify ROADMAP.md was added in the commit
    const diffOutput = gitOrThrow(['diff', 'HEAD~1', 'HEAD', '--name-status'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS });
    assert.ok(
      diffOutput.includes('A\t.planning/ROADMAP.md'),
      'ROADMAP.md should appear as added in the commit'
    );
  });

  test('--files with mix of existing and missing files only stages the existing ones', () => {
    // ROADMAP.md exists on disk, STATE.md does not
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), '# Roadmap\n');

    runGsdTools(
      ['commit', 'partial files', '--files', '.planning/ROADMAP.md', '.planning/STATE.md'],
      tmpDir
    );

    // The commit must not include a deletion of STATE.md
    let diffOutput = '';
    try {
      diffOutput = gitOrThrow(['diff', 'HEAD~1', 'HEAD', '--name-status'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS });
    } catch (e) {
      return; // nothing committed is fine
    }
    assert.ok(
      !diffOutput.includes('D\t.planning/STATE.md'),
      'missing file in --files list must not be committed as a deletion'
    );
  });
});

/**
 * Regression tests for #4208: `commit --files` could not record a file move.
 *
 * The #2014 guard above skips a missing `--files` entry, so the only form that
 * recorded a move was a DIRECTORY entry — which also committed any unrelated
 * file sitting in that directory (a concurrent session's in-flight todo, in
 * the execute-phase sweep). `--files-removed` is the caller-declared deletion
 * intent that lets a move be recorded at file granularity, with the #2014
 * skip-if-missing contract on `--files` left untouched.
 */
describe('commit --files-removed: caller-declared deletions record a move (#4208)', () => {
  let tmpDir;
  const PENDING = path.join('.planning', 'todos', 'pending');
  const COMPLETED = path.join('.planning', 'todos', 'completed');

  function nameStatus() {
    // `--no-renames`: a clean move would otherwise collapse to one `R100` row
    // and hide whether the old path's deletion was actually recorded.
    return gitOrThrow(['diff', '--no-renames', 'HEAD~1', 'HEAD', '--name-status'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS })
      .trim().split('\n').filter(Boolean).sort();
  }

  function status() {
    // `-uall`: once the move empties pending/ of tracked files, plain
    // `--porcelain` collapses its untracked contents to the bare directory.
    return gitOrThrow(['status', '--porcelain', '-uall'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS }).trim();
  }

  beforeEach(() => {
    tmpDir = createTempGitProject();
    fs.mkdirSync(path.join(tmpDir, PENDING), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, COMPLETED), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, PENDING, 'mine.md'), '---\nresolves_phase: 5\n---\nmine\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), '# State\n');
    gitOrThrow(['add', '.planning/'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS });
    gitOrThrow(['commit', '-m', 'seed todo'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS });
    // The move this phase performs, plus a peer's unrelated in-flight todo.
    fs.renameSync(path.join(tmpDir, PENDING, 'mine.md'), path.join(tmpDir, COMPLETED, 'mine.md'));
    fs.writeFileSync(path.join(tmpDir, PENDING, 'peer-inflight.md'), '---\nresolves_phase: 99\n---\npeer\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), '# State\n\nphase 5 closed\n');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('records the move at file granularity and leaves the peer file alone', () => {
    const result = runGsdTools(
      ['commit', 'docs(phase-5): close 1 resolved todo(s)',
        '--files', '.planning/todos/completed/mine.md', '.planning/STATE.md',
        '--files-removed', '.planning/todos/pending/mine.md'],
      tmpDir,
    );
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.committed, true, 'move commit must succeed: ' + result.output);

    assert.deepStrictEqual(
      nameStatus(),
      ['A\t.planning/todos/completed/mine.md', 'D\t.planning/todos/pending/mine.md', 'M\t.planning/STATE.md'],
      'commit must contain exactly the move and STATE.md',
    );
    // The peer's file is untouched: still untracked, never committed — and
    // nothing about the moved todo is left dangling.
    const st = status();
    assert.ok(st.includes('?? .planning/todos/pending/peer-inflight.md'), 'peer file must stay untracked: ' + st);
    assert.ok(!st.includes('mine.md'), 'no dangling state for the moved todo: ' + st);
    // No dual-tracking: the todo is tracked at the new path only.
    const tracked = gitOrThrow(['ls-files', '--', '.planning/todos'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS }).trim();
    assert.strictEqual(tracked, '.planning/todos/completed/mine.md');
  });

  test('a directory entry stages only the tracked files that are absent from disk', () => {
    // A second tracked todo that stays put must NOT be touched by the
    // directory form, and the untracked peer file must stay invisible to it.
    fs.writeFileSync(path.join(tmpDir, PENDING, 'stays.md'), 'stays\n');
    gitOrThrow(['add', path.join(PENDING, 'stays.md')], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS });
    gitOrThrow(['commit', '-m', 'seed a todo that stays'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS });
    fs.appendFileSync(path.join(tmpDir, PENDING, 'stays.md'), 'edited by a peer, uncommitted\n');

    const result = runGsdTools(
      ['commit', 'docs(phase-5): close 1 resolved todo(s)',
        '--files', '.planning/todos/completed/mine.md',
        '--files-removed', '.planning/todos/pending/'],
      tmpDir,
    );
    assert.strictEqual(JSON.parse(result.output).committed, true, result.output);
    assert.deepStrictEqual(
      nameStatus(),
      ['A\t.planning/todos/completed/mine.md', 'D\t.planning/todos/pending/mine.md'],
    );
    const st = status();
    assert.ok(st.includes(' M .planning/todos/pending/stays.md'), 'present tracked file must stay uncommitted: ' + st);
    assert.ok(st.includes('?? .planning/todos/pending/peer-inflight.md'), 'untracked peer file must stay untracked: ' + st);
  });

  test('a --files-removed file entry that is still on disk fails closed and rolls back', () => {
    // The declaration is wrong: pending/mine.md was put back.
    fs.copyFileSync(path.join(tmpDir, COMPLETED, 'mine.md'), path.join(tmpDir, PENDING, 'mine.md'));
    const head = gitOrThrow(['rev-parse', 'HEAD'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS }).trim();

    const result = runGsdTools(
      ['commit', 'docs(phase-5): bad declaration',
        '--files', '.planning/todos/completed/mine.md',
        '--files-removed', '.planning/todos/pending/mine.md'],
      tmpDir,
    );
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.committed, false);
    assert.strictEqual(parsed.reason, 'staging_failed');
    assert.strictEqual(parsed.file, '.planning/todos/pending/mine.md');
    assert.strictEqual(
      gitOrThrow(['rev-parse', 'HEAD'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS }).trim(),
      head,
      'nothing may be committed on a refused declaration',
    );
    // Rollback: the addition this call staged is unstaged again.
    assert.strictEqual(
      gitOrThrow(['diff', '--cached', '--name-only'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS }).trim(),
      '',
    );
  });

  test('a --files-removed path git never tracked is a no-op, not an error', () => {
    const result = runGsdTools(
      ['commit', 'docs(phase-5): close 1 resolved todo(s)',
        '--files', '.planning/todos/completed/mine.md',
        '--files-removed', '.planning/todos/pending/mine.md', '.planning/todos/pending/never-tracked.md'],
      tmpDir,
    );
    assert.strictEqual(JSON.parse(result.output).committed, true, result.output);
    assert.deepStrictEqual(
      nameStatus(),
      ['A\t.planning/todos/completed/mine.md', 'D\t.planning/todos/pending/mine.md'],
    );
  });

  test('--files-removed alone is a declared scope, not the unscoped .planning/ sweep', () => {
    const result = runGsdTools(
      ['commit', 'docs: drop a todo', '--files-removed', '.planning/todos/pending/mine.md'],
      tmpDir,
    );
    assert.strictEqual(JSON.parse(result.output).committed, true, result.output);
    // Only the deletion — not completed/mine.md, STATE.md, or the peer file.
    assert.deepStrictEqual(nameStatus(), ['D\t.planning/todos/pending/mine.md']);
  });

  test('--files keeps its #2014 skip-if-missing contract when --files-removed is also given', () => {
    // A tracked file that is temporarily absent (NOT moved) named via --files
    // must still be skipped, even though the same call declares a removal.
    fs.unlinkSync(path.join(tmpDir, '.planning', 'STATE.md'));
    const result = runGsdTools(
      ['commit', 'docs(phase-5): close 1 resolved todo(s)',
        '--files', '.planning/todos/completed/mine.md', '.planning/STATE.md',
        '--files-removed', '.planning/todos/pending/mine.md'],
      tmpDir,
    );
    assert.strictEqual(JSON.parse(result.output).committed, true, result.output);
    assert.deepStrictEqual(
      nameStatus(),
      ['A\t.planning/todos/completed/mine.md', 'D\t.planning/todos/pending/mine.md'],
      'the temporarily-absent STATE.md must not be committed as a deletion',
    );
  });

  test('a tracked symlink whose target is gone is present, not a removal', () => {
    // `stat`/`existsSync` follow the link and read it as absent; `lstat` does
    // not. Declaring it removed while it still sits in the worktree must fail
    // closed like any other present entry, with nothing left staged.
    const link = path.join(PENDING, 'dangling');
    fs.symlinkSync('target-that-will-vanish.md', path.join(tmpDir, link));
    gitOrThrow(['add', link], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS });
    gitOrThrow(['commit', '-m', 'seed a symlink'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS });
    const head = gitOrThrow(['rev-parse', 'HEAD'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS }).trim();

    const result = runGsdTools(
      ['commit', 'docs: bad declaration',
        '--files', '.planning/todos/completed/mine.md',
        '--files-removed', '.planning/todos/pending/dangling'],
      tmpDir,
    );
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.committed, false, result.output);
    assert.strictEqual(parsed.reason, 'staging_failed');
    assert.strictEqual(parsed.file, '.planning/todos/pending/dangling');
    assert.strictEqual(gitOrThrow(['rev-parse', 'HEAD'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS }).trim(), head);
    assert.strictEqual(gitOrThrow(['diff', '--cached', '--name-only'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS }).trim(), '');
  });

  test('a deletion the caller already staged is committed, not reported as nothing to commit', () => {
    // `git rm` before the call empties the index entry; `ls-files` alone would
    // never list it, so the path would miss the pathspec.
    gitOrThrow(['rm', '-q', '--cached', path.join(PENDING, 'mine.md')], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS });
    const result = runGsdTools(
      ['commit', 'docs: drop a todo', '--files-removed', '.planning/todos/pending/mine.md'],
      tmpDir,
    );
    assert.strictEqual(JSON.parse(result.output).committed, true, result.output);
    assert.deepStrictEqual(nameStatus(), ['D\t.planning/todos/pending/mine.md']);
  });

  test('a deletion staged by this call is rolled back when a later entry fails', () => {
    // Ordering: the good removal is processed first, then the contradicted one.
    fs.copyFileSync(path.join(tmpDir, COMPLETED, 'mine.md'), path.join(tmpDir, PENDING, 'stays-put.md'));
    gitOrThrow(['add', path.join(PENDING, 'stays-put.md')], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS });
    gitOrThrow(['commit', '-m', 'seed a second todo'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS });
    const head = gitOrThrow(['rev-parse', 'HEAD'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS }).trim();

    const result = runGsdTools(
      ['commit', 'docs: bad declaration',
        '--files-removed', '.planning/todos/pending/mine.md', '.planning/todos/pending/stays-put.md'],
      tmpDir,
    );
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.reason, 'staging_failed', result.output);
    assert.strictEqual(parsed.file, '.planning/todos/pending/stays-put.md');
    assert.strictEqual(gitOrThrow(['rev-parse', 'HEAD'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS }).trim(), head);
    // The staged deletion of mine.md was restored to the index by the rollback.
    assert.strictEqual(gitOrThrow(['diff', '--cached', '--name-only'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS }).trim(), '');
    assert.ok(
      gitOrThrow(['ls-files', '--', PENDING], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS }).includes('mine.md'),
      'mine.md must be back in the index after rollback',
    );
  });

  test('a caller-pre-staged deletion with a non-ASCII name survives the rollback', () => {
    // `diff --cached --name-only` without -z quotes `café.md` as
    // `"caf\303\251.md"`, which never matched the raw path, so the rollback
    // treated the caller's own staged deletion as this call's and undid it.
    const cafe = path.join(PENDING, 'café.md');
    fs.writeFileSync(path.join(tmpDir, cafe), 'accent\n');
    gitOrThrow(['add', cafe], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS });
    gitOrThrow(['commit', '-m', 'seed café'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS });
    gitOrThrow(['rm', '-q', cafe], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS });   // caller-staged deletion
    fs.copyFileSync(path.join(tmpDir, COMPLETED, 'mine.md'), path.join(tmpDir, PENDING, 'mine.md'));   // contradiction

    const result = runGsdTools(
      ['commit', 'docs: bad declaration',
        '--files-removed', '.planning/todos/pending/café.md', '.planning/todos/pending/mine.md'],
      tmpDir,
    );
    assert.strictEqual(JSON.parse(result.output).reason, 'staging_failed', result.output);
    const cached = gitOrThrow(['diff', '--cached', '--name-only', '-z'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS }).split('\0').filter(Boolean);
    assert.deepStrictEqual(cached, ['.planning/todos/pending/café.md'], 'the caller\'s own staged deletion must survive');
  });

  test('on an unborn HEAD an absent index-only path is unstaged, never a pathspec entry', (t) => {
    // A root commit has no parent to delete from; naming the path would make
    // `git commit` refuse with "pathspec did not match".
    const fresh = createTempGitProject();
    t.after(() => cleanup(fresh));
    // The fixture may seed commits; make an unborn branch explicitly.
    gitOrThrow(['checkout', '-q', '--orphan', 'unborn'], { cwd: fresh, timeoutMs: GIT_TIMEOUT_MS });
    gitOrThrow(['rm', '-rfq', '--cached', '.'], { cwd: fresh, timeoutMs: GIT_TIMEOUT_MS });
    fs.mkdirSync(path.join(fresh, PENDING), { recursive: true });
    fs.writeFileSync(path.join(fresh, PENDING, 'a.md'), 'a\n');
    fs.writeFileSync(path.join(fresh, PENDING, 'gone.md'), 'gone\n');
    gitOrThrow(['add', PENDING], { cwd: fresh, timeoutMs: GIT_TIMEOUT_MS });
    fs.unlinkSync(path.join(fresh, PENDING, 'gone.md'));

    const result = runGsdTools(
      ['commit', 'docs: root commit',
        '--files', '.planning/todos/pending/a.md',
        '--files-removed', '.planning/todos/pending/gone.md'],
      fresh,
    );
    assert.strictEqual(JSON.parse(result.output).committed, true, result.output);
    const tree = gitOrThrow(['ls-tree', '-r', '--name-only', 'HEAD'], { cwd: fresh, timeoutMs: GIT_TIMEOUT_MS }).trim().split('\n');
    assert.ok(tree.includes('.planning/todos/pending/a.md'), tree.join(','));
    assert.ok(!tree.includes('.planning/todos/pending/gone.md'), tree.join(','));
    assert.strictEqual(gitOrThrow(['diff', '--cached', '--name-only'], { cwd: fresh, timeoutMs: GIT_TIMEOUT_MS }).trim(), '');
  });

  test('a boolean flag inside a list does not end it: the positional after it stays in that list', () => {
    // `--files a --no-verify b --files-removed c`: before #4208 the single
    // slice-to-end list swept `b` into --files; a list that stops at ANY
    // `--` token silently drops it instead (review of #4253). A list runs to
    // the next LIST flag and skips boolean flags on the way.
    const result = runGsdTools(
      ['commit', 'docs(phase-5): close 1 resolved todo(s)',
        '--files', '.planning/todos/completed/mine.md', '--no-verify', '.planning/STATE.md',
        '--files-removed', '.planning/todos/pending/mine.md'],
      tmpDir,
    );
    assert.strictEqual(JSON.parse(result.output).committed, true, result.output);
    assert.deepStrictEqual(
      nameStatus(),
      ['A\t.planning/todos/completed/mine.md', 'D\t.planning/todos/pending/mine.md', 'M\t.planning/STATE.md'],
      'STATE.md, wedged between --no-verify and --files-removed, must still be in the --files list',
    );
  });

  test('a repeated list flag merges its runs, as the old parser did', () => {
    // `--files a --files b`: the pre-#4208 slice-to-end parse yielded [a, b];
    // a parser that stops at the next list flag — including a repeat of the
    // same one — silently dropped b (found by the round's comment audit).
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), '# Roadmap\n');
    const result = runGsdTools(
      ['commit', 'docs(phase-5): close 1 resolved todo(s)',
        '--files', '.planning/todos/completed/mine.md', '--files', '.planning/ROADMAP.md',
        '--files-removed', '.planning/todos/pending/mine.md'],
      tmpDir,
    );
    assert.strictEqual(JSON.parse(result.output).committed, true, result.output);
    assert.deepStrictEqual(
      nameStatus(),
      ['A\t.planning/ROADMAP.md', 'A\t.planning/todos/completed/mine.md', 'D\t.planning/todos/pending/mine.md'],
      'both --files runs must reach the commit',
    );
  });

  test('--files-removed before --files parses both lists and the message', () => {
    const result = runGsdTools(
      ['commit', 'docs(phase-5): close 1 resolved todo(s)',
        '--files-removed', '.planning/todos/pending/mine.md',
        '--files', '.planning/todos/completed/mine.md'],
      tmpDir,
    );
    assert.strictEqual(JSON.parse(result.output).committed, true, result.output);
    assert.deepStrictEqual(
      nameStatus(),
      ['A\t.planning/todos/completed/mine.md', 'D\t.planning/todos/pending/mine.md'],
    );
    const subject = gitOrThrow(['log', '-1', '--format=%s'], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS }).trim();
    assert.strictEqual(subject, 'docs(phase-5): close 1 resolved todo(s)');
  });
});

/**
 * #4253 review: absence from the worktree is not removal. Some index entries
 * are absent BY DESIGN — a submodule gitlink whose directory was deleted by
 * hand, a skip-worktree path a sparse checkout never materialised, an
 * assume-unchanged path — and `lstat` cannot tell them from a moved-away file.
 * Under a directory entry they are left alone, exactly like a present file;
 * named directly they contradict the declaration and fail closed. And a
 * staging failure restores every index entry this call removed EXACTLY,
 * including on an unborn HEAD, where `git reset` has nothing to restore from.
 */
describe('commit --files-removed: index states absent by design are never removals (#4208 review)', () => {
  let tmpDir;
  let stray;
  const PENDING = path.join('.planning', 'todos', 'pending');
  const COMPLETED = path.join('.planning', 'todos', 'completed');

  function git(args, cwd = tmpDir) {
    return gitOrThrow(args, { cwd, timeoutMs: GIT_TIMEOUT_MS }).trim();
  }
  function nameStatus() {
    return git(['diff', '--no-renames', 'HEAD~1', 'HEAD', '--name-status']).split('\n').filter(Boolean).sort();
  }
  // Untrimmed: porcelain's leading column is significant (` D` = unstaged deletion).
  function porcelain(...pathspec) {
    return gitOrThrow(['status', '--porcelain', '--', ...pathspec], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS });
  }
  // Seed the standard move: pending/mine.md -> completed/mine.md, committed at pending/.
  function seedMove() {
    fs.mkdirSync(path.join(tmpDir, PENDING), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, COMPLETED), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, PENDING, 'mine.md'), 'mine\n');
    git(['add', '.planning/']);
    git(['commit', '-q', '-m', 'seed todo']);
    fs.renameSync(path.join(tmpDir, PENDING, 'mine.md'), path.join(tmpDir, COMPLETED, 'mine.md'));
  }
  // A submodule at pending/sub whose directory is then deleted by hand — the
  // one gitlink shape that reads as absent (an uninitialised submodule leaves
  // an empty directory behind, which lstat sees as present).
  function addSubmoduleThenDeleteDir() {
    const subSrc = path.join(tmpDir, '..', path.basename(tmpDir) + '-sub');
    stray = subSrc;
    fs.mkdirSync(subSrc, { recursive: true });
    git(['init', '-q', '.'], subSrc);
    git(['config', 'user.email', 't@t'], subSrc);
    git(['config', 'user.name', 't'], subSrc);
    fs.writeFileSync(path.join(subSrc, 'f.txt'), 'v1\n');
    git(['add', 'f.txt'], subSrc);
    git(['commit', '-q', '-m', 'v1'], subSrc);
    git(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subSrc, '.planning/todos/pending/sub']);
    git(['commit', '-q', '-m', 'add submodule']);
    cleanup(path.join(tmpDir, PENDING, 'sub'));
    assert.match(porcelain(PENDING), /^ D \.planning\/todos\/pending\/sub$/m, 'git itself reads the gitlink as deleted');
  }

  beforeEach(() => { tmpDir = createTempGitProject(); stray = null; });
  afterEach(() => { cleanup(tmpDir); if (stray) cleanup(stray); });

  // Deterministic, privilege-independent restore-failure injection.
  // `chmod a-w` on the git dir (as this file's other restore-failure tests
  // used to) relies on the OS enforcing the *owner's own* permission bits
  // against itself -- which root, a routine identity inside a Docker-based
  // CI bench, does not: every DAC check short-circuits true for uid 0, so the
  // write the chmod meant to block SUCCEEDS, the restore silently comes back
  // clean, and the disclosure this test exists to pin never fires. That is
  // this repo's own named anti-pattern for I/O-failure injection (see
  // CLAUDE.md "Cross-platform test IO-failure injection") -- and it was the
  // actual root cause here: the two tests below failed under a real remote
  // `gsd-test` run against unmodified `next` (root inside the bench
  // container) while passing on an unprivileged workstation, and every OTHER
  // fault-injection test in this file that does NOT depend on a permission
  // check (the timeout hook two tests down that just sleeps; the mode-flip
  // hook after it that runs a real `update-index`) passed in that same run.
  // The fix here targets the CALL, not a permission bit: a fake `git` ahead
  // of the real one on PATH turns `update-index --add --cacheinfo` — the one
  // and only call the restore path makes — into a hard failure unconditionally,
  // in any process regardless of uid. Every other invocation execs straight
  // through to the real binary, so the rest of the commit (the `rm --cached`,
  // the verification `ls-files`, etc.) behaves exactly as it does today.
  function findRealGit() {
    return execFileSync('command', ['-v', 'git'], { shell: '/bin/sh', timeout: GIT_TIMEOUT_MS }).toString().trim();
  }
  function installCacheinfoRestoreFailureShim() {
    const realGit = findRealGit();
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-fake-git-'));
    fs.writeFileSync(path.join(shimDir, 'git'), [
      '#!/bin/sh',
      'has_cacheinfo=0',
      'for arg in "$@"; do',
      '  if [ "$arg" = "--cacheinfo" ]; then has_cacheinfo=1; fi',
      'done',
      'if [ "$1" = "update-index" ] && [ "$has_cacheinfo" = "1" ]; then',
      '  echo "fake-git: forced update-index --cacheinfo failure for test" >&2',
      '  exit 1',
      'fi',
      `exec "${realGit}" "$@"`,
      '',
    ].join('\n'), { mode: 0o755 });
    return { shimDir, path: `${shimDir}${path.delimiter}${process.env.PATH}` };
  }

  test('a directory entry leaves a hand-deleted submodule gitlink in the index and records only the file move', () => {
    seedMove();
    addSubmoduleThenDeleteDir();
    const result = runGsdTools(
      ['commit', 'docs: close a todo', '--files', '.planning/todos/completed/mine.md', '--files-removed', '.planning/todos/pending/'],
      tmpDir,
    );
    assert.strictEqual(JSON.parse(result.output).committed, true, result.output);
    assert.deepStrictEqual(nameStatus(), ['A\t.planning/todos/completed/mine.md', 'D\t.planning/todos/pending/mine.md']);
    // The gitlink is still tracked, at mode 160000, and git still reports the
    // hand-deletion as the caller's unstaged business — not this call's.
    assert.match(git(['ls-files', '-s', '--', PENDING]), /^160000 [0-9a-f]+ 0\t\.planning\/todos\/pending\/sub$/m);
    assert.match(porcelain(PENDING), /^ D \.planning\/todos\/pending\/sub$/m);
  });

  test('a submodule gitlink named directly under --files-removed fails closed, naming the state', () => {
    seedMove();
    addSubmoduleThenDeleteDir();
    const head = git(['rev-parse', 'HEAD']);
    const result = runGsdTools(
      ['commit', 'docs: bad declaration', '--files', '.planning/todos/completed/mine.md', '--files-removed', '.planning/todos/pending/sub'],
      tmpDir,
    );
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.committed, false, result.output);
    assert.strictEqual(parsed.reason, 'staging_failed');
    assert.strictEqual(parsed.file, '.planning/todos/pending/sub');
    assert.match(parsed.error, /submodule gitlink/);
    assert.strictEqual(git(['rev-parse', 'HEAD']), head);
    assert.strictEqual(git(['diff', '--cached', '--name-only']), '', 'the addition this call staged is rolled back');
    assert.match(git(['ls-files', '-s', '--', PENDING]), /^160000 /m, 'the gitlink is untouched');
  });

  test('a skip-worktree path is absent by checkout, not removed: skipped under a directory entry, refused when named', () => {
    seedMove();
    // A second tracked todo that a sparse checkout would not materialise.
    fs.writeFileSync(path.join(tmpDir, PENDING, 'sparse.md'), 'sparse\n');
    git(['add', path.join(PENDING, 'sparse.md')]);
    git(['commit', '-q', '-m', 'seed sparse']);
    git(['update-index', '--skip-worktree', '--', '.planning/todos/pending/sparse.md']);
    fs.unlinkSync(path.join(tmpDir, PENDING, 'sparse.md'));
    assert.strictEqual(porcelain(path.join(PENDING, 'sparse.md')), '', 'git itself does not report a skip-worktree path as deleted');

    const dirForm = runGsdTools(
      ['commit', 'docs: close a todo', '--files', '.planning/todos/completed/mine.md', '--files-removed', '.planning/todos/pending/'],
      tmpDir,
    );
    assert.strictEqual(JSON.parse(dirForm.output).committed, true, dirForm.output);
    assert.deepStrictEqual(nameStatus(), ['A\t.planning/todos/completed/mine.md', 'D\t.planning/todos/pending/mine.md']);
    assert.match(git(['ls-files', '-v', '--', PENDING]), /^S \.planning\/todos\/pending\/sparse\.md$/m, 'the sparse entry stays in the index, still skip-worktree');

    const head = git(['rev-parse', 'HEAD']);
    const named = runGsdTools(['commit', 'docs: bad declaration', '--files-removed', '.planning/todos/pending/sparse.md'], tmpDir);
    const parsed = JSON.parse(named.output);
    assert.strictEqual(parsed.reason, 'staging_failed', named.output);
    assert.strictEqual(parsed.file, '.planning/todos/pending/sparse.md');
    assert.match(parsed.error, /skip-worktree/);
    assert.strictEqual(git(['rev-parse', 'HEAD']), head);
    assert.match(git(['ls-files', '-v', '--', PENDING]), /^S \.planning\/todos\/pending\/sparse\.md$/m);
  });

  test('a directly named path is recognised by any spelling that resolves to it (absolute path)', () => {
    // The direct-vs-directory decision is made on resolved paths. A string
    // compare against git's cwd-relative output silently took the directory
    // polarity for an absolute path, so a named gitlink SKIPPED instead of
    // refusing (found by review, driven).
    seedMove();
    addSubmoduleThenDeleteDir();
    const head = git(['rev-parse', 'HEAD']);
    const result = runGsdTools(
      ['commit', 'docs: bad declaration', '--files', '.planning/todos/completed/mine.md', '--files-removed', path.join(tmpDir, PENDING, 'sub')],
      tmpDir,
    );
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.reason, 'staging_failed', result.output);
    assert.match(parsed.error, /submodule gitlink/);
    assert.strictEqual(git(['rev-parse', 'HEAD']), head);
    assert.match(git(['ls-files', '-s', '--', PENDING]), /^160000 /m, 'the gitlink is untouched');

    // And through a SYMLINKED spelling of the same directory — the macOS
    // `/var` → `/private/var` shape, where `process.cwd()` is the real path
    // and the caller's absolute path is not (CI, first push of this round).
    const alias = tmpDir + '-alias';
    fs.symlinkSync(tmpDir, alias, 'dir');
    try {
      const viaLink = runGsdTools(
        ['commit', 'docs: bad declaration', '--files', '.planning/todos/completed/mine.md', '--files-removed', path.join(alias, PENDING, 'sub')],
        tmpDir,
      );
      const p2 = JSON.parse(viaLink.output);
      assert.strictEqual(p2.reason, 'staging_failed', viaLink.output);
      assert.match(p2.error, /submodule gitlink/);
      assert.strictEqual(git(['rev-parse', 'HEAD']), head);
    } finally {
      fs.unlinkSync(alias);
    }
  });

  test('an intent-to-add entry is not tracked content: skipped under a directory entry, refused when named', () => {
    // `git add -N` renders as a plain `H 100644 <empty blob>` entry, yet there
    // is nothing committed to remove and a cacheinfo rollback cannot restore
    // the flag (found by review, driven).
    seedMove();
    fs.writeFileSync(path.join(tmpDir, PENDING, 'planned.md'), 'planned\n');
    git(['add', '-N', path.join(PENDING, 'planned.md')]);
    fs.unlinkSync(path.join(tmpDir, PENDING, 'planned.md'));
    const before = git(['ls-files', '-s', '--', path.join(PENDING, 'planned.md')]);
    assert.match(before, /^100644 e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 0/, 'fixture: intent-to-add entry present');

    const dirForm = runGsdTools(
      ['commit', 'docs: close a todo', '--files', '.planning/todos/completed/mine.md', '--files-removed', '.planning/todos/pending/'],
      tmpDir,
    );
    assert.strictEqual(JSON.parse(dirForm.output).committed, true, dirForm.output);
    assert.deepStrictEqual(nameStatus(), ['A\t.planning/todos/completed/mine.md', 'D\t.planning/todos/pending/mine.md']);
    assert.strictEqual(git(['ls-files', '-s', '--', path.join(PENDING, 'planned.md')]), before, 'the intent-to-add entry is left alone');

    const named = runGsdTools(['commit', 'docs: bad declaration', '--files-removed', '.planning/todos/pending/planned.md'], tmpDir);
    const parsed = JSON.parse(named.output);
    assert.strictEqual(parsed.reason, 'staging_failed', named.output);
    assert.match(parsed.error, /intent-to-add/);
    assert.strictEqual(git(['ls-files', '-s', '--', path.join(PENDING, 'planned.md')]), before);
  });

  test('an assume-unchanged path named directly fails closed and stays in the index', () => {
    seedMove();
    git(['update-index', '--assume-unchanged', '--', '.planning/todos/pending/mine.md']);
    const result = runGsdTools(['commit', 'docs: drop a todo', '--files-removed', '.planning/todos/pending/mine.md'], tmpDir);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.reason, 'staging_failed', result.output);
    assert.match(parsed.error, /assume-unchanged/);
    assert.match(git(['ls-files', '-v', '--', PENDING]), /^h \.planning\/todos\/pending\/mine\.md$/m);
  });

  test('on an unborn HEAD a removal staged by this call is restored when a later entry fails', (t) => {
    // The rollback cannot `git reset` to a HEAD that does not exist; the
    // entry is put back from the record this call kept of it.
    const fresh = createTempGitProject();
    t.after(() => cleanup(fresh));
    git(['checkout', '-q', '--orphan', 'unborn'], fresh);
    git(['rm', '-rfq', '--cached', '.'], fresh);
    fs.mkdirSync(path.join(fresh, PENDING), { recursive: true });
    fs.writeFileSync(path.join(fresh, PENDING, 'gone.md'), 'gone\n');
    fs.writeFileSync(path.join(fresh, PENDING, 'stays.md'), 'stays\n');
    git(['add', PENDING], fresh);
    const before = git(['ls-files', '-s', '--', PENDING], fresh);
    fs.unlinkSync(path.join(fresh, PENDING, 'gone.md'));

    const result = runGsdTools(
      ['commit', 'docs: root commit', '--files-removed', '.planning/todos/pending/gone.md', '.planning/todos/pending/stays.md'],
      fresh,
    );
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.reason, 'staging_failed', result.output);
    assert.strictEqual(parsed.file, '.planning/todos/pending/stays.md');
    assert.throws(() => git(['rev-parse', '-q', '--verify', 'HEAD'], fresh), 'nothing may be committed');
    assert.strictEqual(git(['ls-files', '-s', '--', PENDING], fresh), before, 'gone.md is back in the index, same mode and blob');
  });

  test('on an unborn HEAD a removal-only call that stages nothing else leaves no removal behind', (t) => {
    // The rollback above fires only on a staging FAILURE. On an unborn HEAD a
    // removal never joins `stagedPaths` (there is no parent to delete from), so
    // a removal-only call that SUCCEEDS reaches the nothing-to-commit guard with
    // an empty pathspec -- and `nothing_to_commit` tells the caller no state
    // changed while `rm --cached` has already mutated the index. The removal
    // would then ride along on the caller's next commit.
    const fresh = createTempGitProject();
    t.after(() => cleanup(fresh));
    git(['checkout', '-q', '--orphan', 'unborn'], fresh);
    git(['rm', '-rfq', '--cached', '.'], fresh);
    fs.mkdirSync(path.join(fresh, PENDING), { recursive: true });
    fs.writeFileSync(path.join(fresh, PENDING, 'gone.md'), 'gone\n');
    git(['add', PENDING], fresh);
    const before = git(['ls-files', '-s', '--', PENDING], fresh);
    fs.unlinkSync(path.join(fresh, PENDING, 'gone.md'));

    const result = runGsdTools(
      ['commit', 'docs: root commit', '--files-removed', '.planning/todos/pending/gone.md'],
      fresh,
    );
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.committed, false, result.output);
    assert.throws(() => git(['rev-parse', '-q', '--verify', 'HEAD'], fresh), 'nothing may be committed');
    assert.strictEqual(
      git(['ls-files', '-s', '--', PENDING], fresh), before,
      'a call reporting no commit must leave the index as it found it',
    );
  });

  test('a removal of an index-only path leaves no removal behind when nothing is recorded', () => {
    // The same defect with a real HEAD, so the fix cannot key on `headExists`.
    // gone.md was `git add`ed and never committed, then deleted from disk: the
    // removal DOES join the pathspec here, but `diff HEAD -- gone.md` reads
    // clean because the path is absent from the worktree and from HEAD alike,
    // so the guard reports nothing_to_commit over a staged removal.
    fs.mkdirSync(path.join(tmpDir, PENDING), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, PENDING, 'seed.md'), 'seed\n');
    git(['add', '.planning/']);
    git(['commit', '-q', '-m', 'seed todo']);
    fs.writeFileSync(path.join(tmpDir, PENDING, 'gone.md'), 'gone\n');
    git(['add', path.join(PENDING, 'gone.md')]);
    const before = git(['ls-files', '-s', '--', PENDING]);
    const head = git(['rev-parse', 'HEAD']);
    fs.unlinkSync(path.join(tmpDir, PENDING, 'gone.md'));

    const result = runGsdTools(
      ['commit', 'docs: remove an uncommitted path', '--files-removed', '.planning/todos/pending/gone.md'],
      tmpDir,
    );
    assert.strictEqual(JSON.parse(result.output).committed, false, result.output);
    assert.strictEqual(git(['rev-parse', 'HEAD']), head, 'nothing may be committed');
    assert.strictEqual(
      git(['ls-files', '-s', '--', PENDING]), before,
      'a call reporting no commit must leave the index as it found it',
    );
  });

  test('a removal the call cannot put back is reported, never as nothing_to_commit',
    { skip: process.platform === 'win32' ? 'the fault-injection shim is a #!/bin/sh script resolved via PATH; Windows git resolution needs a .exe/.cmd shim, a separate fixture' : false },
    (t) => {
    // The restore is best-effort, so it can FAIL -- and reporting
    // nothing_to_commit over a removal we tried and could not undo is the same
    // false "no state changed" the restore exists to prevent, one level down.
    // Driven with a fake `git` ahead of the real one on PATH that fails the
    // one call the restore makes (`update-index --add --cacheinfo`) — see
    // installCacheinfoRestoreFailureShim's header for why this replaced a
    // chmod-based hook.
    fs.mkdirSync(path.join(tmpDir, PENDING), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, PENDING, 'seed.md'), 'seed\n');
    git(['add', '.planning/']);
    git(['commit', '-q', '-m', 'seed todo']);
    fs.writeFileSync(path.join(tmpDir, PENDING, 'gone.md'), 'gone\n');
    git(['add', path.join(PENDING, 'gone.md')]);
    fs.unlinkSync(path.join(tmpDir, PENDING, 'gone.md'));
    const shim = installCacheinfoRestoreFailureShim();
    t.after(() => cleanup(shim.shimDir));

    const result = runGsdTools(
      ['commit', 'docs: remove an uncommitted path', '--files-removed', '.planning/todos/pending/gone.md'],
      tmpDir,
      { PATH: shim.path },
    );
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.committed, false, result.output);
    assert.notStrictEqual(parsed.reason, 'nothing_to_commit', 'a removal left staged must never be reported as no state change');
    assert.strictEqual(parsed.reason, 'staging_failed', result.output);
    assert.match(parsed.error, /could not be restored/);
    assert.match(parsed.error, /gone\.md/);
  });

  test('a rollback that cannot restore a removal discloses it, even when the reported failure is another entry',
    { skip: process.platform === 'win32' ? 'the fault-injection shim is a #!/bin/sh script resolved via PATH; Windows git resolution needs a .exe/.cmd shim, a separate fixture' : false },
    (t) => {
    // The rollback exit reports the failure that CAUSED it -- here a
    // contradictory declaration about a path still on disk -- so a caller
    // reading `failures` would learn nothing about the removal this call had
    // already staged and then could not put back. Both must be disclosed.
    // Driven with the same fake-`git` restore-failure shim as the test above
    // (see installCacheinfoRestoreFailureShim's header).
    seedMove();
    fs.writeFileSync(path.join(tmpDir, PENDING, 'stays.md'), 'stays\n');
    git(['add', path.join(PENDING, 'stays.md')]);
    git(['commit', '-q', '-m', 'seed a present todo']);
    const shim = installCacheinfoRestoreFailureShim();
    t.after(() => cleanup(shim.shimDir));

    // mine.md was moved away (a real removal); stays.md is still on disk, so
    // declaring it removed contradicts the declaration and fails the call.
    const result = runGsdTools(
      ['commit', 'docs: bad declaration',
        '--files-removed', '.planning/todos/pending/mine.md', '.planning/todos/pending/stays.md'],
      tmpDir,
      { PATH: shim.path },
    );
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.reason, 'staging_failed', result.output);
    assert.strictEqual(parsed.file, '.planning/todos/pending/stays.md', 'the REPORTED failure is still the contradictory declaration');
    const disclosed = parsed.failures.filter(f => /could NOT be restored/.test(f.error));
    assert.ok(
      disclosed.length > 0,
      `a removal left staged by a failed rollback must be disclosed; failures were ${JSON.stringify(parsed.failures)}`,
    );
    assert.ok(
      disclosed.some(f => f.file === '.planning/todos/pending/mine.md'),
      `the disclosure must name the un-restored path; got ${JSON.stringify(disclosed)}`,
    );
  });

  test('a removal whose own rm failed is not disclosed as still staged', () => {
    // The mirror of the disclosure above. `removedEntries` is the set this call
    // claims to have STAGED, so an entry recorded before a `rm --cached` that
    // then FAILED would be reported as "still staged in the index" when nothing
    // was staged at all. Driven with a pre-existing index.lock, which fails the
    // rm and the restore alike.
    seedMove();
    fs.writeFileSync(path.join(tmpDir, PENDING, 'stays.md'), 'stays\n');
    git(['add', path.join(PENDING, 'stays.md')]);
    git(['commit', '-q', '-m', 'seed a present todo']);
    const before = git(['ls-files', '-s', '--', PENDING]);
    fs.writeFileSync(path.join(tmpDir, '.git', 'index.lock'), '');

    const result = runGsdTools(
      ['commit', 'docs: bad declaration',
        '--files-removed', '.planning/todos/pending/mine.md', '.planning/todos/pending/stays.md'],
      tmpDir,
    );
    fs.unlinkSync(path.join(tmpDir, '.git', 'index.lock'));
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.reason, 'staging_failed', result.output);
    assert.strictEqual(
      parsed.failures.filter(f => /could NOT be restored/.test(f.error)).length, 0,
      `nothing was staged, so nothing may be disclosed as left staged; failures were ${JSON.stringify(parsed.failures)}`,
    );
    assert.strictEqual(git(['ls-files', '-s', '--', PENDING]), before, 'the index is untouched');
  });

  test('a timed-out removal does not produce a false could-not-restore disclosure', () => {
    // The exit code answers "did the command succeed", never "did the index
    // change": execGit collapses a spawn timeout to a non-zero exit, and a
    // killed git can already have written the index. This pins the RESTORE
    // side of that -- a restore whose update-index was killed after its write
    // landed must not report "could NOT be restored" over an index it did in
    // fact restore. Forcing the restore verdict back onto the exit code fails
    // this test.
    //
    // NAMED RESIDUAL: the RECORD side of the same rule -- a timed-out `rm`
    // whose write DID land must still be recorded and undone -- is NOT pinned
    // here. Whether that write survives the in-process kill is not
    // deterministic (driven: it lands under a shell `timeout`, and did not
    // under execGit's spawnSync bound), so an assertion on it would read as
    // coverage and never run. It is driven by hand instead.
    seedMove();
    const before = git(['ls-files', '-s', '--', PENDING]);
    const hooksDir = path.join(tmpDir, '.git', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'post-index-change'), '#!/bin/sh\nsleep 12\n', { mode: 0o755 });
    const emptyConfig = path.join(tmpDir, 'empty.gitconfig');
    fs.writeFileSync(emptyConfig, '');

    const result = runGsdTools(
      ['commit', 'docs: close a todo', '--files-removed', '.planning/todos/pending/mine.md'],
      tmpDir,
      { GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1' },
    );
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.committed, false, result.output);
    // Consistency only, NOT the control: whichever way the killed write went,
    // the call must leave the index coherent. See the residual note above.
    assert.strictEqual(git(['ls-files', '-s', '--', PENDING]), before, 'the index must be coherent after a timed-out removal');
    // THE CONTROL: the restore succeeded, so nothing may claim otherwise.
    assert.strictEqual(
      (parsed.failures || []).filter(f => /could NOT be restored/.test(f.error)).length, 0,
      `the index was restored, so no disclosure may fire; failures were ${JSON.stringify(parsed.failures)}`,
    );
  });

  test('a restored non-ASCII path is recognised as restored, not reported as a failure', () => {
    // The restore verification reads the index back, so it must read it with
    // `-z`: core.quotePath renders café.md as "caf\\303\\251.md", which never
    // equals the raw path, and an EXACTLY restored entry then read as not
    // restored -- the same quoting defect this PR already fixed for preStaged.
    fs.mkdirSync(path.join(tmpDir, PENDING), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, PENDING, 'seed.md'), 'seed\n');
    git(['add', '.planning/']);
    git(['commit', '-q', '-m', 'seed todo']);
    // Index-only and absent from disk: the call stages the removal, records
    // nothing, and must restore -- the path the verification runs on.
    fs.writeFileSync(path.join(tmpDir, PENDING, 'café.md'), 'cafe\n');
    git(['add', path.join(PENDING, 'café.md')]);
    const before = gitOrThrow(['ls-files', '-s', '-z', '--', PENDING], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS });
    fs.unlinkSync(path.join(tmpDir, PENDING, 'café.md'));

    const result = runGsdTools(
      ['commit', 'docs: remove an uncommitted path', '--files-removed', '.planning/todos/pending/café.md'],
      tmpDir,
    );
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.reason, 'nothing_to_commit', result.output);
    assert.strictEqual(
      gitOrThrow(['ls-files', '-s', '-z', '--', PENDING], { cwd: tmpDir, timeoutMs: GIT_TIMEOUT_MS }), before,
      'the entry is restored exactly',
    );
  });

  test('a path restored at a different mode is not accepted as restored', () => {
    // --cacheinfo restores mode, blob and stage, so a path-only membership test
    // would accept an entry that came back as something else. Driven with a
    // post-index-change hook that rewrites the restored entry's mode.
    fs.mkdirSync(path.join(tmpDir, PENDING), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, PENDING, 'seed.md'), 'seed\n');
    git(['add', '.planning/']);
    git(['commit', '-q', '-m', 'seed todo']);
    fs.writeFileSync(path.join(tmpDir, PENDING, 'gone.md'), 'gone\n');
    git(['add', path.join(PENDING, 'gone.md')]);
    // git's `:<path>` index syntax takes a FORWARD-slash path; `path.join`
    // yields backslashes on Windows and git rejects them as an ambiguous
    // argument. The hook below already uses the slash form for the same reason.
    const GONE = '.planning/todos/pending/gone.md';
    const blob = git(['rev-parse', ':' + GONE]);
    fs.unlinkSync(path.join(tmpDir, PENDING, 'gone.md'));
    const hooksDir = path.join(tmpDir, '.git', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    // Fires after the restore's index write; flips the mode so the entry that
    // comes back is not the entry that was removed.
    fs.writeFileSync(path.join(hooksDir, 'post-index-change'),
      '#!/bin/sh\n'
      + 'git ls-files -s -- .planning/todos/pending/gone.md | grep -q "^100644" '
      + '&& git update-index --add --cacheinfo 100755,' + blob + ',.planning/todos/pending/gone.md\n',
      { mode: 0o755 });
    const emptyConfig = path.join(tmpDir, 'empty.gitconfig');
    fs.writeFileSync(emptyConfig, '');

    const result = runGsdTools(
      ['commit', 'docs: remove an uncommitted path', '--files-removed', '.planning/todos/pending/gone.md'],
      tmpDir,
      { GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1' },
    );
    const parsed = JSON.parse(result.output);
    assert.notStrictEqual(
      parsed.reason, 'nothing_to_commit',
      `the entry came back at a different mode, so the restore is not clean: ${result.output}`,
    );
  });

  test('a tracked filename containing a glob removes only itself, never its neighbours',
    { skip: process.platform === 'win32' ? 'a filename containing `*` cannot exist on Windows (driven: IOException)' : false },
    () => {
    // An index path handed back to git is parsed as a PATHSPEC. A tracked file
    // literally named `*.md` therefore GLOBS: `rm --cached` on it also removed
    // the peers, only the declared entry was recorded, and the rollback then
    // restored one of three -- leaving the others staged as undisclosed
    // deletions. :(literal) is what makes the operand mean the file it names.
    fs.mkdirSync(path.join(tmpDir, PENDING), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, PENDING, '*.md'), 'wildcard\n');
    fs.writeFileSync(path.join(tmpDir, PENDING, 'peer.md'), 'peer\n');
    fs.writeFileSync(path.join(tmpDir, PENDING, 'stays.md'), 'stays\n');
    git(['add', '.planning/']);
    git(['commit', '-q', '-m', 'seed a wildcard-named todo']);
    fs.unlinkSync(path.join(tmpDir, PENDING, '*.md'));
    const before = git(['ls-files', '-s', '--', PENDING]);

    // stays.md is still present, so the call fails and rolls back. Whatever the
    // rollback restores, the peers must never have been touched at all.
    const result = runGsdTools(
      ['commit', 'docs: bad declaration',
        '--files-removed', '.planning/todos/pending/', '.planning/todos/pending/stays.md'],
      tmpDir,
    );
    assert.strictEqual(JSON.parse(result.output).reason, 'staging_failed', result.output);
    assert.strictEqual(
      git(['diff', '--cached', '--name-status']), '',
      'no unrelated deletion may be left staged by a globbing pathspec',
    );
    assert.strictEqual(git(['ls-files', '-s', '--', PENDING]), before, 'the index is exactly as it was');
  });

  test('a tracked filename containing pathspec magic is removed, and commits nothing else',
    { skip: process.platform === 'win32' ? 'a filename containing `:` cannot exist on Windows (driven: FileNotFoundException)' : false },
    () => {
    // The quieter half of the same defect: pathspec magic binds at the START of
    // the operand, so a file named `:(literal)mine` at the repo ROOT has its
    // prefix PARSED -- the rm matched nothing, exited 0, and the entry survived
    // a removal this call went on to report as done. A path under a directory
    // never starts with `:`, so the fixture must be top-level to reach it.
    const odd = ':(literal)mine';
    fs.writeFileSync(path.join(tmpDir, odd), 'mine\n');
    git(['add', '--', ':(literal)' + odd]);
    git(['commit', '-q', '-m', 'seed a magic-named file']);
    assert.strictEqual(git(['ls-files', '--', ':(literal)' + odd]), odd, 'fixture: the odd name is tracked');
    fs.unlinkSync(path.join(tmpDir, odd));

    // A peer that is MODIFIED but never declared: the commit's own pathspec is
    // where an unliteralised name sweeps it in.
    fs.writeFileSync(path.join(tmpDir, 'peer.md'), 'peer\n');
    git(['add', 'peer.md']);
    git(['commit', '-q', '-m', 'seed a peer']);
    fs.writeFileSync(path.join(tmpDir, 'peer.md'), 'peer, modified\n');

    const result = runGsdTools(
      ['commit', 'docs: close a todo', '--files-removed', odd],
      tmpDir,
    );
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.committed, true, result.output);
    assert.strictEqual(
      git(['ls-files', '--', ':(literal)' + odd]), '',
      'the entry the caller named must actually be gone from the index',
    );
    // The commit must contain the declared removal and NOTHING else -- an
    // undeclared `M peer.md` is the sweep this flag exists to remove.
    assert.strictEqual(
      git(['diff', '--no-renames', 'HEAD~1', 'HEAD', '--name-status']), 'D\t' + odd,
      'only the declared removal may be committed',
    );
  });

  test('a glob-named removal commits only itself, never an undeclared peer edit',
    { skip: process.platform === 'win32' ? 'a filename containing `*` cannot exist on Windows (driven: IOException)' : false },
    () => {
    // Literalising the STAGING is not enough: `git commit -- <paths>` takes the
    // same paths as a pathspec, so a tracked file named `*.md` swept a MODIFIED
    // peer into the commit the caller never declared -- the sweep this flag
    // exists to remove, arriving one step after staging.
    fs.mkdirSync(path.join(tmpDir, PENDING), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, PENDING, '*.md'), 'wildcard\n');
    fs.writeFileSync(path.join(tmpDir, PENDING, 'peer.md'), 'peer\n');
    git(['add', '.planning/']);
    git(['commit', '-q', '-m', 'seed a wildcard-named todo']);
    fs.unlinkSync(path.join(tmpDir, PENDING, '*.md'));
    fs.writeFileSync(path.join(tmpDir, PENDING, 'peer.md'), 'peer, modified\n');

    const result = runGsdTools(
      ['commit', 'docs: close a todo', '--files-removed', '.planning/todos/pending/'],
      tmpDir,
    );
    assert.strictEqual(JSON.parse(result.output).committed, true, result.output);
    assert.strictEqual(
      git(['diff', '--no-renames', 'HEAD~1', 'HEAD', '--name-status']),
      'D\t' + path.join(PENDING, '*.md'),
      'only the declared removal may be committed',
    );
    assert.match(porcelain(PENDING), /^ M \.planning\/todos\/pending\/peer\.md$/m, "the peer's edit stays uncommitted");
  });

  test('an intent-to-add entry with a glob name keeps its intent flag',
    { skip: process.platform === 'win32' ? 'a filename containing `*` cannot exist on Windows (driven: IOException)' : false },
    () => {
    // The intent-to-add probe is a `diff --cached` over the path, so an
    // unliteralised glob name matched a STAGED PEER instead of itself, the
    // entry was misclassified as ordinary content, removed, and then restored
    // by --cacheinfo -- which cannot restore the intent flag. It came back as a
    // real staged addition.
    fs.mkdirSync(path.join(tmpDir, PENDING), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, PENDING, 'peer.md'), 'peer\n');
    git(['add', path.join(PENDING, 'peer.md')]);   // a STAGED peer for the glob to find
    fs.writeFileSync(path.join(tmpDir, PENDING, '*.md'), 'wildcard\n');
    git(['add', '-N', '--', ':(literal)' + path.join(PENDING, '*.md')]);
    fs.unlinkSync(path.join(tmpDir, PENDING, '*.md'));
    // OBSERVE THE FLAG, not the entry. `ls-files -v` renders an intent-to-add
    // exactly like an ordinary cached entry, so comparing it cannot see the
    // flag at all -- an earlier cut of this test did that and passed with the
    // fix reverted. An intent-to-add is absent from `diff --cached`; losing the
    // flag turns it into a real staged addition, which is what to assert on.
    assert.doesNotMatch(
      git(['diff', '--cached', '--name-status']), /^A\t.*\*\.md$/m,
      'fixture: the intent-to-add entry is not a staged addition yet',
    );

    // A directory entry: the intent-to-add path must be SKIPPED, not removed.
    const result = runGsdTools(
      ['commit', 'docs: close a todo', '--files-removed', '.planning/todos/pending/'],
      tmpDir,
    );
    assert.ok(result.output, 'the tool produced output');
    assert.doesNotMatch(
      git(['diff', '--cached', '--name-status']), /^A\t.*\*\.md$/m,
      'the intent-to-add entry must keep its flag -- a --cacheinfo restore turns it into a real staged addition',
    );
    assert.match(
      git(['ls-files', '--', ':(literal)' + path.join(PENDING, '*.md')]), /\*\.md/,
      'and it must still be in the index at all',
    );
  });

  test("a nested project's rollback leaves the caller's own staged work alone", (t) => {
    // `diff --cached` prints REPO-relative paths whatever the cwd, while
    // stagedPaths holds the caller's cwd-relative names. In a project nested
    // inside its repo the two name spaces never intersect, so `preStaged`
    // matched NOTHING and the rollback unstaged everything -- including work
    // the caller had staged themselves, which is precisely what preStaged
    // exists to protect. Pre-existing: it governs the --files side too.
    const repo = createTempGitProject();
    t.after(() => cleanup(repo));
    const proj = path.join(repo, 'sub');
    const pending = path.join(proj, PENDING);
    fs.mkdirSync(pending, { recursive: true });
    fs.writeFileSync(path.join(pending, 'mine.md'), 'mine\n');
    fs.writeFileSync(path.join(pending, 'peer.md'), 'peer\n');
    fs.writeFileSync(path.join(pending, 'stays.md'), 'stays\n');
    const g = (args) => gitOrThrow(args, { cwd: repo, timeoutMs: GIT_TIMEOUT_MS }).trim();
    g(['add', 'sub']);
    g(['commit', '-q', '-m', 'seed a nested project']);
    // The caller stages their OWN work: a deletion and a modification.
    fs.unlinkSync(path.join(pending, 'mine.md'));
    g(['add', '-A', '--', 'sub/.planning/todos/pending/mine.md']);
    fs.writeFileSync(path.join(pending, 'peer.md'), 'peer, modified\n');
    g(['add', 'sub/.planning/todos/pending/peer.md']);
    const before = g(['diff', '--cached', '--name-status']);

    // stays.md is present, so the declaration is contradictory and the call
    // rolls back. The rollback must not touch what the caller staged.
    const result = runGsdTools(
      ['commit', 'docs: bad declaration',
        '--files-removed', '.planning/todos/pending/', '.planning/todos/pending/stays.md'],
      proj,
    );
    assert.strictEqual(JSON.parse(result.output).reason, 'staging_failed', result.output);
    assert.strictEqual(
      g(['diff', '--cached', '--name-status']), before,
      "the caller's own staged deletion and modification must survive the rollback",
    );
  });










  test('a file that reappears between the absence check and the rm is refused, and the rollback restores its entry', () => {
    // The window this PR's own headline scenario names: a concurrent session
    // recreates the path after this call judged it absent. Driven
    // deterministically with a post-index-change hook, which git fires the
    // moment `rm --cached` writes the index -- the hook puts the file back
    // exactly then, so the re-check after the mutation must catch it.
    seedMove();
    const hooksDir = path.join(tmpDir, '.git', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(
      path.join(hooksDir, 'post-index-change'),
      '#!/bin/sh\n'
      + 'git ls-files --error-unmatch -- .planning/todos/pending/mine.md >/dev/null 2>&1 '
      + '|| cp .planning/todos/completed/mine.md .planning/todos/pending/mine.md\n',
      { mode: 0o755 },
    );
    // Pin the hook location against a host core.hooksPath (#3901 shape).
    const emptyConfig = path.join(tmpDir, 'empty.gitconfig');
    fs.writeFileSync(emptyConfig, '');
    const head = git(['rev-parse', 'HEAD']);

    const result = runGsdTools(
      ['commit', 'docs: close a todo', '--files', '.planning/todos/completed/mine.md', '--files-removed', '.planning/todos/pending/mine.md'],
      tmpDir,
      { GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1' },
    );
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.committed, false, result.output);
    assert.strictEqual(parsed.reason, 'staging_failed');
    assert.strictEqual(parsed.file, '.planning/todos/pending/mine.md');
    assert.match(parsed.error, /reappeared on disk/);
    assert.strictEqual(git(['rev-parse', 'HEAD']), head, 'nothing may be committed under a message that declared the path removed');
    assert.strictEqual(git(['diff', '--cached', '--name-only']), '', 'the addition is unstaged and the removed entry is back');
    assert.ok(fs.existsSync(path.join(tmpDir, PENDING, 'mine.md')), 'the hook did put the file back (the window was exercised)');
    assert.match(git(['ls-files', '--', PENDING]), /mine\.md/, 'the index entry this call removed is restored');
  });

  test('the rollback restores a caller-pre-staged blob at a removed path exactly, not HEAD\'s version', () => {
    seedMove();
    fs.writeFileSync(path.join(tmpDir, PENDING, 'present.md'), 'present\n');
    git(['add', path.join(PENDING, 'present.md')]);
    git(['commit', '-q', '-m', 'seed a present todo']);
    // The caller staged an edit to mine.md at its OLD path (index only, HEAD
    // still holds the seed blob), then moved the file and declared the old
    // path removed; a `git reset` rollback would put HEAD's blob back,
    // silently discarding the staged edit.
    fs.writeFileSync(path.join(tmpDir, PENDING, 'mine.md'), 'mine, edited and staged\n');
    git(['add', path.join(PENDING, 'mine.md')]);
    const staged = git(['ls-files', '-s', '--', path.join(PENDING, 'mine.md')]);
    assert.notEqual(staged, git(['ls-tree', 'HEAD', '--', path.join(PENDING, 'mine.md')]).replace(/\t/, ' '), 'fixture: the staged blob must differ from HEAD');
    fs.unlinkSync(path.join(tmpDir, PENDING, 'mine.md'));

    const result = runGsdTools(
      ['commit', 'docs: bad declaration', '--files-removed', '.planning/todos/pending/mine.md', '.planning/todos/pending/present.md'],
      tmpDir,
    );
    assert.strictEqual(JSON.parse(result.output).reason, 'staging_failed', result.output);
    assert.strictEqual(git(['ls-files', '-s', '--', path.join(PENDING, 'mine.md')]), staged, 'the pre-staged blob survives the rollback');
  });

  test('a symlink to a directory is one tracked path, not a directory entry', () => {
    // Review of #4253 read the `lstatSync(...).isDirectory()` test as a defect
    // because it does not follow symlinks. It is deliberate, and following the
    // link would be the bug: git tracks a symlink as a single blob (mode
    // 120000) and does NOT traverse it, so the tracked paths "under" it live
    // at the REAL directory and were never named by the caller. Treating the
    // link as a directory entry would stage those -- the directory sweep
    // #4208 exists to remove -- while the entry the caller DID name still sat
    // present on disk, contradicting its own declaration.
    fs.mkdirSync(path.join(tmpDir, PENDING, 'real'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, PENDING, 'real', 'a.md'), 'a\n');
    fs.symlinkSync('real', path.join(tmpDir, PENDING, 'link'));
    git(['add', '.planning/']);
    git(['commit', '-q', '-m', 'seed a symlinked dir']);

    // The premise, driven rather than asserted: one path, and git does not
    // traverse it.
    assert.match(git(['ls-files', '-s', '--', path.join(PENDING, 'link')]), /^120000 /, 'git tracks the symlink itself');
    assert.strictEqual(git(['ls-files', '--', path.join(PENDING, 'link') + '/']), '', 'git does not traverse the symlink');

    const head = git(['rev-parse', 'HEAD']);
    const result = runGsdTools(
      ['commit', 'docs: remove a symlinked dir', '--files-removed', '.planning/todos/pending/link'],
      tmpDir,
    );
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.reason, 'staging_failed', result.output);
    assert.match(parsed.error, /still present on disk/);
    assert.strictEqual(git(['rev-parse', 'HEAD']), head, 'nothing may be committed');
    assert.match(git(['ls-files', '--', PENDING]), /real\/a\.md/, 'the path behind the link is untouched -- the caller never named it');
  });

});

// RULESET.TESTS.property-based-testing: the two-list commit parser is a real
// parser (split argv into two lists by boundary flags, skip embedded boolean
// flags, merge repeated occurrences), and its edge cases were already the
// subject of a review round. The example cases above pin the shapes that broke;
// this pins the invariant they are instances of, over interleavings nobody
// enumerated.
describe('commit --files/--files-removed: the two-list parser upholds its partition invariant (#4208 review)', () => {
  const LIST = [...COMMIT_LIST_FLAGS];
  // The alphabet a real invocation draws from: positionals, both list flags,
  // and the boolean flags that may sit inside a run without ending it.
  const token = fc.oneof(
    fc.constantFrom('a', 'b', 'c', 'd'),
    fc.constantFrom(...LIST),
    fc.constantFrom('--amend', '--no-verify', '--raw'),
  );
  const argv = fc.array(token, { minLength: 0, maxLength: 10 })
    .map(rest => ['commit', ...rest]);

  // The invariant, stated independently of the implementation: walking argv
  // left to right, a list flag opens a run that every later positional joins
  // until the next list flag; a boolean flag is transparent; a positional
  // before any list flag belongs to the message, not to a list.
  function partition(args) {
    const out = Object.fromEntries(LIST.map(f => [f, []]));
    let open = null;
    for (const t of args.slice(1)) {
      if (COMMIT_LIST_FLAGS.has(t)) { open = t; continue; }
      if (t.startsWith('--')) continue;
      if (open !== null) out[open].push(t);
    }
    return out;
  }

  test('every positional lands in exactly the run that is open at it, whatever the flag order or count', () => {
    fc.assert(fc.property(argv, (args) => {
      const expected = partition(args);
      for (const flag of LIST) {
        assert.deepStrictEqual(collectListFlagValues(args, flag), expected[flag]);
      }
      return true;
    }), { numRuns: 500 });
  });

  test('no positional after the first list flag is dropped, and none is claimed by both lists', () => {
    fc.assert(fc.property(argv, (args) => {
      const first = args.findIndex((a, i) => i > 0 && COMMIT_LIST_FLAGS.has(a));
      if (first === -1) return true;
      const afterFirst = args.slice(first + 1).filter(a => !a.startsWith('--'));
      const collected = LIST.flatMap(f => collectListFlagValues(args, f));
      // Multiset equality: every such positional is collected exactly once.
      assert.deepStrictEqual([...collected].sort(), [...afterFirst].sort());
      return true;
    }), { numRuns: 500 });
  });

  test('with --files-removed absent the parse is the pre-#4208 slice-to-end parse', () => {
    // The compatibility half: the only intended change to an invocation that
    // never names the second list is that a second list flag now exists.
    const legacy = fc.array(
      fc.oneof(fc.constantFrom('a', 'b', 'c', 'd'), fc.constantFrom('--files'), fc.constantFrom('--amend', '--no-verify')),
      { minLength: 0, maxLength: 8 },
    ).map(rest => ['commit', ...rest]);
    fc.assert(fc.property(legacy, (args) => {
      const i = args.indexOf('--files');
      const old = i === -1 ? [] : args.slice(i + 1).filter(a => !a.startsWith('--'));
      assert.deepStrictEqual(collectListFlagValues(args, '--files'), old);
      return true;
    }), { numRuns: 500 });
  });
});
