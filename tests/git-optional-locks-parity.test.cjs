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
 * The guard is behavioural: every assertion below watches the options object a
 * *real* seam hands to `node:child_process`, and the last block runs against a
 * real repository. Nothing here reads source as text, so neither a comment
 * naming the variable nor a spawn hidden behind a variable or a wrapper can
 * pass without the env genuinely reaching the OS. What it does NOT cover is a
 * spawn site nobody probed — see the exclusions list, and read it as the open
 * edge of this guard.
 *
 * The last block is the part that establishes the variable is load-bearing: a
 * real repo whose index is stale by stat data alone, run twice, showing that
 * `GIT_OPTIONAL_LOCKS=0` leaves `.git/index` byte-identical and that the
 * default environment rewrites it. Everything above this line proves the code
 * sets the variable; that block proves setting it changes what git does.
 *
 * Scope: the seams probed below cannot regress their env without a red test,
 * and the real-repo block shows the variable is load-bearing. A *new*
 * index-refreshing read-only spawn needs a new probe here.
 *
 * ## Sites deliberately NOT probed
 *
 *   - `src/phase.cts` `worktree list` — worktrees metadata; no index refresh.
 *   - `hooks/gsd-workflow-guard.js` `branch --show-current` — HEAD/refs only.
 *   - `hooks/gsd-statusline.js` `rev-list` — commit objects only.
 *   - `src/check-command-router.cts`, `gate-ui-safety`, `decision-coverage-
 *     support` — no git spawn of their own; they delegate to a probed seam.
 *   - `scripts/*.cjs` — package scripts; no index-refreshing optional lock.
 *   - Shipped workflow markdown snippets (`gsd-core/workflows/*.md`) that
 *     shell out to bare `git status` — out of scope for this TypeScript/hook
 *     seam change; not probed.
 *
 * `src/roadmap-upgrade.cts` is probed below.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const helpers = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { REAL_REPO_GIT_TIMEOUT_MS, STAGED_HOOK_SCRIPT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
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

/** The compiled owner of the read-only env block (#5048). */
const OWNER_MODULE_REL = '../gsd-core/bin/lib/read-only-git-env.cjs';

/** The same file from the repo root — `path.join` would eat the leading `..`. */
const OWNER_MODULE_FROM_ROOT = 'gsd-core/bin/lib/read-only-git-env.cjs';

/**
 * A value a hand-written `{ GIT_OPTIONAL_LOCKS: '0' }` block cannot produce, so
 * seeing it on a spawn proves the owner was consulted rather than bypassed.
 */
const OWNER_SENTINEL = 'owner-sentinel-5048';

/**
 * Run `fn` with the owner's export replaced by one that stamps the sentinel.
 * Restoring happens in `finally`, but the RETURN is outside it — a `return`
 * inside `finally` discards an in-flight throw (no-unsafe-finally).
 */
function withPatchedOwner(fn) {
  const owner = require(OWNER_MODULE_REL);
  const original = owner.readOnlyGitEnv;
  owner.readOnlyGitEnv = (base) => {
    const env = original(base);
    env.GIT_OPTIONAL_LOCKS = OWNER_SENTINEL;
    return env;
  };
  let thrown;
  let out;
  try {
    out = fn();
  } catch (err) {
    thrown = err;
  }
  owner.readOnlyGitEnv = original;
  if (thrown) throw thrown;
  return out;
}

function assertFromOwner(spawns, label) {
  assert.ok(spawns.length > 0, `${label}: no git spawn was intercepted, so nothing was proven`);
  for (const spawn of spawns) {
    assert.equal(
      spawn.env.GIT_OPTIONAL_LOCKS,
      OWNER_SENTINEL,
      `${label}: git ${spawn.argv.slice(1).join(' ')} reached the OS without consulting `
      + 'src/read-only-git-env.cts — it hand-wrote the env block, so this seam has drifted from the owner',
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

  test('roadmap-upgrade applyMigration clean-tree check', (t) => {
    // applyMigration's `git status --porcelain` runs on the real-run path, so
    // it is probed like every other seam rather than assumed to inherit the
    // opt-out.
    //
    // The plan is empty on every field the migration walks, so the function
    // reaches the status check and then does nothing else — the assertion is on
    // the spawn env, not on what a migration would write.
    const { applyMigration } = require('../gsd-core/bin/lib/roadmap-upgrade.cjs');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5048-'));
    t.after(() => helpers.cleanup(root));
    const plan = { alreadyMigrated: false, phases: [], roadmapEdits: [], crossRefEdits: [] };
    const calls = captureSpawns(() => applyMigration(root, plan, { dryRun: false }));
    const git = gitSpawns(calls);
    assert.ok(git.length > 0, 'applyMigration spawned no git; the probe is broken');
    assert.ok(
      git.some(s => gitSubcommand(s.argv) === 'status'),
      `applyMigration no longer runs \`git status\`; saw ${git.map(s => s.argv.join(' ')).join(' | ')}`,
    );
    assertLockedOut(git, 'roadmap-upgrade');
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

/**
 * Same drive as `runHookAndCapture`, but the preload ALSO replaces the shared
 * owner's export with a sentinel, so the capture proves the hook consulted
 * src/read-only-git-env.cts rather than hand-writing the literal. The patch
 * lands in the preload because `--require` runs before the hook body: the hooks
 * `const { readOnlyGitEnv } = require(...)` at load time, so a module-object
 * patch applied afterwards would not be seen.
 */
function runHookAgainstPatchedOwner(t, hookRel) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5048-'));
  t.after(() => helpers.cleanup(root));
  const preload = path.join(root, 'preload.cjs');
  const out = path.join(root, 'spawns.json');
  const ownerPath = path.join(REPO_ROOT, OWNER_MODULE_FROM_ROOT);
  fs.writeFileSync(preload, `${HOOK_CAPTURE_PRELOAD}
  const owner = require(${JSON.stringify(ownerPath)});
  const original = owner.readOnlyGitEnv;
  owner.readOnlyGitEnv = (base) => {
    const env = original(base);
    env.GIT_OPTIONAL_LOCKS = ${JSON.stringify(OWNER_SENTINEL)};
    return env;
  };
`);

  const result = runNode(
    ['--require', preload, path.join(REPO_ROOT, hookRel)],
    {
      input: HOOK_ENVELOPES[hookRel](root),
      env: { ...process.env, GSD_LOCKS_CAPTURE: out },
      timeout: STAGED_HOOK_SCRIPT_TIMEOUT_MS,
    },
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
 * Everything above asks "does the env carry the literal?" — which a seam that
 * HAND-WROTE `{ ...process.env, GIT_OPTIONAL_LOCKS: '0' }` answers just as
 * happily, so none of it can see the drift the shared owner was introduced to
 * remove. A new read-only seam added tomorrow, or an existing one edited back to
 * a hand-written block, stays green here forever.
 *
 * This block closes that hole by making the OWNER the observable. The owner's
 * export is replaced with a function that stamps a sentinel on whatever it
 * returns; a seam that calls it hands the sentinel to the OS, and a seam that
 * hand-writes the literal hands `'0'`. The sentinel cannot be produced by a
 * hand-written block, so the difference is unambiguous.
 *
 * Same module-object argument as `recordSpawns`, and with the same stated
 * limit: the tsc CommonJS emit reads `read_only_git_env_cjs_1.readOnlyGitEnv`
 * at CALL time, so patching the resolved module object is seen by every in-process
 * seam. The two hooks destructure the export at LOAD time, which is why they are
 * driven as subprocesses with the patch installed in a `--require` preload
 * (`runHookAgainstPatchedOwner`) rather than in-process.
 *
 * `delete require.cache` on gsd-statusline.js is load-bearing: the sibling test
 * above already required the hook, and a cached module keeps the ORIGINAL
 * function in its top-level `const`, so the owner patch would be invisible and
 * this test would fail against correct code.
 */
describe('#5048 every seam reads the shared owner instead of hand-writing the block', () => {
  test('execGit — the shared git seam', () => {
    const calls = withPatchedOwner(() => captureSpawns(() => {
      require('../gsd-core/bin/lib/shell-command-projection.cjs').execGit(['status', '--porcelain']);
    }));
    assertFromOwner(gitSpawns(calls), 'execGit');
  });

  test('smart-entry readGitSignals, reached through detectSignals', () => {
    const calls = withPatchedOwner(() => captureSpawns(() => {
      require('../gsd-core/bin/lib/smart-entry.cjs').detectSignals(REPO_ROOT);
    }));
    assertFromOwner(gitSpawns(calls), 'smart-entry');
  });

  test('pristine-baseline gitExec', () => {
    const calls = withPatchedOwner(() => captureSpawns(() => {
      require('../gsd-core/bin/lib/pristine-baseline.cjs').gitExec(REPO_ROOT, ['log', '--format=%H', '-1']);
    }));
    assertFromOwner(gitSpawns(calls), 'gitExec');
  });

  test('roadmap-upgrade applyMigration clean-tree check', (t) => {
    const { applyMigration } = require('../gsd-core/bin/lib/roadmap-upgrade.cjs');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5048-'));
    t.after(() => helpers.cleanup(root));
    const plan = { alreadyMigrated: false, phases: [], roadmapEdits: [], crossRefEdits: [] };
    const calls = withPatchedOwner(() => captureSpawns(() => applyMigration(root, plan, { dryRun: false })));
    assertFromOwner(gitSpawns(calls), 'roadmap-upgrade');
  });

  test('gsd-statusline readGitStatus', () => {
    // Re-required under the patch: see the cache note above. Dropped from the
    // cache again on the way out, because the hook destructures the owner at
    // LOAD time — leaving the sentinel-patched copy cached would hand every
    // later `require` of this hook a seam pinned to the sentinel forever.
    const hookPath = require.resolve('../hooks/gsd-statusline.js');
    const calls = withPatchedOwner(() => {
      delete require.cache[hookPath];
      const { readGitStatus } = require('../hooks/gsd-statusline.js');
      return captureSpawns(
        () => readGitStatus(REPO_ROOT),
        argv => (/--branch/.test(argv.join(' '))
          ? '# branch.oid deadbeef\n# branch.head main\n1 .M N... 100644 100644 100644 aaa bbb staged.cjs\n'
          : ''),
      );
    });
    delete require.cache[hookPath];
    assertFromOwner(gitSpawns(calls), 'gsd-statusline');
  });

  for (const hook of Object.keys(HOOK_ENVELOPES)) {
    test(`${hook} — driven as the real hook process against a patched owner`, (t) => {
      assertFromOwner(gitSpawns(runHookAgainstPatchedOwner(t, hook)), hook);
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
  /** 2035-01-01T00:00:00Z — far enough ahead that no checkout can outrun it. */
  const FIXED_FUTURE_MTIME_MS = Date.parse('2035-01-01T00:00:00Z');

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
    // A fixed far-future mtime, not `Date.now() + 5000`. Git treats an index
    // entry whose mtime is >= the index file's own mtime as racily clean and
    // reloads it from the object store, which is the refresh that takes the
    // lock. Any timestamp in the future satisfies that, so pinning one makes
    // the fixture reproducible instead of drifting with wall-clock time (and
    // immune to a machine whose clock is behind the checkout's).
    const future = new Date(FIXED_FUTURE_MTIME_MS);
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

  /**
   * #5048 acceptance 2: "a `git commit` racing N statusline renders succeeds
   * without `index.lock: File exists`".
   *
   * The race is stood in for deterministically rather than timed. A read-only
   * `git status` contends for `.git/index.lock` — the very path `git add` /
   * `git commit` need — only when it wants to write refreshed stat data back,
   * so this uses the same stat-stale repo the block above uses and then places
   * a lock file on that path for the duration of the renders. Nothing here
   * sleeps or polls: the lock is present before the first render and gone
   * before the commit, so the test cannot pass by getting lucky on timing.
   *
   * Measured on git 2.47.3, so the limit is stated rather than implied: with
   * `GIT_OPTIONAL_LOCKS` unset, a `git status` that cannot take the lock treats
   * the lost refresh as best-effort — it exits 0, prints nothing on stderr, and
   * leaves the index unwritten. The "File exists" error therefore surfaces from
   * the side that NEEDS the lock (the writer), not from the read, which is why
   * this asserts the writer's outcome and the read's side effects rather than
   * an error string. Assertions, all four load-bearing:
   *
   *   1. every render returned the branch header, so no render degraded to null
   *      while the lock was held;
   *   2. `.git/index` is byte-identical after the renders — the reads never
   *      attempted the write at all, which is the variable's whole effect;
   *   3. a real `git commit` of a staged change succeeds afterwards and leaves
   *      no lock behind, so the renders did not strand the path for the writer;
   *   4. control: the same command WITHOUT the variable does rewrite the index
   *      in the same repo, so assertions 1-3 are not vacuous. (If this fails,
   *      git changed and the block above needs revisiting, not deleting.)
   */
  describe('a commit racing N statusline renders', () => {
    const RENDERS = 5;

    function commitTrackedChange(dir) {
      fs.appendFileSync(path.join(dir, 'tracked.txt'), 'changed\n');
      gitOrThrow(['add', 'tracked.txt'], { cwd: dir });
      const result = childProcess.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'after the renders'], {
        encoding: 'utf8',
        timeout: REAL_REPO_GIT_TIMEOUT_MS,
      });
      assert.equal(result.status, 0, `the commit failed after the renders: ${result.stderr}`);
      assert.ok(
        !fs.existsSync(path.join(dir, '.git', 'index.lock')),
        'a render left .git/index.lock behind, so the next writer would fail with File exists',
      );
    }

    test('the reads skip the lock and the writer still gets it', () => {
      const dir = staleIndexRepo();
      try {
        const { readGitStatus } = require('../hooks/gsd-statusline.js');
        const lock = path.join(dir, '.git', 'index.lock');
        const before = digestIndex(dir);

        fs.writeFileSync(lock, '');
        let degraded = null;
        for (let i = 0; i < RENDERS && !degraded; i++) {
          const out = readGitStatus(dir);
          if (typeof out !== 'string' || !out.includes('# branch.head ')) {
            degraded = `render ${i + 1} of ${RENDERS} did not report the branch while the lock was held `
              + '(a read that cannot write the index must still report status)';
          }
        }
        // eslint-disable-next-line local/no-raw-rmsync-in-tests -- removing the fake .git/index.lock fixture itself, not the temp repo; helpers.cleanup() would take the repo out from under the sibling assertions.
        fs.rmSync(lock);

        assert.equal(degraded, null, degraded);
        assert.equal(
          digestIndex(dir), before,
          `${RENDERS} read-only renders rewrote .git/index, so they were contending for the lock`,
        );
        commitTrackedChange(dir);
      } finally {
        helpers.cleanup(dir);
      }
    });

    test('without the variable the same reads contend for the lock (the control)', () => {
      const dir = staleIndexRepo();
      try {
        const lock = path.join(dir, '.git', 'index.lock');
        const before = digestIndex(dir);
        const statusWithoutLocks = () => childProcess.spawnSync(
          'git', ['-C', dir, 'status', '--porcelain'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: REAL_REPO_GIT_TIMEOUT_MS },
        );

        fs.writeFileSync(lock, '');
        for (let i = 0; i < RENDERS; i++) statusWithoutLocks();
        const whileHeld = digestIndex(dir);
        // eslint-disable-next-line local/no-raw-rmsync-in-tests -- removing the fake .git/index.lock fixture itself, not the temp repo; helpers.cleanup() would take the repo out from under the sibling assertions.
        fs.rmSync(lock);
        statusWithoutLocks();
        const afterRelease = digestIndex(dir);

        assert.equal(
          whileHeld, before,
          'the held lock did not block the refresh, so this fixture never reproduced the race '
          + 'and the sibling test would pass for the wrong reason',
        );
        assert.notEqual(
          afterRelease, before,
          'git did not want to refresh the index at all, so GIT_OPTIONAL_LOCKS has nothing to '
          + 'disable here and the sibling test proves nothing; revisit it rather than deleting it',
        );
        commitTrackedChange(dir);
      } finally {
        helpers.cleanup(dir);
      }
    });
  });

});
