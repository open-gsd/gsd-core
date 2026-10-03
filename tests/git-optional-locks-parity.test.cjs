'use strict';

/**
 * #5048 — GIT_OPTIONAL_LOCKS=0 must reach every read-only git spawn.
 *
 * By default several read-only git commands refresh the index and take an
 * *optional* `.git/index.lock` to write the refreshed copy back. That write is
 * a contender for the lock a real `git add` / `git commit` needs, so a read can
 * fail someone else's commit with
 * `Unable to create '.git/index.lock': File exists`. `GIT_OPTIONAL_LOCKS=0`
 * disables only those optional index operations.
 *
 * ## What this file observes
 *
 * Every assertion below watches the options object a *real* seam hands to
 * `node:child_process`: the actual `execGit`, `readGitSignals` (reached through
 * `detectSignals`), `gitExec`, the statusline's `readGitStatus`, and both
 * pre-write hooks' local `git()` — the last two hooks driven as real
 * subprocesses with a preload, because they have no exported seam. The
 * observable is the env that reaches the OS, so a comment naming
 * GIT_OPTIONAL_LOCKS cannot forge a pass and a spawn routed through a variable
 * or a wrapper cannot hide one.
 *
 * Two earlier revisions of this file asserted the same fact by reading `src/`
 * and `hooks/` as text and regex-matching for the variable. Both were source
 * greps, which `RULESET.TESTS.no-source-grep` bans at error level in tests/, and
 * the second was worse than unfashionable: a *comment* naming the variable
 * satisfied the window with no env set at all, and — as the re-review found —
 * the `ROUTED_SPAWN_RE` half that existed to catch spawns "routed through a
 * variable or a wrapper" was never wired into the collection loop, so it
 * exported a claim the file never enforced. That half is gone rather than
 * fixed, and this header no longer claims a new spawn site cannot be added
 * silently: **it cannot.** A `git status` added to a module no probe reaches is
 * not covered by anything here.
 *
 * What replaces the enumeration is the last block, which is the part that
 * actually establishes that the variable is load-bearing: a real repo whose
 * index is stale by stat data alone, run twice, showing that
 * `GIT_OPTIONAL_LOCKS=0` leaves `.git/index` byte-identical and that the
 * default environment rewrites it. Everything above this line proves the code
 * sets the variable; that block proves setting it changes what git does.
 *
 * The honest scope of the guard is therefore: the six seams named below cannot
 * regress their env without a test going red, and the value they set is
 * verified to matter. Adding a *new* read-only git spawn means adding a probe
 * for it in this file — the gap the removed enumeration papered over is the gap
 * this comment now states.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const helpers = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { STAGED_HOOK_SCRIPT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { recordSpawns, gitSubcommand } = require('./helpers/git-optional-locks-probe.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');

const REPO_ROOT = path.join(__dirname, '..');

// ---------------------------------------------------------------------------
// The seams — what the real read-only git spawns hand the OS
// ---------------------------------------------------------------------------

/**
 * Invoke `fn` with child_process intercepted; return the recorded spawns.
 * Restoring happens in `finally`, but the RETURN is outside it — a `return`
 * inside `finally` discards an in-flight throw (no-unsafe-finally).
 */
function captureSpawns(fn, stdoutFor) {
  const restore = recordSpawns(undefined, stdoutFor);
  let thrown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  const calls = restore();
  if (thrown) throw thrown;
  return calls;
}

function gitSpawns(calls) {
  return calls.filter(c => /(^|[\\/])git$/.test(c.file) || c.file === 'git');
}

function assertLockedOut(spawns, label) {
  assert.ok(spawns.length > 0, `${label}: no git spawn was intercepted, so nothing was proven`);
  for (const spawn of spawns) {
    assert.equal(
      spawn.env.GIT_OPTIONAL_LOCKS,
      '0',
      `${label}: git ${spawn.argv.slice(1).join(' ')} reached the OS without GIT_OPTIONAL_LOCKS=0`,
    );
  }
}

describe('#5048 every read-only seam hands GIT_OPTIONAL_LOCKS=0 to the OS', () => {
  test('execGit — the shared git seam', () => {
    const { execGit } = require('../gsd-core/bin/lib/shell-command-projection.cjs');
    const calls = captureSpawns(() => {
      // `status` is index-refreshing, so this is the case that matters.
      execGit(['status', '--porcelain']);
      // Index-free calls ride the same env; assert one so the shared env is
      // pinned for the whole seam and not only for the refreshing subclass.
      execGit(['rev-parse', '--show-toplevel']);
    });
    assertLockedOut(gitSpawns(calls), 'execGit');
  });

  test('a caller can still opt back in through opts.env (the escape hatch is real)', () => {
    // execGit spreads opts.env LAST on purpose, so a caller that genuinely wants
    // the optional index write (a status whose freshness it wants persisted)
    // can re-enable it. Without this, "set it everywhere" would be a trap.
    const { execGit } = require('../gsd-core/bin/lib/shell-command-projection.cjs');
    const calls = captureSpawns(() => {
      execGit(['status'], { env: { GIT_OPTIONAL_LOCKS: '1' } });
    });
    const spawns = gitSpawns(calls);
    assert.ok(spawns.length > 0, 'no git spawn intercepted');
    assert.equal(spawns[0].env.GIT_OPTIONAL_LOCKS, '1');
  });

  test('smart-entry readGitSignals, reached through detectSignals', () => {
    // readGitSignals is module-private; detectSignals is its only caller and is
    // exported, so this drives the real code path rather than a stand-in.
    const { detectSignals } = require('../gsd-core/bin/lib/smart-entry.cjs');
    const calls = captureSpawns(() => {
      detectSignals(REPO_ROOT);
    });
    const git = gitSpawns(calls);
    assert.ok(git.length > 0, 'smart-entry spawned no git; the probe is broken');
    // `status` must be among them — that is the index-refreshing call the fix
    // is about. If a refactor removes it, say so instead of passing vacuously.
    assert.ok(
      git.some(s => gitSubcommand(s.argv) === 'status'),
      `smart-entry no longer runs \`git status\`; saw ${git.map(s => s.argv.join(' ')).join(' | ')}`,
    );
    assertLockedOut(git, 'smart-entry');
  });

  test('pristine-baseline gitExec', () => {
    const { gitExec } = require('../gsd-core/bin/lib/pristine-baseline.cjs');
    const calls = captureSpawns(() => {
      gitExec(REPO_ROOT, ['log', '--format=%H', '-1']);
    });
    assertLockedOut(gitSpawns(calls), 'gitExec');
  });

  test('gsd-statusline readGitStatus', () => {
    const { readGitStatus } = require('../hooks/gsd-statusline.js');
    const calls = captureSpawns(
      () => readGitStatus(REPO_ROOT),
      // A plausible `--porcelain=v2 --branch` answer, so the function runs its
      // real post-spawn parsing instead of failing on an empty string.
      argv => (/--branch/.test(argv.join(' '))
        ? '# branch.oid deadbeef\n# branch.head main\n1 .M N... 100644 100644 100644 aaa bbb staged.cjs\n'
        : ''),
    );
    const git = gitSpawns(calls);
    assert.ok(git.length > 0, 'readGitStatus spawned no git; the probe is broken');
    assert.ok(
      git.some(s => gitSubcommand(s.argv) === 'status'),
      `readGitStatus no longer runs \`git status\`; saw ${git.map(s => s.argv.join(' ')).join(' | ')}`,
    );
    assertLockedOut(git, 'gsd-statusline');
  });
});

/**
 * The two pre-write hooks are standalone scripts: they read a JSON envelope on
 * stdin and exit, and their `git()` helper is module-private with no export. So
 * they are driven the way they actually run — as a subprocess with
 * `node:child_process` intercepted by a preload, and a real envelope on stdin.
 * The hook's own allow/block decision is irrelevant here; the assertion is on
 * the env the captured `git()` handed the OS.
 */
const HOOK_CAPTURE_PRELOAD = `
  const fs = require('node:fs');
  const childProcess = require('node:child_process');
  const calls = [];
  const record = (callee) => (file, args, opts) => {
    calls.push({ file: String(file), argv: (Array.isArray(args) ? args : [args]).map(String),
                 env: (opts && opts.env) || {} });
    return { status: 0, stdout: 'root\\n', stderr: '', error: undefined };
  };
  for (const name of ['execFileSync', 'spawnSync', 'execSync', 'exec']) {
    childProcess[name] = record(name);
  }
  process.on('exit', () => {
    try { fs.writeFileSync(process.env.GSD_LOCKS_CAPTURE, JSON.stringify(calls)); } catch {}
  });
`;

/**
 * The two pre-write hooks read DIFFERENT envelope shapes off stdin, and each
 * bails out before reaching any git() call if its own path field is missing —
 * so driving them with one shared payload silently proves nothing. Each hook
 * therefore carries the minimum envelope that reaches a git() call.
 *
 * gsd-windsurf-pre-write.js: Cascade pre_write_code, tool_info.file_path.
 * gsd-worktree-path-guard.js: tool_input.file_path (falling back to
 *   tool_input.path for the Kimi shape).
 */
const HOOK_ENVELOPES = {
  'hooks/gsd-windsurf-pre-write.js': root => JSON.stringify({
    agent_action_name: 'pre_write_code',
    trajectory_id: 't',
    execution_id: 'e',
    timestamp: '2026-01-01T00:00:00Z',
    model_name: 'test',
    tool_info: { file_path: path.join(root, 'probe.txt'), edits: [] },
  }),
  'hooks/gsd-worktree-path-guard.js': root => JSON.stringify({
    tool_name: 'Write',
    tool_input: { file_path: path.join(root, 'probe.txt'), content: 'x' },
  }),
};

function runHookAndCapture(t, hookRel) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5048-'));
  t.after(() => helpers.cleanup(root));
  const preload = path.join(root, 'preload.cjs');
  const out = path.join(root, 'spawns.json');
  fs.writeFileSync(preload, HOOK_CAPTURE_PRELOAD);

  const result = runNode(
    ['--require', preload, path.join(REPO_ROOT, hookRel)],
    { input: HOOK_ENVELOPES[hookRel](root), env: { ...process.env, GSD_LOCKS_CAPTURE: out }, timeout: STAGED_HOOK_SCRIPT_TIMEOUT_MS },
  );
  assert.ok(result.outcome === 'exited', `driving ${hookRel} did not exit cleanly: ${result.outcome}`);
  assert.ok(fs.existsSync(out), `${hookRel} produced no spawn capture`);
  return JSON.parse(fs.readFileSync(out, 'utf8'));
}

describe('#5048 the two pre-write hooks set the variable on their own git()', () => {
  for (const hook of Object.keys(HOOK_ENVELOPES)) {
    test(`${hook} — driven as the real hook process`, (t) => {
      const calls = runHookAndCapture(t, hook);
      const git = gitSpawns(calls);
      assert.ok(git.length > 0, `${hook} spawned no git through its own helper`);
      assertLockedOut(git, hook);
    });
  }
});

/**
 * Everything above asserts that the code *sets* the variable. This block asserts
 * that setting it *does* something, against real git rather than against our own
 * reading of our own code — the check that the env-level observable is a proxy
 * for the real defect and not just a string we happen to emit.
 *
 * The setup is a repo whose index is stale by STAT DATA alone: a tracked file
 * whose content is unchanged but whose mtime/size metadata no longer matches what
 * the index recorded. git re-reads the file, finds it identical, and writes the
 * refreshed stat data back — which is exactly the optional write the lock exists
 * to protect. Content-change staleness would not do: that case reports a
 * modification and never reaches the refresh.
 *
 * These calls go through `gitOrThrow`, not a raw `execFileSync`: the seam is
 * timeout-bounded by construction (`local/no-unbounded-spawn`), and a fixture
 * that silently failed to `git init` would make every assertion below vacuous.
 * It spawns `git` as a fresh process, so the probe helper's module-object patch
 * cannot intercept it either.
 */
describe('#5048 a real repo shows the variable changes what git does', () => {
  function digestIndex(dir) {
    return crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(dir, '.git', 'index')))
      .digest('hex');
  }

  /** A repo with one commit whose index is stale by stat data alone. */
  function staleIndexRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5048-'));
    const git = (...args) => gitOrThrow(args, { cwd: dir });
    git('init', '-q');
    git('config', 'user.email', 'gsd@example.test');
    git('config', 'user.name', 'gsd test');
    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'same bytes\n');
    git('add', 'tracked.txt');
    git('commit', '-q', '-m', 'initial');
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(dir, 'tracked.txt'), future, future);
    return dir;
  }

  function statusWithLocks(dir, value) {
    gitOrThrow(['status', '--porcelain'], {
      cwd: dir,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: value },
    });
  }

  test('with GIT_OPTIONAL_LOCKS=0, git status leaves .git/index byte-identical', () => {
    const dir = staleIndexRepo();
    try {
      const before = digestIndex(dir);
      statusWithLocks(dir, '0');
      assert.equal(
        digestIndex(dir), before,
        'a read-only git status must not rewrite the index',
      );
    } finally {
      helpers.cleanup(dir);
    }
  });

  test('without it, the same command does rewrite the index (the control)', () => {
    // Without this the test above would pass even if git had stopped refreshing
    // the index altogether, and would be asserting nothing. If this ever fails,
    // git's behaviour changed and the sibling test needs revisiting rather than
    // deleting.
    const dir = staleIndexRepo();
    try {
      const before = digestIndex(dir);
      statusWithLocks(dir, '1');
      assert.notEqual(
        digestIndex(dir), before,
        'expected git to refresh the index without the variable; if this fails '
        + 'the premise of the sibling test changed and it needs revisiting',
      );
    } finally {
      helpers.cleanup(dir);
    }
  });
});
